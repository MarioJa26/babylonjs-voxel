import {
	addToScene,
	createGround,
	createMeshFromData,
	createTexture2DFromPixels,
	type EngineContext,
	getCameraPosition,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	type SceneContext,
	setShaderUniform,
	updateMeshNormals,
	updateMeshPositions,
	updateTexture2DFromPixels,
} from "@babylonjs/lite";
import { worldToChunkCoord } from "@/code/Lib/VoxelMath";
import { Map1 } from "@/code/Maps/Map1";
import MapFog from "@/code/Maps/MapFog";
import { isEyeUnderwater } from "@/code/Maps/UnderWaterEffect";
import { Chunk } from "@/code/World/Chunk/Chunk";
import { ChunkWorkerPool } from "@/code/World/Chunk/ChunkWorkerPool";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import {
	createDistantTerrainMaterial,
	createDistantWaterMaterial,
} from "@/code/World/Light/DistantTerrainShaderLite";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import {
	atlasTileSize,
	getDiffuseTexture2D,
	setDiffuseTexture2D,
} from "@/code/World/Texture/TextureAtlasFactory";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";

const USE_LA_TILE_TEXTURE = false;

let mesh: Mesh;
let waterMesh: Mesh;
let material: ReturnType<typeof createDistantTerrainMaterial>;
let waterMaterial: ReturnType<typeof createDistantWaterMaterial>;

let surfaceTileLookupTexture: ReturnType<typeof createTexture2DFromPixels>;
let surfaceTileLookupData: Uint8Array;

let radius: number;
const gridStep = 1;
let gridResolution: number;
let vertexCount: number;

let sharedPositions: Int16Array;
let sharedNormals: Int8Array;
let sharedSurfaceTiles: Uint8Array;

let floatPositions: Float32Array;
let floatNormals: Float32Array;

const gridOrigin: [number, number] = [0, 0];

let lastChunkX: number = Number.NaN;
let lastChunkZ: number = Number.NaN;
let lastRenderDistance: number = Number.NaN;

let engine: EngineContext;
let scene: SceneContext;

let initialized = false;

const gridOriginScratch = new Float32Array(2);
function setUniformBoth(name: string, value: number | Float32Array): void {
	// Avoid `for (const mat of [material, waterMaterial])`, which allocates
	// a new array every time uniforms change.
	setShaderUniform(material, name, value);
	setShaderUniform(waterMaterial, name, value);
}

// =====================================================================
// Grid mesh construction
// =====================================================================

function createEmptyGridMesh(engine: EngineContext, name: string): Mesh {
	const res = gridResolution;
	const quadCount = (res - 1) * (res - 1);
	const indexCount = quadCount * 6;

	// createMeshFromData is typed to accept Uint32Array only.
	// Keep this as Uint32Array unless the @babylonjs/lite wrapper signature
	// is changed to accept Uint16Array too.
	const indices = new Uint32Array(indexCount);

	let k = 0;
	for (let z = 0; z < res - 1; z++) {
		const row = z * res;
		const next = row + res;

		for (let x = 0; x < res - 1; x++) {
			const i0 = row + x;
			const i1 = i0 + 1;
			const i2 = next + x;
			const i3 = i2 + 1;

			indices[k++] = i0;
			indices[k++] = i1;
			indices[k++] = i2;

			indices[k++] = i1;
			indices[k++] = i3;
			indices[k++] = i2;
		}
	}

	const positions = new Float32Array(vertexCount * 3);
	const normals = new Float32Array(vertexCount * 3);

	for (let i = 1, len = normals.length; i < len; i += 3) {
		normals[i] = 1;
	}

	const m = createMeshFromData(engine, name, positions, normals, indices);
	m.pickable = false;
	return m;
}

function ensureFloatBuffers() {
	if (!floatPositions || floatPositions.length !== vertexCount * 3) {
		floatPositions = new Float32Array(vertexCount * 3);
		floatNormals = new Float32Array(vertexCount * 3);
	}
}

