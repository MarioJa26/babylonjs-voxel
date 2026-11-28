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

import { carryMeshCulled } from "../../MeshVisibility";
import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import {
	createLod2CutoutMaterial,
	createLod2OpaqueMaterial,
	createLod2TransparentMaterial,
} from "../../Shader/Lod2ShaderLite";
import {
	createLod3CutoutMaterial,
	createLod3OpaqueMaterial,
	createLod3TransparentMaterial,
} from "../../Shader/Lod3ShaderLite";
import {
	createLod4OpaqueMaterial,
	createLod4TransparentMaterial,
} from "../../Shader/Lod4ShaderLite";
import {
	createChunkCutoutMaterial,
	createChunkOpaqueMaterial,
	createChunkTransparentMaterial,
} from "../../Shader/OpaqueShaderLite";
import {
	computeSunLightState,
	type SunLightState,
} from "../../Shader/SunLightState";
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
const MAX_LOD_BUCKET = 4;

const TRANSPARENT_TIME_UPDATE_INTERVAL = 3;
const UNIFORM_EPSILON = 1e-5;

// O(1) LOD -> bucket mapping (clamped 0..4)
const LOD_BUCKET_LUT = new Uint8Array([0, 0, 2, 3, 4]);

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
	brightness: 1,
	shadeSunScale: 0.96, // 0.8 * (1 + 0.2)
	shadeWetBright: 1,
};

const sunStateScratch: SunLightState = { x: 0, y: 1, z: 0, intensity: 1 };
const boatChunkOffsets = new Float32Array(192);

// Partitioned material lists for branchless, linear uniform updates
const allMaterials: ShaderMaterial[] = [];
const fogMaterials: ShaderMaterial[] = [];
const timeMaterials: ShaderMaterial[] = [];
const wetnessMaterials: ShaderMaterial[] = [];
const bakeShadeMaterials: ShaderMaterial[] = [];

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

let lastUpdateFrame = -1;
let lastLX = Number.NaN;
let lastLY = Number.NaN;
let lastLZ = Number.NaN;
let lastSun = Number.NaN;
let lastWet = Number.NaN;
let lastBrightness = Number.NaN;

let timeFrameCounter = 0;

const lightDirArray = new Float32Array(3);
const fogInfosArray = new Float32Array(4);
const fogColorArray = new Float32Array(3);

let fogCachedStart = Number.NaN;
let fogCachedEnd = Number.NaN;
let fogCachedColorR = Number.NaN;
let fogCachedColorG = Number.NaN;
let fogCachedColorB = Number.NaN;
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

function normalizeLodBucket(lod: number): number {
	const clamped = lod < 0 ? 0 : lod > MAX_LOD_BUCKET ? MAX_LOD_BUCKET : lod | 0;
	return LOD_BUCKET_LUT[clamped];
}

