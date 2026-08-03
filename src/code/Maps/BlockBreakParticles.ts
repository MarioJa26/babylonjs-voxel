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
	type Texture2D,
	type Vec3,
} from "@babylonjs/lite";
import { isUiOpen, UiFocus } from "@/code/Lib/GameRuntimeState";
import {
	getBlockByWorldCoords,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { getPRNGUnit2 } from "../Generation/NoiseAndParameters/Squirrel13";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { BlockTextures } from "../World/Texture/BlockTextures";
import { FaceName } from "../World/Texture/FaceName";
import { atlasSize, tileSize } from "../World/Texture/TextureAtlasFactory";

const ATLAS_URL = "/texture/diffuse_atlas.png";
const POOL_SIZE = 2048;
const PARTICLES_PER_BREAK = 222;
const MINING_PARTICLES_PER_EMIT = 5;
const MINING_PARTICLE_INTERVAL_MS = 60;
const SPRINT_PARTICLES_PER_EMIT = 5;
const SPRINT_PARTICLE_INTERVAL_MS = 130;
const GRAVITY = -16;
const MAX_DT = 0.1;
const FADE_START = 0.85;
const MAX_PENDING_BURSTS = 8;
let lastMiningEmitMs = 0;
let lastSprintEmitMs = 0;

type Particle = {
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	age: number;
	life: number;
	size: number;
	angle: number;
	spin: number;
	frame: number;
	r: number;
	g: number;
	b: number;
	a: number;
	gravityScale: number;
};

type PendingBurst = {
	x: number;
	y: number;
	z: number;
	frame: number;
	r: number;
	g: number;
	b: number;
};

const alive: Particle[] = [];
const free: Particle[] = [];
const pendingBursts: PendingBurst[] = [];

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

let initScene: SceneContext | null = null;
let billboard: FacingBillboardSpriteSystem | null = null;
let ready = false;

export function play(
	scene: SceneContext,
	position: Vec3,
	blockId: number,
	packedLight: number,
) {
	ensureInit(scene);

	const frame = getBlockFrame(blockId);
	const light = computeLight(packedLight);

	if (ready) {
		spawnBurst(
			position.x,
			position.y,
			position.z,
			frame,
			light.r,
			light.g,
			light.b,
		);
	} else if (pendingBursts.length < MAX_PENDING_BURSTS) {
		pendingBursts.push({
			x: position.x,
			y: position.y,
			z: position.z,
			frame,
			r: light.r,
			g: light.g,
			b: light.b,
		});
	}
}

/**
 * Sparks that pop out of the block face while it is being mined. Emission is
 * throttled internally, so the caller may call this every frame. `x/y/z` is the
 * face center (block center + normal * 0.5) and `nx/ny/nz` the face normal.
 */
export function playMining(
	scene: SceneContext,
	x: number,
	y: number,
	z: number,
	nx: number,
	ny: number,
	nz: number,
	blockId: number,
): void {
	ensureInit(scene);
	if (!ready) return;

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
			light.r,
			light.g,
			light.b,
			1,
			0.6,
		);
	}
}

/**
 * Footstep dust kicked up behind a sprinting player. `x/y/z` is the feet
 * position and `velX/velZ` the world-space horizontal movement vector; dust
 * drifts opposite to it.
 */
export function playSprint(
	scene: SceneContext,
	x: number,
	y: number,
	z: number,
	velX: number,
	velZ: number,
): void {
	ensureInit(scene);
	if (!ready) return;

	const now = performance.now();
	if (now - lastSprintEmitMs < SPRINT_PARTICLE_INTERVAL_MS) return;

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

	lastSprintEmitMs = now;

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
			light.r * shade,
			light.g * shade,
			light.b * shade,
			1.0,
			0.08,
		);
	}
}

function ensureInit(scene: SceneContext): void {
	if (initScene) return;
	initScene = scene;
	onBeforeRender(scene, tick);

	void loadTexture2D(scene.surface.engine, ATLAS_URL, {
		mipMaps: false,
		magFilter: "nearest",
		minFilter: "nearest",
		invertY: false,
		addressModeU: "clamp-to-edge",
		addressModeV: "clamp-to-edge",
	})
		.then((texture: Texture2D | null) => setup(texture))
		.catch((error: unknown) => {
			console.warn("[BlockBreakParticles] failed to load atlas:", error);
		});
}

