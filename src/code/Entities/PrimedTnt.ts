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
import { onGpuWorkDone } from "@/code/World/Light/liteGpuBuffer.js";
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

/** Standard four-second fuse for player-ignited TNT. */
export const TNT_FUSE_SECONDS = 4;

/** Short fuse for chain-ignited TNT. */
export const TNT_CHAIN_FUSE_SECONDS = 0.4;

const GRAVITY = -18;
const MAX_TICK_DT = 0.1;

const HALF_EXTENT = 0.49;
const TNT_SCALE = HALF_EXTENT * 2;
const COLLIDER_EPSILON = 0.001;

const BOUNCE_RESTITUTION = 0.35;
const BOUNCE_MIN_SPEED = 1.2;

const AIR_DAMPING_PER_SEC = 1.2;
const GROUND_DAMPING_PER_SEC = 6;
const VERTICAL_AIR_DAMPING_PER_SEC = 0.2;

const STEP_SIZE = 0.2;

const MAX_RELAY_FUSE_SECONDS = 10;
const REMOTE_HISS_RADIUS_SQ = 32 * 32;

const CHAIN_FUSE_VARIANCE = 0.25;

const INITIAL_HORIZONTAL_SPEED = 1.5;
const INITIAL_VERTICAL_SPEED = 3;
const INITIAL_VERTICAL_VARIANCE = 1.5;

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

const TNT_BLOCK_SAMPLER = createVoxelColliderBlockSampler(
	(x, y, z) => {
		const resolved = resolveBlockAtWorldCoords(x, y, z);

		if (resolved.unloaded) {
			return UNLOADED_SOLID_RESOLVE;
		}

		if (!isCollidableBlock(resolved.blockId)) {
			return null;
		}

		_voxelResolveScratch.blockId = resolved.blockId;
		_voxelResolveScratch.blockState = resolved.blockState;

		return _voxelResolveScratch;
	},
	{
		getFenceDynamicShape,
		getShapeForBlockId,
		isFenceBlockId,
		computeFenceNeighborMask,
	},
);

function randomSignedMagnitude(magnitude: number): number {
	return (Math.random() * 2 - 1) * magnitude;
}

function randomChainFuse(): number {
	return TNT_CHAIN_FUSE_SECONDS + Math.random() * CHAIN_FUSE_VARIANCE;
}

/**
 * Ignite a live TNT block, remove it from the world, relay the ignition, and
 * spawn its primed physics entity.
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

	tnt.addVelocity(
		randomSignedMagnitude(INITIAL_HORIZONTAL_SPEED),
		INITIAL_VERTICAL_SPEED + Math.random() * INITIAL_VERTICAL_VARIANCE,
		randomSignedMagnitude(INITIAL_HORIZONTAL_SPEED),
	);

	playFuseHiss();

	return true;
}

/** Short-fuse igniter passed to local explosions for chain reactions. */
export function igniteChainedTnt(x: number, y: number, z: number): void {
	igniteTnt(x, y, z, randomChainFuse(), false);
}

/**
 * Spawn a primed TNT entity directly without checking or removing a block.
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
 * Spawn a remotely relayed primed TNT entity.
 *
 * The corresponding block has already been removed by the Break broadcast.
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

	const player = Map1.mainPlayer;

	if (!player) {
		return;
	}

	const position = player.position;
	const dx = position.x - x;
	const dy = position.y - y;
	const dz = position.z - z;

	if (dx * dx + dy * dy + dz * dz <= REMOTE_HISS_RADIUS_SQ) {
		playFuseHiss();
	}
}

/** Spawn a remote chain entity without block checks or network messages. */
function spawnRemoteChainTnt(x: number, y: number, z: number): void {
	spawnPrimedTnt(x + 0.5, y + 0.5, z + 0.5, randomChainFuse(), true);
}

/**
 * Flashing, bouncing primed TNT with a fuse countdown.
 */
export class PrimedTnt {
	static readonly #all = new Set<PrimedTnt>();

	/**
	 * Reused frame snapshot.
	 *
	 * A snapshot is still necessary because detonating one TNT can synchronously
	 * spawn chained TNT. Newly spawned entities must begin ticking next frame,
	 * matching the original `[...#all]` behavior.
	 */
	static readonly #tickSnapshot: PrimedTnt[] = [];

	static #observerRegistered = false;

	static #ensureObserver(): void {
		if (PrimedTnt.#observerRegistered) {
			return;
		}

		PrimedTnt.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			if (isUiOpen(UiFocus.pauseMenu)) {
				return;
			}

			const dt = Math.min(MAX_TICK_DT, deltaMs * 0.001);

			if (dt <= 0) {
				return;
			}

			const snapshot = PrimedTnt.#tickSnapshot;
			snapshot.length = 0;

			for (const tnt of PrimedTnt.#all) {
				snapshot.push(tnt);
			}

			const count = snapshot.length;

			for (let i = 0; i < count; i++) {
				snapshot[i].#tick(dt);
			}