function rebuildMaterialTables(): void {
	allMaterials.length = 0;
	fogMaterials.length = 0;
	timeMaterials.length = 0;
	wetnessMaterials.length = 0;
	bakeShadeMaterials.length = 0;

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

	// All materials receive core lighting uniforms
	const candidates = [
		atlasMaterial,
		transparentMaterial,
		cutoutMaterial,
		lod2OpaqueMaterial,
		lod2CutoutMaterial,
		lod2TransparentMaterial,
		lod3OpaqueMaterial,
		lod3CutoutMaterial,
		lod3TransparentMaterial,
		lod4OpaqueMaterial,
		lod4TransparentMaterial,
	];

	for (let i = 0; i < candidates.length; i++) {
		const mat = candidates[i];
		if (mat) {
			allMaterials.push(mat);
		}
	}

	// Fog-enabled materials (all except LOD0/1 opaque & cutout)
	const fogCandidates = [
		transparentMaterial,
		lod2OpaqueMaterial,
		lod2CutoutMaterial,
		lod2TransparentMaterial,
		lod3OpaqueMaterial,
		lod3CutoutMaterial,
		lod3TransparentMaterial,
		lod4OpaqueMaterial,
		lod4TransparentMaterial,
	];
	for (let i = 0; i < fogCandidates.length; i++) {
		const mat = fogCandidates[i];
		if (mat) fogMaterials.push(mat);
	}

	// Animated time materials
	const timeCandidates = [
		transparentMaterial,
		cutoutMaterial,
		lod2CutoutMaterial,
		lod3CutoutMaterial,
		lod4TransparentMaterial,
	];
	for (let i = 0; i < timeCandidates.length; i++) {
		const mat = timeCandidates[i];
		if (mat) timeMaterials.push(mat);
	}

	// Direct wetness uniform materials
	const wetCandidates = [
		atlasMaterial,
		lod2OpaqueMaterial,
		lod3OpaqueMaterial,
		lod4OpaqueMaterial,
	];
	for (let i = 0; i < wetCandidates.length; i++) {
		const mat = wetCandidates[i];
		if (mat) wetnessMaterials.push(mat);
	}

	// Pre-folded bakeShade materials
	const bakeCandidates = [
		lod2OpaqueMaterial,
		lod2CutoutMaterial,
		lod2TransparentMaterial,
		lod3OpaqueMaterial,
		lod3CutoutMaterial,
		lod3TransparentMaterial,
		lod4OpaqueMaterial,
		lod4TransparentMaterial,
	];
	for (let i = 0; i < bakeCandidates.length; i++) {
		const mat = bakeCandidates[i];
		if (mat) bakeShadeMaterials.push(mat);
	}
}

function pushStaticLightingUniforms(): void {
	const uniforms = cachedUniforms;
	const sunIntensity = uniforms.sunLightIntensity;
	const brightness = uniforms.brightness;
	const wetness = uniforms.wetness;
	const shadeSunScale = uniforms.shadeSunScale;
	const shadeWetBright = uniforms.shadeWetBright;

	for (let i = 0, len = allMaterials.length; i < len; i++) {
		const mat = allMaterials[i];
		setShaderUniform(mat, "lightDirection", lightDirArray);
		setShaderUniform(mat, "sunLightIntensity", sunIntensity);
		setShaderUniform(mat, "brightness", brightness);
	}

	for (let i = 0, len = wetnessMaterials.length; i < len; i++) {
		setShaderUniform(wetnessMaterials[i], "wetness", wetness);
	}

	if (cutoutMaterial) {
		setShaderUniform(cutoutMaterial, "cutoutWetDiffuseMul", 1 - 0.35 * wetness);
	}

	for (let i = 0, len = bakeShadeMaterials.length; i < len; i++) {
		const mat = bakeShadeMaterials[i];
		setShaderUniform(mat, "shadeSunScale", shadeSunScale);
		setShaderUniform(mat, "shadeWetBright", shadeWetBright);
	}
}

function setTransparentTimeUniform(time: number): void {
	for (let i = 0, len = timeMaterials.length; i < len; i++) {
		setShaderUniform(timeMaterials[i], "time", time);
	}
}

