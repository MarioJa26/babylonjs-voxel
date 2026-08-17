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
import { isEyeUnderwater } from "@/code/Maps/UnderWaterEffect";
import { GLOBAL_VALUES } from "../GLOBAL_VALUES";
import {
	createLod2OpaqueMaterial,
	createLod2TransparentMaterial,
} from "../Light/Lod2ShaderLite";
import {
	createLod3OpaqueMaterial,
	createLod3TransparentMaterial,
} from "../Light/Lod3ShaderLite";
import {
	createChunkCutoutMaterial,
	createChunkOpaqueMaterial,
	createChunkTransparentMaterial,
} from "../Light/OpaqueShaderLite";
import { packAtlas } from "../Texture/AtlasPacker";
import {
	atlasTileSize,
	setDiffuseArray,
	setNormalArray,
} from "../Texture/TextureAtlasFactory";
import type { Chunk } from "./Chunk";
import type { MeshData } from "./DataStructures/MeshData";
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

let atlasMaterial: ShaderMaterial | null = null;
let transparentMaterial: ShaderMaterial | null = null;
let cutoutMaterial: ShaderMaterial | null = null;
let lod3OpaqueMaterial: ShaderMaterial | null = null;
let lod3TransparentMaterial: ShaderMaterial | null = null;
let lod2OpaqueMaterial: ShaderMaterial | null = null;
let lod2TransparentMaterial: ShaderMaterial | null = null;

let engineRef: EngineContext | null = null;
let sceneRef: SceneContext | null = null;

// Per-frame fog (no Babylon scene.fog in Lite) — sourced from MapFog below.

const cachedUniforms = {
	lightDirection: { x: 0, y: 1, z: 0 },
	cameraPosition: vec3Zero(),
	time: 0,
	sunLightIntensity: 1.0,
	wetness: 0,
};

let lastUpdateFrame = -1;

// ── Allocation-reducing pools / reused state ──────────────────────────────────

// Boat chunks are standalone (all subchunk offsets zero) — reused every rebuild.
const boatChunkOffsets = new Float32Array(192);

// Reused material list so the per-frame uniform pass doesn't allocate a new
// 6-element array on every call.
const materialList: ShaderMaterial[] = [];

let materialListDirty = true;

function populateMaterialList(): void {
	if (!materialListDirty) return;

	materialList.length = 0;
	if (atlasMaterial) materialList.push(atlasMaterial);
	if (transparentMaterial) materialList.push(transparentMaterial);
	if (cutoutMaterial) materialList.push(cutoutMaterial);
	if (lod2OpaqueMaterial) materialList.push(lod2OpaqueMaterial);
	if (lod2TransparentMaterial) materialList.push(lod2TransparentMaterial);
	if (lod3OpaqueMaterial) materialList.push(lod3OpaqueMaterial);
	if (lod3TransparentMaterial) materialList.push(lod3TransparentMaterial);

	materialListDirty = false;
}

// Static-uniform dirty tracking: skip the 6-material GPU uniform write when the
// scene lighting hasn't changed (only the animated `time` uniform keeps updating).
const UNIFORM_EPSILON = 0.00001;
let lastLX = 0;
let lastLY = 0;
let lastLZ = 0;
let lastSun = -1;
let lastWet = -1;
let _timeFrameCounter = 0;

function nearlyEqual(a: number, b: number, eps = UNIFORM_EPSILON): boolean {
	return Math.abs(a - b) <= eps;
}

function getOpaqueMaterialForLodBucket(lod: number): ShaderMaterial {
	return lod >= 3
		? lod3OpaqueMaterial!
		: lod >= 2
			? lod2OpaqueMaterial!
			: atlasMaterial!;
}

function getTransparentMaterialForLodBucket(lod: number): ShaderMaterial {
	return lod >= 3
		? lod3TransparentMaterial!
		: lod >= 2
			? lod2TransparentMaterial!
			: transparentMaterial!;
}

