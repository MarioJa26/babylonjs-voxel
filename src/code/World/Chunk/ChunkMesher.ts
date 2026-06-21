import {
	type AbstractEngine,
	AbstractMesh,
	BoundingInfo,
	Buffer,
	Effect,
	type Material,
	Mesh,
	type Scene,
	ShaderMaterial,
	Texture,
	UniformBuffer,
	Vector3,
	VertexBuffer,
} from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { WorldEnvironment } from "../../Maps/WorldEnvironment";
import { GLOBAL_VALUES } from "../GLOBAL_VALUES";
import { Lod2Shader } from "../Light/Lod2Shader";
import { Lod3Shader } from "../Light/Lod3Shader";
import { OpaqueShader } from "../Light/OpaqueShader";
import { TransparentShader } from "../Light/TransparentShader";
import { updateBlockTexturesUV } from "../Texture/BlockTextures";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";
import { TextureCache } from "../Texture/TextureCache";
import {
	TextureDefinitions,
	TextureDefinitionsReady,
} from "../Texture/TextureDefinitions";
import { Chunk } from "./Chunk";
import type { MeshData } from "./DataStructures/MeshData";
import {
	assignChunkToGroup,
	disposeAll,
	MergedMeshMeta,
	PRECOMPUTED_CHUNK_OFFSETS_ARRAY,
	setOnGroupMeshNeedsRebuild,
} from "./MergedMeshManager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LodCrossFadeState = {
	startMs: number;
	durationMs: number;
	direction: 1 | -1;
	seed: number;
};

class LodMeshMeta {
	__lodLevel = 0;
	__lodCrossFade: LodCrossFadeState | null = null;
}

// ---------------------------------------------------------------------------
// Module-level state  (replaces static class fields)
// ---------------------------------------------------------------------------

let atlasMaterial: Material | null = null;
let transparentMaterial: Material | null = null;
let lod3OpaqueMaterial: Material | null = null;
let lod3TransparentMaterial: Material | null = null;
let lod2OpaqueMaterial: Material | null = null;
let lod2TransparentMaterial: Material | null = null;

let globalUniformBuffer: UniformBuffer | null = null;
let sharedFacePositionBuffer: Buffer | null = null;
const activeLodFadeMeshes = new Set<Mesh>();

const LOD_FADE_DURATION_MS = 150;

const _lodFadeScratch: LodCrossFadeState = {
	startMs: 0,
	durationMs: 0,
	direction: 1,
	seed: 0,
};

// Cache global uniforms — updated once per frame.
const cachedUniforms = {
	lightDirection: new Vector3(0, 1, 0),
	cameraPosition: new Vector3(0, 0, 0),
	time: 0,
	sunLightIntensity: 1.0,
	wetness: 0,
	vFogInfos: new Float32Array(4),
	vFogColor: new Float32Array(3),
};

// Indexed quad: 4 vertices, 6 indices.
// `position.x` is used purely as a vertexId (0..3) in the chunk vertex shaders.
const FACE_VERTEX_TEMPLATE = new Float32Array([
	0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0,
]);
const FACE_INDEX_TEMPLATE = new Uint16Array([0, 2, 1, 0, 3, 2]);

// PERF: Scratch values reused every frame — avoids per-call heap allocations.
const tmpLightDir = new Vector3(0, 0, 0);
const scratchFadeUniforms = { progress: 1, direction: 0, seed: 0 };
const fadeMeshSnapshot: Mesh[] = [];

let lastUpdateFrame = -1;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureMeshMetadata(mesh: Mesh): LodMeshMeta {
	if (mesh.metadata instanceof LodMeshMeta) {
		return mesh.metadata;
	}
	const meta = new LodMeshMeta();
	mesh.metadata = meta;
	return meta;
}

function getMeshLodLevel(mesh: Mesh | null): number | null {
	if (!mesh?.metadata) return null;
	if (mesh.metadata instanceof MergedMeshMeta) return mesh.metadata.__lodLevel;
	if (mesh.metadata instanceof LodMeshMeta) return mesh.metadata.__lodLevel;
	return null;
}

function setMeshLodLevel(mesh: Mesh, lod: number): void {
	if (mesh.metadata instanceof MergedMeshMeta) {
		mesh.metadata.__lodLevel = lod;
		return;
	}
	ensureMeshMetadata(mesh).__lodLevel = lod;
}

function getMeshFadeState(mesh: Mesh): LodCrossFadeState | null {
	if (!(mesh.metadata instanceof LodMeshMeta)) return null;
	const state = mesh.metadata.__lodCrossFade;
	if (!state) return null;
	if (
		typeof state.startMs !== "number" ||
		typeof state.durationMs !== "number" ||
		typeof state.direction !== "number" ||
		typeof state.seed !== "number"
	) {
		return null;
	}
	return state;
}

function clearMeshFadeState(mesh: Mesh): void {
	if (!(mesh.metadata instanceof LodMeshMeta)) return;
	mesh.metadata.__lodCrossFade = null;
}