function pushFogUniforms(): void {
	const scene = sceneRef;
	let liquid: LiquidDefinition | null = null;

	if (scene?.camera) {
		const position = getCameraPosition(scene.camera);
		liquid = getEyeLiquid(position.x, position.y, position.z);
	}

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

	for (let i = 0, len = fogMaterials.length; i < len; i++) {
		const material = fogMaterials[i];
		setShaderUniform(material, "fogInfos", fogInfosArray);
		setShaderUniform(material, "fogColor", fogColorArray);
	}
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
	packedInput.material = material;
	packedInput.faceData = faceData;
	packedInput.chunkOffsets = chunkOffsets;

	packedInputPosition[0] = x;
	packedInputPosition[1] = y;
	packedInputPosition[2] = z;

	packedInputBoundsMin[0] = x;
	packedInputBoundsMin[1] = y;
	packedInputBoundsMin[2] = z;

	packedInputBoundsMax[0] = x + boundsSize;
	packedInputBoundsMax[1] = y + boundsSize;
	packedInputBoundsMax[2] = z + boundsSize;

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
		if (!mesh) return null;
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

function syncGroupLayer(
	group: MergedMeshGroup,
	existingMesh: Mesh | null,
	mergedData: { faceData: Uint8Array; faceCount: number } | null | undefined,
	material: ShaderMaterial,
	originX: number,
	originY: number,
	originZ: number,
	dirtyRanges: readonly MergedFaceRange[] | null,
	cullReference: Mesh | null,
	renderOrder: number,
): Mesh | null {
	if (!mergedData || mergedData.faceCount <= 0) {
		if (existingMesh) {
			disposePackedMesh(existingMesh);
		}
		return null;
	}

	const input = preparePackedInput(
		material,
		mergedData.faceData,
		group.chunkOffsets,
		originX,
		originY,
		originZ,
		GROUP_WORLD_SIZE,
	);

	const mesh = createOrUpdatePackedMesh(
		existingMesh,
		input,
		dirtyRanges,
		renderOrder,
	);

	if (mesh) {
		carryMeshCulled(cullReference, mesh);
	}

	return mesh;
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
		opaqueMaterialByLod[0]!,
		0,
	);
	chunk.cutoutMesh = updateBoatMesh(
		chunk.cutoutMesh as Mesh | null,
		validCutout,
		cutoutMaterialByLod[0]!,
		0,
	);
	chunk.waterMesh = updateBoatMesh(
		chunk.waterMesh as Mesh | null,
		validWater,
		transparentMaterialByLod[0]!,
		1,
	);

	chunk.opaqueMeshData = validOpaque;
	chunk.waterMeshData = validWater;
	chunk.cutoutMeshData = validCutout;
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

		rebuildMaterialTables();
	}

	// Sync initial lighting state
	const direction = cachedUniforms.lightDirection;
	lastLX = direction.x;
	lastLY = direction.y;
	lastLZ = direction.z;
	lastSun = cachedUniforms.sunLightIntensity;
	lastWet = cachedUniforms.wetness;
	lastBrightness = SETTING_PARAMS.BRIGHTNESS;
	cachedUniforms.brightness = lastBrightness;

	lightDirArray[0] = direction.x;
	lightDirArray[1] = direction.y;
	lightDirArray[2] = direction.z;

	pushStaticLightingUniforms();
	setTransparentTimeUniform(performance.now() * 0.001);
	pushFogUniforms();
}

setOnGroupMeshNeedsRebuild((group) => {
	if (!sceneRef) return;

	const lodBucket = normalizeLodBucket(group.lodBucket);
	const originX = group.gridX * GROUP_WORLD_SIZE;
	const originY = group.gridY * GROUP_WORLD_SIZE;
	const originZ = group.gridZ * GROUP_WORLD_SIZE;

	const cullReference =
		group.opaqueMeshRef ?? group.cutoutMeshRef ?? group.waterMeshRef;

	group.opaqueMeshRef = syncGroupLayer(
		group,
		group.opaqueMeshRef,
		group.cachedOpaque,
		opaqueMaterialByLod[lodBucket]!,
		originX,
		originY,
		originZ,
		group.dirtyOpaqueRanges,
		cullReference,
		0,
	);

	group.cutoutMeshRef = syncGroupLayer(
		group,
		group.cutoutMeshRef as Mesh | null,
		group.cachedCutout,
		cutoutMaterialByLod[lodBucket]!,
		originX,
		originY,
		originZ,
		group.dirtyCutoutRanges,
		cullReference,
		0,
	);

	group.waterMeshRef = syncGroupLayer(
		group,
		group.waterMeshRef as Mesh | null,
		group.cachedWater,
		transparentMaterialByLod[lodBucket]!,
		originX,
		originY,
		originZ,
		group.dirtyWaterRanges,
		cullReference,
		1,
	);
});