/**
 * Cutout (alpha-test) bucket material per LOD. Near chunks use the cheap
 * dedicated cutout material; LOD2/LOD3 reuse their existing transparent
 * materials (no water-only uniforms there, so both meshes look identical to
 * the old single transparent mesh).
 */
function getCutoutMaterialForLodBucket(lod: number): ShaderMaterial {
	return lod >= 3
		? lod3TransparentMaterial!
		: lod >= 2
			? lod2TransparentMaterial!
			: cutoutMaterial!;
}

// Constant per-bucket tint applied by the LOD2/LOD3 shaders' applyTintBucket.
// 6 × vec4 (rgb = tint, a = mix amount). Mirrors the classic port's LUT
// (ChunkMesher.core.ts.bak:838). Must be populated — an all-zero buffer makes
// every LOD2/LOD3 fragment render black.
const LOD_TINT_LUT = new Float32Array([
	1.0,
	1.0,
	1.0,
	1.0, // bucket 0 (no tint)
	0.96,
	0.98,
	1.02,
	0.88, // 1
	1.04,
	1.0,
	0.92,
	0.9, // 2
	0.92,
	1.06,
	0.92,
	1.05, // 3
	0.9,
	0.98,
	1.08,
	0.9, // 4
	1.05,
	0.97,
	0.9,
	0.95, // 5
]);

function uploadTintLUT(): void {
	// LOD materials bind their own tintLUT in their factories.
}

const fogInfosArray = new Float32Array(4);
const fogColorArray = new Float32Array(3);

function hasStaticLightingChanged(): boolean {
	const u = cachedUniforms;
	return (
		!nearlyEqual(u.lightDirection.x, lastLX) ||
		!nearlyEqual(u.lightDirection.y, lastLY) ||
		!nearlyEqual(u.lightDirection.z, lastLZ) ||
		!nearlyEqual(u.sunLightIntensity, lastSun) ||
		!nearlyEqual(u.wetness, lastWet)
	);
}

function cacheStaticLightingState(): void {
	const u = cachedUniforms;
	lastLX = u.lightDirection.x;
	lastLY = u.lightDirection.y;
	lastLZ = u.lightDirection.z;
	lastSun = u.sunLightIntensity;
	lastWet = u.wetness;
	lightDirArray[0] = u.lightDirection.x;
	lightDirArray[1] = u.lightDirection.y;
	lightDirArray[2] = u.lightDirection.z;
}

function setStaticMaterialUniforms(m: ShaderMaterial): void {
	setShaderUniform(m, "lightDirection", lightDirArray);
	setShaderUniform(m, "sunLightIntensity", cachedUniforms.sunLightIntensity);

	const wetness = cachedUniforms.wetness;

	// Near + LOD opaque shaders declare/use shaderUniforms.wetness.
	if (
		m === atlasMaterial ||
		m === lod2OpaqueMaterial ||
		m === lod3OpaqueMaterial
	) {
		setShaderUniform(m, "wetness", wetness);
	}

	// Cutout does not get normal/specular wetness. It only gets cheap diffuse
	// wetness via cutoutWetDiffuseMul (darken toward 0.65 when wet).
	if (m === cutoutMaterial) {
		setShaderUniform(m, "cutoutWetDiffuseMul", 1.0 + (0.65 - 1.0) * wetness);
	}
}

function setTransparentTimeUniform(time: number): void {
	// Only the near transparent shader declares/uses `time`; Lite prunes it
	// from the other materials' generated uniform struct, so guard the write.
	if (transparentMaterial) {
		setShaderUniform(transparentMaterial, "time", time);
	}
}

// Push fog uniforms from MapFog every frame so the debug fog sliders and
// underwater transitions affect chunk + LOD2 + LOD3 together. Layout is
// [0, start, end, 0] — the vertex shader reads .y = start, .z = end.
let _fogCachedStart = -1;
let _fogCachedEnd = -1;
let _fogCachedColorR = -1;
let _fogCachedColorG = -1;
let _fogCachedColorB = -1;
let _fogCachedUnderwater = false;

