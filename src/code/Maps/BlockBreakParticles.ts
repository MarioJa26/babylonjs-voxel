import {
	addBillboardSpriteIndex,
	addFacingBillboardSystem,
	billboardBlendAlpha,
	clearBillboardSprites,
	createFacingBillboardSystem,
	createGridSpriteAtlas,
	type FacingBillboardSpriteSystem,
	loadTexture2D,
	onBeforeRender,
	type SceneContext,
	type Vec3,
} from "@babylonjs/lite";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	_voxelResolveScratch,
	createVoxelColliderBlockSampler,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import { getPRNGUnit2 } from "../Generation/NoiseAndParameters/Squirrel13";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { BlockFaceTileX, BlockFaceTileY } from "../World/Texture/BlockTextures";
import { FaceName } from "../World/Texture/FaceName";
import { atlasSize, tileSize } from "../World/Texture/TextureAtlasFactory";

const ATLAS_URL = "/texture/diffuse_atlas.png";
const POOL_SIZE = 2048;
const PARTICLES_PER_BREAK = 198;

const MINING_PARTICLES_PER_EMIT = 6;
const MINING_PARTICLE_INTERVAL_MS = 67;

const SPRINT_PARTICLES_PER_EMIT = 6;
const SPRINT_PARTICLE_INTERVAL_MS = 120;

// Minimum horizontal speed before a sprinting player kicks up dust.
const SPRINT_MIN_SPEED_SQ = 66;
// Feet offset subtracted from a player's body origin to land dust at the ground.
const SPRINT_FEET_OFFSET = 0.85;

/**
 * Per-emitter throttle state. Sprint dust is emitted by the local player and
 * every remote player from locally-available interpolated motion, so each
 * emitter keeps its own cadence instead of contending on a shared timer.
 */
export interface SprintEmitterState {
	lastSprintEmitMs: number;
}

export function makeSprintEmitterState(): SprintEmitterState {
	return { lastSprintEmitMs: 0 };
}

export { SPRINT_FEET_OFFSET, SPRINT_MIN_SPEED_SQ };

const ARROW_PARTICLES_PER_EMIT = 8;
const ARROW_PARTICLE_INTERVAL_MS = 75;

// Wound drip while an arrow rides a mob: slow red trickle from the impact.
// Throttling is CALLER-side (per stuck arrow), so any number of wounded mobs
// can drip simultaneously — see MOB_DRIP_INTERVAL_MS.
export const MOB_DRIP_INTERVAL_MS = 240;
const MOB_DRIPS_PER_EMIT = 24;
const MOB_DAMAGE_PARTICLES_MIN = 4;
const MOB_DAMAGE_PARTICLES_PER_POINT = 6;
const MOB_DAMAGE_PARTICLES_MAX = 32;
const MOB_BLOOD_BLOCK = BlockType.CoralBlock;

const GRAVITY = -16;
const MAX_DT = 0.1;
const FADE_START = 0.85;

const DEBRIS_PER_BREAK = 32;
const DEBRIS_RESTITUTION = 0.35;
const DEBRIS_COLLIDE_STEP = 0.15;
const DEBRIS_SETTLE_SPEED = 1.0;
const DEBRIS_RADIUS_SCALE = 0.4;

let lastMiningEmitMs = 0;
let lastArrowHitEmitMs = 0;

// ---------------------------------------------------------------------------
// Particle pool (SoA / typed-array layout).
//
// Particles live densely packed in [0, aliveCount). Removal is a swap with
// the last live particle followed by aliveCount--, so there is no separate
// free-list to maintain — the tail past aliveCount *is* the free capacity.
// This keeps every per-frame scan cache-dense and GC-transparent (no object
// pointers for the collector to trace), matching the typed-array-LUT /
// scratch-buffer conventions used elsewhere in the engine.
// ---------------------------------------------------------------------------

