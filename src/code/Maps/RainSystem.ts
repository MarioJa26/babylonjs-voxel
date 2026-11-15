/**
 * Rain rendering.
 *
 * Falling rain is drawn as world-space, vertically locked billboard streaks that all come from
 * ONE instanced draw, so the effect costs a single draw call no matter how
 * many drops are on screen.
 *
 * Drop state lives in flat typed arrays, matching the BlockBreakParticles
 * convention: no per-drop objects, no per-frame allocation, and the collector
 * never has to trace the pool. The pool is a fixed-size ring of slots that
 * respawn in place — a drop that lands is recycled rather than removed, so
 * there is no free list to maintain.
 *
 * The active drop volume follows the camera, so rain surrounds the player
 * without needing a world-sized simulation. Drops keep their
 * WORLD positions while they fall — only their respawn is camera-relative —
 * so the rain does not appear to travel with the player.
 */
import {
	type AxisLockedBillboardSpriteSystem,
	addAxisLockedBillboardSystem,
	addBillboardSpriteIndex,
	billboardBlendAlpha,
	clearBillboardSprites,
	createAxisLockedBillboardSystem,
	createGridSpriteAtlas,
	createTexture2DFromPixels,
	type EngineContext,
	getCameraPosition,
	type SceneContext,
} from "@babylonjs/lite";
import { disposeRainAudio, updateRainAudio } from "../Audio/RainAudio";
import { rainExposureForSkyLight } from "../Audio/RainAudioMix";
import { isUiOpen, UiFocus } from "../Lib/GameRuntimeState";
import {
	getBlockByWorldCoords,
	getLightByWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { isCollidableBlock } from "../World/Texture/BlockType";
import { getEyeLiquid } from "./UnderWaterEffect";
import { WorldEnvironment } from "./WorldEnvironment";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Drops rendered at full rain intensity. */
const MAX_DROPS = 1600;

/** Streak width in metres. */
const DROP_WIDTH = 0.055;

/**
 * Streak length in metres.
 *
 * A drop travels `FALL_SPEED / 60` ≈ 0.37 m per frame at 60 Hz. The streak
 * has to be about twice as long as that or the rain strobes: each drop is
 * a single frame's position, not a continuous trail, so a streak shorter than
 * the per-frame travel reads as a string of separate dashes.
 */
const DROP_LENGTH = 0.72;

/** Fall speed in m/s. */
const FALL_SPEED = 22;

/** Per-drop speed spread, as a fraction of FALL_SPEED. */
const SPEED_JITTER = 0.2;

/** Half-extent of the drop volume around the camera, in metres. */
const BOX_HALF_XZ = 9;

/** Top of the drop volume, relative to the camera, in metres. */
const BOX_TOP = 8;

/** Bottom of the drop volume, relative to the camera, in metres. */
const BOX_BOTTOM = -6;

/** Fraction of a drop's life spent fading in and out. */
const EDGE_FADE = 0.12;

/** Distance at which a drop starts to fade out, in metres. */
const FADE_DISTANCE = 14;

/** Longest frame step the simulation accepts, in seconds. */
const MAX_DT = 0.1;

/** Streak texture: a 2x2 grid of soft vertical streaks, 32 px per cell. */
const TEX_CELL_PX = 32;
const TEX_GRID = 2;
const TEX_SIZE_PX = TEX_CELL_PX * TEX_GRID;

/** Streak tint: cool blue-gray, closer to Minecraft rain than white sparks. */
const DROP_RGB_R = 0.5;
const DROP_RGB_G = 0.64;
const DROP_RGB_B = 0.78;

// ---------------------------------------------------------------------------
// Drop pool (SoA / typed-array layout)
// ---------------------------------------------------------------------------

const px = new Float32Array(MAX_DROPS);
const py = new Float32Array(MAX_DROPS);
const pz = new Float32Array(MAX_DROPS);
const pvy = new Float32Array(MAX_DROPS);
const page = new Float32Array(MAX_DROPS);
const plife = new Float32Array(MAX_DROPS);
const pframe = new Uint8Array(MAX_DROPS);

/**
 * Per drop: 1 when the column it falls in can see the sky.
 *
 * Rain is a world effect, not a screen effect. It falls in every column
 * the sky can reach and stops at whatever it lands on, so a drop under a
 * roof belongs inside the building and is never drawn.
 */
const pexposed = new Uint8Array(MAX_DROPS);

/** Number of drops currently in the pool. */
let aliveCount = 0;

/** Camera position cached from the previous frame (for respawns). */
let camX = 0;
let camY = 0;
let camZ = 0;

/**
 * True while the rain is actually being rendered.
 *
 * The pool is re-seeded on the rising edge, so a shower that stops and
 * starts again does not resume with every drop frozen in one clump.
 */
let wasRaining = false;

let billboard: AxisLockedBillboardSpriteSystem | null = null;
let sceneRef: SceneContext | null = null;

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

/**
 * Local xorshift32.
 *
 * Deliberately NOT the shared terrain PRNG (`getPRNGUnit2`): rain must not
 * perturb the noise stream that generates terrain, or the same seed would
 * produce different worlds depending on whether it rained.
 */
let rngState = 0x1a2b3c4d;

function nextRandom(): number {
	let x = rngState;
	x ^= x << 13;
	x >>>= 0;
	x ^= x >> 17;
	x ^= x << 5;
	x >>>= 0;
	rngState = x;
	return x / 4294967296;
}

// ---------------------------------------------------------------------------
// Streak texture
// ---------------------------------------------------------------------------

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/**
 * Builds the rain streak texture.
 *
 * Generated on the CPU rather than shipped as an asset so the effect has no
 * load-time dependency and the variants stay in sync with the constants here.
 * Each cell holds one variant (different width and length) so the drops do
 * not all look identical.
 */
function buildRainTexture(): Uint8Array {
	const data = new Uint8Array(TEX_SIZE_PX * TEX_SIZE_PX * 4);

	for (let cellY = 0; cellY < TEX_GRID; cellY++) {
		for (let cellX = 0; cellX < TEX_GRID; cellX++) {
			const variant = cellY * TEX_GRID + cellX;

			// Variants 0/1 are narrow and long, 2/3 are wider and shorter.
			const edge = variant < 2 ? 0.58 : 0.68;
			const fade = variant < 2 ? 0.3 : 0.2;

			for (let py = 0; py < TEX_CELL_PX; py++) {
				for (let px = 0; px < TEX_CELL_PX; px++) {
					const u = (px + 0.5) / TEX_CELL_PX;
					const v = (py + 0.5) / TEX_CELL_PX;

					// Broad, almost rectangular cross-section with a soft edge.
					// This reads as a short rain strip rather than a white spark.
					const dx = (u - 0.5) * 2;
					const profile = 1 - smoothstep(edge, 1, Math.abs(dx));

					// Symmetric vertical falloff. Symmetric on purpose — the
					// atlas may flip V, and a head/tail gradient would end up
					// upside down when it does.
					const along =
						smoothstep(0, fade, v) * (1 - smoothstep(1 - fade, 1, v));

					const alpha = Math.max(0, Math.min(1, profile * along));

					const index =
						((cellY * TEX_CELL_PX + py) * TEX_SIZE_PX +
							cellX * TEX_CELL_PX +
							px) *
						4;

					data[index] = 255;
					data[index + 1] = 255;
					data[index + 2] = 255;
					data[index + 3] = Math.round(alpha * 255);
				}
			}
		}
	}

	return data;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Build the rain streak texture and register the billboard system.
 *
 * MUST run BEFORE `registerScene`: `addAxisLockedBillboardSystem` uses the
 * scene's deferred-renderable hook, and `registerScene` is what builds it.
 * Calling it later leaves the system without a GPU renderable.
 */
export function initRain(engine: EngineContext, scene: SceneContext): void {
	sceneRef = scene;

	try {
		const texture = createTexture2DFromPixels(
			engine,
			buildRainTexture(),
			TEX_SIZE_PX,
			TEX_SIZE_PX,
			{
				// Linear filtering: the streaks are thin, and nearest
				// sampling turns them into crawling stair-steps.
				minFilter: "linear",
				magFilter: "linear",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		);

		const atlas = createGridSpriteAtlas(texture, {
			cellWidthPx: TEX_CELL_PX,
			cellHeightPx: TEX_CELL_PX,
		});

		const system = createAxisLockedBillboardSystem(atlas, [0, 1, 0], {
			capacity: MAX_DROPS,
			blendMode: billboardBlendAlpha,
		});

		system.visible = false;

		addAxisLockedBillboardSystem(scene, system);
		billboard = system;
	} catch (error: unknown) {
		console.warn("[RainSystem] failed to initialise:", error);
	}
}

/** Release the rain system. Safe to call when it was never initialised. */
export function disposeRain(): void {
	billboard = null;
	sceneRef = null;
	aliveCount = 0;
	wasRaining = false;
	disposeRainAudio();
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function respawnDrop(i: number): void {
	const speed =
		FALL_SPEED * (1 - SPEED_JITTER + nextRandom() * SPEED_JITTER * 2);

	px[i] = camX + (nextRandom() * 2 - 1) * BOX_HALF_XZ;
	py[i] = camY + BOX_TOP;
	pz[i] = camZ + (nextRandom() * 2 - 1) * BOX_HALF_XZ;

	pvy[i] = speed;
	page[i] = 0;
	plife[i] = (BOX_TOP - BOX_BOTTOM) / speed;
	pframe[i] = Math.floor(nextRandom() * 4) & 3;

	/*
	 * Whether this column can see the sky.
	 *
	 * Tested where the drop starts, at the top of the volume: a column
	 * blocked up there is under a roof, and its rain belongs inside the
	 * building rather than falling on it. A drop that starts in the open
	 * stays in the open all the way down — anything that would block it
	 * is a solid block, and the collision test catches that.
	 */
	pexposed[i] = getSkyLight(px[i], py[i], pz[i]) > 0 ? 1 : 0;
}

function seedPool(): void {
	for (let i = 0; i < MAX_DROPS; i++) {
		respawnDrop(i);

		// Spread the initial ages so the first frame does not show every drop
		// entering the volume at the same instant.
		const age = nextRandom() * plife[i];
		page[i] = age;
		py[i] = camY + BOX_TOP - pvy[i] * age;
	}

	aliveCount = MAX_DROPS;
}

/**
 * Sky light level at a world position, 0..15.
 *
 * Sky light is the skylight propagation value, independent of the time of
 * day (the day/night cycle is applied in the shader). A level of zero means
 * the position is fully enclosed — a cave or a sealed room — while 15 means
 * it sees the open sky. An unloaded chunk reports full sky light, so
 * streaming never hides the rain.
 */
function getSkyLight(x: number, y: number, z: number): number {
	const packed = getLightByWorldCoords(
		Math.floor(x),
		Math.floor(y),
		Math.floor(z),
	);
	return (packed >> 4) & 0xf;
}

/**
 * Advance the rain and rebuild the billboard sprites.
 *
 * Called once per frame from the map update.
 */
export function updateRain(deltaMs: number): void {
	const system = billboard;

	if (system === null) {
		updateRainAudio(0, 0);
		return;
	}

	const dt = Math.min(MAX_DT, deltaMs * 0.001);

	const intensity = WorldEnvironment.instance?.rainIntensity ?? 0;
	const visible = Math.round(MAX_DROPS * intensity);

	// Paused or not raining: keep the system out of the draw entirely.
	if (!(dt > 0) || visible <= 0 || isUiOpen(UiFocus.pauseMenu)) {
		clearBillboardSprites(system);
		system.visible = false;
		wasRaining = false;
		updateRainAudio(0, 0);
		return;
	}

	const scene = sceneRef;
	const camera = scene?.camera;
	if (!camera) {
		system.visible = false;
		updateRainAudio(0, 0);
		return;
	}

	const camPos = getCameraPosition(camera);
	camX = camPos.x;
	camY = camPos.y;
	camZ = camPos.z;

	/*
	 * Under cover: the rain stays in the world; only the listener's audio
	 * exposure is reduced. Exposed columns elsewhere in the volume remain
	 * rather than per drop, so the cost is one voxel lookup.
	 *
	 * A position with zero sky light is fully enclosed — a cave, or a room
	 * with a solid roof. An unloaded chunk reports full sky light, so
	 * streaming never hides the rain.
	 */
	const skyLight = getSkyLight(camX, camY, camZ);
	const underwater = getEyeLiquid(camX, camY, camZ) !== null;

	/*
	 * The sound follows the same rule as the picture, but not quite:
	 * under water the rain is still there, just dulled by the water, so
	 * it stays audible. A sealed position hears nothing at all.
	 *
	 * The bed scales with the intensity and goes muffled as the player
	 * moves under cover, so it swells and fades with the weather.
	 */
	updateRainAudio(intensity, rainExposureForSkyLight(skyLight, underwater));

	if (underwater) {
		clearBillboardSprites(system);
		system.visible = false;
		wasRaining = false;
		return;
	}

	if (!wasRaining) {
		seedPool();
		wasRaining = true;
	}

	system.visible = true;

	/*
	 * Rain brightness follows the sky. The same sun-elevation curve the
	 * particle lighting uses, so streaks go dim at night without needing a
	 * per-drop light sample.
	 */
	const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
	const sunIntensity = Math.min(1, Math.max(0, sunElevation * 4));
	const brightness = 0.22 + 0.78 * Math.min(1, sunIntensity + 0.3);

	/*
	 * Per-drop opacity. Milder than the count curve on purpose: the drop
	 * count already carries most of the "how heavy is it" signal, so dimming
	 * the streaks as well would make light rain look faint AND sparse.
	 */
	const baseAlpha = Math.min(0.62, 0.18 + intensity * 0.44);

	const position = scratchPos;
	const sizeWorld = scratchSize;
	const color = scratchColor;
	const props = scratchProps;

	color[0] = DROP_RGB_R * brightness;
	color[1] = DROP_RGB_G * brightness;
	color[2] = DROP_RGB_B * brightness;

	sizeWorld[0] = DROP_WIDTH;
	sizeWorld[1] = DROP_LENGTH;

	clearBillboardSprites(system);

	/*
	 * The WHOLE pool is simulated every frame, and only `visible` exposed
	 * drops are drawn. The budget counts visible drops rather than pool slots,
	 * so standing indoors does not hide the outside rain.
	 *
	 * Simulating only the visible ones would freeze the rest in mid-air:
	 * the visible budget grows with the rain intensity, so raising the
	 * intensity would bring a clump of stale drops into view and leave them
	 * hanging there. Simulation is a handful of arithmetic ops per drop;
	 * only the draw is budgeted.
	 */
	let drawn = 0;
	for (let i = 0; i < aliveCount; i++) {
		const age = page[i] + dt;
		const life = plife[i];

		if (age >= life) {
			respawnDrop(i);
			continue;
		}

		page[i] = age;
		py[i] -= pvy[i] * dt;

		// A roofed column is allowed to age out and respawn, but never draws.
		// This is what makes rain stop at a roof instead of appearing inside it.
		if (pexposed[i] === 0) continue;

		/*
		 * Ground collision. The drop's centre is what matters: the streak is
		 * 1.4 m long and centred on the drop, so once the centre enters a
		 * solid block the depth test already clips the lower half of the
		 * streak against the surface. Dropping the drop there makes the
		 * streak end exactly at the ground, and keeps rain from falling
		 * through a roof into the room below.
		 *
		 * Include dynamic blocks as well as terrain mutations, so placed or
		 * moving roofs stop the rain too.
		 */
		if (
			py[i] < camY + BOX_BOTTOM ||
			isCollidableBlock(
				getBlockByWorldCoords(
					Math.floor(px[i]),
					Math.floor(py[i]),
					Math.floor(pz[i]),
				),
			)
		) {
			respawnDrop(i);
			continue;
		}

		// Past the draw budget: keep falling, but do not draw.
		if (drawn >= visible) continue;

		// Fade in at the top of the volume and out at the bottom, so drops
		// neither pop into existence nor vanish abruptly.
		const t = age / life;
		let alpha = baseAlpha;
		if (t < EDGE_FADE) {
			alpha *= t / EDGE_FADE;
		} else if (t > 1 - EDGE_FADE) {
			alpha *= (1 - t) / EDGE_FADE;
		}

		// Distance fade: far streaks are thin enough to alias badly.
		const dx = px[i] - camX;
		const dy = py[i] - camY;
		const dz = pz[i] - camZ;
		const distSq = dx * dx + dy * dy + dz * dz;
		if (distSq > FADE_DISTANCE * FADE_DISTANCE) {
			const dist = Math.sqrt(distSq);
			const fade = 1 - (dist - FADE_DISTANCE) / (BOX_HALF_XZ * 2);
			alpha *= Math.max(fade, 0);
		}

		if (alpha <= 0.002) continue;

		position[0] = px[i];
		position[1] = py[i];
		position[2] = pz[i];

		color[3] = alpha;
		props.frame = pframe[i];

		addBillboardSpriteIndex(system, props);
		drawn++;
	}
}

/**
 * Live drop count, for HUD diagnostics.
 */
export function getRainDropCount(): number {
	return aliveCount;
}
