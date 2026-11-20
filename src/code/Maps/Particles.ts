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
import { FRAME_WORK_BUDGET } from "@/code/Lib/FrameWorkBudget";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import { getBlockAndStateByWorldCoordsInto } from "@/code/World/Chunk/ChunkLoadingSystem";
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
import { isCollidableBlock } from "@/code/World/Texture/BlockType";
import { tileSize } from "../World/Texture/TextureAtlasFactory";

const ATLAS_URL = "/texture/diffuse_atlas.png";
const POOL_SIZE = 8192;

const GRAVITY = -16;
const MAX_DT = 0.1;
const FADE_START = 0.85;
const FADE_RANGE = 1 - FADE_START;

const DEBRIS_RESTITUTION = 0.35;
// 0.25 stays below the thinnest collidable (fence arms/posts 0.25 wide,
// effective width larger with particle radius) so sweeps cannot tunnel,
// while needing ~40% fewer substeps than 0.15 for fast explosion debris.
const DEBRIS_COLLIDE_STEP = 0.25;
const DEBRIS_SETTLE_SPEED = 1.0;
const DEBRIS_RADIUS_SCALE = 0.4;
// Initial GPU billboard capacity. POOL_SIZE (particle pool) is unchanged —
// this only sizes the preallocated instance buffer. 16k holds 10k+ alive
// with headroom; the lite system grows (doubles) if chained blasts exceed it.
const BILLBOARD_INITIAL_CAPACITY = 16384;

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
// Precomputed fade curve per particle: fadeStartAge = life * FADE_START,
// fadeInv = 1 / (life - fadeStartAge). Avoids a multiply per particle per
// frame (and a divide while fading) in tick.
const pFadeStart = new Float32Array(POOL_SIZE);
const pFadeInv = new Float32Array(POOL_SIZE);
const pframe = new Uint16Array(POOL_SIZE);
/** bit0 = collide (routes through voxel collision in tick), bit1 = settled. */
const pflags = new Uint8Array(POOL_SIZE);
const COLLIDE_BIT = 1;
const SETTLED_BIT = 2;

let aliveCount = 0;

/** Voxel collision sweeps performed during the most recent tick. */
let collisionQueries = 0;

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

// Scratch objects for debris collision sweeps (allocation-free).
const scratchDebrisPos: Vec3 = { x: 0, y: 0, z: 0 };
const scratchDebrisHalf: Vec3 = { x: 0, y: 0, z: 0 };