// =====================================================================
// Per-frame uniforms (Lite has no onBind — drive from onBeforeRender)
// =====================================================================

// Scratch arrays + change caches: the sun is static while timeScale === 0 and
// fog only changes on underwater transitions/overrides, so steady-state
// frames skip every setShaderUniform (and the material-UBO writeBuffer).
const lightDirScratch = new Float32Array(3);
const fogInfosScratch = new Float32Array(4);
const fogColorScratch = new Float32Array(3);
let lastLx = Number.NaN;
let lastLy = Number.NaN;
let lastLz = Number.NaN;
let lastSunIntensity = Number.NaN;
let lastUnderWater: boolean | null = null;
let lastFogStart = Number.NaN;
let lastFogEnd = Number.NaN;
let lastFogColorR = Number.NaN;
let lastFogColorG = Number.NaN;
let lastFogColorB = Number.NaN;
let lastFogInvRange = Number.NaN;

function updateUniforms() {
	if (!material || !waterMaterial) return;

	const lightDir = GLOBAL_VALUES.skyLightDirection;
	const shaderDirY = -lightDir.y;

	const t = (shaderDirY + 0.2) / 0.4;
	const clampedT = t < 0 ? 0 : t > 1 ? 1 : t;
	const rawBlend = 1 - clampedT;
	const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
	const invBlend = 1 - blend;

	const lx = -lightDir.x * invBlend;
	const ly = -lightDir.y * invBlend + blend;
	const lz = -lightDir.z * invBlend;

	const rawIntensity = (-lightDir.y + 0.1) * 4.0;
	const sunLightIntensity =
		rawIntensity < 0 ? 0 : rawIntensity > 1 ? 1 : rawIntensity;

	const camera = scene ? scene.camera : null;
	const camPos = camera ? getCameraPosition(camera) : null;
	const isUnderWater = camPos
		? isEyeUnderwater(camPos.x, camPos.y, camPos.z)
		: false;

	const start = MapFog.getFogStart(isUnderWater);
	const end = MapFog.getFogEnd(isUnderWater);
	const fogColor = MapFog.getFogColor(isUnderWater);
	const fogInvRange = 1.0 / Math.max(end - start, 1e-4);

	const staticChanged =
		lx !== lastLx ||
		ly !== lastLy ||
		lz !== lastLz ||
		sunLightIntensity !== lastSunIntensity;

	const fogChanged =
		isUnderWater !== lastUnderWater ||
		start !== lastFogStart ||
		end !== lastFogEnd ||
		fogColor[0] !== lastFogColorR ||
		fogColor[1] !== lastFogColorG ||
		fogColor[2] !== lastFogColorB ||
		fogInvRange !== lastFogInvRange;

	if (!staticChanged && !fogChanged) return;

	if (staticChanged) {
		lightDirScratch[0] = lx;
		lightDirScratch[1] = ly;
		lightDirScratch[2] = lz;

		lastLx = lx;
		lastLy = ly;
		lastLz = lz;
		lastSunIntensity = sunLightIntensity;

		setUniformBoth("lightDirection", lightDirScratch);
		setUniformBoth("sunLightIntensity", sunLightIntensity);
	}

	if (fogChanged) {
		fogInfosScratch[0] = 0;
		fogInfosScratch[1] = start;
		fogInfosScratch[2] = end;
		fogInfosScratch[3] = 0;

		fogColorScratch[0] = fogColor[0];
		fogColorScratch[1] = fogColor[1];
		fogColorScratch[2] = fogColor[2];

		lastUnderWater = isUnderWater;
		lastFogStart = start;
		lastFogEnd = end;
		lastFogColorR = fogColor[0];
		lastFogColorG = fogColor[1];
		lastFogColorB = fogColor[2];
		lastFogInvRange = fogInvRange;

		setUniformBoth("fogInfos", fogInfosScratch);
		setUniformBoth("fogColor", fogColorScratch);
		setUniformBoth("fogInvRange", fogInvRange);
	}
}