const px = new Float32Array(POOL_SIZE);
const py = new Float32Array(POOL_SIZE);
const pz = new Float32Array(POOL_SIZE);
const pvx = new Float32Array(POOL_SIZE);
const pvy = new Float32Array(POOL_SIZE);
const pvz = new Float32Array(POOL_SIZE);
const page = new Float32Array(POOL_SIZE);
const plife = new Float32Array(POOL_SIZE);
const psize = new Float32Array(POOL_SIZE);
const pangle = new Float32Array(POOL_SIZE);
const pspin = new Float32Array(POOL_SIZE);
const pr = new Float32Array(POOL_SIZE);
const pg = new Float32Array(POOL_SIZE);
const pb = new Float32Array(POOL_SIZE);
const pa = new Float32Array(POOL_SIZE);
const pgrav = new Float32Array(POOL_SIZE);
const pframe = new Uint16Array(POOL_SIZE);
/** bit0 = collide (routes through voxel collision in tick), bit1 = settled. */
const pflags = new Uint8Array(POOL_SIZE);
const COLLIDE_BIT = 1;
const SETTLED_BIT = 2;

let aliveCount = 0;

// Scratch props reused across every `addBillboardSpriteIndex` call so the
// per-frame billboard rebuild allocates nothing.
const scratchPos: [number, number, number] = [0, 0, 0];
const scratchSize: [number, number] = [0, 0];
const scratchColor: [number, number, number, number] = [0, 0, 0, 0];
const scratchProps = {
	position: scratchPos,
	sizeWorld: scratchSize,
	rotation: 0,
	color: scratchColor,
	frame: 0,
};

// Scratch light result reused across every `computeLight` call. Safe because
// every call site consumes `.r/.g/.b` immediately and never holds the
// reference across a subsequent `computeLight` call.
const scratchLight = { r: 0, g: 0, b: 0 };

// Scratch objects for debris collision sweeps (allocation-free).
const scratchDebrisPos: Vec3 = { x: 0, y: 0, z: 0 };
const scratchDebrisHalf: Vec3 = { x: 0, y: 0, z: 0 };

// Shared shape-aware voxel sampler + stateless collider (DroppedItem pattern).
// The collider's fixed half-extents are never used; debris sweeps call
// `overlapsBox` with per-particle radii instead.
const DEBRIS_BLOCK_SAMPLER = createVoxelColliderBlockSampler(
	(x, y, z) => {
		const blockId = getBlockByWorldCoords(x, y, z);
		if (!isCollidableBlock(blockId)) return null;
		_voxelResolveScratch.blockId = blockId;
		_voxelResolveScratch.blockState = getBlockStateByWorldCoords(x, y, z);
		return _voxelResolveScratch;
	},
	{
		getFenceDynamicShape,
		getShapeForBlockId,
		isFenceBlockId,
		computeFenceNeighborMask,
	},
);

const debrisCollider = new VoxelAabbCollider(
	{ x: 1, y: 1, z: 1 },
	DEBRIS_BLOCK_SAMPLER,
	0.001,
);

// Block id -> atlas frame index, precomputed once. Reads typed arrays directly.
const blockFrameLUT = buildBlockFrameLUT();

function buildBlockFrameLUT(): Uint16Array {
	const count = BlockFaceTileX.length / FaceName.Count;
	const lut = new Uint16Array(count);
	for (let id = 0; id < count; id++) {
		const base = id * FaceName.Count + FaceName.All;
		const tx = BlockFaceTileX[base];
		const ty = BlockFaceTileY[base];
		// atlasSize may still be 0 at module init; fallback to 16 (matches atlasSize default)
		const size = atlasSize || 16;
		lut[id] = ty * size + tx;
	}
	return lut;
}

let billboard: FacingBillboardSpriteSystem | null = null;

export function play(
	position: Vec3,
	blockId: number,
	packedLight: number,
): void {
	if (!billboard) return;

	const frame = getBlockFrame(blockId);
	const light = computeLight(packedLight);

	spawnBurst(
		position.x,
		position.y,
		position.z,
		frame,
		light.r,
		light.g,
		light.b,
	);
}

