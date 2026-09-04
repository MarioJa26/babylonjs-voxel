import {
	addToScene,
	createBox,
	createStandardMaterial,
	disposeMeshGpu,
	type Mesh,
	onBeforeRender,
	removeFromScene,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { playFuseHiss } from "@/code/Audio/TntAudio";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import { Map1 } from "@/code/Maps/Map1";
import {
	getOnBlockBroken,
	getOnTntIgnite,
} from "@/code/Player/Hud/BlockHighlight/BreakingBlockHandler";
import {
	deleteBlock,
	getBlockByWorldCoords,
	resolveBlockAtWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	_voxelResolveScratch,
	Axis as ColliderAxis,
	createVoxelColliderBlockSampler,
	UNLOADED_SOLID_RESOLVE,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { explode } from "@/code/World/Explosion";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";

/** Standard 4s fuse for player-ignited TNT. */
export const TNT_FUSE_SECONDS = 4;
/** Short fuse for chain-ignited TNT so cascades ripple instead of syncing. */
export const TNT_CHAIN_FUSE_SECONDS = 0.4;

const GRAVITY = -18;
const MAX_TICK_DT = 0.1;
const HALF_EXTENT = 0.49;
const BOUNCE_RESTITUTION = 0.35;
const BOUNCE_MIN_SPEED = 1.2;
const AIR_DAMPING_PER_SEC = 1.2;
const GROUND_DAMPING_PER_SEC = 6.0;
const STEP_SIZE = 0.2;
// Upper bound for relayed fuse values (mirrors the server's MAX_TNT_FUSE).
const MAX_RELAY_FUSE_SECONDS = 10;
// Squared radius inside which a remote ignition plays the fuse hiss.
const REMOTE_HISS_RADIUS_SQ = 32 * 32;

// Same streaming-safe sampler as dropped items: unloaded chunks read as
// solid so primed TNT can't fall through the world at the render edge.
const TNT_BLOCK_SAMPLER = createVoxelColliderBlockSampler(
	(x, y, z) => {
		const r = resolveBlockAtWorldCoords(x, y, z);
		if (r.unloaded) return UNLOADED_SOLID_RESOLVE;
		if (!isCollidableBlock(r.blockId)) return null;
		_voxelResolveScratch.blockId = r.blockId;
		_voxelResolveScratch.blockState = r.blockState;
		return _voxelResolveScratch;
	},
	{
		getFenceDynamicShape,
		getShapeForBlockId,
		isFenceBlockId,
		computeFenceNeighborMask,
	},
);

/**
 * Ignite the TNT block at (x, y, z): delete it, relay the ignition to other
 * clients, spawn a bouncing primed cube, and start the fuse. No-op when the
 * block is no longer live TNT (double-ignite guard for chains).
 *
 * `sendBreak` controls only the per-block Break notify (skipped for chains —
 * the authoritative explosion already owns those blocks and a far-away
 * notify would be rejected as TooFar). The TntIgnite relay is always sent:
 * other clients only get the Break (block vanishes) and need it to spawn
 * the primed entity.
 */
export function igniteTnt(
	x: number,
	y: number,
	z: number,
	fuseSeconds: number = TNT_FUSE_SECONDS,
	sendBreak = true,
): boolean {
	if (getBlockByWorldCoords(x, y, z) !== BlockType.Tnt) {
		return false;
	}

	deleteBlock(x, y, z);
	if (sendBreak) {
		getOnBlockBroken()?.(x, y, z, BlockType.Tnt);
	}
	getOnTntIgnite()?.(x, y, z, fuseSeconds);

	const tnt = spawnPrimedTnt(x + 0.5, y + 0.5, z + 0.5, fuseSeconds, false);
	// Small random pop so stacked ignitions scatter instead of overlapping.
	tnt.addVelocity(
		(Math.random() * 2 - 1) * 1.5,
		3 + Math.random() * 1.5,
		(Math.random() * 2 - 1) * 1.5,
	);
	playFuseHiss();
	return true;
}

/** Short-fuse igniter passed to explode() for chain reactions. */
export function igniteChainedTnt(x: number, y: number, z: number): void {
	igniteTnt(x, y, z, TNT_CHAIN_FUSE_SECONDS + Math.random() * 0.25, false);
}

/**
 * Spawn a primed entity directly (no block check/removal). Feeds the local
 * simulation (igniteTnt) and remote entities from TntIgnite relays.
 */
export function spawnPrimedTnt(
	x: number,
	y: number,
	z: number,
	fuseSeconds: number,
	remote: boolean,
): PrimedTnt {
	return new PrimedTnt(x, y, z, fuseSeconds, remote);
}

/**
 * Remote spawn entry point for TntIgnite relays (block coords + fuse).
 * The block itself is already gone locally via the Break broadcast.
 */
export function spawnRemotePrimedTnt(
	x: number,
	y: number,
	z: number,
	fuseSeconds: number,
): void {
	const fuse =
		Number.isFinite(fuseSeconds) && fuseSeconds > 0
			? Math.min(fuseSeconds, MAX_RELAY_FUSE_SECONDS)
			: TNT_FUSE_SECONDS;
	spawnPrimedTnt(x + 0.5, y + 0.5, z + 0.5, fuse, true);

	// Fuse hiss only when the ignition is close to the local player.
	const player = Map1.mainPlayer;
	if (player) {
		const p = player.position;
		const dx = p.x - x;
		const dy = p.y - y;
		const dz = p.z - z;
		if (dx * dx + dy * dy + dz * dz <= REMOTE_HISS_RADIUS_SQ) {
			playFuseHiss();
		}
	}
}

/** Remote chain igniter: ripple visuals without block checks or network. */
function spawnRemoteChainTnt(x: number, y: number, z: number): void {
	spawnPrimedTnt(
		x + 0.5,
		y + 0.5,
		z + 0.5,
		TNT_CHAIN_FUSE_SECONDS + Math.random() * 0.25,
		true,
	);
}

/**
 * Primed TNT: a flashing red cube with dropped-item-style AABB physics and
 * a fuse countdown. On expiry it detonates via explode() (radius 4, chained
 * ignition, player/mob damage, FX). Rendered with a plain standard material
 * so no atlas dependency is needed for the entity.
 */
export class PrimedTnt {
	static readonly #all = new Set<PrimedTnt>();
	static #observerRegistered = false;

	static #ensureObserver(): void {
		if (PrimedTnt.#observerRegistered) return;
		PrimedTnt.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = Math.min(MAX_TICK_DT, deltaMs * 0.001);
			if (dt <= 0) return;
			if (isUiOpen(UiFocus.pauseMenu)) return;

			for (const tnt of [...PrimedTnt.#all]) {
				tnt.#tick(dt);
			}
		});
	}

	static disposeAll(): void {
		for (const tnt of [...PrimedTnt.#all]) {
			tnt.#dispose();
		}
	}

	#mesh: Mesh;
	// Lite's StandardMaterial type is structural here; flashing only needs
	// diffuseColor, which the boat hull precedent sets the same way.
	#material: { diffuseColor: [number, number, number] };
	#collider: VoxelAabbCollider;
	#position: Vec3;
	#velocity: Vec3;
	#fuse: number;
	#flashTimer = 0;
	#flashOn = false;
	#grounded = false;
	#disposed = false;
	// Remote entities come from TntIgnite relays: same bounce/flash/fuse
	// sim, but detonation is FX + damage only (no block edits, no Explosion
	// message — the lighting client owns the authoritative crater).
	#remote = false;

	constructor(
		x: number,
		y: number,
		z: number,
		fuseSeconds: number,
		remote = false,
	) {
		PrimedTnt.#ensureObserver();

		this.#position = vec3(x, y, z);
		this.#velocity = vec3(0, 0, 0);
		this.#fuse = fuseSeconds;
		this.#remote = remote;

		this.#mesh = createBox(Map1.engine, 1);
		this.#mesh.name = "primedTnt";
		this.#mesh.position.set(x, y, z);
		this.#mesh.scaling.set(HALF_EXTENT * 2, HALF_EXTENT * 2, HALF_EXTENT * 2);
		this.#mesh.pickable = false;

		const material = createStandardMaterial();
		material.diffuseColor = [0.85, 0.12, 0.08];
		this.#material = material as unknown as {
			diffuseColor: [number, number, number];
		};
		this.#mesh.material = material;
		addToScene(Map1.mainScene, this.#mesh);

		this.#collider = new VoxelAabbCollider(
			vec3(HALF_EXTENT, HALF_EXTENT, HALF_EXTENT),
			TNT_BLOCK_SAMPLER,
			0.001,
		);

		PrimedTnt.#all.add(this);
	}

	addVelocity(x: number, y: number, z: number): void {
		this.#velocity.x += x;
		this.#velocity.y += y;
		this.#velocity.z += z;
	}

	#tick(dt: number): void {
		if (this.#disposed) return;

		this.#fuse -= dt;
		if (this.#fuse <= 0) {
			const { x, y, z } = this.#position;
			const remote = this.#remote;
			this.#dispose();
			if (remote) {
				explode(x, y, z, {
					chainIgniter: spawnRemoteChainTnt,
					syncExplosion: false,
				});
			} else {
				explode(x, y, z, { chainIgniter: igniteChainedTnt });
			}
			return;
		}

		// Flash faster as the fuse runs out.
		const interval = this.#fuse > 1 ? 0.35 : 0.1;
		this.#flashTimer += dt;
		if (this.#flashTimer >= interval) {
			this.#flashTimer = 0;
			this.#flashOn = !this.#flashOn;
			this.#material.diffuseColor = this.#flashOn
				? [1, 0.95, 0.9]
				: [0.85, 0.12, 0.08];
		}

		this.#updatePhysics(dt);
		this.#mesh.position.set(
			this.#position.x,
			this.#position.y,
			this.#position.z,
		);
	}

	#updatePhysics(dt: number): void {
		this.#velocity.y += GRAVITY * dt;

		this.#collider.moveAxis(
			this.#position,
			this.#velocity,
			ColliderAxis.X,
			this.#velocity.x * dt,
			STEP_SIZE,
		);

		this.#grounded = false;
		const preY = this.#position.y;
		const preVy = this.#velocity.y;
		this.#collider.moveAxis(
			this.#position,
			this.#velocity,
			ColliderAxis.Y,
			this.#velocity.y * dt,
			STEP_SIZE,
		);
		if (this.#position.y === preY && preVy < 0) {
			this.#grounded = true;
		}

		this.#collider.moveAxis(
			this.#position,
			this.#velocity,
			ColliderAxis.Z,
			this.#velocity.z * dt,
			STEP_SIZE,
		);

		// moveAxis zeroes velocity on impact; restore a bounce on hard
		// landings so primed TNT hops instead of sticking.
		if (this.#grounded) {
			if (-preVy > BOUNCE_MIN_SPEED) {
				this.#velocity.y = -preVy * BOUNCE_RESTITUTION;
			} else {
				this.#velocity.y = 0;
			}
		}

		const damping = this.#grounded
			? GROUND_DAMPING_PER_SEC
			: AIR_DAMPING_PER_SEC;
		const keep = Math.exp(-damping * dt);
		this.#velocity.x *= keep;
		this.#velocity.z *= keep;
		if (!this.#grounded) {
			this.#velocity.y *= Math.exp(-0.2 * dt);
		}
	}

	#dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		PrimedTnt.#all.delete(this);
		this.#collider.dispose();
		removeFromScene(Map1.mainScene, this.#mesh);
		disposeMeshGpu(this.#mesh);
	}
}