// =====================================================================
// Terrain data application
// =====================================================================

function applyTerrainData(
	pos: Int16Array,
	nrm: Int8Array,
	tiles: Uint8Array,
	worldX: number,
	worldZ: number,
) {
	const len3 = vertexCount * 3;

	for (let i = 0; i < len3; i++) {
		floatPositions[i] = pos[i];
		floatNormals[i] = nrm[i] * (1 / 127);
	}

	updateMeshPositions(engine, mesh, floatPositions);
	updateMeshNormals(engine, mesh, floatNormals);

	mesh.position.set(worldX, -2, worldZ);
	waterMesh.position.set(worldX, GenerationParams.SEA_LEVEL, worldZ);

	const originX = worldX - radius * Chunk.SIZE;
	const originZ = worldZ - radius * Chunk.SIZE;

	gridOrigin[0] = originX;
	gridOrigin[1] = originZ;
	gridOriginScratch[0] = originX;
	gridOriginScratch[1] = originZ;
	setShaderUniform(material, "gridOriginWorld", gridOriginScratch);

	if (USE_LA_TILE_TEXTURE) {
		surfaceTileLookupData.set(tiles.subarray(0, surfaceTileLookupData.length));
	} else {
		const max = tiles.length;
		for (let s = 0, d = 0; s < max; s += 2, d += 4) {
			surfaceTileLookupData[d] = tiles[s];
			surfaceTileLookupData[d + 1] = tiles[s + 1];
			surfaceTileLookupData[d + 2] = 0;
			surfaceTileLookupData[d + 3] = 255;
		}
	}

	updateTexture2DFromPixels(
		engine,
		surfaceTileLookupTexture,
		surfaceTileLookupData,
		0,
		0,
		gridResolution,
		gridResolution,
	);
}

// =====================================================================
// Public API
// =====================================================================