/**
 * Bouncy debris kicked out of a broken block. Particles collide with the voxel
 * world (shape-aware: slabs/stairs/fences), bounce with restitution, and settle
 * to rest on surfaces where they fade out. `x/y/z` is the broken block center.
 */
export function playDebris(
	x: number,
	y: number,
	z: number,
	blockId: number,
	packedLight: number,
): void {
	if (!billboard) return;

	const frame = getBlockFrame(blockId);
	const light = computeLight(packedLight);

	spawnDebrisBurst(x, y, z, frame, light.r, light.g, light.b);
}

/**
 * Sparks that pop out of the block face while it is being mined. Emission is
 * throttled internally, so the caller may call this every frame. `x/y/z` is the
 * face center (block center + normal * 0.5) and `nx/ny/nz` the face normal.
 */
export function playMining(
	x: number,
	y: number,
	z: number,
	nx: number,
	ny: number,
	nz: number,
	blockId: number,
): void {
	if (!billboard) return;

	const now = performance.now();
	if (now - lastMiningEmitMs < MINING_PARTICLE_INTERVAL_MS) return;
	lastMiningEmitMs = now;

	const frame = getBlockFrame(blockId);

	// Sample light one more half-block out along the normal: `x/y/z` is the
	// face boundary, which floors into the mined (solid) block for half of the
	// faces — that voxel stores no light, so particles came out black there.
	// `face center + normal * 0.5` lands in the adjacent air block, which is
	// lit, for every face (same spot the block-break burst samples).
	const light = computeLight(
		getLightByWorldCoords(x + nx * 0.5, y + ny * 0.5, z + nz * 0.5),
	);
	const lr = light.r;
	const lg = light.g;
	const lb = light.b;

	for (let i = 0; i < MINING_PARTICLES_PER_EMIT; i++) {
		const jx = (getPRNGUnit2() - 0.5) * 0.5;
		const jy = (getPRNGUnit2() - 0.5) * 0.5;
		const jz = (getPRNGUnit2() - 0.5) * 0.5;
		const speed = 0.5 + getPRNGUnit2();
		addParticle(
			x + jx,
			y + jy,
			z + jz,
			nx * speed + jx * 0.6,
			ny * speed + 0.35 + jy * 0.6,
			nz * speed + jz * 0.6,
			0.3 + getPRNGUnit2() * 0.25,
			0.04 + getPRNGUnit2() * 0.03,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr,
			lg,
			lb,
			1,
			0.6,
		);
	}
}
export function playArrowHit(
	x: number,
	y: number,
	z: number,
	nx: number,
	ny: number,
	nz: number,
	blockId: number,
): void {
	if (!billboard) return;

	const now = performance.now();
	if (now - lastArrowHitEmitMs < ARROW_PARTICLE_INTERVAL_MS) return;
	lastArrowHitEmitMs = now;

	const frame = getBlockFrame(blockId);

	// Sample light one more half-block out along the normal: `x/y/z` is the
	// face boundary, which floors into the mined (solid) block for half of the
	// faces — that voxel stores no light, so particles came out black there.
	// `face center + normal * 0.5` lands in the adjacent air block, which is
	// lit, for every face (same spot the block-break burst samples).
	const light = computeLight(
		getLightByWorldCoords(x + nx * 0.5, y + ny * 0.5, z + nz * 0.5),
	);
	const lr = light.r;
	const lg = light.g;
	const lb = light.b;
	let life = 0.4 + getPRNGUnit2();

	for (let i = 0; i < ARROW_PARTICLES_PER_EMIT; i++) {
		const jx = (getPRNGUnit2() - 0.25) * 0.25;
		const jy = (getPRNGUnit2() - 0.3) * 0.3;
		const jz = (getPRNGUnit2() - 0.25) * 0.25;
		const speed = 0.66 + getPRNGUnit2();
		life += 0.1;
		addParticle(
			x + jx,
			y + jy,
			z + jz,
			nx * speed + jx * 0.6,
			ny * speed + 0.35 + jy * 0.6,
			nz * speed + jz * 0.6,
			life,
			0.04 + getPRNGUnit2() * 0.03,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr,
			lg,
			lb,
			1,
			0.5,
		);
		addParticle(
			x + jx,
			y + jy,
			z + jz,
			nx * speed + jx * 0.6,
			ny * speed + 0.35 + jy * 0.6,
			nz * speed + jz * 0.6,
			life,
			0.04 + getPRNGUnit2() * 0.03,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr,
			lg,
			lb,
			1,
			0.5,
			1,
		);
	}
}