function pushFogUniforms(): void {
	populateMaterialList();

	const camera = sceneRef ? sceneRef.camera : null;
	let isUnderWater = false;

	if (camera) {
		const p = getCameraPosition(camera);
		isUnderWater = isEyeUnderwater(p.x, p.y, p.z);
	}

	const start = MapFog.getFogStart(isUnderWater);
	const end = MapFog.getFogEnd(isUnderWater);
	const color = MapFog.getFogColor(isUnderWater);

	const r = color[0];
	const g = color[1];
	const b = color[2];

	if (
		nearlyEqual(start, _fogCachedStart) &&
		nearlyEqual(end, _fogCachedEnd) &&
		nearlyEqual(r, _fogCachedColorR) &&
		nearlyEqual(g, _fogCachedColorG) &&
		nearlyEqual(b, _fogCachedColorB) &&
		isUnderWater === _fogCachedUnderwater
	) {
		return;
	}

	_fogCachedStart = start;
	_fogCachedEnd = end;
	_fogCachedColorR = r;
	_fogCachedColorG = g;
	_fogCachedColorB = b;
	_fogCachedUnderwater = isUnderWater;

	fogInfosArray[0] = 0;
	fogInfosArray[1] = start;
	fogInfosArray[2] = end;
	fogInfosArray[3] = 0;

	fogColorArray[0] = r;
	fogColorArray[1] = g;
	fogColorArray[2] = b;

	for (let i = 0, n = materialList.length; i < n; i++) {
		const m = materialList[i];
		if (!m || !materialUsesFog(m)) continue;

		setShaderUniform(m, "fogInfos", fogInfosArray);
		setShaderUniform(m, "fogColor", fogColorArray);
	}
}
function materialUsesFog(m: ShaderMaterial): boolean {
	// Near opaque and near cutout are intended to be cheap/no-fog.
	// Water + LOD transparent/opaque keep fog.
	return m !== atlasMaterial && m !== cutoutMaterial;
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
	const atlasMaxTiles = Math.floor(1.0 / tileSize + 0.5);

	const baseOpts = {
		engine,
		scene,
		tintLUT: LOD_TINT_LUT,
		atlasTileSize: tileSize,
		atlasMaxTiles,
		faceArenaCount: getFaceArenaCount(),
	};

	if (!atlasMaterial) {
		atlasMaterial = createChunkOpaqueMaterial({
			...baseOpts,
			diffuseTexture: diffuse,
			normalTexture: normal,
		});

		transparentMaterial = createChunkTransparentMaterial({
			...baseOpts,
			diffuseTexture: transparentTexture,
			normalTexture: null,
		});

		cutoutMaterial = createChunkCutoutMaterial({
			...baseOpts,
			diffuseTexture: transparentTexture,
			normalTexture: null,
		});

		lod2OpaqueMaterial = createLod2OpaqueMaterial({
			...baseOpts,
			diffuseTexture: diffuse,
		});

		lod2TransparentMaterial = createLod2TransparentMaterial({
			...baseOpts,
			diffuseTexture: transparentTexture,
		});

		lod3OpaqueMaterial = createLod3OpaqueMaterial({
			...baseOpts,
			diffuseTexture: diffuse,
		});

		lod3TransparentMaterial = createLod3TransparentMaterial({
			...baseOpts,
			diffuseTexture: transparentTexture,
		});

		materialListDirty = true;
		uploadTintLUT();
	}

	populateMaterialList();

	// Important: setStaticMaterialUniforms reads lightDirArray, so cache it first.
	cacheStaticLightingState();

	for (let i = 0, n = materialList.length; i < n; i++) {
		const m = materialList[i];
		if (m) setStaticMaterialUniforms(m);
	}

	setTransparentTimeUniform(performance.now() * 0.001);
	pushFogUniforms();
}

