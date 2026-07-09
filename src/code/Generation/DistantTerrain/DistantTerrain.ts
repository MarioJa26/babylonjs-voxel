import {
	Effect,
	Mesh,
	MeshBuilder,
	RawTexture,
	type Scene,
	ShaderMaterial,
	Texture,
	Vector2,
	Vector3,
	VertexBuffer,
} from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { Chunk } from "@/code/World/Chunk/Chunk";
import { worldToChunkCoord } from "@/code/World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "@/code/World/Chunk/ChunkWorkerPool";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import {
	distantTerrainFragmentShader,
	distantTerrainVertexShader,
	distantWaterFragmentShader,
	distantWaterVertexShader,
} from "@/code/World/Light/DistantTerrainShader";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import {
	atlasTileSize,
	getDiffuse,
	setDiffuse,
} from "@/code/World/Texture/TextureAtlasFactory";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";

const USE_LA_TILE_TEXTURE = false;
const _cachedZeroVec = new Vector3(0, 0, 0);

let mesh: Mesh;
let waterMesh: Mesh;
let material: ShaderMaterial;
let waterMaterial: ShaderMaterial;
let diffuseAtlasTexture: Texture | null = null;

let surfaceTileLookupTexture: RawTexture;
let surfaceTileLookupData: Uint8Array;

let radius: number;
const gridStep = 1;
let gridResolution: number;

let sharedPositions: Int16Array;
let sharedNormals: Int8Array;
let sharedSurfaceTiles: Uint8Array;

const gridOrigin = new Vector2();

let lastChunkX: number = Number.NaN;
let lastChunkZ: number = Number.NaN;

let positionVB: VertexBuffer | undefined;
let normalVB: VertexBuffer | undefined;

let initialized = false;

// =====================================================================
// Helpers
// =====================================================================

function createEmptyGridMesh(name: string, scene: Scene): Mesh {
	const m = new Mesh(name, scene);
	const engine = scene.getEngine();

	const res = gridResolution;
	const vertexCount = res * res;
	const quadCount = (res - 1) * (res - 1);
	const indexCount = quadCount * 6;

	const useUint32 = vertexCount > 65535 && !!engine.getCaps().uintIndices;
	const indices = useUint32
		? new Uint32Array(indexCount)
		: new Uint16Array(indexCount);

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
			indices[k++] = i2;
			indices[k++] = i1;

			indices[k++] = i1;
			indices[k++] = i2;
			indices[k++] = i3;
		}
	}
	m.setIndices(indices);

	const positions = new Int16Array(vertexCount * 3);
	const normals = new Int8Array(vertexCount * 3);

	for (let i = 1; i < normals.length; i += 3) {
		normals[i] = 127;
	}

	positionVB = new VertexBuffer(
		engine,
		positions,
		VertexBuffer.PositionKind,
		true,
		false,
		3,
		false,
		0,
		undefined,
		VertexBuffer.SHORT,
		false,
	);
	m.setVerticesBuffer(positionVB);

	normalVB = new VertexBuffer(
		engine,
		normals,
		VertexBuffer.NormalKind,
		true,
		false,
		3,
		false,
		0,
		undefined,
		VertexBuffer.BYTE,
		true,
	);
	m.setVerticesBuffer(normalVB);

	return m;
}

function bindDiffuseTexture() {
	if (!diffuseAtlasTexture) {
		diffuseAtlasTexture = getDiffuse();
	}

	if (!diffuseAtlasTexture) {
		diffuseAtlasTexture = new Texture(
			"/texture/diffuse_atlas.png",
			Map1.mainScene,
			{
				noMipmap: false,
				samplingMode: Texture.NEAREST_SAMPLINGMODE,
			},
		);
		setDiffuse(diffuseAtlasTexture);
	}

	if (diffuseAtlasTexture) {
		diffuseAtlasTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
		diffuseAtlasTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
		material.setTexture("diffuseTexture", diffuseAtlasTexture);
		material.setFloat("useTexture", 1);
	}
}

