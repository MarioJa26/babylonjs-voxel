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
const FADE_INV_RANGE = 1 / (1 - FADE_START);

const DEBRIS_RESTITUTION = 0.35;
const DEBRIS_COLLIDE_STEP = 0.25;
const DEBRIS_SETTLE_SPEED = 1.0;
const DEBRIS_SIDE_BOUNCE_SPEED = DEBRIS_SETTLE_SPEED * 1.4;
const DEBRIS_RADIUS_SCALE = 0.4;

const BILLBOARD_INITIAL_CAPACITY = 16384;

const COLLIDE_BIT = 1;
const SETTLED_BIT = 2;

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
const pFadeStart = new Float32Array(POOL_SIZE);
const pFadeInv = new Float32Array(POOL_SIZE);

const pframe = new Uint16Array(POOL_SIZE);
const pflags = new Uint8Array(POOL_SIZE);

let aliveCount = 0;
let collisionQueries = 0;

let billboard: FacingBillboardSpriteSystem | null = null;
let initialization: Promise<void> | null = null;
let tickRegistered = false;

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

const scratchDebrisPos: Vec3 = { x: 0, y: 0, z: 0 };
const scratchDebrisHalf: Vec3 = { x: 0, y: 0, z: 0 };

const DEBRIS_BLOCK_SAMPLER = createVoxelColliderBlockSampler(
	(x, y, z) => {
		getBlockAndStateByWorldCoordsInto(x, y, z, _voxelResolveScratch);

		if (!isCollidableBlock(_voxelResolveScratch.blockId)) {
			return null;
		}

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

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

export function isParticlesReady(): boolean {
	return billboard !== null;
}

export function getAliveParticleCount(): number {
	return aliveCount;
}

export function getParticleCollisionQueryCount(): number {
	return collisionQueries;
}

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
	if (
		aliveCount >= POOL_SIZE ||
		life <= 0 ||
		size <= 0 ||
		!Number.isFinite(life) ||
		!Number.isFinite(size)
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

	const fadeDuration = life * (1 - FADE_START);
	pFadeStart[i] = life * FADE_START;
	pFadeInv[i] = FADE_INV_RANGE / life;

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

	// Retain the explicit value to make the fade relationship clear and guard
	// against accidental constant changes that produce a zero duration.
	if (fadeDuration <= 0) {
		pFadeInv[i] = 0;
	}
}

function removeParticle(i: number): void {
	const last = aliveCount - 1;
	aliveCount = last;

	if (i === last) {
		return;
	}

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

export function initBlockBreakParticles(scene: SceneContext): Promise<void> {
	if (billboard !== null) {
		return Promise.resolve();
	}

	if (initialization !== null) {
		return initialization;
	}

	if (!tickRegistered) {
		tickRegistered = true;
		onBeforeRender(scene, tick);
	}

	initialization = initializeBillboard(scene).finally(() => {
		/*
		 * Permit a retry after failure. Once successful, billboard itself
		 * prevents subsequent initialization.
		 */
		initialization = null;
	});

	return initialization;
}

async function initializeBillboard(scene: SceneContext): Promise<void> {
	try {
		const texture = await loadTexture2D(scene.surface.engine, ATLAS_URL, {
			mipMaps: false,
			magFilter: "nearest",
			minFilter: "nearest",
			invertY: false,
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		if (!texture) {
			return;
		}

		const atlas = createGridSpriteAtlas(texture, {
			cellWidthPx: tileSize,
			cellHeightPx: tileSize,
		});

		const system = createFacingBillboardSystem(atlas, {
			capacity: BILLBOARD_INITIAL_CAPACITY,
			blendMode: billboardBlendAlpha,
		});

		addFacingBillboardSystem(scene, system);
		await flushDeferredRenderables(scene);

		billboard = system;
	} catch (error: unknown) {
		console.warn("[Particles] failed to initialise:", error);
	}
}

function flushDeferredRenderables(scene: SceneContext): Promise<void> {
	const context = scene as unknown as {
		_deferredBuilders?: Array<() => Promise<void>>;
		_renderables?: Array<{ order: number }>;
		_renderableVersion?: number;
	};

	const builders = context._deferredBuilders;

	if (!builders || builders.length === 0) {
		return Promise.resolve();
	}

	const pending = builders.splice(0, builders.length);

	return Promise.all(pending.map(runDeferredBuilder)).then(() => {
		const renderables = context._renderables;

		if (renderables && renderables.length > 1) {
			renderables.sort(compareRenderableOrder);
		}

		if (context._renderableVersion !== undefined) {
			context._renderableVersion++;
		}
	});
}

function runDeferredBuilder(builder: () => Promise<void>): Promise<void> {
	return builder();
}

function compareRenderableOrder(
	a: { order: number },
	b: { order: number },
): number {
	return a.order - b.order;
}

function tick(deltaMs: number): void {
	collisionQueries = 0;

	const system = billboard;

	if (system === null || aliveCount === 0) {
		return;
	}

	const dt = Math.min(MAX_DT, deltaMs * 0.001);

	if (dt <= 0 || !Number.isFinite(dt) || isUiOpen(UiFocus.pauseMenu)) {
		return;
	}

	clearBillboardSprites(system);

	const gravityDt = GRAVITY * dt;

	let i = 0;

	while (i < aliveCount) {
		const life = plife[i];
		const age = page[i] + dt;

		if (age >= life) {
			removeParticle(i);
			continue;
		}

		page[i] = age;

		let flags = pflags[i];

		if ((flags & COLLIDE_BIT) !== 0 && (flags & SETTLED_BIT) === 0) {
			if (FRAME_WORK_BUDGET.takeCollisionChecks()) {
				collideParticle(i, dt);
				collisionQueries++;
				flags = pflags[i];
			} else {
				integrateParticle(i, dt, gravityDt);
			}
		} else if ((flags & COLLIDE_BIT) === 0) {
			integrateParticle(i, dt, gravityDt);
		}

		if ((flags & SETTLED_BIT) === 0) {
			const spin = pspin[i];

			if (spin !== 0) {
				pangle[i] += spin * dt;
			}
		}

		let alpha = pa[i];

		if (age > pFadeStart[i]) {
			alpha *= (life - age) * pFadeInv[i];

			if (alpha <= 0) {
				i++;
				continue;
			}
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
		i++;
	}
}

function integrateParticle(i: number, dt: number, gravityDt: number): void {
	const vy = pvy[i] + gravityDt * pgrav[i];

	pvy[i] = vy;

	px[i] += pvx[i] * dt;
	py[i] += vy * dt;
	pz[i] += pvz[i] * dt;
}

function collideParticle(i: number, dt: number): void {
	const vy = pvy[i] + GRAVITY * dt * pgrav[i];
	pvy[i] = vy;

	const half = psize[i] * DEBRIS_RADIUS_SCALE;

	scratchDebrisHalf.x = half;
	scratchDebrisHalf.y = half;
	scratchDebrisHalf.z = half;

	const dx = pvx[i] * dt;
	const dy = vy * dt;
	const dz = pvz[i] * dt;

	if (dx !== 0) {
		moveDebrisAxis(i, 0, dx);
	}

	if (dy !== 0) {
		moveDebrisAxis(i, 1, dy);
	}

	/*
	 * A downward Y collision may settle the particle. Horizontal movement is
	 * intentionally still processed to preserve the original axis ordering
	 * and final position.
	 */
	if (dz !== 0) {
		moveDebrisAxis(i, 2, dz);
	}
}

function moveDebrisAxis(i: number, axis: 0 | 1 | 2, delta: number): void {
	const direction = delta > 0 ? 1 : -1;
	let remaining = delta * direction;

	const pos = scratchDebrisPos;
	const half = scratchDebrisHalf;

	while (remaining > 1e-8) {
		const step =
			remaining > DEBRIS_COLLIDE_STEP ? DEBRIS_COLLIDE_STEP : remaining;

		const movement = step * direction;

		const currentX = px[i];
		const currentY = py[i];
		const currentZ = pz[i];

		pos.x = currentX;
		pos.y = currentY;
		pos.z = currentZ;

		if (axis === 0) {
			pos.x = currentX + movement;
		} else if (axis === 1) {
			pos.y = currentY + movement;
		} else {
			pos.z = currentZ + movement;
		}

		if (debrisCollider.overlapsBox(pos, half)) {
			onDebrisHit(i, axis, direction);
			return;
		}

		if (axis === 0) {
			px[i] = pos.x;
		} else if (axis === 1) {
			py[i] = pos.y;
		} else {
			pz[i] = pos.z;
		}

		remaining -= step;
	}
}

function onDebrisHit(i: number, axis: 0 | 1 | 2, direction: number): void {
	if (axis === 1) {
		const velocity = pvy[i];

		if (direction < 0 && -velocity > DEBRIS_SETTLE_SPEED) {
			pvy[i] = -velocity * DEBRIS_RESTITUTION;
		} else {
			pvy[i] = 0;

			if (direction < 0) {
				pflags[i] |= SETTLED_BIT;
			}
		}

		return;
	}

	if (axis === 0) {
		const velocity = pvx[i];

		pvx[i] =
			Math.abs(velocity) > DEBRIS_SIDE_BOUNCE_SPEED
				? -velocity * DEBRIS_RESTITUTION
				: 0;

		return;
	}

	const velocity = pvz[i];

	pvz[i] =
		Math.abs(velocity) > DEBRIS_SIDE_BOUNCE_SPEED
			? -velocity * DEBRIS_RESTITUTION
			: 0;
}