const _packedInput: PackedMeshInput = {
	name: "",
	material: null as any,
	faceDataA: null as any,
	faceDataB: null as any,
	faceDataC: null as any,
	chunkOffsets: null as any,
	position: [0, 0, 0],
	boundsMin: [0, 0, 0],
	boundsMax: [0, 0, 0],
};

function buildLiteMesh(
	group: MergedMeshGroup,
	existingMesh: Mesh | null,
	mergedData: {
		faceDataA: Uint8Array;
		faceDataB: Uint8Array;
		faceDataC: Uint8Array;
		faceCount: number;
	},
	material: ShaderMaterial,
	originX: number,
	originY: number,
	originZ: number,
	dirtyRanges: readonly MergedFaceRange[] | null,
	renderOrder = 0,
): Mesh | null {
	const S = GROUP_SIZE * CHUNK_SIZE;
	const input = _packedInput;

	input.name = "";
	input.material = material;
	input.faceDataA = mergedData.faceDataA;
	input.faceDataB = mergedData.faceDataB;
	input.faceDataC = mergedData.faceDataC;
	input.chunkOffsets = group.chunkOffsets;

	input.position[0] = originX;
	input.position[1] = originY;
	input.position[2] = originZ;

	input.boundsMin[0] = originX;
	input.boundsMin[1] = originY;
	input.boundsMin[2] = originZ;

	input.boundsMax[0] = originX + S;
	input.boundsMax[1] = originY + S;
	input.boundsMax[2] = originZ + S;

	if (!existingMesh) {
		const created = createPackedChunkMesh(input);
		if (!created) return null;

		created.renderOrder = renderOrder;
		return created;
	}

	const updated = updatePackedChunkMesh(existingMesh, input, dirtyRanges);
	const mesh = updated ?? existingMesh;

	if (mesh.material !== material) {
		mesh.material = material;
	}

	mesh.renderOrder = renderOrder;
	return mesh;
}

setOnGroupMeshNeedsRebuild((group) => {
	if (!sceneRef) return;

	const lod = group.lodBucket;
	const S = CHUNK_SIZE;
	const G = GROUP_SIZE;

	const ox = group.gridX * G * S;
	const oy = group.gridY * G * S;
	const oz = group.gridZ * G * S;

	// 1. Opaque first.
	if (group.cachedOpaque && group.cachedOpaque.faceCount > 0) {
		const built = buildLiteMesh(
			group,
			group.opaqueMeshRef,
			group.cachedOpaque,
			getOpaqueMaterialForLodBucket(lod),
			ox,
			oy,
			oz,
			group.dirtyOpaqueRanges,
			0,
		);

		if (built) {
			group.opaqueMeshRef = built;
			built.visible = true;
		}
	} else if (group.opaqueMeshRef) {
		disposePackedMesh(group.opaqueMeshRef);
		group.opaqueMeshRef = null;
	}

	// 2. Cutout before water so alpha-tested pixels can populate depth.
	if (group.cachedCutout && group.cachedCutout.faceCount > 0) {
		const built = buildLiteMesh(
			group,
			group.cutoutMeshRef as Mesh | null,
			group.cachedCutout,
			getCutoutMaterialForLodBucket(lod),
			ox,
			oy,
			oz,
			group.dirtyCutoutRanges,
			0,
		);

		if (built) {
			group.cutoutMeshRef = built;
			built.visible = true;
		}
	} else if (group.cutoutMeshRef) {
		disposePackedMesh(group.cutoutMeshRef);
		group.cutoutMeshRef = null;
	}

	// 3. Blended water last.
	if (group.cachedWater && group.cachedWater.faceCount > 0) {
		const built = buildLiteMesh(
			group,
			group.waterMeshRef as Mesh | null,
			group.cachedWater,
			getTransparentMaterialForLodBucket(lod),
			ox,
			oy,
			oz,
			group.dirtyWaterRanges,
			1,
		);

		if (built) {
			group.waterMeshRef = built;
			built.visible = true;
		}
	} else if (group.waterMeshRef) {
		disposePackedMesh(group.waterMeshRef);
		group.waterMeshRef = null;
	}
});

