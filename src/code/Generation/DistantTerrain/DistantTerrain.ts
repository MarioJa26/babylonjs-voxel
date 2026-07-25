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

// =====================================================================
// Grid mesh construction
// =====================================================================

function createEmptyGridMesh(engine: EngineContext, name: string): Mesh {
	const res = gridResolution;
	const quadCount = (res - 1) * (res - 1);
	const indexCount = quadCount * 6;

	const indices = new Uint32Array(indexCount);
	let k = 0;
	for (let z = 0; z < res - 1; z++) {
		const row = z * res;
		const next = (z + 1) * res;
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
	for (let i = 1; i < normals.length; i += 3) {
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

function updateUniforms() {
	if (!material || !waterMaterial) return;

	const lightDir = GLOBAL_VALUES.skyLightDirection;
	const shaderDirY = -lightDir.y;
	const rawBlend = 1 - Math.min(1, Math.max(0, (shaderDirY + 0.2) / 0.4));
	const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);

	const lx = -lightDir.x * (1 - blend);
	const ly = -lightDir.y * (1 - blend) + blend;
	const lz = -lightDir.z * (1 - blend);

	const rawIntensity = (-lightDir.y + 0.1) * 4.0;
	const sunLightIntensity =
		rawIntensity < 0.0 ? 0.0 : rawIntensity > 1.0 ? 1.0 : rawIntensity;

	const camera = scene ? scene.camera : null;
	const camPos = camera ? getCameraPosition(camera) : null;
	const isUnderWater = camPos
		? isEyeUnderwater(camPos.x, camPos.y, camPos.z)
		: false;
	const start = MapFog.getFogStart(isUnderWater);
	const end = MapFog.getFogEnd(isUnderWater);
	const fogInfos: [number, number, number, number] = [0, start, end, 0];
	const fogColor = MapFog.getFogColor(isUnderWater);
	// Precomputed reciprocal of (far - near) so the per-fragment fog factor can
	// multiply instead of divide (mirrors the SKYBLEND_FACTOR trick).
	const fogInvRange = 1.0 / Math.max(end - start, 1e-4);

	for (const mat of [material, waterMaterial]) {
		setShaderUniform(mat, "lightDirection", [lx, ly, lz]);
		setShaderUniform(mat, "sunLightIntensity", sunLightIntensity);
		setShaderUniform(mat, "fogInfos", fogInfos);
		setShaderUniform(mat, "fogColor", fogColor);
		setShaderUniform(mat, "fogInvRange", fogInvRange);
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
	for (let i = 0; i < vertexCount * 3; i++) {
		floatPositions[i] = pos[i];
		floatNormals[i] = nrm[i] / 127;
	}

	updateMeshPositions(engine, mesh, floatPositions);
	updateMeshNormals(engine, mesh, floatNormals);

	mesh.position.set(worldX, -2, worldZ);
	waterMesh.position.set(worldX, GenerationParams.SEA_LEVEL, worldZ);

	gridOrigin[0] = worldX - radius * Chunk.SIZE;
	gridOrigin[1] = worldZ - radius * Chunk.SIZE;
	setShaderUniform(material, "gridOriginWorld", [gridOrigin[0], gridOrigin[1]]);

	if (USE_LA_TILE_TEXTURE) {
		surfaceTileLookupData.set(tiles.subarray(0, surfaceTileLookupData.length));
	} else {
		for (let s = 0, d = 0; s < tiles.length; s += 2, d += 4) {
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