/**
 * Slow red trickle from a wound — spawns droplets at the given point.
 * Stateless by design: the CALLER throttles per emitter (each stuck arrow
 * keeps its own timer against MOB_DRIP_INTERVAL_MS), so any number of wounded
 * mobs can drip at the same time. `x/y/z` is the arrow tip. Drips fall under
 * gravity, collide with the voxel world and settle briefly before fading.
 *
 * @param damage Dealt per emit — scales the number of droplets so harder
 *   hits bleed more. Defaults to 1 (base MOB_DRIPS_PER_EMIT droplets).
 */
export function playMobDrip(
	x: number,
	y: number,
	z: number,
	damage = 0.5,
): void {
	if (!billboard) return;

	const frame = getBlockFrame(MOB_BLOOD_BLOCK);
	const light = computeLight(getLightByWorldCoords(x, y - 0.25, z));
	const bloodR = light.r * 1.0;
	const bloodG = light.g * 0.3;
	const bloodB = light.b * 0.24;
	// Scale particle count with damage, clamped to a sane range.
	const count = Math.min(
		MOB_DRIPS_PER_EMIT,
		Math.max(1, Math.round(MOB_DRIPS_PER_EMIT * Math.max(0, damage))),
	);

	let life = 10.33 + getPRNGUnit2();
	for (let i = 0; i < count; i++) {
		life += 0.1;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.1,
			y + (getPRNGUnit2() - 0.5) * 0.1,
			z + (getPRNGUnit2() - 0.5) * 0.1,
			(getPRNGUnit2() - 0.5) * 0.4,
			getPRNGUnit2() * 2,
			(getPRNGUnit2() - 0.5) * 0.4,
			life,
			0.04 + getPRNGUnit2() * 0.02,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 2,
			frame,
			bloodR,
			bloodG,
			bloodB,
			1,
			1,
			1,
		);
	}
}

/** Short blood burst when a mob takes direct damage. */
export function playMobDamage(
	x: number,
	y: number,
	z: number,
	damage: number,
): void {
	if (!billboard || !Number.isFinite(damage) || damage <= 0) return;

	const frame = getBlockFrame(MOB_BLOOD_BLOCK);
	const light = computeLight(getLightByWorldCoords(x, y, z));
	// Use a dedicated red atlas tile for the initial hit burst and reinforce it
	// with a blood-red tint so it cannot look like the coral drip effect.
	const bloodR = light.r * 1.0;
	const bloodG = light.g * 0.3;
	const bloodB = light.b * 0.24;
	const count = Math.min(
		MOB_DAMAGE_PARTICLES_MAX,
		Math.max(
			MOB_DAMAGE_PARTICLES_MIN,
			Math.ceil(damage * MOB_DAMAGE_PARTICLES_PER_POINT),
		),
	);

	for (let i = 0; i < count; i++) {
		const angle = getPRNGUnit2() * Math.PI * 2;
		const speed = 0.25 + getPRNGUnit2() * 0.65;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.18,
			y + (getPRNGUnit2() - 0.5) * 0.22,
			z + (getPRNGUnit2() - 0.5) * 0.18,
			Math.cos(angle) * speed,
			0.45 + getPRNGUnit2() * 1.1,
			Math.sin(angle) * speed,
			0.3 + getPRNGUnit2() * 0.45,
			0.035 + getPRNGUnit2() * 0.025,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 3,
			frame,
			bloodR,
			bloodG,
			bloodB,
			1,
			1,
			1,
		);
	}
}

