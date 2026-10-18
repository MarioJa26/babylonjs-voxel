import {
	type EngineContext,
	getCameraPosition,
	type Mesh,
	type SceneContext,
	type ShaderMaterial,
	setShaderUniform,
} from "@babylonjs/lite";
import { vec3Zero } from "@/code/Lib/Math";
import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import { Map1 } from "@/code/Maps/Map1";
import MapFog from "@/code/Maps/MapFog";
import { getEyeLiquid } from "@/code/Maps/UnderWaterEffect";
import {
	type LiquidDefinition,
	WATER_LIQUID,
} from "@/code/World/Liquid/LiquidRegistry";
import { GLOBAL_VALUES } from "../../GLOBAL_VALUES";
import {
	createLod2CutoutMaterial,
	createLod2OpaqueMaterial,
	createLod2TransparentMaterial,
} from "../../Light/Lod2ShaderLite";
import {
	createLod3CutoutMaterial,
	createLod3OpaqueMaterial,
	createLod3TransparentMaterial,
} from "../../Light/Lod3ShaderLite";
import {
	createLod4OpaqueMaterial,
	createLod4TransparentMaterial,
} from "../../Light/Lod4ShaderLite";
import {
	createChunkCutoutMaterial,
	createChunkOpaqueMaterial,
	createChunkTransparentMaterial,
} from "../../Light/OpaqueShaderLite";
import { carryMeshCulled } from "../../MeshVisibility";
import { packAtlas } from "../../Texture/AtlasPacker";
import {
	atlasTileSize,
	setDiffuseArray,
	setNormalArray,
} from "../../Texture/TextureAtlasFactory";
import type { Chunk } from "../Chunk";
import type { MeshData } from "../DataStructures/MeshData";
import {
	assignChunkToGroup,
	disposeAll,
	type MergedFaceRange,
	type MergedMeshGroup,
	setOnGroupMeshNeedsRebuild,
} from "./MergedMeshManager";
import {
	createPackedChunkMesh,
	destroyPackedArenas,
	disposePackedMesh,
	getFaceArenaCount,
	initPackedChunkArenas,
	type PackedMeshInput,
	updatePackedChunkMesh,
} from "./PackedChunkMesh";

const GROUP_SIZE = 4;
const GROUP_WORLD_SIZE = GROUP_SIZE * CHUNK_SIZE;

const LOD2_BUCKET = 2;
const LOD3_BUCKET = 3;
const LOD4_BUCKET = 4;
const MAX_LOD_BUCKET = 4;

const LIGHT_QUANTIZATION_SCALE = 256;
const LIGHT_QUANTIZATION_INVERSE = 1 / LIGHT_QUANTIZATION_SCALE;
const TRANSPARENT_TIME_UPDATE_INTERVAL = 3;
const UNIFORM_EPSILON = 0.00001;

let atlasMaterial: ShaderMaterial | null = null;
let transparentMaterial: ShaderMaterial | null = null;
let cutoutMaterial: ShaderMaterial | null = null;

let lod2OpaqueMaterial: ShaderMaterial | null = null;
let lod2CutoutMaterial: ShaderMaterial | null = null;
let lod2TransparentMaterial: ShaderMaterial | null = null;

let lod3OpaqueMaterial: ShaderMaterial | null = null;
let lod3CutoutMaterial: ShaderMaterial | null = null;
let lod3TransparentMaterial: ShaderMaterial | null = null;

let lod4OpaqueMaterial: ShaderMaterial | null = null;
let lod4TransparentMaterial: ShaderMaterial | null = null;

let engineRef: EngineContext | null = null;
let sceneRef: SceneContext | null = null;

const cachedUniforms = {
	lightDirection: { x: 0, y: 1, z: 0 },
	cameraPosition: vec3Zero(),
	time: 0,
	sunLightIntensity: 1,
	wetness: 0,
};

let lastUpdateFrame = -1;

