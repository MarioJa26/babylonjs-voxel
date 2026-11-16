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

const MAX_DROPS = 1600;

const DROP_WIDTH = 0.055;
const DROP_LENGTH = 0.72;

const FALL_SPEED = 22;
const SPEED_JITTER = 0.2;

const BOX_HALF_XZ = 9;
const BOX_TOP = 8;
const BOX_BOTTOM = -6;

const EDGE_FADE = 0.12;
const FADE_DISTANCE = 14;

const MAX_DT = 0.1;

const TEX_CELL_PX = 32;
const TEX_GRID = 2;
const TEX_SIZE_PX = TEX_CELL_PX * TEX_GRID;

const DROP_RGB_R = 0.5;
const DROP_RGB_G = 0.64;
const DROP_RGB_B = 0.78;

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

const MS_TO_SECONDS = 0.001;

const SPEED_MIN_FACTOR = 1 - SPEED_JITTER;
const SPEED_FACTOR_RANGE = SPEED_JITTER * 2;

const DROP_VOLUME_HEIGHT = BOX_TOP - BOX_BOTTOM;
const BOX_DIAMETER_XZ = BOX_HALF_XZ * 2;

const EDGE_FADE_END = 1 - EDGE_FADE;
const INVERSE_EDGE_FADE = 1 / EDGE_FADE;

const FADE_DISTANCE_SQ = FADE_DISTANCE * FADE_DISTANCE;
const INVERSE_DISTANCE_FADE_RANGE = 1 / BOX_DIAMETER_XZ;

const MIN_VISIBLE_ALPHA = 0.002;

const TEX_CHANNELS = 4;
const TEX_ROW_STRIDE = TEX_SIZE_PX * TEX_CHANNELS;
const TEX_CELL_STRIDE = TEX_CELL_PX * TEX_CHANNELS;
const INVERSE_TEX_CELL_PX = 1 / TEX_CELL_PX;

const RANDOM_SCALE = 1 / 4294967296;

// ---------------------------------------------------------------------------
// Drop pool
// ---------------------------------------------------------------------------

const px = new Float32Array(MAX_DROPS);
const py = new Float32Array(MAX_DROPS);
const pz = new Float32Array(MAX_DROPS);

const pvy = new Float32Array(MAX_DROPS);
const page = new Float32Array(MAX_DROPS);
const plife = new Float32Array(MAX_DROPS);

const pframe = new Uint8Array(MAX_DROPS);
const pexposed = new Uint8Array(MAX_DROPS);

/**
 * Drops do not move horizontally, so their voxel X/Z coordinates only need
 * to be calculated when they respawn rather than every simulation frame.
 */
const pblockX = new Int32Array(MAX_DROPS);
const pblockZ = new Int32Array(MAX_DROPS);

let aliveCount = 0;

let camX = 0;
let camY = 0;
let camZ = 0;

let wasRaining = false;

let billboard: AxisLockedBillboardSpriteSystem | null = null;
let sceneRef: SceneContext | null = null;

// ---------------------------------------------------------------------------
// Reusable billboard data
// ---------------------------------------------------------------------------

const scratchPos: [number, number, number] = [0, 0, 0];
const scratchSize: [number, number] = [DROP_WIDTH, DROP_LENGTH];
const scratchColor: [number, number, number, number] = [0, 0, 0, 0];

const scratchProps = {
	position: scratchPos,
	sizeWorld: scratchSize,
	rotation: 0,
	color: scratchColor,
	frame: 0,
};

// ---------------------------------------------------------------------------
// Random generator
// ---------------------------------------------------------------------------

let rngState = 0x1a2b3c4d;

function nextRandom(): number {
	let x = rngState;

	x ^= x << 13;
	x >>>= 0;
	x ^= x >>> 17;
	x ^= x << 5;
	x >>>= 0;

	rngState = x;

	return x * RANDOM_SCALE;
}

// ---------------------------------------------------------------------------
// Streak texture
// ---------------------------------------------------------------------------

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = (value - edge0) / (edge1 - edge0);

	if (t <= 0) return 0;
	if (t >= 1) return 1;

	return t * t * (3 - 2 * t);
}

/**
 * Build the generated 2x2 rain-streak atlas.
 *
 * Horizontal and vertical profiles are calculated once per variant/coordinate
 * rather than once per pixel.
 */