function setMeshFadeState(mesh: Mesh, state: LodCrossFadeState): void {
	const meta = ensureMeshMetadata(mesh);
	if (!meta.__lodCrossFade) {
		meta.__lodCrossFade = { startMs: 0, durationMs: 0, direction: 1, seed: 0 };
	}
	meta.__lodCrossFade.startMs = state.startMs;
	meta.__lodCrossFade.durationMs = state.durationMs;
	meta.__lodCrossFade.direction = state.direction;
	meta.__lodCrossFade.seed = state.seed;
	activeLodFadeMeshes.add(mesh);
}

function makeFadeSeed(chunk: Chunk): number {
	const hx = Math.imul(chunk.chunkX | 0, 73856093);
	const hy = Math.imul(chunk.chunkY | 0, 19349663);
	const hz = Math.imul(chunk.chunkZ | 0, 83492791);
	const mixed = (hx ^ hy ^ hz) >>> 0;
	return (mixed % 1024) + 1;
}

function beginLodCrossFade(
	chunk: Chunk,
	oldMesh: Mesh | null,
	newMesh: Mesh | null,
): void {
	if (!oldMesh || !newMesh) return;
	if (oldMesh === newMesh) return;
	if (oldMesh.isDisposed() || newMesh.isDisposed()) return;

	const now = performance.now();
	const seed = makeFadeSeed(chunk);

	newMesh.visibility = 0;

	// If the old mesh is already mid-fade, continue from its current
	// visibility instead of snapping to 1 (which causes a visible pop).
	const oldState = getMeshFadeState(oldMesh);
	if (oldState) {
		const elapsed = (now - oldState.startMs) / oldState.durationMs;
		const currentProgress = elapsed < 0 ? 0 : elapsed > 1 ? 1 : elapsed;
		const currentVis =
			oldState.direction > 0 ? currentProgress : 1 - currentProgress;
		// Rewind startMs so the fade-out continues from currentVis.
		const rewoundStart = now - (1 - currentVis) * LOD_FADE_DURATION_MS;
		_lodFadeScratch.startMs = rewoundStart;
		_lodFadeScratch.durationMs = LOD_FADE_DURATION_MS;
		_lodFadeScratch.direction = -1;
		_lodFadeScratch.seed = seed;
		setMeshFadeState(oldMesh, _lodFadeScratch);
	} else {
		oldMesh.visibility = 1;
		_lodFadeScratch.startMs = now;
		_lodFadeScratch.durationMs = LOD_FADE_DURATION_MS;
		_lodFadeScratch.direction = -1;
		_lodFadeScratch.seed = seed;
		setMeshFadeState(oldMesh, _lodFadeScratch);
	}

	_lodFadeScratch.startMs = now;
	_lodFadeScratch.durationMs = LOD_FADE_DURATION_MS;
	_lodFadeScratch.direction = 1;
	_lodFadeScratch.seed = seed;
	setMeshFadeState(newMesh, _lodFadeScratch);
}

function shouldUseLodCrossFade(
	previousLod: number | null,
	nextLod: number,
): boolean {
	if (previousLod === null || previousLod === nextLod) return false;
	// LOD0 <-> LOD1 is intentionally instant: quality is very close.
	if (
		(previousLod === 0 && nextLod === 1) ||
		(previousLod === 1 && nextLod === 0)
	)
		return false;
	return true;
}

// PERF: Returns the module-level scratch object instead of allocating a new
// one per call. Callers must not hold a reference across frames.
function getMeshFadeUniforms(
	mesh: Mesh | undefined,
	nowMs?: number,
): typeof scratchFadeUniforms {
	if (!mesh) {
		scratchFadeUniforms.progress = 1;
		scratchFadeUniforms.direction = 0;
		scratchFadeUniforms.seed = 0;
		return scratchFadeUniforms;
	}

	const state = getMeshFadeState(mesh);
	if (!state) {
		scratchFadeUniforms.progress = 1;
		scratchFadeUniforms.direction = 0;
		scratchFadeUniforms.seed = 0;
		return scratchFadeUniforms;
	}

	const elapsed =
		((nowMs ?? performance.now()) - state.startMs) / state.durationMs;
	scratchFadeUniforms.progress = elapsed < 0 ? 0 : elapsed > 1 ? 1 : elapsed;
	scratchFadeUniforms.direction = state.direction;
	scratchFadeUniforms.seed = state.seed;
	return scratchFadeUniforms;
}

function updateLodCrossFades(nowMs: number): void {
	if (activeLodFadeMeshes.size === 0) return;

	// PERF: Fill a reusable array instead of Array.from(Set) — avoids a
	// heap allocation every frame while fades are active.
	fadeMeshSnapshot.length = 0;
	for (const mesh of activeLodFadeMeshes) {
		fadeMeshSnapshot.push(mesh);
	}

	for (let i = 0; i < fadeMeshSnapshot.length; i++) {
		const mesh = fadeMeshSnapshot[i]!;
		if (mesh.isDisposed()) {
			activeLodFadeMeshes.delete(mesh);
			continue;
		}

		const state = getMeshFadeState(mesh);
		if (!state) {
			activeLodFadeMeshes.delete(mesh);
			continue;
		}

		const t = (nowMs - state.startMs) / state.durationMs;
		const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
		mesh.visibility = state.direction > 0 ? clamped : 1 - clamped;
		if (t >= 1) {
			activeLodFadeMeshes.delete(mesh);
			clearMeshFadeState(mesh);
			if (state.direction < 0) {
				mesh.dispose();
			} else {
				mesh.visibility = 1;
			}
		}
	}
}