export async function initDistantTerrain(): Promise<void> {
	if (initialized) return;

	engine = Map1.engine;
	scene = Map1.mainScene;

	radius = SETTING_PARAMS.DISTANT_RENDER_DISTANCE;
	const segments = Math.floor((radius * 2) / gridStep);
	gridResolution = segments + 1;
	vertexCount = gridResolution * gridResolution;
	ensureFloatBuffers();
	const size = radius * 2 * Chunk.SIZE;

	if (
		typeof SharedArrayBuffer === "undefined" ||
		(typeof self !== "undefined" &&
			"crossOriginIsolated" in self &&
			!(self as unknown as { crossOriginIsolated: boolean })
				.crossOriginIsolated)
	) {
		throw new Error(
			"DistantTerrain requires SharedArrayBuffer. " +
				"Make sure crossOriginIsolated is true and your dev server sends " +
				"Cross-Origin-Opener-Policy: same-origin and " +
				"Cross-Origin-Embedder-Policy: require-corp.",
		);
	}

	const positionsBuffer = new SharedArrayBuffer(
		vertexCount * 3 * Int16Array.BYTES_PER_ELEMENT,
	);
	const normalsBuffer = new SharedArrayBuffer(
		vertexCount * 3 * Int8Array.BYTES_PER_ELEMENT,
	);
	const surfaceTilesBuffer = new SharedArrayBuffer(
		vertexCount * 2 * Uint8Array.BYTES_PER_ELEMENT,
	);

	sharedPositions = new Int16Array(positionsBuffer);
	sharedNormals = new Int8Array(normalsBuffer);
	sharedSurfaceTiles = new Uint8Array(surfaceTilesBuffer);

	ChunkWorkerPool.getInstance().initDistantTerrainShared(
		positionsBuffer,
		normalsBuffer,
		surfaceTilesBuffer,
		radius,
		gridStep,
	);

	mesh = createEmptyGridMesh(engine, "distantTerrain");

	waterMesh = createGround(engine, {
		width: size,
		height: size,
		subdivisions: 1,
	});
	waterMesh.pickable = false;

	if (USE_LA_TILE_TEXTURE) {
		surfaceTileLookupData = new Uint8Array(vertexCount * 2);
	} else {
		surfaceTileLookupData = new Uint8Array(vertexCount * 4);
	}

	surfaceTileLookupTexture = createTexture2DFromPixels(
		engine,
		surfaceTileLookupData,
		gridResolution,
		gridResolution,
		{ addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
	);

	ChunkWorkerPool.getInstance().onDistantTerrainGenerated = (data) => {
		const worldX = data.centerChunkX * Chunk.SIZE;
		const worldZ = data.centerChunkZ * Chunk.SIZE;
		applyTerrainData(
			sharedPositions,
			sharedNormals,
			sharedSurfaceTiles,
			worldX,
			worldZ,
		);
	};

	let diffuse = getDiffuseTexture2D();
	if (!diffuse) {
		diffuse = await loadTexture2D(engine, "/texture/diffuse_atlas.png", {
			mipMaps: false,
			magFilter: "nearest",
			minFilter: "nearest",
		});
		setDiffuseTexture2D(diffuse);
	}

	material = createDistantTerrainMaterial({
		engine,
		scene,
		diffuseTexture: diffuse,
		tileLookupTexture: surfaceTileLookupTexture,
		atlasTileSize,
		textureScale: 32,
		tileGridResolution: gridResolution,
		gridWorldStep: Chunk.SIZE * gridStep,
	});
	mesh.material = material;
	// Draw the distant terrain as a pure background layer: render it BEFORE the
	// chunk meshes (renderOrder 0) so every chunk drawn afterwards paints on top
	// of it. The terrain keeps depthTest/depthWrite on for correct self-occlusion
	// of its own hills, but because chunks are drawn after it, the clipmap is
	// always rendered behind the real chunks regardless of depth-buffer state.
	mesh.renderOrder = 0;
	addToScene(scene, mesh);

	waterMaterial = createDistantWaterMaterial();
	waterMesh.material = waterMaterial;
	// Draw the distant water as part of the background layer, just after the
	// terrain (renderOrder 0) and before the chunk meshes (renderOrder 0). With
	// chunks drawn afterwards it is always painted over by real terrain/water, so
	// the flat clipmap plane can never appear in front of chunks. depthWrite is
	// off so it never occludes anything itself.
	waterMesh.renderOrder = 0;
	addToScene(scene, waterMesh);

	onBeforeRender(scene, updateUniforms);

	initialized = true;
}

export function isInitialized(): boolean {
	return initialized;
}

/**
 * Force full clip map regeneration on the next update() call.
 * Used after the server sends a new seed so the distant terrain
 * is rebuilt from scratch instead of sliding stale data.
 */
export function resetDistantTerrain(): void {
	lastChunkX = Number.NaN;
	lastChunkZ = Number.NaN;
	lastRenderDistance = Number.NaN;
}

export function update(worldX: number, worldZ: number) {
	const cx = worldToChunkCoord(worldX);
	const cz = worldToChunkCoord(worldZ);
	const effectiveRenderDistance =
		SETTING_PARAMS.RENDER_DISTANCE +
		SETTING_PARAMS.LOD_1_OFFSET +
		SETTING_PARAMS.LOD_2_OFFSET;
	const renderDistanceChanged = effectiveRenderDistance !== lastRenderDistance;
	if (cx === lastChunkX && cz === lastChunkZ && !renderDistanceChanged) return;
	lastChunkX = cx;
	lastChunkZ = cz;
	lastRenderDistance = effectiveRenderDistance;
	ChunkWorkerPool.getInstance().scheduleDistantTerrain(
		cx,
		cz,
		radius,
		effectiveRenderDistance,
		gridStep,
	);
}

export function dispose(): void {
	initialized = false;
}
