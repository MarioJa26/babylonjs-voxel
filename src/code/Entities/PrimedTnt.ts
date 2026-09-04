import {
	addToScene,
	createMeshFromData,
	createShaderMaterial,
	disposeMeshGpu,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	removeFromScene,
	type ShaderMaterial,
	setShaderTexture,
	setShaderUniform,
	setShaderVector3,
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
import { getUnitCubeGeometry } from "@/code/Player/Inventory/DroppedItem";
import {
	deleteBlock,
	getBlockByWorldCoords,
	getLightByWorldCoords,
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
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { getAtlasTile } from "@/code/World/Texture/BlockTextures";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import {
	atlasSize,
	atlasTileSize,
	getDiffuseTexture2D,
} from "@/code/World/Texture/TextureAtlasFactory";

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

const primedTntVertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vNormal : vec3<f32>,
  @location(2) vWorldPos : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  let worldPos = shaderSystem.world * vec4<f32>(input.position, 1.0);
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vUV = input.uv;
  out.vNormal = input.normal;
  out.vWorldPos = worldPos.xyz;
  return out;
}
`;

const primedTntFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vNormal : vec3<f32>,
  @location(2) vWorldPos : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let atlasUV = in.vUV * shaderUniforms.uScale + shaderUniforms.uOffset;
  let tex = textureSample(diffuseTexture, diffuseTextureSampler, atlasUV);
  if (tex.a < 0.5) { discard; }
  let lit = tex.rgb * shaderUniforms.tintColor;
  // Fuse burn: mix toward white as detonation approaches (0 = TNT texture).
  let flashed = mix(lit, vec3<f32>(1.0), shaderUniforms.uFlash);
  return vec4<f32>(flashed, 1.0);
}
`;

function createPrimedTntMaterial(): ShaderMaterial {
	return createShaderMaterial({
		name: "primedTntMaterial",
		vertexSource: primedTntVertexWGSL,
		fragmentSource: primedTntFragmentWGSL,
		attributes: ["position", "normal", "uv"],
		uniforms: [
			"world",
			"worldViewProjection",
			{ name: "uScale", type: "f32" },
			{ name: "uOffset", type: "vec2<f32>" },
			{ name: "tintColor", type: "vec3<f32>" },
			{ name: "uFlash", type: "f32" },
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: true,
	});
}

// Lite's ShaderMaterial type exposes no dispose — call it structurally.
function disposeTntMaterial(mat: ShaderMaterial): void {
	(mat as unknown as { dispose?: () => void }).dispose?.();
}

// Voxel-light tint convention (mirrors DroppedItem so the cube sits in the
// scene lighting instead of glowing fullbright).
const LIGHT_NORMALIZE_MUL = 1.0 / 15.0;
const TNT_SKY_LIGHT_COLOR = { x: 0.8, y: 0.8, z: 0.8 };
const TNT_BLOCK_LIGHT_COLOR = { x: 0.9, y: 0.6, z: 0.2 };

/** Fuse-burn white level at detonation: the texture fades to 75% white. */
const DETONATION_FLASH = 0.75;

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
 * Primed TNT: a TNT-textured bouncing cube with dropped-item-style AABB
 * physics and a fuse countdown. The texture fades toward white as the fuse
 * burns (75% white at detonation — no blinking). On expiry it detonates via
 * explode() (radius 4, chained ignition, player/mob damage, FX).
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
	#material: ShaderMaterial;
	/** Bumped on dispose so a late atlas bind never resurrects the mesh. */
	#materialEpoch = 0;
	#sceneAdded = false;
	#collider: VoxelAabbCollider;
	#position: Vec3;
	#velocity: Vec3;
	#fuse: number;
	#initialFuse: number;
	#tint: [number, number, number] = [1, 1, 1];
	#lastLightX = Number.NaN;
	#lastLightY = Number.NaN;
	#lastLightZ = Number.NaN;
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
		this.#initialFuse = fuseSeconds > 0 ? fuseSeconds : 1;
		this.#remote = remote;

		const geometry = getUnitCubeGeometry();
		this.#mesh = createMeshFromData(
			Map1.engine,
			"primedTnt",
			geometry.positions,
			geometry.normals,
			geometry.indices,
			geometry.uvs,
		);
		this.#mesh.name = "primedTnt";
		this.#mesh.position.set(x, y, z);
		this.#mesh.scaling.set(HALF_EXTENT * 2, HALF_EXTENT * 2, HALF_EXTENT * 2);
		this.#mesh.pickable = false;
		// Stays out of the scene (and invisible) until the atlas texture is
		// bound — an unbound sampler crashes the Lite bind-group build.
		this.#mesh.visible = false;

		this.#material = createPrimedTntMaterial();
		this.#mesh.material = this.#material;
		this.#applyAtlasTile();
		this.#updateLightingIfNeeded(true);
		this.#bindAtlasTexture();

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

		// Fuse burn: steady fade toward white, no blinking. uFlash reaches
		// DETONATION_FLASH (75% white) exactly at detonation.
		const progress = 1 - this.#fuse / this.#initialFuse;
		const flash = Math.min(1, Math.max(0, progress)) * DETONATION_FLASH;
		setShaderUniform(this.#material, "uFlash", flash);

		this.#updatePhysics(dt);
		this.#updateLightingIfNeeded();
		this.#mesh.position.set(
			this.#position.x,
			this.#position.y,
			this.#position.z,
		);
	}

	#applyAtlasTile(): void {
		const tile = getAtlasTile(BlockType.Tnt) ?? [0, 0];
		const tileSize = atlasTileSize;
		const clampedX = Math.max(0, Math.min(atlasSize - 1, tile[0]));
		const clampedY = Math.max(0, Math.min(atlasSize - 1, tile[1]));
		const atlasRow = atlasSize - 1 - clampedY;

		setShaderUniform(this.#material, "uScale", tileSize);
		setShaderUniform(this.#material, "uOffset", [
			clampedX * tileSize,
			atlasRow * tileSize,
		]);
	}

	#bindAtlasTexture(): void {
		const sharedAtlas = getDiffuseTexture2D();
		if (sharedAtlas) {
			setShaderTexture(this.#material, "diffuseTexture", sharedAtlas);
			this.#ensureAddedToScene();
			return;
		}

		const mat = this.#material;
		const epoch = this.#materialEpoch;
		void loadTexture2D(Map1.engine, "/texture/diffuse_atlas.png", {
			mipMaps: true,
			magFilter: "nearest",
			minFilter: "nearest",
		})
			.then((atlas) => {
				if (
					this.#disposed ||
					!atlas ||
					this.#material !== mat ||
					this.#materialEpoch !== epoch
				) {
					return;
				}
				setShaderTexture(this.#material, "diffuseTexture", atlas);
				this.#ensureAddedToScene();
			})
			.catch(() => {
				// Mesh stays hidden; physics and detonation are unaffected.
			});
	}

	#ensureAddedToScene(): void {
		if (this.#sceneAdded) return;
		this.#sceneAdded = true;
		this.#mesh.visible = true;
		addToScene(Map1.mainScene, this.#mesh);
	}

	#updateLightingIfNeeded(force = false): void {
		const lx = this.#position.x | 0;
		const ly = this.#position.y | 0;
		const lz = this.#position.z | 0;

		if (
			!force &&
			lx === this.#lastLightX &&
			ly === this.#lastLightY &&
			lz === this.#lastLightZ
		) {
			return;
		}

		this.#lastLightX = lx;
		this.#lastLightY = ly;
		this.#lastLightZ = lz;

		this.#applyTintFromPackedLight(
			getLightByWorldCoords(
				this.#position.x,
				this.#position.y,
				this.#position.z,
			),
		);
	}

	#applyTintFromPackedLight(packedLight: number): void {
		const skyLight = ((packedLight >> 4) & 0xf) * LIGHT_NORMALIZE_MUL;
		const blockLight = (packedLight & 0xf) * LIGHT_NORMALIZE_MUL;

		const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
		const sunLightIntensity = Math.min(1.0, Math.max(0.0, sunElevation * 4.0));
		const skyScale = sunLightIntensity + 0.3;

		const skyR = skyLight * TNT_SKY_LIGHT_COLOR.x * skyScale;
		const skyG = skyLight * TNT_SKY_LIGHT_COLOR.y * skyScale;
		const skyB = skyLight * TNT_SKY_LIGHT_COLOR.z * skyScale;

		const blockR = blockLight * TNT_BLOCK_LIGHT_COLOR.x;
		const blockG = blockLight * TNT_BLOCK_LIGHT_COLOR.y;
		const blockB = blockLight * TNT_BLOCK_LIGHT_COLOR.z;

		this.#tint[0] = Math.min(1.0, Math.max(0.3, skyR + blockR));
		this.#tint[1] = Math.min(1.0, Math.max(0.3, skyG + blockG));
		this.#tint[2] = Math.min(1.0, Math.max(0.3, skyB + blockB));

		setShaderVector3(this.#material, "tintColor", this.#tint);
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
		if (this.#sceneAdded) {
			removeFromScene(Map1.mainScene, this.#mesh);
		}
		disposeMeshGpu(this.#mesh);
		// Invalidate any in-flight atlas bind, then free the material: it is
		// per-instance (unlike DroppedItem's pool) and primed TNT is rare.
		this.#materialEpoch++;
		disposeTntMaterial(this.#material);
	}
}
