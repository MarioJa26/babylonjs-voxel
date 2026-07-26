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

// Boat meshes always carry an all-zero chunkIndex. Pool a single zero-filled
// buffer instead of allocating a fresh Uint8Array on every boat rebuild.
let boatChunkIndexPool = new Uint8Array(0);
function getBoatChunkIndex(size: number): Uint8Array {
	if (boatChunkIndexPool.length < size) {
		boatChunkIndexPool = new Uint8Array(size);
	} else {
		boatChunkIndexPool.fill(0, 0, size);
	}
	return boatChunkIndexPool.subarray(0, size);
}

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
	if (lod2OpaqueMaterial) materialList.push(lod2OpaqueMaterial);
	if (lod2TransparentMaterial) materialList.push(lod2TransparentMaterial);
	if (lod3OpaqueMaterial) materialList.push(lod3OpaqueMaterial);
	if (lod3TransparentMaterial) materialList.push(lod3TransparentMaterial);

	materialListDirty = false;
}

// Static-uniform dirty tracking: skip the 6-material GPU uniform write when the
// scene lighting hasn't changed (only the animated `time` uniform keeps updating).
let lastLX = 0;
let lastLY = 0;
let lastLZ = 0;
let lastSun = -1;
let lastWet = -1;
let _timeFrameCounter = 0;

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

function setMaterialGroupUniforms(m: ShaderMaterial): void {
	setShaderUniform(m, "sunLightIntensity", cachedUniforms.sunLightIntensity);
	setShaderUniform(m, "wetness", cachedUniforms.wetness);
	// Only the transparent shader declares/uses `time`; Lite prunes it from the
	// other materials' generated uniform struct, so guard the write.
	if (m === transparentMaterial) {
		setShaderUniform(m, "time", performance.now() * 0.001);
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
	if (
		start === _fogCachedStart &&
		end === _fogCachedEnd &&
		color[0] === _fogCachedColorR &&
		color[1] === _fogCachedColorG &&
		color[2] === _fogCachedColorB &&
		isUnderWater === _fogCachedUnderwater
	) {
		return;
	}
	_fogCachedStart = start;
	_fogCachedEnd = end;
	_fogCachedColorR = color[0];
	_fogCachedColorG = color[1];
	_fogCachedColorB = color[2];
	_fogCachedUnderwater = isUnderWater;
	fogInfosArray[0] = 0;
	fogInfosArray[1] = start;
	fogInfosArray[2] = end;
	fogInfosArray[3] = 0;
	fogColorArray[0] = color[0];
	fogColorArray[1] = color[1];
	fogColorArray[2] = color[2];
	for (let i = 0; i < materialList.length; i++) {
		const m = materialList[i];
		if (!m) continue;
		if (m === atlasMaterial) continue;
		setShaderUniform(m, "fogInfos", fogInfosArray);
		setShaderUniform(m, "fogColor", fogColorArray);
	}
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
		engine: engine as EngineContext,
		scene: scene as SceneContext,
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
		uploadTintLUT();
	}

	populateMaterialList();
	for (let i = 0; i < materialList.length; i++) {
		const m = materialList[i];
		if (m) setMaterialGroupUniforms(m);
	}
	pushFogUniforms();
}

const _packedInput: PackedMeshInput = {
	name: "",
	material: null as any,
	faceDataA: null as any,
	faceDataB: null as any,
	faceDataC: null as any,
	chunkIndex: null as any,
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
		chunkIndex: Uint8Array;
		faceCount: number;
	},
	material: ShaderMaterial,
	originX: number,
	originY: number,
	originZ: number,
	_isTransparent: boolean,
): Mesh | null {
	const S = GROUP_SIZE * CHUNK_SIZE;
	const input = _packedInput;
	input.name = "";
	input.material = material;
	input.faceDataA = mergedData.faceDataA;
	input.faceDataB = mergedData.faceDataB;
	input.faceDataC = mergedData.faceDataC;
	input.chunkIndex = mergedData.chunkIndex;
	input.chunkOffsets = group.chunkOffsets;

	// mutate arrays instead of replacing
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
		if (!created) return existingMesh;
		return created;
	}

	const updated = updatePackedChunkMesh(existingMesh, input);
	if (existingMesh.material !== material) existingMesh.material = material;
	existingMesh.renderOrder = 1;
	return updated ?? existingMesh;
}