// PERF: applyLodShaderBindings is only ever called during initAtlas, so the
// closure is created once per material. The onBind itself must not allocate —
// getMeshFadeUniforms returns a scratch object, so no allocation there.
function applyLodShaderBindings(material: ShaderMaterial): void {
	material.onBind = (mesh) => {
		const effect = material.getEffect();
		if (!effect) return;

		if (!activeLodFadeMeshes.has(mesh as Mesh)) {
			effect.setFloat("lodFadeProgress", 1);
			effect.setFloat("lodFadeDirection", 0);
			effect.setFloat("lodFadeSeed", 0);
		} else {
			const fade = getMeshFadeUniforms(mesh as Mesh);
			effect.setFloat("lodFadeProgress", fade.progress);
			effect.setFloat("lodFadeDirection", fade.direction);
			effect.setFloat("lodFadeSeed", fade.seed);
		}

		// Chunk offsets for merged meshes - use cached array to avoid allocation.
		const meta = (mesh as Mesh).metadata;
		const arr =
			meta instanceof MergedMeshMeta && meta.chunkOffsetsArray
				? meta.chunkOffsetsArray
				: PRECOMPUTED_CHUNK_OFFSETS_ARRAY;
		effect.setArray3("chunkOffsets", arr);
	};
}

function applyMergedMeshBindings(material: ShaderMaterial): void {
	material.onBind = (mesh) => {
		const effect = material.getEffect();
		if (!effect) return;

		// Chunk offsets for merged meshes - use cached array to avoid allocation.
		const meta = (mesh as Mesh).metadata;
		const arr =
			meta instanceof MergedMeshMeta && meta.chunkOffsetsArray
				? meta.chunkOffsetsArray
				: PRECOMPUTED_CHUNK_OFFSETS_ARRAY;
		effect.setArray3("chunkOffsets", arr);
	};
}

// PERF: Guard is a no-op after first call — skip engine/scene lookup on the hot path.
function ensureSharedFacePositionBuffer(): void {
	if (sharedFacePositionBuffer) return;
	sharedFacePositionBuffer = new Buffer(
		Map1.mainScene.getEngine(),
		FACE_VERTEX_TEMPLATE,
		false,
		3,
		false,
		false,
	);
}

// ---------------------------------------------------------------------------
// Merged mesh upsert — creates/updates a single mesh for a group of chunks.
// ---------------------------------------------------------------------------

function upsertFaceVertexBufferMerged(
	mesh: Mesh,
	engine: AbstractEngine,
	kind: string,
	data: Uint8Array,
	itemSize: number,
): void {
	const existing = mesh.getVertexBuffer(kind);
	const nextLength = data.length;

	if (existing?.isUpdatable()) {
		const rawData = existing.getData();
		const capacity = rawData
			? ((rawData as ArrayBufferView).byteLength ?? 0)
			: 0;
		if (capacity >= nextLength) {
			existing.update(data);
			return;
		}
	}

	existing?.dispose();

	mesh.setVerticesBuffer(
		new VertexBuffer(
			engine,
			data,
			kind,
			true,
			undefined,
			itemSize,
			true,
			undefined,
			itemSize,
			VertexBuffer.UNSIGNED_BYTE,
			false,
		),
	);
}

// ---------------------------------------------------------------------------
// Material helpers
// ---------------------------------------------------------------------------

function getOpaqueMaterialForLodBucket(lod: number): Material {
	return lod >= 3
		? lod3OpaqueMaterial!
		: lod >= 2
			? lod2OpaqueMaterial!
			: atlasMaterial!;
}

function getTransparentMaterialForLodBucket(lod: number): Material {
	return lod >= 3
		? lod3TransparentMaterial!
		: lod >= 2
			? lod2TransparentMaterial!
			: transparentMaterial!;
}

function beginGroupLodCrossFadeIfNeeded(
	group: {
		membersArray: { chunk: Chunk }[];
	},
	previousLod: number | null,
	nextLod: number,
	oldMesh: Mesh | null,
	newMesh: Mesh | null,
): void {
	if (!shouldUseLodCrossFade(previousLod, nextLod)) return;
	const firstMember = group.membersArray[0];
	if (!firstMember) return;
	beginLodCrossFade(firstMember.chunk, oldMesh, newMesh);
}

// ---------------------------------------------------------------------------
// Register callback: update group mesh vertex buffers when a chunk is removed
// ---------------------------------------------------------------------------