async function setup(texture: Texture2D | null): Promise<void> {
	if (!texture) return;

	const atlas = createGridSpriteAtlas(texture, {
		cellWidthPx: tileSize,
		cellHeightPx: tileSize,
	});
	billboard = createFacingBillboardSystem(atlas, {
		capacity: POOL_SIZE,
		blendMode: billboardBlendAlpha,
	});
	addFacingBillboardSystem(initScene!, billboard);

	// `addFacingBillboardSystem` registers a deferred renderable builder that
	// Lite only flushes during `buildScene` (at scene registration). The scene
	// is long registered by the time the first block breaks, so flush the
	// builder ourselves or the billboard never gets a GPU renderable.
	try {
		await flushDeferredRenderables(initScene!);
	} catch {
		return;
	}
	ready = true;

	for (const burst of pendingBursts) {
		spawnBurst(
			burst.x,
			burst.y,
			burst.z,
			burst.frame,
			burst.r,
			burst.g,
			burst.b,
		);
	}
	pendingBursts.length = 0;
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
	if (!billboard) return;

	const dt = Math.min(MAX_DT, deltaMs * 0.001);
	if (dt <= 0) return;
	if (isUiOpen(UiFocus.pauseMenu)) return;

	const gravityDt = GRAVITY * dt;
	for (let i = 0; i < alive.length; i++) {
		const p = alive[i];
		p.vy += gravityDt * p.gravityScale;
		p.x += p.vx * dt;
		p.y += p.vy * dt;
		p.z += p.vz * dt;
		p.age += dt;
		p.angle += p.spin * dt;
		if (p.age >= p.life) {
			alive[i] = alive[alive.length - 1];
			alive.pop();
			free.push(p);
			i--;
		}
	}

	clearBillboardSprites(billboard);
	for (let i = 0; i < alive.length; i++) {
		const p = alive[i];
		const lifeFrac = p.age / p.life;
		const alpha =
			lifeFrac > FADE_START
				? 1 - (lifeFrac - FADE_START) / (1 - FADE_START)
				: 1;
		scratchPos[0] = p.x;
		scratchPos[1] = p.y;
		scratchPos[2] = p.z;
		scratchSize[0] = p.size;
		scratchSize[1] = p.size;
		scratchColor[0] = p.r;
		scratchColor[1] = p.g;
		scratchColor[2] = p.b;
		scratchColor[3] = alpha * p.a;
		scratchProps.rotation = p.angle;
		scratchProps.frame = p.frame;
		addBillboardSpriteIndex(billboard, scratchProps);
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
): void {
	if (alive.length >= POOL_SIZE) return;
	const p = free.pop() ?? createParticle();
	p.x = x;
	p.y = y;
	p.z = z;
	p.vx = vx;
	p.vy = vy;
	p.vz = vz;
	p.age = 0;
	p.life = life;
	p.size = size;
	p.angle = angle;
	p.spin = spin;
	p.frame = frame;
	p.r = r;
	p.g = g;
	p.b = b;
	p.a = a;
	p.gravityScale = gravityScale;
	alive.push(p);
}

function createParticle(): Particle {
	return {
		x: 0,
		y: 0,
		z: 0,
		vx: 0,
		vy: 0,
		vz: 0,
		age: 0,
		life: 1,
		size: 0.1,
		angle: 0,
		spin: 0,
		frame: 0,
		r: 1,
		g: 1,
		b: 1,
		a: 1,
		gravityScale: 1,
	};
}

function getBlockFrame(blockId: number): number {
	const blockTex = BlockTextures[blockId];
	if (!blockTex) return 0;
	const uv =
		blockTex[FaceName.All] ??
		blockTex[FaceName.Side] ??
		blockTex[FaceName.Top] ??
		blockTex[FaceName.Bottom] ??
		blockTex.find((tile) => tile !== undefined);
	if (!uv) return 0;
	return uv[1] * atlasSize + uv[0];
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

	const skyR = skyLight * 0.8 * skyScale;
	const skyG = skyLight * 0.8 * skyScale;
	const skyB = skyLight * 0.8 * skyScale;

	const blockR = blockLight * 0.9;
	const blockG = blockLight * 0.6;
	const blockB = blockLight * 0.2;

	return {
		r: Math.min(1, Math.max(0.2, skyR + blockR)),
		g: Math.min(1, Math.max(0.2, skyG + blockG)),
		b: Math.min(1, Math.max(0.2, skyB + blockB)),
	};
}
