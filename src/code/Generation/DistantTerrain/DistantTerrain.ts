import {
	addToScene,
	createMeshFromData,
	createTexture2DFromPixels,
	disposeMeshGpu,
	type EngineContext,
	getCameraPosition,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	removeFromScene,
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
import { onGpuWorkDone } from "@/code/World/Light/liteGpuBuffer";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import {
	atlasTileSize,
	getDiffuseTexture2D,
	setDiffuseTexture2D,
} from "@/code/World/Texture/TextureAtlasFactory";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";

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

let sharedPositions: Float32Array;
let sharedNormals: Float32Array;
let sharedSurfaceTiles: Uint8Array;

const gridOrigin: [number, number] = [0, 0];

let lastChunkX: number = Number.NaN;
let lastChunkZ: number = Number.NaN;
let lastRenderDistance: number = Number.NaN;

// Chunk radius of the close-up hole cut out of the clip meshes. Real
// chunk/LOD geometry covers this region, so the clipmap neither shades nor
// rasterizes it there. Rebuilt only when the effective render distance
// changes — never per frame, never per vertex.
let holeHalfChunks = -1;

// Last applied terrain origin, so rebuilt meshes can re-upload the most
// recent worker data immediately instead of flashing empty for a roundtrip.
let lastWorldX = 0;
let lastWorldZ = 0;
let hasTerrainData = false;

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

// The impostor dips below every real-geometry LOD band (INSIDE_CLIP_Y), so
// the hole radius must cover the OUTERMOST per-chunk LOD ring — not just the
// near bands. Mirrors the worker's clip test (DistantTerrainGenerator).
function effectiveClipRadius(): number {
	return (
		SETTING_PARAMS.RENDER_DISTANCE +
		Math.max(
			SETTING_PARAMS.LOD_1_OFFSET,
			SETTING_PARAMS.LOD_2_OFFSET,
			SETTING_PARAMS.LOD_3_OFFSET,
			SETTING_PARAMS.LOD_4_OFFSET,
			SETTING_PARAMS.LOD_5_OFFSET,
		)
	);
}

// Grid cell (x, z) maps to chunk offset (x * gridStep - radius) because the
// grid snaps to the center chunk (gridStep = 1 ⇒ grid center == center
// chunk), so hole membership per cell is STATIC under sliding-window moves:
// the hole never needs per-frame or per-vertex updates.
function buildTerrainIndices(holeRd: number): Uint32Array {
	const res = gridResolution;

	const insideX: boolean[] = new Array(res);
	const insideZ: boolean[] = new Array(res);

	for (let v = 0; v < res; v++) {
		// Same inside test as the worker's generateVertex (strictly greater
		// on the low side, inclusive on the high side).
		const off = v * gridStep - radius;
		const inside = off > -holeRd && off <= holeRd;
		insideX[v] = inside;
		insideZ[v] = inside;
	}

	const indices: number[] = [];

	for (let z = 0; z < res - 1; z++) {
		const row = z * res;
		const next = row + res;
		const inZ0 = insideZ[z];
		const inZ1 = insideZ[z + 1];

		for (let x = 0; x < res - 1; x++) {
			// Skip quads fully inside the close-up region: real geometry
			// covers them. Zero vertex cost, zero fragment cost, and — unlike
			// a shader camera-distance test — zero ALU per vertex to decide.
			// Boundary quads are kept so their outer half still renders.
			if (inZ0 && inZ1 && insideX[x] && insideX[x + 1]) continue;

			const i0 = row + x;
			const i1 = i0 + 1;
			const i2 = next + x;
			const i3 = i2 + 1;

			indices.push(i0, i1, i2, i1, i3, i2);
		}
	}

	return Uint32Array.from(indices);
}

function createDistantWaterMesh(): Mesh {
	const cs = Chunk.SIZE;
	const outer = radius * cs;
	// Clamp the hole inside the plane so a huge render distance can never
	// invert the ring into bow-tie (degenerate) triangles.
	const inner = Math.min(Math.max(holeHalfChunks, 0) * cs, outer);

	// Square frame with a rectangular hole: full-width north/south strips
	// plus middle west/east strips. Same (i0,i1,i2)/(i1,i3,i2) winding pattern
	// as the terrain grid (up-facing with backface culling on).
	const positions = new Float32Array([
		-outer,
		0,
		-outer, // 0 N-strip
		outer,
		0,
		-outer, // 1
		-outer,
		0,
		-inner, // 2
		outer,
		0,
		-inner, // 3
		-outer,
		0,
		inner, // 4 S-strip
		outer,
		0,
		inner, // 5
		-outer,
		0,
		outer, // 6
		outer,
		0,
		outer, // 7
		-inner,
		0,
		-inner, // 8 W-strip
		-inner,
		0,
		inner, // 9
		inner,
		0,
		-inner, // 10 E-strip
		inner,
		0,
		inner, // 11
	]);

	const normals = new Float32Array(12 * 3);

	for (let i = 1; i < normals.length; i += 3) {
		normals[i] = 1;
	}

	const indices = new Uint32Array([
		0,
		1,
		2,
		1,
		3,
		2, // north
		4,
		5,
		6,
		5,
		7,
		6, // south
		2,
		8,
		4,
		8,
		9,
		4, // west
		10,
		3,
		11,
		3,
		5,
		11, // east
	]);

	const m = createMeshFromData(
		engine,
		"distantWater",
		positions,
		normals,
		indices,
	);
	m.pickable = false;
	return m;
}

// Recreate both clip meshes so their index buffers match a new hole size.
// Runs only when the effective render distance changes. Old GPU buffers are
// retired after the in-flight frames finish (same pattern as the face-arena
// growth path) so a rebuild can never destroy a buffer mid-submit.
function rebuildClipMeshes(): void {
	const oldTerrain = mesh;
	mesh = createEmptyGridMesh(engine, "distantTerrain");
	mesh.material = material;
	mesh.renderOrder = 0;
	addToScene(scene, mesh);

	if (oldTerrain) {
		removeFromScene(scene, oldTerrain);
		void onGpuWorkDone(engine).then(() => disposeMeshGpu(oldTerrain));
	}

	if (hasTerrainData) {
		updateMeshPositions(engine, mesh, sharedPositions);
		updateMeshNormals(engine, mesh, sharedNormals);
		mesh.position.set(lastWorldX, -2, lastWorldZ);
	}

	const oldWater = waterMesh;
	waterMesh = createDistantWaterMesh();
	waterMesh.material = waterMaterial;
	waterMesh.renderOrder = 0;
	addToScene(scene, waterMesh);

	if (oldWater) {
		removeFromScene(scene, oldWater);
		void onGpuWorkDone(engine).then(() => disposeMeshGpu(oldWater));
	}

	if (hasTerrainData) {
		waterMesh.position.set(
			lastWorldX,
			GenerationParams.SEA_LEVEL - 3,
			lastWorldZ,
		);
	}
}

function createEmptyGridMesh(engine: EngineContext, name: string): Mesh {
	const indices = buildTerrainIndices(Math.max(holeHalfChunks, 0));

	const positions = new Float32Array(vertexCount * 3);
	const normals = new Float32Array(vertexCount * 3);

	for (let i = 1, len = normals.length; i < len; i += 3) {
		normals[i] = 1;
	}

	const m = createMeshFromData(engine, name, positions, normals, indices);
	m.pickable = false;
	return m;
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

	// Quantize to 1/256 steps — the sun drifts continuously through the day
	// cycle, and exact floats would re-write both UBOs every frame for
	// imperceptible deltas (writeBuffer was a top render-loop cost).
	const q = (v: number): number => Math.round(v * 256) / 256;
	const lxQ = q(lx);
	const lyQ = q(ly);
	const lzQ = q(lz);
	const sunQ = q(sunLightIntensity);

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
		lxQ !== lastLx ||
		lyQ !== lastLy ||
		lzQ !== lastLz ||
		sunQ !== lastSunIntensity;

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
		lightDirScratch[0] = lxQ;
		lightDirScratch[1] = lyQ;
		lightDirScratch[2] = lzQ;
		lastLx = lxQ;
		lastLy = lyQ;
		lastLz = lzQ;
		lastSunIntensity = sunQ;

		setUniformBoth("lightDirection", lightDirScratch);
		setUniformBoth("sunLightIntensity", sunQ);
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
	pos: Float32Array,
	nrm: Float32Array,
	tiles: Uint8Array,
	worldX: number,
	worldZ: number,
) {
	// Positions/normals are Float32 SABs — direct upload, no Int→Float mirror.
	updateMeshPositions(engine, mesh, pos);
	updateMeshNormals(engine, mesh, nrm);

	mesh.position.set(worldX, -2, worldZ);
	// Sit the flat clip-map water a few blocks below sea level so it can
	// never z-fight with far-tile water tops (which draw AT sea level).
	waterMesh.position.set(worldX, GenerationParams.SEA_LEVEL - 3, worldZ);

	lastWorldX = worldX;
	lastWorldZ = worldZ;
	hasTerrainData = true;

	const originX = worldX - radius * Chunk.SIZE;
	const originZ = worldZ - radius * Chunk.SIZE;

	gridOrigin[0] = originX;
	gridOrigin[1] = originZ;
	gridOriginScratch[0] = originX;
	gridOriginScratch[1] = originZ;
	setShaderUniform(material, "gridOriginWorld", gridOriginScratch);

	// Tiles are now RGBA (4 bytes/vert) — direct upload, no LA→RGBA expand.
	surfaceTileLookupData.set(tiles.subarray(0, surfaceTileLookupData.length));

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
	holeHalfChunks = effectiveClipRadius();

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
		vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT,
	);
	const normalsBuffer = new SharedArrayBuffer(
		vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT,
	);
	const surfaceTilesBuffer = new SharedArrayBuffer(
		vertexCount * 4 * Uint8Array.BYTES_PER_ELEMENT,
	);

	sharedPositions = new Float32Array(positionsBuffer);
	sharedNormals = new Float32Array(normalsBuffer);
	sharedSurfaceTiles = new Uint8Array(surfaceTilesBuffer);

	ChunkWorkerPool.getInstance().initDistantTerrainShared(
		positionsBuffer,
		normalsBuffer,
		surfaceTilesBuffer,
		radius,
		gridStep,
	);

	mesh = createEmptyGridMesh(engine, "distantTerrain");

	// PERF: the flat water plane used to span the FULL far-tile horizon
	// (512 chunks) as a placeholder while far tiles streamed in. At steady
	// state far-tile geometry + water completely cover it, so nearly every
	// fragment it shaded was overdrawn — a full-horizon blended pass wasted
	// every frame. Keep it at the clip-map radius only: it still fills the
	// ocean inside the streaming underlay, and beyond that edge far tiles
	// render the horizon themselves. The plane is a square frame with a
	// close-up hole (same skip as the terrain grid): real chunk water covers
	// the middle, so those fragments are never shaded at all.
	waterMesh = createDistantWaterMesh();

	surfaceTileLookupData = new Uint8Array(vertexCount * 4);

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
	// The impostor dips below every real-geometry LOD band (INSIDE_CLIP_Y),
	// so the clip radius must cover the OUTERMOST per-chunk LOD ring — not
	// just the near bands.
	const effectiveRenderDistance = effectiveClipRadius();
	const renderDistanceChanged = effectiveRenderDistance !== lastRenderDistance;
	if (cx === lastChunkX && cz === lastChunkZ && !renderDistanceChanged) return;
	lastChunkX = cx;
	lastChunkZ = cz;
	lastRenderDistance = effectiveRenderDistance;
	// The hole rect is static under player movement (grid snaps to the center
	// chunk), so the index buffers only need a rebuild when the clip radius
	// itself changes — i.e. on render-distance settings changes, not per frame.
	if (
		renderDistanceChanged &&
		initialized &&
		effectiveRenderDistance !== holeHalfChunks
	) {
		holeHalfChunks = effectiveRenderDistance;
		rebuildClipMeshes();
	}
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