const boatChunkOffsets = new Float32Array(192);
const materialList: ShaderMaterial[] = [];

const opaqueMaterialByLod: Array<ShaderMaterial | null> = [
	null,
	null,
	null,
	null,
	null,
];

const cutoutMaterialByLod: Array<ShaderMaterial | null> = [
	null,
	null,
	null,
	null,
	null,
];

const transparentMaterialByLod: Array<ShaderMaterial | null> = [
	null,
	null,
	null,
	null,
	null,
];

let materialListDirty = true;
let materialBucketsDirty = true;

let lastLX = 0;
let lastLY = 0;
let lastLZ = 0;
let lastSun = -1;
let lastWet = -1;

let timeFrameCounter = 0;

const lightDirArray = new Float32Array(3);
const fogInfosArray = new Float32Array(4);
const fogColorArray = new Float32Array(3);

let fogCachedStart = -1;
let fogCachedEnd = -1;
let fogCachedColorR = -1;
let fogCachedColorG = -1;
let fogCachedColorB = -1;
let fogCachedUnderwater = false;

const LOD_TINT_LUT = new Float32Array([
	1.0, 1.0, 1.0, 1.0, 0.96, 0.98, 1.02, 0.88, 1.04, 1.0, 0.92, 0.9, 0.92, 1.06,
	0.92, 1.05, 0.9, 0.98, 1.08, 0.9, 1.05, 0.97, 0.9, 0.95,
]);

const packedInputPosition: [number, number, number] = [0, 0, 0];
const packedInputBoundsMin: [number, number, number] = [0, 0, 0];
const packedInputBoundsMax: [number, number, number] = [0, 0, 0];

const packedInput: PackedMeshInput = {
	name: "",
	material: null as unknown as ShaderMaterial,
	faceData: null as unknown as Uint8Array,
	chunkOffsets: null as unknown as Float32Array,
	position: packedInputPosition,
	boundsMin: packedInputBoundsMin,
	boundsMax: packedInputBoundsMax,
};

function nearlyEqual(a: number, b: number): boolean {
	return Math.abs(a - b) <= UNIFORM_EPSILON;
}