// Shared shape-aware voxel sampler + stateless collider (DroppedItem pattern).
// The collider's fixed half-extents are never used; debris sweeps call
// `overlapsBox` with per-particle radii instead.
//
// Single-fetch: one chunk resolve for id+state instead of two
// (getBlock + getState each resolved the chunk). Identical shape/fence logic.
const DEBRIS_BLOCK_SAMPLER = createVoxelColliderBlockSampler(
	(x, y, z) => {
		getBlockAndStateByWorldCoordsInto(x, y, z, _voxelResolveScratch);
		if (!isCollidableBlock(_voxelResolveScratch.blockId)) return null;
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

let billboard: FacingBillboardSpriteSystem | null = null;

/**
 * Whether the billboard system has finished initialising. Until
 * `initBlockBreakParticles` resolves this is false and every emission path
 * (see PlayParticles) is a no-op.
 */
export function isParticlesReady(): boolean {
	return billboard !== null;
}

/** Unpacked colour triple, used by every emission path. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Live particle count, for budget decisions made by other systems. */
export function getAliveParticleCount(): number {
	return aliveCount;
}

/**
 * Voxel collision sweeps actually performed this frame.
 *
 * Kept distinct from `aliveParticleCount` because a saturated pool is a
 * different problem from expensive collision: the first is emission volume, the
 * second is simulation cost. HUD diagnostics read both.
 */
export function getParticleCollisionQueryCount(): number {
	return collisionQueries;
}

/**
 * Low-level pool push: insert one particle with explicit properties. All
 * higher-level emission paths (see PlayParticles) funnel through this.
 */
export function addParticle(
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

	/*
	 * Reject malformed particles before they enter the dense pool. A NaN life
	 * never satisfies `age >= life`, so without this guard it would occupy a
	 * pool slot permanently and send invalid values to the billboard system.
	 */
	if (
		!Number.isFinite(life) ||
		life <= 0 ||
		!Number.isFinite(size) ||
		size <= 0
	) {
		return;
	}

	const i = aliveCount++;

	px[i] = x;
	py[i] = y;
	pz[i] = z;

	pvx[i] = vx;
	pvy[i] = vy;
	pvz[i] = vz;

	page[i] = 0;
	plife[i] = life;

	const fadeDuration = life * FADE_RANGE;
	pFadeStart[i] = life - fadeDuration;
	pFadeInv[i] = 1 / fadeDuration;

	psize[i] = size;
	pangle[i] = angle;
	pspin[i] = spin;
	pframe[i] = frame;

	pr[i] = r;
	pg[i] = g;
	pb[i] = b;
	pa[i] = a;

	pgrav[i] = gravityScale;
	pflags[i] = collide === 1 ? COLLIDE_BIT : 0;
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
	pFadeStart[i] = pFadeStart[last];
	pFadeInv[i] = pFadeInv[last];
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
			capacity: BILLBOARD_INITIAL_CAPACITY,
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
		console.warn("[Particles] failed to initialise:", error);
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

	// Reset before the early returns so the diagnostic always reflects the last
	// completed tick rather than a stale count from whenever one last ran.
	collisionQueries = 0;

	if (system === null || aliveCount === 0) return;

	const dt = Math.min(MAX_DT, deltaMs * 0.001);
	if (!(dt > 0) || isUiOpen(UiFocus.pauseMenu)) return;

	clearBillboardSprites(system);

	const gravityDt = GRAVITY * dt;

	// Cache frequently used references and scratch values for the hot loop.
	const lpx = px;
	const lpy = py;
	const lpz = pz;
	const lpvx = pvx;
	const lpvy = pvy;
	const lpvz = pvz;
	const lpage = page;
	const lplife = plife;
	const lpsize = psize;
	const lpangle = pangle;
	const lpspin = pspin;
	const lpr = pr;
	const lpg = pg;
	const lpb = pb;
	const lpa = pa;
	const lpgrav = pgrav;
	const lFadeStart = pFadeStart;
	const lFadeInv = pFadeInv;
	const lframe = pframe;
	const lflags = pflags;

	const position = scratchPos;
	const sizeWorld = scratchSize;
	const color = scratchColor;
	const props = scratchProps;

	let i = 0;

	while (i < aliveCount) {
		const life = lplife[i];
		const age = lpage[i] + dt;

		if (age >= life) {
			/*
			 * Swap-removal puts an unprocessed particle into slot i, so do not
			 * increment i here.
			 */
			removeParticle(i);
			continue;
		}

		lpage[i] = age;

		let flags = lflags[i];

		if ((flags & COLLIDE_BIT) !== 0) {
			if ((flags & SETTLED_BIT) === 0) {
				if (FRAME_WORK_BUDGET.takeCollisionChecks()) {
					collideParticle(i, dt);
					collisionQueries++;

					// Collision may have settled the particle.
					flags = lflags[i];
				} else {
					// Budget exhausted: integrate without sweeping so the
					// particle still falls instead of hanging. Slightly wrong
					// for this one frame, which is far cheaper than the voxel
					// sweeps. The next frame retries and corrects.
					const vy = lpvy[i] + gravityDt * lpgrav[i];
					lpvy[i] = vy;
					lpx[i] += lpvx[i] * dt;
					lpy[i] += vy * dt;
					lpz[i] += lpvz[i] * dt;
				}
			}
		} else {
			const vy = lpvy[i] + gravityDt * lpgrav[i];

			lpvy[i] = vy;
			lpx[i] += lpvx[i] * dt;
			lpy[i] += vy * dt;
			lpz[i] += lpvz[i] * dt;
		}

		if ((flags & SETTLED_BIT) === 0) {
			const spin = lpspin[i];

			if (spin !== 0) {
				lpangle[i] += spin * dt;
			}
		}

		let alpha = lpa[i];
		const fadeStart = lFadeStart[i];

		if (age > fadeStart) {
			alpha *= (life - age) * lFadeInv[i];

			// Protect the renderer from minor floating-point undershoot.
			if (alpha <= 0) {
				i++;
				continue;
			}
		}

		position[0] = lpx[i];
		position[1] = lpy[i];
		position[2] = lpz[i];

		const particleSize = lpsize[i];
		sizeWorld[0] = particleSize;
		sizeWorld[1] = particleSize;

		color[0] = lpr[i];
		color[1] = lpg[i];
		color[2] = lpb[i];
		color[3] = alpha;

		props.rotation = lpangle[i];
		props.frame = lframe[i];

		addBillboardSpriteIndex(system, props);
		i++;
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
