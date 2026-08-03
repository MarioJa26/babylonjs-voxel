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
import { getPRNGUnit2 } from "../Generation/NoiseAndParameters/Squirrel13";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { BlockTextures } from "../World/Texture/BlockTextures";
import { FaceName } from "../World/Texture/FaceName";
import { atlasSize, tileSize } from "../World/Texture/TextureAtlasFactory";

const ATLAS_URL = "/texture/diffuse_atlas.png";
const POOL_SIZE = 1024;
const PARTICLES_PER_BREAK = 32;
const GRAVITY = -16;
const MAX_DT = 0.1;
const FADE_START = 0.85;
const MAX_PENDING_BURSTS = 8;

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
		p.vy += gravityDt;
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
		if (alive.length >= POOL_SIZE) break;
		const p = free.pop() ?? createParticle();
		p.x = x + (getPRNGUnit2() - 0.5) * 0.8;
		p.y = y + (getPRNGUnit2() - 0.5) * 0.8;
		p.z = z + (getPRNGUnit2() - 0.5) * 0.8;
		p.vx = (getPRNGUnit2() - 0.5) * 2.8;
		p.vy = getPRNGUnit2() * 4.0;
		p.vz = (getPRNGUnit2() - 0.5) * 2.8;
		p.age = 0;
		p.life = 0.75 + getPRNGUnit2() * 0.9;
		p.size = 0.053 + getPRNGUnit2() * 0.08;
		p.angle = getPRNGUnit2();
		p.spin = getPRNGUnit2() - 0.5;
		p.frame = frame;
		const shade = 0.7 + getPRNGUnit2() * 0.3;
		p.r = r * shade;
		p.g = g * shade;
		p.b = b * shade;
		p.a = 1;
		alive.push(p);
	}
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