/**
 * Footstep dust kicked up behind a sprinting player. `x/y/z` is the feet
 * position and `velX/velZ` the world-space horizontal movement vector; dust
 * drifts opposite to it.
 */
export function playSprint(
	emitter: SprintEmitterState,
	x: number,
	y: number,
	z: number,
	velX: number,
	velZ: number,
): void {
	if (!billboard) return;

	const now = performance.now();
	if (now - emitter.lastSprintEmitMs < SPRINT_PARTICLE_INTERVAL_MS) return;

	// Dust picks up the block underfoot: frame + tint come from the ground
	// block at the feet, so it changes with the terrain instead of always
	// showing the same tile. No block underfoot (air / unloaded chunk) means
	// no dust — e.g. while falling or flying over open air.
	const groundBlockId = getBlockByWorldCoords(
		Math.floor(x),
		Math.floor(y - 0.05),
		Math.floor(z),
	);
	if (groundBlockId === 0) return;
	const frame = getBlockFrame(groundBlockId);
	const light = computeLight(getLightByWorldCoords(x, y, z));
	const lr = light.r;
	const lg = light.g;
	const lb = light.b;

	emitter.lastSprintEmitMs = now;

	const speed = Math.max(0.0001, Math.hypot(velX, velZ));
	const dirX = velX / speed;
	const dirZ = velZ / speed;

	const count = SPRINT_PARTICLES_PER_EMIT + Math.floor(getPRNGUnit2() * 2);
	for (let i = 0; i < count; i++) {
		const shade = 0.8 + getPRNGUnit2() * 0.2;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.5,
			y + 0.12,
			z + (getPRNGUnit2() - 0.5) * 0.5,
			-dirX * (0.4 + getPRNGUnit2() * 0.7) + (getPRNGUnit2() - 0.5) * 0.4,
			0.34,
			-dirZ * (0.4 + getPRNGUnit2() * 0.7) + (getPRNGUnit2() - 0.5) * 0.4,
			0.35 + getPRNGUnit2() * 0.3,
			0.1,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr * shade,
			lg * shade,
			lb * shade,
			1.0,
			0.08,
		);
	}
}

/**
 * Landing dust kicked up when a mob hits the ground after a fall. `x/y/z` is
 * the landing point (physical ground contact); particle count scales with fall
 * distance so harder landings throw up more dust. The particles use the tile
 * and lighting of the block that was actually hit.
 */
export function playLandingDust(
	x: number,
	y: number,
	z: number,
	fallDistance: number,
): void {
	if (!billboard || !Number.isFinite(fallDistance) || fallDistance <= 0) return;

	// `y` is the physical contact height. Sample the voxel immediately below
	// it so the puff uses the block that was actually hit, not a hard-coded
	// atlas tile (and never accidentally samples air at the surface boundary).
	let groundBlockId = getBlockByWorldCoords(
		Math.floor(x),
		Math.floor(y - 0.05),
		Math.floor(z),
	);
	if (!isCollidableBlock(groundBlockId)) {
		// Pass-through cover (tall grass, snow layers) or a fall that
		// outran chunk streaming — the collider treats unloaded chunks as
		// solid, so the landing is real but the query reads air. Scan down
		// for the first solid block so the puff still matches the terrain;
		// with nothing loaded yet, fall back to generic dust instead of
		// silently emitting nothing.
		groundBlockId = 0;
		const groundY = Math.floor(y - 0.05);
		for (let d = 1; d <= 6; d++) {
			const id = getBlockByWorldCoords(
				Math.floor(x),
				groundY - d,
				Math.floor(z),
			);
			if (isCollidableBlock(id)) {
				groundBlockId = id;
				break;
			}
		}
		if (groundBlockId === 0) groundBlockId = BlockType.GravellySand;
	}

	const frame = getBlockFrame(groundBlockId);
	const light = computeLight(getLightByWorldCoords(x, y + 0.05, z));
	const shade = 0.85 + getPRNGUnit2() * 0.15;
	const lr = light.r * shade;
	const lg = light.g * shade;
	const lb = light.b * shade;

	// Scale particle count with fall distance: a 3-block fall makes a small
	// puff, a 20-block drop kicks up a big cloud. Clamped to the pool.
	const count = Math.min(
		PARTICLES_PER_BREAK,
		Math.max(8, Math.round(fallDistance * 12)),
	);

	// Clamp the fall distance driving initial speeds: count already caps at
	// 198, so unbounded speeds would spread very high falls over a huge disc
	// that disperses in under a second and reads as no particles. Capped
	// falls still render as a big dense lingering cloud.
	const speedFall = Math.min(fallDistance, 12);

	for (let i = 0; i < count; i++) {
		const angle = getPRNGUnit2() * Math.PI * 2;
		const outSpeed = 0.3 + getPRNGUnit2() * (0.4 + speedFall * 0.15);
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.6,
			y + 0.025,
			z + (getPRNGUnit2() - 0.5) * 0.6,
			Math.cos(angle) * outSpeed,
			0.4 + getPRNGUnit2() * (0.6 + speedFall * 0.1),
			Math.sin(angle) * outSpeed,
			0.4 + getPRNGUnit2() * 0.4,
			0.08 + getPRNGUnit2() * 0.06,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr,
			lg,
			lb,
			1.0,
			0.1,
		);
	}
}