function buildBoatInput(
	material: ShaderMaterial,
	data: MeshData,
): PackedMeshInput {
	//_packedInput.name = "";
	_packedInput.material = material;
	_packedInput.faceDataA = data.faceDataA;
	_packedInput.faceDataB = data.faceDataB;
	_packedInput.faceDataC = data.faceDataC;
	_packedInput.chunkOffsets = boatChunkOffsets;
	// Boat chunks carry no world AABB, so they are never frustum-culled.

	// _packedInput is a shared scratch object also written by buildLiteMesh, so
	// every field must be set explicitly. Boat chunk meshes are parented to the
	// boat's visualRoot and repositioned to -center by BoatChunk.syncVisualMeshes,
	// so they live at local origin; reset position here to avoid inheriting the
	// last group origin buildLiteMesh left in the scratch object (causes flicker).
	_packedInput.position[0] = 0;
	_packedInput.position[1] = 0;
	_packedInput.position[2] = 0;

	_packedInput.boundsMin[0] = 0;
	_packedInput.boundsMin[1] = 0;
	_packedInput.boundsMin[2] = 0;

	_packedInput.boundsMax[0] = 0;
	_packedInput.boundsMax[1] = 0;
	_packedInput.boundsMax[2] = 0;

	return _packedInput;
}

function createBoatChunkMesh(
	chunk: Chunk,
	opaqueData: MeshData | null,
	waterData: MeshData | null,
	cutoutData: MeshData | null,
): void {
	const hasOpaque = !!opaqueData && opaqueData.faceCount > 0;
	const hasWater = !!waterData && waterData.faceCount > 0;
	const hasCutout = !!cutoutData && cutoutData.faceCount > 0;

	const matOpaque = getOpaqueMaterialForLodBucket(0);
	const matWater = getTransparentMaterialForLodBucket(0);
	const matCutout = getCutoutMaterialForLodBucket(0);

	// Cache coords locally (avoids repeated property access)
	const x = chunk.chunkX;
	const y = chunk.chunkY;
	const z = chunk.chunkZ;

	// ---- OPAQUE ----
	let mesh = chunk.mesh;

	if (hasOpaque) {
		const input = buildBoatInput(matOpaque, opaqueData!);

		if (mesh) {
			const updated = updatePackedChunkMesh(mesh, input);
			mesh = updated ?? mesh;

			if (mesh.material !== matOpaque) {
				mesh.material = matOpaque;
			}
		} else {
			mesh = createPackedChunkMesh(input) as Mesh | null;
		}
	} else if (mesh) {
		disposePackedMesh(mesh);
		mesh = null;
	}

	chunk.mesh = mesh;

	// ---- WATER ----
	let wMesh = chunk.waterMesh as Mesh | null;

	if (hasWater) {
		const input = buildBoatInput(matWater, waterData!);

		if (wMesh) {
			const updated = updatePackedChunkMesh(wMesh, input);
			wMesh = updated ?? wMesh;

			if (wMesh.material !== matWater) {
				wMesh.material = matWater;
			}
		} else {
			wMesh = createPackedChunkMesh(input) as Mesh | null;
		}
	} else if (wMesh) {
		disposePackedMesh(wMesh);
		wMesh = null;
	}

	chunk.waterMesh = wMesh;

	// ---- CUTOUT ----
	let cMesh = chunk.cutoutMesh as Mesh | null;

	if (hasCutout) {
		const input = buildBoatInput(matCutout, cutoutData!);

		if (cMesh) {
			const updated = updatePackedChunkMesh(cMesh, input);
			cMesh = updated ?? cMesh;

			if (cMesh.material !== matCutout) {
				cMesh.material = matCutout;
			}
		} else {
			cMesh = createPackedChunkMesh(input) as Mesh | null;
		}
	} else if (cMesh) {
		disposePackedMesh(cMesh);
		cMesh = null;
	}

	chunk.cutoutMesh = cMesh;

	// ---- DATA CACHE ----
	chunk.opaqueMeshData = hasOpaque ? opaqueData : null;
	chunk.waterMeshData = hasWater ? waterData : null;
	chunk.cutoutMeshData = hasCutout ? cutoutData : null;
}