function clampUnit(value: number): number {
	return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function quantizeLightingValue(value: number): number {
	return (
		Math.round(value * LIGHT_QUANTIZATION_SCALE) * LIGHT_QUANTIZATION_INVERSE
	);
}

function normalizeLodBucket(lod: number): number {
	return lod >= MAX_LOD_BUCKET
		? MAX_LOD_BUCKET
		: lod >= LOD3_BUCKET
			? LOD3_BUCKET
			: lod >= LOD2_BUCKET
				? LOD2_BUCKET
				: 0;
}

function populateMaterialBuckets(): void {
	if (!materialBucketsDirty) {
		return;
	}

	opaqueMaterialByLod[0] = atlasMaterial;
	opaqueMaterialByLod[1] = atlasMaterial;
	opaqueMaterialByLod[2] = lod2OpaqueMaterial;
	opaqueMaterialByLod[3] = lod3OpaqueMaterial;
	opaqueMaterialByLod[4] = lod4OpaqueMaterial;

	cutoutMaterialByLod[0] = cutoutMaterial;
	cutoutMaterialByLod[1] = cutoutMaterial;
	cutoutMaterialByLod[2] = lod2CutoutMaterial;
	cutoutMaterialByLod[3] = lod3CutoutMaterial;
	cutoutMaterialByLod[4] = lod4TransparentMaterial;

	transparentMaterialByLod[0] = transparentMaterial;
	transparentMaterialByLod[1] = transparentMaterial;
	transparentMaterialByLod[2] = lod2TransparentMaterial;
	transparentMaterialByLod[3] = lod3TransparentMaterial;
	transparentMaterialByLod[4] = lod4TransparentMaterial;

	materialBucketsDirty = false;
}

function getOpaqueMaterialForLodBucket(lod: number): ShaderMaterial {
	populateMaterialBuckets();
	return opaqueMaterialByLod[normalizeLodBucket(lod)]!;
}

function getCutoutMaterialForLodBucket(lod: number): ShaderMaterial {
	populateMaterialBuckets();
	return cutoutMaterialByLod[normalizeLodBucket(lod)]!;
}

function getTransparentMaterialForLodBucket(lod: number): ShaderMaterial {
	populateMaterialBuckets();
	return transparentMaterialByLod[normalizeLodBucket(lod)]!;
}

function populateMaterialList(): void {
	if (!materialListDirty) {
		return;
	}

	materialList.length = 0;

	if (atlasMaterial) materialList.push(atlasMaterial);
	if (transparentMaterial) materialList.push(transparentMaterial);
	if (cutoutMaterial) materialList.push(cutoutMaterial);

	if (lod2OpaqueMaterial) materialList.push(lod2OpaqueMaterial);
	if (lod2CutoutMaterial) materialList.push(lod2CutoutMaterial);
	if (lod2TransparentMaterial) {
		materialList.push(lod2TransparentMaterial);
	}

	if (lod3OpaqueMaterial) materialList.push(lod3OpaqueMaterial);
	if (lod3CutoutMaterial) materialList.push(lod3CutoutMaterial);
	if (lod3TransparentMaterial) {
		materialList.push(lod3TransparentMaterial);
	}

	if (lod4OpaqueMaterial) materialList.push(lod4OpaqueMaterial);
	if (lod4TransparentMaterial) {
		materialList.push(lod4TransparentMaterial);
	}

	materialListDirty = false;
}

function hasStaticLightingChanged(): boolean {
	const uniforms = cachedUniforms;
	const direction = uniforms.lightDirection;

	return (
		!nearlyEqual(direction.x, lastLX) ||
		!nearlyEqual(direction.y, lastLY) ||
		!nearlyEqual(direction.z, lastLZ) ||
		!nearlyEqual(uniforms.sunLightIntensity, lastSun) ||
		!nearlyEqual(uniforms.wetness, lastWet)
	);
}

function cacheStaticLightingState(): void {
	const uniforms = cachedUniforms;
	const direction = uniforms.lightDirection;

	lastLX = direction.x;
	lastLY = direction.y;
	lastLZ = direction.z;
	lastSun = uniforms.sunLightIntensity;
	lastWet = uniforms.wetness;

	lightDirArray[0] = direction.x;
	lightDirArray[1] = direction.y;
	lightDirArray[2] = direction.z;
}

function setStaticMaterialUniforms(material: ShaderMaterial): void {
	setShaderUniform(material, "lightDirection", lightDirArray);
	setShaderUniform(
		material,
		"sunLightIntensity",
		cachedUniforms.sunLightIntensity,
	);

	const wetness = cachedUniforms.wetness;

	if (
		material === atlasMaterial ||
		material === lod2OpaqueMaterial ||
		material === lod3OpaqueMaterial ||
		material === lod4OpaqueMaterial
	) {
		setShaderUniform(material, "wetness", wetness);
	}

	if (material === cutoutMaterial) {
		setShaderUniform(material, "cutoutWetDiffuseMul", 1 - 0.35 * wetness);
	}
}

function setTransparentTimeUniform(time: number): void {
	if (transparentMaterial) {
		setShaderUniform(transparentMaterial, "time", time);
	}
}

function materialUsesFog(material: ShaderMaterial): boolean {
	return material !== atlasMaterial && material !== cutoutMaterial;
}

function pushFogUniforms(): void {
	populateMaterialList();

	let liquid: LiquidDefinition | null = null;
	const scene = sceneRef;

	if (scene?.camera) {
		const position = getCameraPosition(scene.camera);

		liquid = getEyeLiquid(position.x, position.y, position.z);
	}

	// Water keeps the MapFog values (including dev overrides); lava and oil
	// use their registry fog so the sky matches the dense overlay.
	const underwater = liquid !== null;
	const liquidFog = underwater && liquid !== WATER_LIQUID ? liquid : null;

	const start = liquidFog ? liquidFog.fogStart : MapFog.getFogStart(underwater);
	const end = liquidFog ? liquidFog.fogEnd : MapFog.getFogEnd(underwater);
	const color = liquidFog ? liquidFog.fogColor : MapFog.getFogColor(underwater);

	const r = color[0];
	const g = color[1];
	const b = color[2];

	if (
		underwater === fogCachedUnderwater &&
		nearlyEqual(start, fogCachedStart) &&
		nearlyEqual(end, fogCachedEnd) &&
		nearlyEqual(r, fogCachedColorR) &&
		nearlyEqual(g, fogCachedColorG) &&
		nearlyEqual(b, fogCachedColorB)
	) {
		return;
	}

	fogCachedStart = start;
	fogCachedEnd = end;
	fogCachedColorR = r;
	fogCachedColorG = g;
	fogCachedColorB = b;
	fogCachedUnderwater = underwater;

	fogInfosArray[0] = 0;
	fogInfosArray[1] = start;
	fogInfosArray[2] = end;
	fogInfosArray[3] = 0;

	fogColorArray[0] = r;
	fogColorArray[1] = g;
	fogColorArray[2] = b;

	for (let i = 0, count = materialList.length; i < count; i++) {
		const material = materialList[i];

		if (!materialUsesFog(material)) {
			continue;
		}

		setShaderUniform(material, "fogInfos", fogInfosArray);
		setShaderUniform(material, "fogColor", fogColorArray);
	}
}

function resetPackedInputSpatialData(
	x: number,
	y: number,
	z: number,
	size: number,
): void {
	packedInputPosition[0] = x;
	packedInputPosition[1] = y;
	packedInputPosition[2] = z;

	packedInputBoundsMin[0] = x;
	packedInputBoundsMin[1] = y;
	packedInputBoundsMin[2] = z;

	packedInputBoundsMax[0] = x + size;
	packedInputBoundsMax[1] = y + size;
	packedInputBoundsMax[2] = z + size;
}

function preparePackedInput(
	material: ShaderMaterial,
	faceData: Uint8Array,
	chunkOffsets: Float32Array,
	x: number,
	y: number,
	z: number,
	boundsSize: number,
): PackedMeshInput {
	packedInput.name = "";
	packedInput.material = material;
	packedInput.faceData = faceData;
	packedInput.chunkOffsets = chunkOffsets;

	resetPackedInputSpatialData(x, y, z, boundsSize);

	return packedInput;
}

function createOrUpdatePackedMesh(
	existingMesh: Mesh | null,
	input: PackedMeshInput,
	dirtyRanges?: readonly MergedFaceRange[] | null,
	renderOrder = 0,
): Mesh | null {
	if (!existingMesh) {
		const mesh = createPackedChunkMesh(input);

		if (!mesh) {
			return null;
		}

		mesh.renderOrder = renderOrder;
		return mesh;
	}

	const mesh =
		updatePackedChunkMesh(existingMesh, input, dirtyRanges) ?? existingMesh;

	if (mesh.material !== input.material) {
		mesh.material = input.material;
	}

	mesh.renderOrder = renderOrder;
	return mesh;
}

function buildLiteMesh(
	group: MergedMeshGroup,
	existingMesh: Mesh | null,
	mergedData: {
		faceData: Uint8Array;
		faceCount: number;
	},
	material: ShaderMaterial,
	originX: number,
	originY: number,
	originZ: number,
	dirtyRanges: readonly MergedFaceRange[] | null,
	renderOrder = 0,
): Mesh | null {
	const input = preparePackedInput(
		material,
		mergedData.faceData,
		group.chunkOffsets,
		originX,
		originY,
		originZ,
		GROUP_WORLD_SIZE,
	);

	return createOrUpdatePackedMesh(
		existingMesh,
		input,
		dirtyRanges,
		renderOrder,
	);
}

function updateBoatMesh(
	existingMesh: Mesh | null,
	data: MeshData | null,
	material: ShaderMaterial,
	renderOrder: number,
): Mesh | null {
	if (!data || data.faceCount <= 0) {
		if (existingMesh) {
			disposePackedMesh(existingMesh);
		}

		return null;
	}

	const input = preparePackedInput(
		material,
		data.faceData,
		boatChunkOffsets,
		0,
		0,
		0,
		0,
	);

	return createOrUpdatePackedMesh(existingMesh, input, null, renderOrder);
}

function createBoatChunkMesh(
	chunk: Chunk,
	opaqueData: MeshData | null,
	waterData: MeshData | null,
	cutoutData: MeshData | null,
): void {
	const validOpaque =
		opaqueData && opaqueData.faceCount > 0 ? opaqueData : null;

	const validWater = waterData && waterData.faceCount > 0 ? waterData : null;

	const validCutout =
		cutoutData && cutoutData.faceCount > 0 ? cutoutData : null;

	chunk.mesh = updateBoatMesh(
		chunk.mesh,
		validOpaque,
		getOpaqueMaterialForLodBucket(0),
		0,
	);

	chunk.cutoutMesh = updateBoatMesh(
		chunk.cutoutMesh as Mesh | null,
		validCutout,
		getCutoutMaterialForLodBucket(0),
		0,
	);

	chunk.waterMesh = updateBoatMesh(
		chunk.waterMesh as Mesh | null,
		validWater,
		getTransparentMaterialForLodBucket(0),
		1,
	);

	chunk.opaqueMeshData = validOpaque;
	chunk.waterMeshData = validWater;
	chunk.cutoutMeshData = validCutout;
}

function uploadTintLUT(): void {
	// LOD material factories bind their tint LUT directly.
}

export async function initAtlas(): Promise<void> {
	const scene = sceneRef;
	const engine = engineRef;

	if (!scene || !engine) {
		console.error("initAtlas(): engine/scene not initialised.");
		return;
	}

	initPackedChunkArenas(engine, scene);

	const {
		diffuse,
		normal,
		transparent: transparentTexture,
	} = await packAtlas(engine);

	setDiffuseArray(diffuse);
	setNormalArray(normal);

	const tileSize = atlasTileSize;
	const atlasMaxTiles = Math.floor(1 / tileSize + 0.5);

	if (!atlasMaterial) {
		const baseOptions = {
			engine,
			scene,
			tintLUT: LOD_TINT_LUT,
			atlasTileSize: tileSize,
			atlasMaxTiles,
			faceArenaCount: getFaceArenaCount(),
		};

		atlasMaterial = createChunkOpaqueMaterial({
			...baseOptions,
			diffuseTexture: diffuse,
			normalTexture: normal,
		});

		transparentMaterial = createChunkTransparentMaterial({
			...baseOptions,
			diffuseTexture: transparentTexture,
			normalTexture: null,
		});

		cutoutMaterial = createChunkCutoutMaterial({
			...baseOptions,
			diffuseTexture: transparentTexture,
			normalTexture: null,
		});

		lod2OpaqueMaterial = createLod2OpaqueMaterial({
			...baseOptions,
			diffuseTexture: diffuse,
		});

		lod2CutoutMaterial = createLod2CutoutMaterial({
			...baseOptions,
			diffuseTexture: transparentTexture,
		});

		lod2TransparentMaterial = createLod2TransparentMaterial({
			...baseOptions,
			diffuseTexture: transparentTexture,
		});

		lod3OpaqueMaterial = createLod3OpaqueMaterial({
			...baseOptions,
			diffuseTexture: diffuse,
		});

		lod3CutoutMaterial = createLod3CutoutMaterial({
			...baseOptions,
			diffuseTexture: transparentTexture,
		});

		lod3TransparentMaterial = createLod3TransparentMaterial({
			...baseOptions,
			diffuseTexture: transparentTexture,
		});

		lod4OpaqueMaterial = createLod4OpaqueMaterial({
			...baseOptions,
			diffuseTexture: diffuse,
		});

		lod4TransparentMaterial = createLod4TransparentMaterial({
			...baseOptions,
			diffuseTexture: transparentTexture,
		});

		materialListDirty = true;
		materialBucketsDirty = true;

		uploadTintLUT();
	}

	populateMaterialList();
	populateMaterialBuckets();
	cacheStaticLightingState();

	for (let i = 0, count = materialList.length; i < count; i++) {
		setStaticMaterialUniforms(materialList[i]);
	}

	setTransparentTimeUniform(performance.now() * 0.001);
	pushFogUniforms();
}

setOnGroupMeshNeedsRebuild((group) => {
	if (!sceneRef) {
		return;
	}

	const lod = group.lodBucket;

	const originX = group.gridX * GROUP_WORLD_SIZE;
	const originY = group.gridY * GROUP_WORLD_SIZE;
	const originZ = group.gridZ * GROUP_WORLD_SIZE;

	const cullReference =
		group.opaqueMeshRef ?? group.cutoutMeshRef ?? group.waterMeshRef;

	if (group.cachedOpaque && group.cachedOpaque.faceCount > 0) {
		const mesh = buildLiteMesh(
			group,
			group.opaqueMeshRef,
			group.cachedOpaque,
			getOpaqueMaterialForLodBucket(lod),
			originX,
			originY,
			originZ,
			group.dirtyOpaqueRanges,
			0,
		);

		if (mesh) {
			carryMeshCulled(cullReference, mesh);
			group.opaqueMeshRef = mesh;
		}
	} else if (group.opaqueMeshRef) {
		disposePackedMesh(group.opaqueMeshRef);
		group.opaqueMeshRef = null;
	}

	if (group.cachedCutout && group.cachedCutout.faceCount > 0) {
		const mesh = buildLiteMesh(
			group,
			group.cutoutMeshRef as Mesh | null,
			group.cachedCutout,
			getCutoutMaterialForLodBucket(lod),
			originX,
			originY,
			originZ,
			group.dirtyCutoutRanges,
			0,
		);

		if (mesh) {
			carryMeshCulled(cullReference, mesh);
			group.cutoutMeshRef = mesh;
		}
	} else if (group.cutoutMeshRef) {
		disposePackedMesh(group.cutoutMeshRef);
		group.cutoutMeshRef = null;
	}

	if (group.cachedWater && group.cachedWater.faceCount > 0) {
		const mesh = buildLiteMesh(
			group,
			group.waterMeshRef as Mesh | null,
			group.cachedWater,
			getTransparentMaterialForLodBucket(lod),
			originX,
			originY,
			originZ,
			group.dirtyWaterRanges,
			1,
		);

		if (mesh) {
			carryMeshCulled(cullReference, mesh);
			group.waterMeshRef = mesh;
		}
	} else if (group.waterMeshRef) {
		disposePackedMesh(group.waterMeshRef);
		group.waterMeshRef = null;
	}
});

export function createMeshFromData(
	chunk: Chunk,
	opaqueMeshData: MeshData | null,
	waterMeshData: MeshData | null,
	cutoutMeshData: MeshData | null,
): void {
	const opaque =
		opaqueMeshData && opaqueMeshData.faceCount > 0 ? opaqueMeshData : null;

	const water =
		waterMeshData && waterMeshData.faceCount > 0 ? waterMeshData : null;

	const cutout =
		cutoutMeshData && cutoutMeshData.faceCount > 0 ? cutoutMeshData : null;

	if (chunk.isBoatChunk) {
		createBoatChunkMesh(chunk, opaque, water, cutout);
		return;
	}

	if ((chunk.lodLevel ?? 0) === 0 && chunk.isModified) {
		chunk.opaqueMeshData = opaqueMeshData;
		chunk.waterMeshData = waterMeshData;
		chunk.cutoutMeshData = cutoutMeshData;
	} else {
		chunk.opaqueMeshData = null;
		chunk.waterMeshData = null;
		chunk.cutoutMeshData = null;
	}

	assignChunkToGroup(chunk, opaqueMeshData, waterMeshData, cutoutMeshData);
}

export function initEngineContext(
	engine: EngineContext,
	scene: SceneContext,
): void {
	engineRef = engine;
	sceneRef = scene;
}

export function updateGlobalUniforms(frameId: number): void {
	if (frameId === lastUpdateFrame || engineRef === null || sceneRef === null) {
		return;
	}

	lastUpdateFrame = frameId;

	const sourceDirection = GLOBAL_VALUES.skyLightDirection;
	const uniforms = cachedUniforms;
	const direction = uniforms.lightDirection;

	const lightY = sourceDirection.y;
	const shaderDirectionY = -lightY;

	const normalizedHorizon = clampUnit((shaderDirectionY + 0.2) * 2.5);

	const inverseHorizon = 1 - normalizedHorizon;
	const verticalBlend =
		inverseHorizon * inverseHorizon * (3 - 2 * inverseHorizon);

	const directionalBlend = 1 - verticalBlend;

	direction.x = quantizeLightingValue(-sourceDirection.x * directionalBlend);

	direction.y = quantizeLightingValue(
		-lightY * directionalBlend + verticalBlend,
	);

	direction.z = quantizeLightingValue(-sourceDirection.z * directionalBlend);

	uniforms.sunLightIntensity = quantizeLightingValue(
		clampUnit((-lightY + 0.1) * 4),
	);

	uniforms.wetness = Map1.environment?.wetness ?? 0;

	let updateTransparentTime = false;

	if (hasStaticLightingChanged()) {
		populateMaterialList();
		cacheStaticLightingState();

		for (let i = 0, count = materialList.length; i < count; i++) {
			setStaticMaterialUniforms(materialList[i]);
		}

		timeFrameCounter = 1;
		updateTransparentTime = transparentMaterial !== null;
	} else if (transparentMaterial !== null) {
		if (timeFrameCounter++ % TRANSPARENT_TIME_UPDATE_INTERVAL === 0) {
			updateTransparentTime = true;
		}
	}

	if (updateTransparentTime) {
		setTransparentTimeUniform(performance.now() * 0.001);
	}

	pushFogUniforms();
}

export function disposeSharedResources(): void {
	disposeAll();

	atlasMaterial = null;
	transparentMaterial = null;
	cutoutMaterial = null;

	lod2OpaqueMaterial = null;
	lod2CutoutMaterial = null;
	lod2TransparentMaterial = null;

	lod3OpaqueMaterial = null;
	lod3CutoutMaterial = null;
	lod3TransparentMaterial = null;

	lod4OpaqueMaterial = null;
	lod4TransparentMaterial = null;

	materialList.length = 0;

	for (let i = 0; i <= MAX_LOD_BUCKET; i++) {
		opaqueMaterialByLod[i] = null;
		cutoutMaterialByLod[i] = null;
		transparentMaterialByLod[i] = null;
	}

	destroyPackedArenas();

	engineRef = null;
	sceneRef = null;
	lastUpdateFrame = -1;

	materialListDirty = true;
	materialBucketsDirty = true;

	lastLX = 0;
	lastLY = 0;
	lastLZ = 0;
	lastSun = -1;
	lastWet = -1;

	timeFrameCounter = 0;

	fogCachedStart = -1;
	fogCachedEnd = -1;
	fogCachedColorR = -1;
	fogCachedColorG = -1;
	fogCachedColorB = -1;
	fogCachedUnderwater = false;
}