/**
 * Explicit one-time init, awaited by TestScene after scene registration.
 * Registers the per-frame tick, loads the block atlas, and builds the
 * billboard system. Until this resolves, every play* call is a no-op.
 */
export async function initBlockBreakParticles(
	scene: SceneContext,
): Promise<void> {
	onBeforeRender(scene, tick);

	try {
		const texture = await loadTexture2D(scene.surface.engine, ATLAS_URL, {
			mipMaps: false,
			magFilter: "nearest",
			minFilter: "nearest",
			invertY: false,
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		if (!texture) return;

		const atlas = createGridSpriteAtlas(texture, {
			cellWidthPx: tileSize,
			cellHeightPx: tileSize,
		});
		const system = createFacingBillboardSystem(atlas, {
			capacity: POOL_SIZE,
			blendMode: billboardBlendAlpha,
		});
		addFacingBillboardSystem(scene, system);

		// `addFacingBillboardSystem` registers a deferred renderable builder
		// that Lite only flushes during `buildScene` (at scene registration).
		// Init runs right after `registerScene`, so flush the builder here or
		// the billboard never gets a GPU renderable.
		await flushDeferredRenderables(scene);

		billboard = system;
	} catch (error: unknown) {
		console.warn("[BlockBreakParticles] failed to initialise:", error);
	}
}

function flushDeferredRenderables(scene: SceneContext): Promise<void> {
	const ctx = scene as unknown as {
		_deferredBuilders?: Array<() => Promise<void>>;
		_renderables?: Array<{ order: number }>;
		_renderableVersion?: number;
	};
	const builders = ctx._deferredBuilders?.splice(0) ?? [];
	return Promise.all(builders.map((build) => build())).then(() => {
		ctx._renderables?.sort((a, b) => a.order - b.order);
		if (ctx._renderableVersion !== undefined) ctx._renderableVersion++;
	});
}

function tick(deltaMs: number): void {
	const system = billboard;
	if (!system) return;

	const dt = Math.min(MAX_DT, deltaMs * 0.001);
	if (dt <= 0 || isUiOpen(UiFocus.pauseMenu)) return;

	clearBillboardSprites(system);

	const gravityDt = GRAVITY * dt;

	for (let i = 0; i < aliveCount; i++) {
		const flags = pflags[i];

		if (flags & COLLIDE_BIT) {
			if (!(flags & SETTLED_BIT)) {
				collideParticle(i, dt);
			}
		} else {
			pvy[i] += gravityDt * pgrav[i];
			px[i] += pvx[i] * dt;
			py[i] += pvy[i] * dt;
			pz[i] += pvz[i] * dt;
		}

		const age = page[i] + dt;
		page[i] = age;

		if (!(pflags[i] & SETTLED_BIT)) {
			pangle[i] += pspin[i] * dt;
		}

		const life = plife[i];
		if (age >= life) {
			removeParticle(i);

			// Do not increment i. removeParticle swapped the final live
			// particle into this slot, so that particle must be processed.
			continue;
		}

		let alpha = pa[i];
		const fadeStartAge = life * FADE_START;

		if (age > fadeStartAge) {
			alpha *= (life - age) / (life - fadeStartAge);
		}

		scratchPos[0] = px[i];
		scratchPos[1] = py[i];
		scratchPos[2] = pz[i];

		const size = psize[i];
		scratchSize[0] = size;
		scratchSize[1] = size;

		scratchColor[0] = pr[i];
		scratchColor[1] = pg[i];
		scratchColor[2] = pb[i];
		scratchColor[3] = alpha;

		scratchProps.rotation = pangle[i];
		scratchProps.frame = pframe[i];

		addBillboardSpriteIndex(system, scratchProps);
	}
}

function spawnBurst(
	x: number,
	y: number,
	z: number,
	frame: number,
	r: number,
	g: number,
	b: number,
): void {
	for (let i = 0; i < PARTICLES_PER_BREAK; i++) {
		const shade = 0.7 + getPRNGUnit2() * 0.3;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.8,
			y + (getPRNGUnit2() - 0.5) * 0.8,
			z + (getPRNGUnit2() - 0.5) * 0.8,
			(getPRNGUnit2() - 0.5) * 2.8,
			getPRNGUnit2() * 4.0,
			(getPRNGUnit2() - 0.5) * 2.8,
			0.75 + getPRNGUnit2() * 0.9,
			0.053 + getPRNGUnit2() * 0.08,
			getPRNGUnit2(),
			getPRNGUnit2() - 0.5,
			frame,
			r * shade,
			g * shade,
			b * shade,
			1,
			1,
		);
	}
}

function spawnDebrisBurst(
	x: number,
	y: number,
	z: number,
	frame: number,
	r: number,
	g: number,
	b: number,
): void {
	for (let i = 0; i < DEBRIS_PER_BREAK; i++) {
		const shade = 0.8 + getPRNGUnit2() * 0.25;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.8,
			y + 0.15,
			z + (getPRNGUnit2() - 0.5) * 0.8,
			(getPRNGUnit2() - 0.5) * 2.2,
			1.4 + getPRNGUnit2() * 2.2,
			(getPRNGUnit2() - 0.5) * 2.2,
			1.3 + getPRNGUnit2() * 1.2,
			0.06 + getPRNGUnit2() * 0.07,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 3,
			frame,
			r * shade,
			g * shade,
			b * shade,
			1,
			1,
			1,
		);
	}
}