setOnGroupMeshNeedsRebuild((group) => {
	const scene = Map1.mainScene;
	if (!scene) return;

	const lod = group.lodBucket;

	// -----------------------------------------------------------------------
	// Opaque
	// -----------------------------------------------------------------------
	if (group.cachedOpaque && group.cachedOpaque.faceCount > 0) {
		const previousMesh = group.opaqueMeshRef;
		const previousLod = getMeshLodLevel(previousMesh);
		const mat = getOpaqueMaterialForLodBucket(lod);
		group.opaqueMeshRef = upsertMergedMesh(
			group,
			group.opaqueMeshRef,
			group.cachedOpaque,
			`merged_opaque_${group.groupKey}`,
			mat,
		);
		setMeshLodLevel(group.opaqueMeshRef, lod);
		group.opaqueMeshRef.isVisible = true;
		beginGroupLodCrossFadeIfNeeded(
			group,
			previousLod,
			lod,
			previousMesh,
			group.opaqueMeshRef,
		);
	} else if (group.opaqueMeshRef) {
		group.opaqueMeshRef.overridenInstanceCount = 0;
		group.opaqueMeshRef.isVisible = false;
	}

	// -----------------------------------------------------------------------
	// Transparent
	// -----------------------------------------------------------------------
	if (group.cachedTransparent && group.cachedTransparent.faceCount > 0) {
		const previousMesh = group.transparentMeshRef;
		const previousLod = getMeshLodLevel(previousMesh);
		const mat = getTransparentMaterialForLodBucket(lod);
		group.transparentMeshRef = upsertMergedMesh(
			group,
			group.transparentMeshRef,
			group.cachedTransparent,
			`merged_transparent_${group.groupKey}`,
			mat,
		);
		setMeshLodLevel(group.transparentMeshRef, lod);
		group.transparentMeshRef.isVisible = true;
		beginGroupLodCrossFadeIfNeeded(
			group,
			previousLod,
			lod,
			previousMesh,
			group.transparentMeshRef,
		);
	} else if (group.transparentMeshRef) {
		group.transparentMeshRef.overridenInstanceCount = 0;
		group.transparentMeshRef.isVisible = false;
	}
});

function upsertMergedMesh(
	group: {
		gridX: number;
		gridY: number;
		gridZ: number;
		groupKey: string;
		chunkOffsets: Float32Array;
	},
	existingMesh: Mesh | null,
	mergedData: {
		faceDataA: Uint8Array;
		faceDataB: Uint8Array;
		faceDataC: Uint8Array;
		chunkIndex: Uint8Array;
		faceCount: number;
	},
	name: string,
	material: Material,
): Mesh {
	const scene = Map1.mainScene;
	const engine = scene.getEngine();

	ensureSharedFacePositionBuffer();

	let mesh = existingMesh;

	if (!mesh) {
		mesh = new Mesh(name, scene);
		mesh.renderingGroupId = 1;
		mesh.material = material;
		mesh.checkCollisions = false;
		mesh.isPickable = false;
		mesh.doNotSyncBoundingInfo = true;
		mesh.ignoreNonUniformScaling = true;

		// Shared static face-position buffer.
		mesh.setVerticesBuffer(
			sharedFacePositionBuffer!.createVertexBuffer(
				VertexBuffer.PositionKind,
				0,
				3,
				3,
				false,
				false,
				0,
			),
		);

		mesh.setIndices(FACE_INDEX_TEMPLATE);

		// Position at group origin.
		const S = Chunk.SIZE;
		const G = 4; // GROUP_SIZE
		mesh.position.set(
			group.gridX * G * S,
			group.gridY * G * S,
			group.gridZ * G * S,
		);

		// Bounding box covers all chunks in the group.
		const groupExtent = G * S;
		mesh.setBoundingInfo(
			new BoundingInfo(
				Vector3.Zero(),
				new Vector3(groupExtent, groupExtent, groupExtent),
			),
		);
		mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;

		mesh.freezeWorldMatrix();

		mesh.material = material;
		mesh.name = name;

		// Store chunkOffsets in metadata for onBind callback.
		const meta = new MergedMeshMeta();
		meta.chunkOffsets = group.chunkOffsets;
		meta.chunkOffsetsArray = PRECOMPUTED_CHUNK_OFFSETS_ARRAY;
		mesh.metadata = meta;
	} else {
		if (mesh.material !== material) mesh.material = material;
	}

	upsertFaceVertexBufferMerged(
		mesh,
		engine,
		"faceDataA",
		mergedData.faceDataA,
		4,
	);
	upsertFaceVertexBufferMerged(
		mesh,
		engine,
		"faceDataB",
		mergedData.faceDataB,
		4,
	);
	upsertFaceVertexBufferMerged(
		mesh,
		engine,
		"faceDataC",
		mergedData.faceDataC,
		4,
	);
	upsertFaceVertexBufferMerged(
		mesh,
		engine,
		"chunkIndex",
		mergedData.chunkIndex,
		1,
	);

	mesh.overridenInstanceCount = mergedData.faceCount;

	return mesh;
}

function createCachedTexture(url: string, scene: Scene, args: any): Texture {
	const texture = new Texture(null, scene, args);

	loadTextureToCache(url)
		.then((blobUrl) => {
			texture.onLoadObservable.addOnce(() => {
				try {
					URL.revokeObjectURL(blobUrl);
				} catch {
					/* ignore */
				}
			});
			texture.updateURL(blobUrl);
		})
		.catch((e) => {
			console.warn("Texture cache failed, falling back to network", e);
			texture.updateURL(url);
		});

	return texture;
}