function bindCommonUniforms(effect: Effect, scene: Scene) {
	effect.setVector3("lightDirection", GLOBAL_VALUES.skyLightDirection);

	const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
	const _raw = sunElevation * 4;
	const sunLightIntensity = _raw < 0.0 ? 0.0 : _raw > 1.0 ? 1.0 : _raw;
	effect.setFloat("sunLightIntensity", sunLightIntensity);

	effect.setVector3(
		"cameraPosition",
		scene.activeCamera?.position || _cachedZeroVec,
	);
	effect.setFloat4(
		"vFogInfos",
		scene.fogMode,
		scene.fogStart,
		scene.fogEnd,
		scene.fogDensity,
	);
	effect.setColor3("vFogColor", scene.fogColor);
}

function applyTerrainData(
	pos: Int16Array,
	nrm: Int8Array,
	tiles: Uint8Array,
	worldX: number,
	worldZ: number,
) {
	mesh.position.set(worldX, -2, worldZ);

	waterMesh.position.set(worldX, GenerationParams.SEA_LEVEL, worldZ);
	gridOrigin.x = worldX - radius * Chunk.SIZE;
	gridOrigin.y = worldZ - radius * Chunk.SIZE;
	material.setVector2("gridOriginWorld", gridOrigin);

	positionVB?.update(pos);
	normalVB?.update(nrm);

	if (USE_LA_TILE_TEXTURE) {
		if (tiles.length !== surfaceTileLookupData.length) {
			for (let i = 0, j = 0; i < tiles.length; i += 2, j += 2) {
				surfaceTileLookupData[j] = tiles[i];
				surfaceTileLookupData[j + 1] = tiles[i + 1];
			}
		} else {
			surfaceTileLookupData.set(tiles);
		}
	} else {
		for (let src = 0, dst = 0; src < tiles.length; src += 2, dst += 4) {
			surfaceTileLookupData[dst] = tiles[src];
			surfaceTileLookupData[dst + 1] = tiles[src + 1];
			surfaceTileLookupData[dst + 2] = 0;
			surfaceTileLookupData[dst + 3] = 255;
		}
	}

	surfaceTileLookupTexture.update(surfaceTileLookupData);
}

// =====================================================================
// Public API
// =====================================================================