/** Integrates a colliding particle through voxel collision, axis by axis. */
function collideParticle(i: number, dt: number): void {
	pvy[i] += GRAVITY * dt * pgrav[i];

	const half = psize[i] * DEBRIS_RADIUS_SCALE;
	scratchDebrisHalf.x = half;
	scratchDebrisHalf.y = half;
	scratchDebrisHalf.z = half;

	moveDebrisAxis(i, 0, pvx[i] * dt);
	moveDebrisAxis(i, 1, pvy[i] * dt);
	moveDebrisAxis(i, 2, pvz[i] * dt);
}

/**
 * Sweep one axis for a colliding particle. On hit, the particle is left at the
 * contact point and `onDebrisHit` bounces or settles velocity along that axis.
 */
function moveDebrisAxis(i: number, axis: number, delta: number): void {
	if (delta === 0) return;

	const dir = delta > 0 ? 1 : -1;
	let remaining = Math.abs(delta);

	const pos = scratchDebrisPos;
	while (remaining > 1e-8) {
		const step =
			remaining > DEBRIS_COLLIDE_STEP ? DEBRIS_COLLIDE_STEP : remaining;
		const move = step * dir;

		pos.x = px[i];
		pos.y = py[i];
		pos.z = pz[i];
		if (axis === 0) pos.x += move;
		else if (axis === 1) pos.y += move;
		else pos.z += move;

		if (debrisCollider.overlapsBox(pos, scratchDebrisHalf)) {
			onDebrisHit(i, axis, dir);
			return;
		}

		if (axis === 0) px[i] = pos.x;
		else if (axis === 1) py[i] = pos.y;
		else pz[i] = pos.z;

		remaining -= step;
	}
}