export function createMeshFromData(
	chunk: Chunk,
	opaqueMeshData: MeshData | null,
	waterMeshData: MeshData | null,
	cutoutMeshData: MeshData | null,
	appliedLod?: number,
): void {
	const opaque =
		opaqueMeshData && opaqueMeshData.faceCount > 0 ? opaqueMeshData : null;
	const water =
		waterMeshData && waterMeshData.faceCount > 0 ? waterMeshData : null;
	const cutout =
		cutoutMeshData && cutoutMeshData.faceCount > 0 ? cutoutMeshData : null;

	chunk.appliedMeshLod = appliedLod ?? chunk.lodLevel ?? 0;

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

export function updateGlobalUniforms(
	frameId: number,
	nowSeconds = performance.now() * 0.001,
): void {
	if (frameId === lastUpdateFrame) {
		return;
	}
	lastUpdateFrame = frameId;

	const sun = computeSunLightState(sunStateScratch);
	const wetness = Map1.environment?.effectiveWetness ?? 0;
	const brightness = SETTING_PARAMS.BRIGHTNESS;

	const lightingChanged =
		!nearlyEqual(sun.x, lastLX) ||
		!nearlyEqual(sun.y, lastLY) ||
		!nearlyEqual(sun.z, lastLZ) ||
		!nearlyEqual(sun.intensity, lastSun) ||
		!nearlyEqual(wetness, lastWet) ||
		!nearlyEqual(brightness, lastBrightness);

	if (lightingChanged) {
		lastLX = sun.x;
		lastLY = sun.y;
		lastLZ = sun.z;
		lastSun = sun.intensity;
		lastWet = wetness;
		lastBrightness = brightness;

		const uniforms = cachedUniforms;
		uniforms.lightDirection.x = sun.x;
		uniforms.lightDirection.y = sun.y;
		uniforms.lightDirection.z = sun.z;
		uniforms.sunLightIntensity = sun.intensity;
		uniforms.wetness = wetness;
		uniforms.brightness = brightness;
		uniforms.shadeSunScale = 0.8 * (sun.intensity + 0.2);
		uniforms.shadeWetBright = (1 - 0.35 * wetness) * brightness;

		lightDirArray[0] = sun.x;
		lightDirArray[1] = sun.y;
		lightDirArray[2] = sun.z;

		pushStaticLightingUniforms();

		timeFrameCounter = 1;
		if (timeMaterials.length > 0) {
			setTransparentTimeUniform(nowSeconds);
		}
	} else if (
		timeMaterials.length > 0 &&
		timeFrameCounter++ % TRANSPARENT_TIME_UPDATE_INTERVAL === 0
	) {
		setTransparentTimeUniform(nowSeconds);
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

	allMaterials.length = 0;
	fogMaterials.length = 0;
	timeMaterials.length = 0;
	wetnessMaterials.length = 0;
	bakeShadeMaterials.length = 0;

	for (let i = 0; i <= MAX_LOD_BUCKET; i++) {
		opaqueMaterialByLod[i] = null;
		cutoutMaterialByLod[i] = null;
		transparentMaterialByLod[i] = null;
	}

	destroyPackedArenas();

	engineRef = null;
	sceneRef = null;
	lastUpdateFrame = -1;

	lastLX = Number.NaN;
	lastLY = Number.NaN;
	lastLZ = Number.NaN;
	lastSun = Number.NaN;
	lastWet = Number.NaN;
	lastBrightness = Number.NaN;

	timeFrameCounter = 0;

	fogCachedStart = Number.NaN;
	fogCachedEnd = Number.NaN;
	fogCachedColorR = Number.NaN;
	fogCachedColorG = Number.NaN;
	fogCachedColorB = Number.NaN;
	fogCachedUnderwater = false;
}