export function createMeshFromData(
	chunk: Chunk,
	opaqueMeshData: MeshData | null,
	waterMeshData: MeshData | null,
	cutoutMeshData: MeshData | null,
): void {
	const hasOpaque = !!opaqueMeshData && opaqueMeshData.faceCount > 0;
	const hasWater = !!waterMeshData && waterMeshData.faceCount > 0;
	const hasCutout = !!cutoutMeshData && cutoutMeshData.faceCount > 0;

	if (chunk.isBoatChunk) {
		createBoatChunkMesh(
			chunk,
			hasOpaque ? opaqueMeshData : null,
			hasWater ? waterMeshData : null,
			hasCutout ? cutoutMeshData : null,
		);
		return;
	}

	const lodLevel = chunk.lodLevel ?? 0;
	if (lodLevel === 0 && chunk.isModified) {
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

const lightDirArray = new Float32Array(3);
export function updateGlobalUniforms(frameId: number): void {
	if (lastUpdateFrame === frameId) return;
	lastUpdateFrame = frameId;

	if (!engineRef || !sceneRef) return;

	const lightDir = GLOBAL_VALUES.skyLightDirection;
	const u = cachedUniforms;

	const shaderDirY = -lightDir.y;
	const rawBlend = 1 - Math.min(1, Math.max(0, (shaderDirY + 0.2) / 0.4));
	const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
	const invBlend = 1 - blend;

	u.lightDirection.x = -lightDir.x * invBlend;
	u.lightDirection.y = -lightDir.y * invBlend + blend;
	u.lightDirection.z = -lightDir.z * invBlend;

	const rawIntensity = (-lightDir.y + 0.1) * 4.0;
	u.sunLightIntensity =
		rawIntensity < 0.0 ? 0.0 : rawIntensity > 1.0 ? 1.0 : rawIntensity;

	u.wetness = Map1.environment ? (Map1.environment.wetness ?? 0) : 0;

	if (hasStaticLightingChanged()) {
		populateMaterialList();
		cacheStaticLightingState();

		for (let i = 0, n = materialList.length; i < n; i++) {
			const m = materialList[i];
			if (m) setStaticMaterialUniforms(m);
		}

		setTransparentTimeUniform(performance.now() * 0.001);
		_timeFrameCounter = 1;
	} else if (transparentMaterial && _timeFrameCounter++ % 3 === 0) {
		setTransparentTimeUniform(performance.now() * 0.001);
	}

	pushFogUniforms();
}

export function disposeSharedResources(): void {
	disposeAll();

	atlasMaterial = null;
	transparentMaterial = null;
	cutoutMaterial = null;
	lod3OpaqueMaterial = null;
	lod3TransparentMaterial = null;
	lod2OpaqueMaterial = null;
	lod2TransparentMaterial = null;

	destroyPackedArenas();

	engineRef = null;
	sceneRef = null;
	lastUpdateFrame = -1;

	materialListDirty = true;

	// Safer if the world/session is recreated.
	lastLX = 0;
	lastLY = 0;
	lastLZ = 0;
	lastSun = -1;
	lastWet = -1;
	_timeFrameCounter = 0;

	_fogCachedStart = -1;
	_fogCachedEnd = -1;
	_fogCachedColorR = -1;
	_fogCachedColorG = -1;
	_fogCachedColorB = -1;
	_fogCachedUnderwater = false;
}