/** Reflect or zero velocity on the axis that just hit a block. */
function onDebrisHit(i: number, axis: number, dir: number): void {
	if (axis === 1) {
		if (dir < 0 && -pvy[i] > DEBRIS_SETTLE_SPEED) {
			pvy[i] = -pvy[i] * DEBRIS_RESTITUTION;
		} else {
			pvy[i] = 0;
			if (dir < 0) pflags[i] |= SETTLED_BIT;
		}
		return;
	}

	const v = axis === 0 ? pvx[i] : pvz[i];
	if (Math.abs(v) > DEBRIS_SETTLE_SPEED * 1.4) {
		const bounced = -v * DEBRIS_RESTITUTION;
		if (axis === 0) pvx[i] = bounced;
		else pvz[i] = bounced;
	} else {
		if (axis === 0) pvx[i] = 0;
		else pvz[i] = 0;
	}
}

function addParticle(
	x: number,
	y: number,
	z: number,
	vx: number,
	vy: number,
	vz: number,
	life: number,
	size: number,
	angle: number,
	spin: number,
	frame: number,
	r: number,
	g: number,
	b: number,
	a: number,
	gravityScale: number,
	collide: 0 | 1 = 0,
): void {
	if (aliveCount >= POOL_SIZE) return;
	const i = aliveCount++;
	px[i] = x;
	py[i] = y;
	pz[i] = z;
	pvx[i] = vx;
	pvy[i] = vy;
	pvz[i] = vz;
	page[i] = 0;
	plife[i] = life;
	psize[i] = size;
	pangle[i] = angle;
	pspin[i] = spin;
	pframe[i] = frame;
	pr[i] = r;
	pg[i] = g;
	pb[i] = b;
	pa[i] = a;
	pgrav[i] = gravityScale;
	pflags[i] = collide;
}

/** Swap-remove: overwrites slot `i` with the last live particle and shrinks aliveCount. */
function removeParticle(i: number): void {
	const last = --aliveCount;
	if (i === last) return;
	px[i] = px[last];
	py[i] = py[last];
	pz[i] = pz[last];
	pvx[i] = pvx[last];
	pvy[i] = pvy[last];
	pvz[i] = pvz[last];
	page[i] = page[last];
	plife[i] = plife[last];
	psize[i] = psize[last];
	pangle[i] = pangle[last];
	pspin[i] = pspin[last];
	pframe[i] = pframe[last];
	pr[i] = pr[last];
	pg[i] = pg[last];
	pb[i] = pb[last];
	pa[i] = pa[last];
	pgrav[i] = pgrav[last];
	pflags[i] = pflags[last];
}

function getBlockFrame(blockId: number): number {
	return blockFrameLUT[blockId] ?? 0;
}

function computeLight(packedLight: number): {
	r: number;
	g: number;
	b: number;
} {
	const skyLight = ((packedLight >> 4) & 0xf) / 15;
	const blockLight = (packedLight & 0xf) / 15;

	const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
	const sunLightIntensity = Math.min(1.0, Math.max(0.0, sunElevation * 4.0));
	const skyScale = sunLightIntensity + 0.3;

	const skyRGB = skyLight * 0.8 * skyScale;

	const blockR = blockLight * 0.9;
	const blockG = blockLight * 0.6;
	const blockB = blockLight * 0.2;

	scratchLight.r = Math.min(1, Math.max(0.2, skyRGB + blockR));
	scratchLight.g = Math.min(1, Math.max(0.2, skyRGB + blockG));
	scratchLight.b = Math.min(1, Math.max(0.2, skyRGB + blockB));
	return scratchLight;
}