export function init() {
	if (initialized) return;

	radius = SETTING_PARAMS.DISTANT_RENDER_DISTANCE;
	const segments = Math.floor((radius * 2) / gridStep);
	gridResolution = segments + 1;
	const size = radius * 2 * Chunk.SIZE;

	if (
		typeof SharedArrayBuffer === "undefined" ||
		(typeof self !== "undefined" &&
			"crossOriginIsolated" in self &&
			!self.crossOriginIsolated)
	) {
		throw new Error(
			"DistantTerrain requires SharedArrayBuffer. " +
				"Make sure crossOriginIsolated is true and your dev server sends " +
				"Cross-Origin-Opener-Policy: same-origin and " +
				"Cross-Origin-Embedder-Policy: require-corp.",
		);
	}

	const vertexCount = gridResolution * gridResolution;

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

	mesh = createEmptyGridMesh("distantTerrain", Map1.mainScene);
	mesh.sideOrientation = Mesh.FRONTSIDE;

	waterMesh = MeshBuilder.CreateGround(
		"distantWater",
		{
			width: size,
			height: size,
			subdivisions: 1,
			updatable: false,
		},
		Map1.mainScene,
	);

	if (USE_LA_TILE_TEXTURE) {
		surfaceTileLookupData = new Uint8Array(gridResolution * gridResolution * 2);
		surfaceTileLookupTexture = RawTexture.CreateLuminanceAlphaTexture(
			surfaceTileLookupData,
			gridResolution,
			gridResolution,
			Map1.mainScene,
			false,
			false,
			Texture.NEAREST_SAMPLINGMODE,
		);
	} else {
		surfaceTileLookupData = new Uint8Array(gridResolution * gridResolution * 4);
		surfaceTileLookupTexture = RawTexture.CreateRGBATexture(
			surfaceTileLookupData,
			gridResolution,
			gridResolution,
			Map1.mainScene,
			false,
			false,
			Texture.NEAREST_SAMPLINGMODE,
		);
	}

	surfaceTileLookupTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
	surfaceTileLookupTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

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

	Effect.ShadersStore.distantTerrainVertexShader = distantTerrainVertexShader;
	Effect.ShadersStore.distantTerrainFragmentShader =
		distantTerrainFragmentShader;
	Effect.ShadersStore.distantWaterVertexShader = distantWaterVertexShader;
	Effect.ShadersStore.distantWaterFragmentShader = distantWaterFragmentShader;

	material = new ShaderMaterial(
		"distantTerrainMat",
		Map1.mainScene,
		{ vertex: "distantTerrain", fragment: "distantTerrain" },
		{
			attributes: ["position", "normal"],
			uniforms: [
				"world",
				"worldViewProjection",
				"lightDirection",
				"sunLightIntensity",
				"atlasTileSize",
				"textureScale",
				"useTexture",
				"tileGridResolution",
				"gridOriginWorld",
				"gridWorldStep",
				"vFogInfos",
				"vFogColor",
				"cameraPosition",
			],
			samplers: ["diffuseTexture", "tileLookupTexture"],
		},
	);

	material.onBind = (m) => {
		const effect = material.getEffect();
		if (!effect) return;
		bindCommonUniforms(effect, m.getScene());
	};

	material.setFloat("atlasTileSize", atlasTileSize);
	material.setFloat("textureScale", 32);
	material.setFloat("tileGridResolution", gridResolution);
	material.setFloat("gridWorldStep", Chunk.SIZE * gridStep);
	material.setFloat("useTexture", 0);
	material.setTexture("tileLookupTexture", surfaceTileLookupTexture);

	bindDiffuseTexture();
	mesh.material = material;

	waterMaterial = new ShaderMaterial(
		"distantWaterMat",
		Map1.mainScene,
		{ vertex: "distantWater", fragment: "distantWater" },
		{
			attributes: ["position"],
			uniforms: [
				"world",
				"worldViewProjection",
				"lightDirection",
				"sunLightIntensity",
				"vFogInfos",
				"vFogColor",
				"cameraPosition",
			],
		},
	);

	waterMaterial.onBind = (m) => {
		const effect = waterMaterial.getEffect();
		if (!effect) return;
		bindCommonUniforms(effect, m.getScene());
	};

	waterMesh.material = waterMaterial;

	mesh.isPickable = false;
	mesh.checkCollisions = false;
	mesh.receiveShadows = false;
	mesh.doNotSyncBoundingInfo = true;
	mesh.alwaysSelectAsActiveMesh = true;

	waterMesh.isPickable = false;
	waterMesh.checkCollisions = false;
	waterMesh.receiveShadows = false;
	waterMesh.doNotSyncBoundingInfo = true;
	waterMesh.alwaysSelectAsActiveMesh = true;

	if (Map1.mainScene._activeMeshesFrozen) {
		Map1.mainScene.unfreezeActiveMeshes();
		Map1.mainScene.freezeActiveMeshes();
	}

	initialized = true;
}

export function isInitialized(): boolean {
	return initialized;
}

export function update(worldX: number, worldZ: number) {
	const cx = worldToChunkCoord(worldX);
	const cz = worldToChunkCoord(worldZ);
	if (cx === lastChunkX && cz === lastChunkZ) return;
	lastChunkX = cx;
	lastChunkZ = cz;
	ChunkWorkerPool.getInstance().scheduleDistantTerrain(
		cx,
		cz,
		radius,
		SETTING_PARAMS.RENDER_DISTANCE,
		gridStep,
	);
}

export function dispose(): void {
	initialized = false;
}
