import {
	addToScene,
	createMeshFromData,
	type LiteMetadata,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	removeFromScene,
	type ShaderMaterial,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import { vec3Zero } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import {
	acquireSpriteMaterial,
	getBillboardQuadGeometry,
	releaseSpriteMaterial,
} from "@/code/Player/Inventory/DroppedItem";
import { resolveBlockAtWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	_voxelResolveScratch,
	Axis as ColliderAxis,
	createVoxelColliderBlockSampler,
	UNLOADED_SOLID_RESOLVE,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { isCollidableBlock } from "@/code/World/Texture/BlockType";

/**
 * XP orb — a souls-like violet/teal wisp dropped by hostile mobs.
 *
 * Deliberately local-only (like a particle with physics): each client
 * spawns and collects its own orbs, so no network protocol was needed —
 * singleplayer deaths spawn them in onDeath, multiplayer kills spawn them
 * in RemoteMobManager from the kill-linked despawn. XP itself is per-player
 * (PlayerStats.xp / xpLevel).
 */

export const XP_ORB_ICON_URL = "/texture/items/xp_orb.png";

const GRAVITY = -18;
const STEP_SIZE = 0.2;
const EPSILON = 0.001;
const MAGNET_RADIUS_SQ = 4.5 * 4.5;
const PICKUP_RADIUS_SQ = 1.3 * 1.3;
const MAGNET_ACCEL = 22;
const MAX_ORBS = 150;
const ORB_LIFETIME_SEC = 300;

const ORB_SAMPLER = createVoxelColliderBlockSampler(
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

let orbTexturePromise: Promise<Texture2D | null> | null = null;
function getOrbTexture(): Promise<Texture2D | null> {
	if (!orbTexturePromise) {
		orbTexturePromise = loadTexture2D(Map1.engine, XP_ORB_ICON_URL, {
			mipMaps: true,
			magFilter: "nearest",
			minFilter: "nearest",
		}).catch(() => null);
	}
	return orbTexturePromise;
}

export class XpOrb {
	#mesh: Mesh;
	#material: ShaderMaterial;
	#materialEpoch = 0;
	#position: Vec3;
	#velocity = vec3Zero();
	#collider: VoxelAabbCollider;
	#disposed = false;
	#value: number;
	#age = 0;
	#bobPhase = Math.random() * Math.PI * 2;
	#sceneAdded = false;
	#grounded = false;

	static #allOrbs: XpOrb[] = [];
	static #observerRegistered = false;

	static #ensureObserver(): void {
		if (XpOrb.#observerRegistered) return;
		XpOrb.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001;
			if (dt <= 0) return;
			if (isUiOpen(UiFocus.pauseMenu)) return;

			const orbs = XpOrb.#allOrbs;
			for (let i = 0; i < orbs.length; i++) {
				orbs[i].#tick(dt);
			}
		});
	}

	constructor(x: number, y: number, z: number, value: number) {
		this.#value = Math.max(1, Math.floor(value));
		this.#position = vec3(x, y, z);

		const geometry = getBillboardQuadGeometry();
		this.#mesh = createMeshFromData(
			Map1.engine,
			"xpOrb",
			geometry.positions,
			geometry.normals,
			geometry.indices,
			geometry.uvs,
		);
		const meta = new MetadataContainer();
		this.#mesh.metadata = meta as unknown as LiteMetadata;
		this.#mesh.pickable = false;
		this.#mesh.position.set(x, y, z);
		this.#mesh.scaling.set(0.35, 0.35, 0.35);

		this.#material = acquireSpriteMaterial(XP_ORB_ICON_URL);
		this.#mesh.material = this.#material;
		this.#mesh.visible = false;

		this.#collider = new VoxelAabbCollider(
			vec3(0.15, 0.15, 0.15),
			ORB_SAMPLER,
			EPSILON,
		);

		setShaderUniform(this.#material, "uScale", 1);
		setShaderUniform(this.#material, "uOffset", [0, 0]);
		// Souls-like wisp tint: pale violet over a purple/teal texture.
		setShaderUniform(this.#material, "tintColor", [0.82, 0.78, 1.0]);

		const mat = this.#material;
		const epoch = this.#materialEpoch;
		void getOrbTexture().then((tex) => {
			if (
				this.#disposed ||
				!tex ||
				this.#material !== mat ||
				this.#materialEpoch !== epoch
			)
				return;
			setShaderTexture(this.#material, "diffuseTexture", tex);
			if (!this.#sceneAdded) {
				this.#sceneAdded = true;
				addToScene(Map1.mainScene, this.#mesh);
			}
			this.#mesh.visible = true;
		});

		// Random pop on spawn so stacked orbs scatter like item drops.
		this.#velocity.x = (Math.random() - 0.5) * 3;
		this.#velocity.y = 3 + Math.random() * 2;
		this.#velocity.z = (Math.random() - 0.5) * 3;

		if (XpOrb.#allOrbs.length >= MAX_ORBS) {
			// Merge into the oldest orb instead of growing forever.
			const oldest = XpOrb.#allOrbs[0];
			if (oldest) oldest.#value += this.#value;
			this.#collider.dispose();
			releaseSpriteMaterial(XP_ORB_ICON_URL, this.#material);
			this.#disposed = true;
			return;
		}

		XpOrb.#allOrbs.push(this);
		XpOrb.#ensureObserver();
	}

	#tick(dt: number): void {
		if (this.#disposed) return;

		this.#age += dt;
		if (this.#age >= ORB_LIFETIME_SEC) {
			this.#dispose();
			return;
		}

		const player = Map1.mainPlayer;
		if (player) {
			const pp = player.position;
			const dx = pp.x - this.#position.x;
			const dy = pp.y + 0.5 - this.#position.y;
			const dz = pp.z - this.#position.z;
			const distSq = dx * dx + dy * dy + dz * dz;

			if (distSq <= PICKUP_RADIUS_SQ) {
				player.stats.addXp(this.#value);
				this.#dispose();
				return;
			}

			if (distSq <= MAGNET_RADIUS_SQ && distSq > 0.0001) {
				const dist = Math.sqrt(distSq);
				const pull = MAGNET_ACCEL * dt;
				this.#velocity.x += (dx / dist) * pull;
				this.#velocity.y += (dy / dist) * pull;
				this.#velocity.z += (dz / dist) * pull;
			}
		}

		this.#velocity.y += GRAVITY * dt;
		this.#moveAxis(ColliderAxis.X, this.#velocity.x * dt);
		const preY = this.#position.y;
		this.#moveAxis(ColliderAxis.Y, this.#velocity.y * dt);
		this.#grounded = this.#position.y === preY && this.#velocity.y < 0;
		this.#moveAxis(ColliderAxis.Z, this.#velocity.z * dt);

		const damping = this.#grounded ? 8.0 : 1.8;
		const keep = Math.exp(-damping * dt);
		this.#velocity.x *= keep;
		this.#velocity.y *= keep;
		this.#velocity.z *= keep;
		if (this.#grounded && this.#velocity.y < 0) this.#velocity.y = 0;

		// Gentle bob + camera-facing billboard.
		this.#bobPhase += dt * 3;
		this.#mesh.position.set(
			this.#position.x,
			this.#position.y + Math.sin(this.#bobPhase) * 0.05,
			this.#position.z,
		);
		const cam = Map1.mainScene.camera;
		if (cam) {
			const m = cam.worldMatrix;
			this.#mesh.rotation.y = Math.atan2(
				m[12] - this.#position.x,
				m[14] - this.#position.z,
			);
		}
	}

	#moveAxis(axis: ColliderAxis, delta: number): void {
		if (delta === 0) return;
		this.#collider.moveAxis(
			this.#position,
			this.#velocity,
			axis,
			delta,
			STEP_SIZE,
		);
	}

	#dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const idx = XpOrb.#allOrbs.indexOf(this);
		if (idx >= 0) XpOrb.#allOrbs.splice(idx, 1);
		this.#collider.dispose();
		if (this.#sceneAdded) removeFromScene(Map1.mainScene, this.#mesh);
		this.#materialEpoch++;
		releaseSpriteMaterial(XP_ORB_ICON_URL, this.#material);
	}

	static disposeAll(): void {
		for (const orb of [...XpOrb.#allOrbs]) orb.#dispose();
	}
}

/** Spawn 1-3 orbs splitting `min..max` total XP at a death position. */
export function spawnXpOrbs(
	x: number,
	y: number,
	z: number,
	min: number,
	max: number,
): void {
	const lo = Math.floor(min);
	const hi = Math.floor(max);
	const total = hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
	const orbCount = 1 + Math.floor(Math.random() * 3);
	const base = Math.floor(total / orbCount);
	for (let i = 0; i < orbCount; i++) {
		const value = i === orbCount - 1 ? total - base * i : base;
		if (value <= 0) continue;
		// Never let an orb failure break the caller's onDeath: a throw here
		// would otherwise eat the rest of the death handling.
		try {
			new XpOrb(
				x + (Math.random() - 0.5) * 0.6,
				y + 0.5,
				z + (Math.random() - 0.5) * 0.6,
				value,
			);
		} catch (error) {
			console.warn("XpOrb: failed to spawn orb:", error);
		}
	}
}