async function loadTextureToCache(url: string): Promise<string> {
	const cacheKey = `${url}?v=${GLOBAL_VALUES.TEXTURE_VERSION}`;

	const cachedBlob = await TextureCache.get(cacheKey);
	if (cachedBlob) return URL.createObjectURL(cachedBlob);

	const response = await fetch(cacheKey);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch texture: ${cacheKey} (${response.status})`,
		);
	}

	const newBlob = await response.blob();
	await TextureCache.put(cacheKey, newBlob);
	return URL.createObjectURL(newBlob);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initAtlas(): Promise<void> {
	const scene = Map1.mainScene;
	if (!scene) {
		console.error("initAtlas(): scene is not available.");
		return;
	}

	// If CREATE_ATLAS flag is set, rebuild the atlas instead of loading from files
	if (GLOBAL_VALUES.CREATE_ATLAS) {
		await TextureDefinitionsReady;
		const atlas = await TextureAtlasFactory.buildAtlas(
			scene,
			TextureDefinitions,
		);
		if (atlas?.uvMap) {
			updateBlockTexturesUV(atlas.uvMap, TextureDefinitions);
		}
		return;
	}

	let diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
	let normalAtlasTexture = TextureAtlasFactory.getNormal();

	if (!diffuseAtlasTexture) {
		if (GLOBAL_VALUES.CACHE_TEXTURES) {
			diffuseAtlasTexture = createCachedTexture(
				"/texture/diffuse_atlas.png",
				scene,
				{
					noMipmap: false,
					samplingMode: Texture.NEAREST_SAMPLINGMODE,
				},
			);
			normalAtlasTexture = createCachedTexture(
				"/texture/normal_atlas.png",
				scene,
				{
					noMipmap: false,
					samplingMode: Texture.NEAREST_SAMPLINGMODE,
				},
			);
		} else {
			diffuseAtlasTexture = new Texture("/texture/diffuse_atlas.png", scene, {
				noMipmap: false,
				samplingMode: Texture.NEAREST_SAMPLINGMODE,
			});
			normalAtlasTexture = new Texture("/texture/normal_atlas.png", scene, {
				noMipmap: false,
				samplingMode: Texture.NEAREST_SAMPLINGMODE,
			});
		}

		TextureAtlasFactory.setDiffuse(diffuseAtlasTexture);
		TextureAtlasFactory.setNormal(normalAtlasTexture);
	}

	if (!diffuseAtlasTexture) {
		console.error("Texture Atlas not yet built or available!");
		return;
	}

	// -------------------------------------------------------------------------
	// Shader registration
	// -------------------------------------------------------------------------
	Effect.ShadersStore["chunkVertexShader"] = OpaqueShader.chunkVertexShader;
	Effect.ShadersStore["chunkFragmentShader"] = OpaqueShader.chunkFragmentShader;

	// IMPORTANT FIX:
	// Transparent chunk meshes must use the transparent vertex shader,
	// not the shared opaque vertex shader.
	Effect.ShadersStore["transparentChunkVertexShader"] =
		TransparentShader.chunkVertexShader;
	Effect.ShadersStore["transparentChunkFragmentShader"] =
		TransparentShader.chunkFragmentShader;

	Effect.ShadersStore["lod3ChunkVertexShader"] = Lod3Shader.chunkVertexShader;
	Effect.ShadersStore["lod3ChunkFragmentShader"] =
		Lod3Shader.opaqueFragmentShader;
	Effect.ShadersStore["lod3TransparentChunkFragmentShader"] =
		Lod3Shader.transparentFragmentShader;

	Effect.ShadersStore["lod2ChunkVertexShader"] = Lod2Shader.chunkVertexShader;
	Effect.ShadersStore["lod2ChunkFragmentShader"] =
		Lod2Shader.opaqueFragmentShader;
	Effect.ShadersStore["lod2TransparentChunkFragmentShader"] =
		Lod2Shader.transparentFragmentShader;

	if (!globalUniformBuffer) {
		globalUniformBuffer = new UniformBuffer(
			scene.getEngine(),
			undefined,
			true,
			"GlobalUniforms",
		);
		globalUniformBuffer.addUniform("lightDirection", 3);
		globalUniformBuffer.addUniform("cameraPosition", 3);
		globalUniformBuffer.addUniform("sunLightIntensity", 1);
		globalUniformBuffer.addUniform("wetness", 1);
		globalUniformBuffer.addUniform("time", 1);
		globalUniformBuffer.addUniform("vFogInfos", 4);
		globalUniformBuffer.addUniform("vFogColor", 3);
		globalUniformBuffer.create();
	}

	const tileSize = TextureAtlasFactory.atlasTileSize;
	const atlasMaxTiles = Math.floor(1.0 / tileSize + 0.5);

	// The LOD materials share the same uniform list — hoist it to avoid
	// repeating the array literal six times.
	const lodUniforms = [
		"world",
		"worldViewProjection",
		"atlasTileSize",
		"atlasMaxTiles",
		"lodFadeProgress",
		"lodFadeDirection",
		"lodFadeSeed",
		"tintLUT",
		"chunkOffsets",
	];

	// -------------------------------------------------------------------------
	// Opaque material
	// -------------------------------------------------------------------------
	if (!atlasMaterial) {
		const mat = new ShaderMaterial(
			"chunkShaderMaterial",
			scene,
			{ vertex: "chunk", fragment: "chunk" },
			{
				attributes: [
					"position",
					"faceDataA",
					"faceDataB",
					"faceDataC",
					"chunkIndex",
				],
				uniforms: [
					"world",
					"worldViewProjection",
					"atlasTileSize",
					"atlasMaxTiles",
					"chunkOffsets",
				],
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture", "normalTexture"],
			},
		);
		mat.backFaceCulling = true;
		//mat.setPrePassRenderer(scene.prePassRenderer!);
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyMergedMeshBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.freeze();
		atlasMaterial = mat;
	} else {
		const mat = atlasMaterial as ShaderMaterial;
		if (mat.isFrozen) mat.unfreeze();
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		mat.freeze();
	}

	// -------------------------------------------------------------------------
	// Tint LUT data (constant, used by LOD2/LOD3)
	// -------------------------------------------------------------------------
	// PERF: Hoist Array.from() once instead of calling it 8 times per initAtlas.
	const tintLUTArray = Array.from(
		new Float32Array([
			1.0, 1.0, 1.0, 1.0, 0.96, 0.98, 1.02, 0.88, 1.04, 1.0, 0.92, 0.9, 0.92,
			1.06, 0.92, 1.05, 0.9, 0.98, 1.08, 0.9, 1.05, 0.97, 0.9, 0.95,
		]),
	);

	// -------------------------------------------------------------------------
	// Transparent material
	// -------------------------------------------------------------------------
	if (!transparentMaterial) {
		const mat = new ShaderMaterial(
			"transparentChunkShaderMaterial",
			scene,
			{ vertex: "transparentChunk", fragment: "transparentChunk" },
			{
				attributes: [
					"position",
					"faceDataA",
					"faceDataB",
					"faceDataC",
					"chunkIndex",
				],
				uniforms: [
					"world",
					"worldViewProjection",
					"atlasTileSize",
					"atlasMaxTiles",
					"chunkOffsets",
				],
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture", "normalTexture"],
			},
		);
		mat.backFaceCulling = false;
		mat.forceDepthWrite = false;
		mat.needAlphaBlending = () => true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyMergedMeshBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.freeze();
		transparentMaterial = mat;
	} else {
		const mat = transparentMaterial as ShaderMaterial;
		if (mat.isFrozen) mat.unfreeze();
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		mat.freeze();
	}

	// -------------------------------------------------------------------------
	// LOD3 opaque material
	// -------------------------------------------------------------------------
	if (!lod3OpaqueMaterial) {
		const mat = new ShaderMaterial(
			"lod3ChunkShaderMaterial",
			scene,
			{ vertex: "lod3Chunk", fragment: "lod3Chunk" },
			{
				attributes: [
					"position",
					"faceDataA",
					"faceDataB",
					"faceDataC",
					"chunkIndex",
				],
				uniforms: lodUniforms,
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setArray4("tintLUT", tintLUTArray);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.freeze();
		lod3OpaqueMaterial = mat;
	} else {
		const mat = lod3OpaqueMaterial as ShaderMaterial;
		if (mat.isFrozen) mat.unfreeze();
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setArray4("tintLUT", tintLUTArray);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.freeze();
	}

	// -------------------------------------------------------------------------
	// LOD3 transparent material
	// -------------------------------------------------------------------------
	if (!lod3TransparentMaterial) {
		const mat = new ShaderMaterial(
			"lod3TransparentChunkShaderMaterial",
			scene,
			{ vertex: "lod3Chunk", fragment: "lod3TransparentChunk" },
			{
				attributes: [
					"position",
					"faceDataA",
					"faceDataB",
					"faceDataC",
					"chunkIndex",
				],
				uniforms: lodUniforms,
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.forceDepthWrite = false;
		mat.needAlphaBlending = () => true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setArray4("tintLUT", tintLUTArray);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.freeze();
		lod3TransparentMaterial = mat;
	} else {
		const mat = lod3TransparentMaterial as ShaderMaterial;
		if (mat.isFrozen) mat.unfreeze();
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setArray4("tintLUT", tintLUTArray);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.freeze();
	}

	// -------------------------------------------------------------------------
	// LOD2 opaque material
	// -------------------------------------------------------------------------
	if (!lod2OpaqueMaterial) {
		const mat = new ShaderMaterial(
			"lod2ChunkShaderMaterial",
			scene,
			{ vertex: "lod2Chunk", fragment: "lod2Chunk" },
			{
				attributes: [
					"position",
					"faceDataA",
					"faceDataB",
					"faceDataC",
					"chunkIndex",
				],
				uniforms: lodUniforms,
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture", "normalTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setArray4("tintLUT", tintLUTArray);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.freeze();
		lod2OpaqueMaterial = mat;
	} else {
		const mat = lod2OpaqueMaterial as ShaderMaterial;
		if (mat.isFrozen) mat.unfreeze();
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setArray4("tintLUT", tintLUTArray);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.freeze();
	}

	// -------------------------------------------------------------------------
	// LOD2 transparent material
	// -------------------------------------------------------------------------
	if (!lod2TransparentMaterial) {
		const mat = new ShaderMaterial(
			"lod2TransparentChunkShaderMaterial",
			scene,
			{ vertex: "lod2Chunk", fragment: "lod2TransparentChunk" },
			{
				attributes: [
					"position",
					"faceDataA",
					"faceDataB",
					"faceDataC",
					"chunkIndex",
				],
				uniforms: lodUniforms,
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture", "normalTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.forceDepthWrite = false;
		mat.needAlphaBlending = () => true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setArray4("tintLUT", tintLUTArray);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.freeze();
		lod2TransparentMaterial = mat;
	} else {
		const mat = lod2TransparentMaterial as ShaderMaterial;
		if (mat.isFrozen) mat.unfreeze();
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setFloat("atlasMaxTiles", atlasMaxTiles);
		mat.setArray4("tintLUT", tintLUTArray);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.freeze();
	}
}

// ---------------------------------------------------------------------------
// Boat chunk standalone mesh — creates individual meshes for chunks that live
// at far-away virtual coordinates (Y=670000) but are rendered via a parent
// hierarchy at the boat's actual world position.
// ---------------------------------------------------------------------------

const BOAT_CHUNK_OFFSETS_ARRAY = [0, 0, 0];

function createBoatChunkStandaloneMesh(
	name: string,
	material: Material,
	faceData: {
		faceDataA: Uint8Array;
		faceDataB: Uint8Array;
		faceDataC: Uint8Array;
		chunkIndex: Uint8Array;
		faceCount: number;
	},
): Mesh {
	const scene = Map1.mainScene;
	const engine = scene.getEngine();

	ensureSharedFacePositionBuffer();

	const mesh = new Mesh(name, scene);
	mesh.renderingGroupId = 1;
	mesh.material = material;
	mesh.checkCollisions = false;
	mesh.isPickable = false;
	mesh.ignoreNonUniformScaling = true;

	mesh.setVerticesBuffer(
		sharedFacePositionBuffer!.createVertexBuffer(
			VertexBuffer.PositionKind,
			0,
			3,
			3,
			false,
			false,
			0,
		),
	);

	mesh.setIndices(FACE_INDEX_TEMPLATE);

	mesh.position.set(0, 0, 0);

	const S = Chunk.SIZE;
	mesh.setBoundingInfo(new BoundingInfo(Vector3.Zero(), new Vector3(S, S, S)));
	mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;

	const meta = new MergedMeshMeta();
	meta.chunkOffsetsArray = BOAT_CHUNK_OFFSETS_ARRAY;
	mesh.metadata = meta;

	upsertFaceVertexBufferMerged(
		mesh,
		engine,
		"faceDataA",
		faceData.faceDataA,
		4,
	);
	upsertFaceVertexBufferMerged(
		mesh,
		engine,
		"faceDataB",
		faceData.faceDataB,
		4,
	);
	upsertFaceVertexBufferMerged(
		mesh,
		engine,
		"faceDataC",
		faceData.faceDataC,
		4,
	);
	upsertFaceVertexBufferMerged(
		mesh,
		engine,
		"chunkIndex",
		faceData.chunkIndex,
		1,
	);

	mesh.overridenInstanceCount = faceData.faceCount;

	return mesh;
}

function createBoatChunkMesh(
	chunk: Chunk,
	opaqueData: MeshData | null,
	transparentData: MeshData | null,
): void {
	const hasOpaque = !!opaqueData && opaqueData.faceCount > 0;
	const hasTransparent = !!transparentData && transparentData.faceCount > 0;

	// Dispose previous standalone meshes if they exist.
	if (chunk.mesh) {
		chunk.mesh.dispose();
		chunk.mesh = null;
	}
	if (chunk.transparentMesh) {
		chunk.transparentMesh.dispose();
		chunk.transparentMesh = null;
	}

	if (hasOpaque) {
		const data = opaqueData!;
		const chunkIndex = new Uint8Array(data.faceCount);
		const mat = getOpaqueMaterialForLodBucket(0);
		chunk.mesh = createBoatChunkStandaloneMesh(
			`boat_chunk_opaque_${chunk.chunkX}_${chunk.chunkY}_${chunk.chunkZ}`,
			mat,
			{
				faceDataA: data.faceDataA,
				faceDataB: data.faceDataB,
				faceDataC: data.faceDataC,
				chunkIndex,
				faceCount: data.faceCount,
			},
		);
		chunk.mesh.isVisible = true;
	}

	if (hasTransparent) {
		const data = transparentData!;
		const chunkIndex = new Uint8Array(data.faceCount);
		const mat = getTransparentMaterialForLodBucket(0);
		chunk.transparentMesh = createBoatChunkStandaloneMesh(
			`boat_chunk_transparent_${chunk.chunkX}_${chunk.chunkY}_${chunk.chunkZ}`,
			mat,
			{
				faceDataA: data.faceDataA,
				faceDataB: data.faceDataB,
				faceDataC: data.faceDataC,
				chunkIndex,
				faceCount: data.faceCount,
			},
		);
		chunk.transparentMesh.isVisible = true;
	}

	// Store cached data for re-creation on remesh.
	chunk.opaqueMeshData = hasOpaque ? opaqueData : null;
	chunk.transparentMeshData = hasTransparent ? transparentData : null;
}

export function createMeshFromData(
	chunk: Chunk,
	meshData: { opaque: MeshData | null; transparent: MeshData | null },
): void {
	const opaqueMeshData = meshData.opaque;
	const transparentMeshData = meshData.transparent;

	const hasOpaque = !!opaqueMeshData && opaqueMeshData.faceCount > 0;
	const hasTransparent =
		!!transparentMeshData && transparentMeshData.faceCount > 0;

	// Boat chunks need standalone meshes parented to a visual root.
	// They live at far-away virtual coordinates (Y=670000) for the chunk system
	// but are rendered at the boat's actual position via the parent hierarchy.
	if (chunk.isBoatChunk) {
		createBoatChunkMesh(
			chunk,
			hasOpaque ? opaqueMeshData : null,
			hasTransparent ? transparentMeshData : null,
		);
		return;
	}

	// Cache raw mesh data for LOD0 modified chunks.
	const lodLevel = chunk.lodLevel ?? 0;
	if (lodLevel === 0 && chunk.isModified) {
		chunk.opaqueMeshData = hasOpaque ? opaqueMeshData : null;
		chunk.transparentMeshData = hasTransparent ? transparentMeshData : null;
	} else {
		chunk.opaqueMeshData = null;
		chunk.transparentMeshData = null;
	}

	// Only assign data to the group.
	// Actual mesh creation/update happens in flushDirtyMergedGroups()
	// through setOnGroupMeshNeedsRebuild().
	assignChunkToGroup(
		chunk,
		hasOpaque ? opaqueMeshData! : null,
		hasTransparent ? transparentMeshData! : null,
	);
}

export function updateGlobalUniforms(frameId: number): void {
	if (lastUpdateFrame === frameId) return;
	lastUpdateFrame = frameId;

	const scene = Map1.mainScene;
	if (!scene || !globalUniformBuffer) return;

	const camera = scene.activeCamera;
	if (!camera) return;

	const lightDir = GLOBAL_VALUES.skyLightDirection;
	tmpLightDir
		.set(lightDir.x, lightDir.y, lightDir.z)
		.normalizeToRef(tmpLightDir);

	const u = cachedUniforms;

	// Blend the light direction toward straight-up (0, 1, 0) as the sun
	// approaches the horizon, so blocks are never lit from below.
	const shaderDirY = -tmpLightDir.y; // positive when sun is above
	const rawBlend = 1 - Math.min(1, Math.max(0, (shaderDirY + 0.2) / 0.4));
	const blend = rawBlend * rawBlend * (3 - 2 * rawBlend); // smoothstep

	u.lightDirection.set(
		-tmpLightDir.x * (1 - blend),
		-tmpLightDir.y * (1 - blend) + blend,
		-tmpLightDir.z * (1 - blend),
	);
	u.lightDirection.normalize();

	const camPos = camera.position;
	u.cameraPosition.set(camPos.x, camPos.y, camPos.z);

	const nowMs = performance.now();
	u.time = nowMs / 1000.0;

	// PERF: Inline clamp avoids Math.min/Math.max call overhead.
	const rawIntensity = (-lightDir.y + 0.1) * 4.0;
	u.sunLightIntensity =
		rawIntensity < 0.0 ? 0.0 : rawIntensity > 1.0 ? 1.0 : rawIntensity;

	u.wetness = WorldEnvironment.instance ? WorldEnvironment.instance.wetness : 0;

	const fog = scene.fogColor;
	u.vFogInfos[0] = scene.fogMode;
	u.vFogInfos[1] = scene.fogStart;
	u.vFogInfos[2] = scene.fogEnd;
	u.vFogInfos[3] = scene.fogDensity;
	u.vFogColor[0] = fog.r;
	u.vFogColor[1] = fog.g;
	u.vFogColor[2] = fog.b;

	globalUniformBuffer.updateVector3("lightDirection", u.lightDirection);
	globalUniformBuffer.updateVector3("cameraPosition", u.cameraPosition);
	globalUniformBuffer.updateFloat("sunLightIntensity", u.sunLightIntensity);
	globalUniformBuffer.updateFloat("wetness", u.wetness);
	globalUniformBuffer.updateFloat("time", u.time);
	globalUniformBuffer.updateFloat4(
		"vFogInfos",
		u.vFogInfos[0],
		u.vFogInfos[1],
		u.vFogInfos[2],
		u.vFogInfos[3],
	);
	globalUniformBuffer.updateFloat3(
		"vFogColor",
		u.vFogColor[0],
		u.vFogColor[1],
		u.vFogColor[2],
	);
	globalUniformBuffer.update();

	updateLodCrossFades(nowMs);
}

export function disposeSharedResources(): void {
	// Dispose all merged mesh groups first (they hold shared meshes).
	disposeAll();

	sharedFacePositionBuffer?.dispose();
	sharedFacePositionBuffer = null;

	globalUniformBuffer?.dispose();
	globalUniformBuffer = null;

	atlasMaterial?.dispose();
	atlasMaterial = null;

	transparentMaterial?.dispose();
	transparentMaterial = null;

	lod3OpaqueMaterial?.dispose();
	lod3OpaqueMaterial = null;

	lod3TransparentMaterial?.dispose();
	lod3TransparentMaterial = null;

	lod2OpaqueMaterial?.dispose();
	lod2OpaqueMaterial = null;

	lod2TransparentMaterial?.dispose();
	lod2TransparentMaterial = null;

	activeLodFadeMeshes.clear();
	fadeMeshSnapshot.length = 0;
	lastUpdateFrame = -1;
}