setOnGroupMeshNeedsRebuild((group) => {
	const scene = sceneRef;
	if (!scene) return;

	const lod = group.lodBucket;
	const S = 32; // Chunk.SIZE
	const G = GROUP_SIZE;
	const ox = group.gridX * G * S;
	const oy = group.gridY * G * S;
	const oz = group.gridZ * G * S;

	if (group.cachedOpaque && group.cachedOpaque.faceCount > 0) {
		const mat = getOpaqueMaterialForLodBucket(lod);
		const built = buildLiteMesh(
			group,
			group.opaqueMeshRef,
			group.cachedOpaque,
			mat,
			ox,
			oy,
			oz,
			false,
		) as any;
		if (built) {
			group.opaqueMeshRef = built;
			built.isVisible = true;
		}
	} else if (group.opaqueMeshRef) {
		(group.opaqueMeshRef as any).isVisible = false;
	}

	if (group.cachedTransparent && group.cachedTransparent.faceCount > 0) {
		const mat = getTransparentMaterialForLodBucket(lod);
		// Only near (lod 0) transparent meshes carry `meta` in color.w; LOD
		// transparent meshes keep tintBucket for their tint shaders.
		const isNearTransparent = mat === transparentMaterial;
		const built = buildLiteMesh(
			group,
			group.transparentMeshRef as any,
			group.cachedTransparent,
			mat,
			ox,
			oy,
			oz,
			isNearTransparent,
		) as any;
		if (built) {
			group.transparentMeshRef = built;
			(built as any).isVisible = true;
		}
	} else if (group.transparentMeshRef) {
		(group.transparentMeshRef as any).isVisible = false;
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
	_packedInput.chunkIndex = getBoatChunkIndex(data.faceCount);
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
	transparentData: MeshData | null,
): void {
	const hasOpaque = !!opaqueData && opaqueData.faceCount > 0;
	const hasTransparent = !!transparentData && transparentData.faceCount > 0;

	const matOpaque = getOpaqueMaterialForLodBucket(0);
	const matTransparent = getTransparentMaterialForLodBucket(0);

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

	// ---- TRANSPARENT ----
	let tMesh = chunk.transparentMesh as Mesh | null;

	if (hasTransparent) {
		const input = buildBoatInput(matTransparent, transparentData!);

		if (tMesh) {
			const updated = updatePackedChunkMesh(tMesh, input);
			tMesh = updated ?? tMesh;

			if (tMesh.material !== matTransparent) {
				tMesh.material = matTransparent;
			}
		} else {
			tMesh = createPackedChunkMesh(input) as Mesh | null;
		}
	} else if (tMesh) {
		disposePackedMesh(tMesh);
		tMesh = null;
	}

	chunk.transparentMesh = tMesh;

	// ---- DATA CACHE ----
	chunk.opaqueMeshData = hasOpaque ? opaqueData : null;
	chunk.transparentMeshData = hasTransparent ? transparentData : null;
}

export function createMeshFromData(
	chunk: Chunk,
	opaqueMeshData: MeshData | null,
	transparentMeshData: MeshData | null,
): void {
	const hasOpaque = !!opaqueMeshData && opaqueMeshData.faceCount > 0;
	const hasTransparent =
		!!transparentMeshData && transparentMeshData.faceCount > 0;

	if (chunk.isBoatChunk) {
		createBoatChunkMesh(
			chunk,
			hasOpaque ? opaqueMeshData : null,
			hasTransparent ? transparentMeshData : null,
		);
		return;
	}

	const lodLevel = chunk.lodLevel ?? 0;
	if (lodLevel === 0 && chunk.isModified) {
		chunk.opaqueMeshData = opaqueMeshData;
		chunk.transparentMeshData = transparentMeshData;
	} else {
		chunk.opaqueMeshData = null;
		chunk.transparentMeshData = null;
	}

	assignChunkToGroup(chunk, opaqueMeshData, transparentMeshData);
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

	u.lightDirection.x = -lightDir.x * (1 - blend);
	u.lightDirection.y = -lightDir.y * (1 - blend) + blend;
	u.lightDirection.z = -lightDir.z * (1 - blend);

	const rawIntensity = (-lightDir.y + 0.1) * 4.0;
	u.sunLightIntensity =
		rawIntensity < 0.0 ? 0.0 : rawIntensity > 1.0 ? 1.0 : rawIntensity;

	u.wetness = Map1.environment ? (Map1.environment.wetness ?? 0) : 0;

	populateMaterialList();

	const staticChanged =
		u.lightDirection.x !== lastLX ||
		u.lightDirection.y !== lastLY ||
		u.lightDirection.z !== lastLZ ||
		u.sunLightIntensity !== lastSun ||
		u.wetness !== lastWet;

	if (staticChanged) {
		lastLX = u.lightDirection.x;
		lastLY = u.lightDirection.y;
		lastLZ = u.lightDirection.z;
		lastSun = u.sunLightIntensity;
		lastWet = u.wetness;
		for (let i = 0; i < materialList.length; i++) {
			const m = materialList[i];
			if (!m) continue;

			lightDirArray[0] = u.lightDirection.x;
			lightDirArray[1] = u.lightDirection.y;
			lightDirArray[2] = u.lightDirection.z;

			setShaderUniform(m, "lightDirection", lightDirArray);

			setMaterialGroupUniforms(m);
		}
	} else if (transparentMaterial) {
		// Lighting is static, but the transparent shader still animates `time`.
		// Throttle to ~20fps (every 3 frames) since the shader uses time for
		// slow water animation — smooth float changes at 16ms granularity
		// produce the same visual result while cutting 2/3 of the custom-UBO
		// writeBuffer calls for the transparent material.
		if (_timeFrameCounter++ % 3 !== 0) return;
		const time = performance.now() * 0.001;
		setShaderUniform(transparentMaterial, "time", time);
	}

	// Fog reacts to MapFog overrides + underwater transitions, so push every frame.
	pushFogUniforms();
}

export function disposeSharedResources(): void {
	disposeAll();

	atlasMaterial = null;
	transparentMaterial = null;
	lod3OpaqueMaterial = null;
	lod3TransparentMaterial = null;
	lod2OpaqueMaterial = null;
	lod2TransparentMaterial = null;

	destroyPackedArenas();

	engineRef = null;
	sceneRef = null;
	lastUpdateFrame = -1;
	materialListDirty = true;
}