			// Do not retain disposed instances between frames.
			snapshot.length = 0;
		});
	}

	static disposeAll(): void {
		const snapshot = PrimedTnt.#tickSnapshot;
		snapshot.length = 0;

		for (const tnt of PrimedTnt.#all) {
			snapshot.push(tnt);
		}

		const count = snapshot.length;

		for (let i = 0; i < count; i++) {
			snapshot[i].#dispose();
		}

		snapshot.length = 0;
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
	#disposed = false;
	#remote: boolean;

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
		const mesh = createMeshFromData(
			Map1.engine,
			"primedTnt",
			geometry.positions,
			geometry.normals,
			geometry.indices,
			geometry.uvs,
		);
		mesh.name = "primedTnt";
		mesh.position.set(x, y, z);
		mesh.scaling.set(TNT_SCALE, TNT_SCALE, TNT_SCALE);
		mesh.pickable = false;
		// Stays out of the scene (and invisible) until the atlas texture is
		// bound — an unbound sampler crashes the Lite bind-group build.
		mesh.visible = false;

		const material = createPrimedTntMaterial();
		mesh.material = material;

		this.#mesh = mesh;
		this.#material = material;

		this.#applyAtlasTile();
		this.#updateLightingIfNeeded(true);
		this.#bindAtlasTexture();

		this.#collider = new VoxelAabbCollider(
			vec3(HALF_EXTENT, HALF_EXTENT, HALF_EXTENT),
			TNT_BLOCK_SAMPLER,
			COLLIDER_EPSILON,
		);

		PrimedTnt.#all.add(this);
	}

	addVelocity(x: number, y: number, z: number): void {
		const velocity = this.#velocity;

		velocity.x += x;
		velocity.y += y;
		velocity.z += z;
	}

	#tick(dt: number): void {
		if (this.#disposed) {
			return;
		}

		this.#fuse -= dt;

		if (this.#fuse <= 0) {
			this.#detonate();
			return;
		}

		this.#updateFlash(dt);
		this.#updatePhysics(dt);

		const position = this.#position;

		this.#mesh.position.set(position.x, position.y, position.z);
		this.#updateLightingIfNeeded();
	}

	#detonate(): void {
		const position = this.#position;
		const x = position.x;
		const y = position.y;
		const z = position.z;
		const remote = this.#remote;

		this.#dispose();

		if (remote) {
			explode(x, y, z, {
				chainIgniter: spawnRemoteChainTnt,
				syncExplosion: false,
			});

			return;
		}

		explode(x, y, z, {
			chainIgniter: igniteChainedTnt,
		});
	}

	#updateFlash(dt: number): void {
		void dt;
		// Fuse burn: steady fade toward white, no blinking. uFlash reaches
		// DETONATION_FLASH (75% white) exactly at detonation. Per-frame
		// setShaderUniform is a proven path (water time, player uAnim,
		// crack uCrackStage all update this way).
		const progress = 1 - this.#fuse / this.#initialFuse;
		const flash = Math.min(1, Math.max(0, progress)) * DETONATION_FLASH;
		setShaderUniform(this.#material, "uFlash", flash);
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
		const position = this.#position;
		const velocity = this.#velocity;
		const collider = this.#collider;

		velocity.y += GRAVITY * dt;

		collider.moveAxis(
			position,
			velocity,
			ColliderAxis.X,
			velocity.x * dt,
			STEP_SIZE,
		);

		const previousY = position.y;
		const impactVelocityY = velocity.y;

		collider.moveAxis(
			position,
			velocity,
			ColliderAxis.Y,
			impactVelocityY * dt,
			STEP_SIZE,
		);

		const grounded = position.y === previousY && impactVelocityY < 0;

		collider.moveAxis(
			position,
			velocity,
			ColliderAxis.Z,
			velocity.z * dt,
			STEP_SIZE,
		);

		if (grounded) {
			velocity.y =
				-impactVelocityY > BOUNCE_MIN_SPEED
					? -impactVelocityY * BOUNCE_RESTITUTION
					: 0;
		}

		const horizontalDamping = grounded
			? GROUND_DAMPING_PER_SEC
			: AIR_DAMPING_PER_SEC;

		const horizontalKeep = Math.exp(-horizontalDamping * dt);

		velocity.x *= horizontalKeep;
		velocity.z *= horizontalKeep;

		if (!grounded) {
			velocity.y *= Math.exp(-VERTICAL_AIR_DAMPING_PER_SEC * dt);
		}
	}

	#dispose(): void {
		if (this.#disposed) {
			return;
		}

		this.#disposed = true;
		PrimedTnt.#all.delete(this);

		this.#collider.dispose();

		if (this.#sceneAdded) {
			removeFromScene(Map1.mainScene, this.#mesh);
		}
		// Invalidate any in-flight atlas bind, then free GPU resources once
		// previously-submitted frames have drained (see deferTntGpuDisposal).
		this.#materialEpoch++;
		deferTntGpuDisposal(this.#mesh, this.#material);
	}
}
// BUGFIX: Deferred GPU disposal (same hazard as Chunk.ts/PackedChunkMesh.ts:
// disposeMeshGpu() destroys buffers immediately, but the GPU may still be
// rendering with them from a previously-submitted command buffer, producing
// "buffer used in submit while destroyed" validation errors every frame).
// The mesh leaves the scene synchronously (no new submits reference it);
// buffer and material destruction waits until the GPU is idle.
function deferTntGpuDisposal(mesh: Mesh, mat: ShaderMaterial): void {
	const engine = Map1.engine;
	if (!engine) {
		disposeMeshGpu(mesh);
		disposeTntMaterial(mat);
		return;
	}

	const destroy = (): void => {
		disposeMeshGpu(mesh);
		disposeTntMaterial(mat);
	};
	void onGpuWorkDone(engine).then(destroy, destroy);
}