function buildRainTexture(): Uint8Array {
	const data = new Uint8Array(TEX_SIZE_PX * TEX_SIZE_PX * TEX_CHANNELS);

	const horizontalProfile = new Float32Array(TEX_GRID * TEX_CELL_PX);
	const verticalProfile = new Float32Array(TEX_GRID * TEX_CELL_PX);

	for (let variantGroup = 0; variantGroup < TEX_GRID; variantGroup++) {
		const edge = variantGroup === 0 ? 0.58 : 0.68;
		const fade = variantGroup === 0 ? 0.3 : 0.2;
		const profileOffset = variantGroup * TEX_CELL_PX;

		for (let pixel = 0; pixel < TEX_CELL_PX; pixel++) {
			const coordinate = (pixel + 0.5) * INVERSE_TEX_CELL_PX;
			const x = Math.abs((coordinate - 0.5) * 2);

			horizontalProfile[profileOffset + pixel] = 1 - smoothstep(edge, 1, x);

			verticalProfile[profileOffset + pixel] =
				smoothstep(0, fade, coordinate) *
				(1 - smoothstep(1 - fade, 1, coordinate));
		}
	}

	for (let cellY = 0; cellY < TEX_GRID; cellY++) {
		const variantGroup = cellY;
		const profileOffset = variantGroup * TEX_CELL_PX;
		const textureY = cellY * TEX_CELL_PX;

		for (let cellX = 0; cellX < TEX_GRID; cellX++) {
			const textureXBytes = cellX * TEX_CELL_STRIDE;

			for (let localY = 0; localY < TEX_CELL_PX; localY++) {
				const along = verticalProfile[profileOffset + localY];
				let dataIndex = (textureY + localY) * TEX_ROW_STRIDE + textureXBytes;

				for (let localX = 0; localX < TEX_CELL_PX; localX++) {
					const alpha = horizontalProfile[profileOffset + localX] * along;

					data[dataIndex] = 255;
					data[dataIndex + 1] = 255;
					data[dataIndex + 2] = 255;
					data[dataIndex + 3] = Math.round(alpha * 255);

					dataIndex += TEX_CHANNELS;
				}
			}
		}
	}

	return data;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function initRain(engine: EngineContext, scene: SceneContext): void {
	sceneRef = scene;

	try {
		const texture = createTexture2DFromPixels(
			engine,
			buildRainTexture(),
			TEX_SIZE_PX,
			TEX_SIZE_PX,
			{
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
		billboard = null;
		console.warn("[RainSystem] failed to initialise:", error);
	}
}

export function disposeRain(): void {
	const system = billboard;

	if (system !== null) {
		clearBillboardSprites(system);
		system.visible = false;
	}

	billboard = null;
	sceneRef = null;

	aliveCount = 0;
	wasRaining = false;

	disposeRainAudio();
}

// ---------------------------------------------------------------------------
// Sky visibility
// ---------------------------------------------------------------------------

function getSkyLightByBlock(
	blockX: number,
	blockY: number,
	blockZ: number,
): number {
	return (getLightByWorldCoords(blockX, blockY, blockZ) >>> 4) & 0xf;
}

function getSkyLight(x: number, y: number, z: number): number {
	return getSkyLightByBlock(Math.floor(x), Math.floor(y), Math.floor(z));
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function respawnDrop(index: number): void {
	const speed =
		FALL_SPEED * (SPEED_MIN_FACTOR + nextRandom() * SPEED_FACTOR_RANGE);

	const x = camX + (nextRandom() * 2 - 1) * BOX_HALF_XZ;
	const z = camZ + (nextRandom() * 2 - 1) * BOX_HALF_XZ;
	const y = camY + BOX_TOP;

	const blockX = Math.floor(x);
	const blockZ = Math.floor(z);

	px[index] = x;
	py[index] = y;
	pz[index] = z;

	pblockX[index] = blockX;
	pblockZ[index] = blockZ;

	pvy[index] = speed;
	page[index] = 0;
	plife[index] = DROP_VOLUME_HEIGHT / speed;
	pframe[index] = (nextRandom() * 4) | 0;

	pexposed[index] =
		getSkyLightByBlock(blockX, Math.floor(y), blockZ) > 0 ? 1 : 0;
}

function seedPool(): void {
	for (let index = 0; index < MAX_DROPS; index++) {
		respawnDrop(index);

		const age = nextRandom() * plife[index];

		page[index] = age;
		py[index] = camY + BOX_TOP - pvy[index] * age;
	}

	aliveCount = MAX_DROPS;
}

function stopVisibleRain(
	system: AxisLockedBillboardSpriteSystem,
	resetSimulation: boolean,
): void {
	clearBillboardSprites(system);
	system.visible = false;

	if (resetSimulation) {
		wasRaining = false;
	}
}

/**
 * Advance the rain simulation and rebuild the single instanced draw.
 */
export function updateRain(deltaMs: number): void {
	const system = billboard;

	if (system === null) {
		updateRainAudio(0, 0);
		return;
	}

	const intensity = WorldEnvironment.instance?.rainIntensity ?? 0;
	const visibleBudget = Math.round(MAX_DROPS * intensity);

	const dt = Math.min(MAX_DT, deltaMs * MS_TO_SECONDS);

	if (dt <= 0 || visibleBudget <= 0 || isUiOpen(UiFocus.pauseMenu)) {
		stopVisibleRain(system, true);
		updateRainAudio(0, 0);
		return;
	}

	const camera = sceneRef?.camera;

	if (!camera) {
		stopVisibleRain(system, false);
		updateRainAudio(0, 0);
		return;
	}

	const cameraPosition = getCameraPosition(camera);

	camX = cameraPosition.x;
	camY = cameraPosition.y;
	camZ = cameraPosition.z;

	const cameraX = camX;
	const cameraY = camY;
	const cameraZ = camZ;

	const skyLight = getSkyLight(cameraX, cameraY, cameraZ);
	const underwater = getEyeLiquid(cameraX, cameraY, cameraZ) !== null;

	updateRainAudio(intensity, rainExposureForSkyLight(skyLight, underwater));

	if (underwater) {
		stopVisibleRain(system, true);
		return;
	}

	if (!wasRaining) {
		seedPool();
		wasRaining = true;
	}

	const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;

	const sunIntensity =
		sunElevation <= 0 ? 0 : sunElevation >= 0.25 ? 1 : sunElevation * 4;

	const brightnessInput = sunIntensity + 0.3;
	const brightness = 0.22 + 0.78 * (brightnessInput < 1 ? brightnessInput : 1);

	const baseAlpha = Math.min(0.62, 0.18 + intensity * 0.44);

	const color = scratchColor;

	color[0] = DROP_RGB_R * brightness;
	color[1] = DROP_RGB_G * brightness;
	color[2] = DROP_RGB_B * brightness;

	clearBillboardSprites(system);
	system.visible = true;

	// Stable local references reduce repeated module/property resolution in
	// the hot loop and make the data-oriented layout explicit.
	const positionsX = px;
	const positionsY = py;
	const positionsZ = pz;

	const velocitiesY = pvy;
	const ages = page;
	const lifetimes = plife;

	const frames = pframe;
	const exposed = pexposed;
	const blockXs = pblockX;
	const blockZs = pblockZ;

	const position = scratchPos;
	const props = scratchProps;

	const lowerBoundary = cameraY + BOX_BOTTOM;
	const count = aliveCount;

	let drawn = 0;

	for (let index = 0; index < count; index++) {
		const age = ages[index] + dt;
		const life = lifetimes[index];

		if (age >= life) {
			respawnDrop(index);
			continue;
		}

		const y = positionsY[index] - velocitiesY[index] * dt;

		ages[index] = age;
		positionsY[index] = y;

		if (exposed[index] === 0) {
			continue;
		}

		if (
			y < lowerBoundary ||
			isCollidableBlock(
				getBlockByWorldCoords(blockXs[index], Math.floor(y), blockZs[index]),
			)
		) {
			respawnDrop(index);
			continue;
		}

		if (drawn >= visibleBudget) {
			continue;
		}

		const normalizedAge = age / life;
		let alpha = baseAlpha;

		if (normalizedAge < EDGE_FADE) {
			alpha *= normalizedAge * INVERSE_EDGE_FADE;
		} else if (normalizedAge > EDGE_FADE_END) {
			alpha *= (1 - normalizedAge) * INVERSE_EDGE_FADE;
		}

		const x = positionsX[index];
		const z = positionsZ[index];

		const dx = x - cameraX;
		const dy = y - cameraY;
		const dz = z - cameraZ;

		const distanceSquared = dx * dx + dy * dy + dz * dz;

		if (distanceSquared > FADE_DISTANCE_SQ) {
			const distance = Math.sqrt(distanceSquared);

			const distanceAlpha =
				1 - (distance - FADE_DISTANCE) * INVERSE_DISTANCE_FADE_RANGE;

			if (distanceAlpha <= 0) {
				continue;
			}

			alpha *= distanceAlpha;
		}

		if (alpha <= MIN_VISIBLE_ALPHA) {
			continue;
		}

		position[0] = x;
		position[1] = y;
		position[2] = z;

		color[3] = alpha;
		props.frame = frames[index];

		addBillboardSpriteIndex(system, props);
		drawn++;
	}
}

export function getRainDropCount(): number {
	return aliveCount;
}
