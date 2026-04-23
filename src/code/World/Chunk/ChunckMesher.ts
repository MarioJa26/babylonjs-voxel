import {
	AbstractMesh,
	BoundingInfo,
	Buffer,
	Effect,
	type Material,
	Mesh,
	ShaderMaterial,
	Texture,
	UniformBuffer,
	Vector2,
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
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";
import { TextureCache } from "../Texture/TextureCache";
import { Chunk } from "./Chunk";
import type { MeshData } from "./DataStructures/MeshData";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LodCrossFadeState = {
	startMs: number;
	durationMs: number;
	direction: 1 | -1;
	seed: number;
};

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

// Cache global uniforms — updated once per frame.
const cachedUniforms = {
	lightDirection: new Vector3(0, 1, 0),
	cameraPosition: new Vector3(0, 0, 0),
	cameraPlanes: new Vector2(0.1, 1000),
	time: 0,
	sunLightIntensity: 1.0,
	wetness: 0,
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

function ensureMeshMetadata(mesh: Mesh): Record<string, unknown> {
	if (!mesh.metadata || typeof mesh.metadata !== "object") {
		mesh.metadata = {};
	}
	return mesh.metadata as Record<string, unknown>;
}

function getMeshLodLevel(mesh: Mesh | null): number | null {
	if (!mesh?.metadata || typeof mesh.metadata !== "object") return null;
	const lod = (mesh.metadata as Record<string, unknown>).__lodLevel;
	return typeof lod === "number" ? lod : null;
}

function setMeshLodLevel(mesh: Mesh, lod: number): void {
	ensureMeshMetadata(mesh).__lodLevel = lod;
}

function getMeshFadeState(mesh: Mesh): LodCrossFadeState | null {
	if (!mesh.metadata || typeof mesh.metadata !== "object") return null;
	const state = (mesh.metadata as Record<string, unknown>).__lodCrossFade as
		| LodCrossFadeState
		| undefined;
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
	if (!mesh.metadata || typeof mesh.metadata !== "object") return;
	delete (mesh.metadata as Record<string, unknown>).__lodCrossFade;
}

function setMeshFadeState(mesh: Mesh, state: LodCrossFadeState): void {
	ensureMeshMetadata(mesh).__lodCrossFade = state;
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
	oldMesh.visibility = 1;

	setMeshFadeState(newMesh, {
		startMs: now,
		durationMs: LOD_FADE_DURATION_MS,
		direction: 1,
		seed,
	});
	setMeshFadeState(oldMesh, {
		startMs: now,
		durationMs: LOD_FADE_DURATION_MS,
		direction: -1,
		seed,
	});
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

	const elapsed = (performance.now() - state.startMs) / state.durationMs;
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

		const fade = getMeshFadeUniforms(mesh as Mesh | undefined);
		effect.setFloat("lodFadeProgress", fade.progress);
		effect.setFloat("lodFadeDirection", fade.direction);
		effect.setFloat("lodFadeSeed", fade.seed);
		const scene = (mesh as Mesh | undefined)?.getScene() ?? Map1.mainScene;
		effect.setFloat4(
			"vFogInfos",
			scene.fogMode,
			scene.fogStart,
			scene.fogEnd,
			scene.fogDensity,
		);
		effect.setColor3("vFogColor", scene.fogColor);
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

function getFaceBufferLengths(mesh: Mesh): Record<string, number> {
	if (!mesh.metadata || typeof mesh.metadata !== "object") {
		mesh.metadata = {};
	}
	const metadata = mesh.metadata as {
		__chunkMesherFaceBufferLengths?: Record<string, number>;
	};
	if (!metadata.__chunkMesherFaceBufferLengths) {
		metadata.__chunkMesherFaceBufferLengths = Object.create(null) as Record<
			string,
			number
		>;
	}
	return metadata.__chunkMesherFaceBufferLengths;
}

function upsertFaceVertexBuffer(
	mesh: Mesh,
	engine: ReturnType<typeof Map1.mainScene.getEngine>,
	kind: string,
	data: Uint8Array,
): void {
	const bufferLengths = getFaceBufferLengths(mesh);
	const existing = mesh.getVertexBuffer(kind);
	const nextLength = data.length;

	// Fast path: same-sized updatable buffer -> update in place.
	if (
		existing &&
		existing.isUpdatable() &&
		bufferLengths[kind] === nextLength
	) {
		existing.update(data);
		return;
	}

	// Size changed or old buffer is not updatable -> recreate.
	existing?.dispose();

	mesh.setVerticesBuffer(
		new VertexBuffer(
			engine,
			data,
			kind,
			true,
			undefined,
			4,
			true,
			undefined,
			4,
			VertexBuffer.UNSIGNED_BYTE,
			false,
		),
	);

	bufferLengths[kind] = nextLength;
}

function upsertMesh(
	chunk: Chunk,
	existingMesh: Mesh | null,
	meshData: MeshData,
	name: string,
	material: Material,
	renderingGroupId = 1,
): Mesh {
	const scene = Map1.mainScene;
	const engine = scene.getEngine();

	ensureSharedFacePositionBuffer();

	let mesh = existingMesh;

	if (!mesh) {
		mesh = new Mesh(name, scene);
		mesh.renderingGroupId = renderingGroupId;
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

		// Index buffer is created once per mesh.
		mesh.setIndices(FACE_INDEX_TEMPLATE);

		mesh.position.set(
			chunk.chunkX * Chunk.SIZE,
			chunk.chunkY * Chunk.SIZE,
			chunk.chunkZ * Chunk.SIZE,
		);

		mesh.setBoundingInfo(
			new BoundingInfo(
				Vector3.Zero(),
				new Vector3(Chunk.SIZE, Chunk.SIZE, Chunk.SIZE),
			),
		);
		mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;

		mesh.freezeWorldMatrix();
	}

	mesh.renderingGroupId = renderingGroupId;
	mesh.material = material;
	mesh.name = `${name}_${chunk.chunkX}_${chunk.chunkY}_${chunk.chunkZ}`;

	upsertFaceVertexBuffer(mesh, engine, "faceDataA", meshData.faceDataA);
	upsertFaceVertexBuffer(mesh, engine, "faceDataB", meshData.faceDataB);
	upsertFaceVertexBuffer(mesh, engine, "faceDataC", meshData.faceDataC);

	mesh.overridenInstanceCount = meshData.faceCount;

	return mesh;
}

function createCachedTexture(url: string, scene: any, args: any): Texture {
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

export function initAtlas(): void {
	const scene = Map1.mainScene;
	if (!scene) {
		console.error("initAtlas(): scene is not available.");
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
		globalUniformBuffer.create();
	}

	const tileSize = TextureAtlasFactory.atlasTileSize;

	// The LOD materials share the same uniform list — hoist it to avoid
	// repeating the array literal six times.
	const lodUniforms = [
		"world",
		"worldViewProjection",
		"atlasTileSize",
		"vFogInfos",
		"vFogColor",
		"lodFadeProgress",
		"lodFadeDirection",
		"lodFadeSeed",
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
				attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
				uniforms: ["world", "worldViewProjection", "atlasTileSize"],
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture", "normalTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.setPrePassRenderer(scene.prePassRenderer!);
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.freeze();
		atlasMaterial = mat;
	} else {
		const mat = atlasMaterial as ShaderMaterial;
		if (mat.isFrozen) mat.unfreeze();
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		mat.freeze();
	}

	// -------------------------------------------------------------------------
	// Transparent material
	// -------------------------------------------------------------------------
	if (!transparentMaterial) {
		const mat = new ShaderMaterial(
			"transparentChunkShaderMaterial",
			scene,
			// IMPORTANT FIX:
			// Use the transparent vertex shader, not the shared "chunk" vertex shader.
			{ vertex: "transparentChunk", fragment: "transparentChunk" },
			{
				attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
				uniforms: ["world", "worldViewProjection", "atlasTileSize"],
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture", "normalTexture"],
			},
		);
		mat.backFaceCulling = false;
		mat.forceDepthWrite = false;
		mat.needAlphaBlending = () => true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.freeze();
		transparentMaterial = mat;
	} else {
		const mat = transparentMaterial as ShaderMaterial;
		if (mat.isFrozen) mat.unfreeze();
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
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
				attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
				uniforms: lodUniforms,
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		lod3OpaqueMaterial = mat;
	} else {
		const mat = lod3OpaqueMaterial as ShaderMaterial;
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
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
				attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
				uniforms: lodUniforms,
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.forceDepthWrite = false;
		mat.needAlphaBlending = () => true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		lod3TransparentMaterial = mat;
	} else {
		const mat = lod3TransparentMaterial as ShaderMaterial;
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
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
				attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
				uniforms: lodUniforms,
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture", "normalTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		lod2OpaqueMaterial = mat;
	} else {
		const mat = lod2OpaqueMaterial as ShaderMaterial;
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
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
				attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
				uniforms: lodUniforms,
				uniformBuffers: ["GlobalUniforms"],
				samplers: ["diffuseTexture", "normalTexture"],
			},
		);
		mat.backFaceCulling = true;
		mat.forceDepthWrite = false;
		mat.needAlphaBlending = () => true;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		lod2TransparentMaterial = mat;
	} else {
		const mat = lod2TransparentMaterial as ShaderMaterial;
		mat.wireframe = GLOBAL_VALUES.DEBUG;
		mat.setFloat("atlasTileSize", tileSize);
		mat.setTexture("diffuseTexture", diffuseAtlasTexture);
		if (normalAtlasTexture) mat.setTexture("normalTexture", normalAtlasTexture);
		mat.setUniformBuffer("GlobalUniforms", globalUniformBuffer);
		applyLodShaderBindings(mat);
	}
}

export function createMeshFromData(
	chunk: Chunk,
	meshData: { opaque: MeshData | null; transparent: MeshData | null },
): void {
	const previousOpaqueMesh = chunk.mesh;
	const previousTransparentMesh = chunk.transparentMesh;
	const previousOpaqueLod = getMeshLodLevel(previousOpaqueMesh);
	const previousTransparentLod = getMeshLodLevel(previousTransparentMesh);

	const opaqueMeshData = meshData.opaque;
	const transparentMeshData = meshData.transparent;

	const hasOpaque = !!opaqueMeshData && opaqueMeshData.faceCount > 0;
	const hasTransparent =
		!!transparentMeshData && transparentMeshData.faceCount > 0;

	// Cache raw mesh data for any chunk that may be persisted.
	//
	// NOTE:
	// `isLODMeshCacheDirty` is used to persist derived mesh cache deltas even when
	// voxel storage was not modified (e.g. border geometry generated after
	// neighbors become available).
	const lodLevel = chunk.lodLevel ?? 0;

	// Only persist base mesh fields for LOD0; other LODs should be persisted via
	// the serialized LOD cache (lodMeshes) instead.
	if (lodLevel === 0 && (chunk.isModified || chunk.isLODMeshCacheDirty)) {
		chunk.opaqueMeshData = hasOpaque ? opaqueMeshData : null;
		chunk.transparentMeshData = hasTransparent ? transparentMeshData : null;
	} else {
		chunk.opaqueMeshData = null;
		chunk.transparentMeshData = null;
	}

	const lodChangedOpaque =
		previousOpaqueLod !== null && previousOpaqueLod !== lodLevel;
	const lodChangedTransparent =
		previousTransparentLod !== null && previousTransparentLod !== lodLevel;

	if (hasOpaque) {
		const mat =
			lodLevel >= 3
				? lod3OpaqueMaterial!
				: lodLevel >= 2
					? lod2OpaqueMaterial!
					: atlasMaterial!;

		chunk.mesh = upsertMesh(
			chunk,
			lodChangedOpaque ? null : chunk.mesh,
			opaqueMeshData!,
			"c_opaque",
			mat,
			1,
		);
		setMeshLodLevel(chunk.mesh!, lodLevel);
	} else if (chunk.mesh) {
		chunk.mesh.dispose();
		chunk.mesh = null;
	}

	if (hasTransparent) {
		const mat =
			lodLevel >= 3
				? lod3TransparentMaterial!
				: lodLevel >= 2
					? lod2TransparentMaterial!
					: transparentMaterial!;

		chunk.transparentMesh = upsertMesh(
			chunk,
			lodChangedTransparent ? null : chunk.transparentMesh,
			transparentMeshData!,
			"c_transparent",
			mat,
			1,
		);
		setMeshLodLevel(chunk.transparentMesh!, lodLevel);
	} else if (chunk.transparentMesh) {
		chunk.transparentMesh.dispose();
		chunk.transparentMesh = null;
	}

	if (lodChangedOpaque && previousOpaqueMesh && chunk.mesh) {
		if (shouldUseLodCrossFade(previousOpaqueLod, lodLevel)) {
			beginLodCrossFade(chunk, previousOpaqueMesh, chunk.mesh);
		} else {
			previousOpaqueMesh.dispose();
		}
	}

	if (
		lodChangedTransparent &&
		previousTransparentMesh &&
		chunk.transparentMesh
	) {
		if (shouldUseLodCrossFade(previousTransparentLod, lodLevel)) {
			beginLodCrossFade(chunk, previousTransparentMesh, chunk.transparentMesh);
		} else {
			previousTransparentMesh.dispose();
		}
	}

	if (chunk.colliderDirty) {
		chunk.colliderDirty = false;
	}
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
	u.lightDirection.set(-tmpLightDir.x, -tmpLightDir.y, -tmpLightDir.z);

	const camPos = camera.position;
	u.cameraPosition.set(camPos.x, camPos.y, camPos.z);
	u.cameraPlanes.set(camera.minZ, camera.maxZ);

	const nowMs = performance.now();
	u.time = nowMs / 1000.0;

	// PERF: Inline clamp avoids Math.min/Math.max call overhead.
	const rawIntensity = (-lightDir.y + 0.1) * 4.0;
	u.sunLightIntensity =
		rawIntensity < 0.1 ? 0.1 : rawIntensity > 1.0 ? 1.0 : rawIntensity;

	u.wetness = WorldEnvironment.instance ? WorldEnvironment.instance.wetness : 0;

	globalUniformBuffer.updateVector3("lightDirection", u.lightDirection);
	globalUniformBuffer.updateVector3("cameraPosition", u.cameraPosition);
	globalUniformBuffer.updateFloat("sunLightIntensity", u.sunLightIntensity);
	globalUniformBuffer.updateFloat("wetness", u.wetness);
	globalUniformBuffer.updateFloat("time", u.time);
	globalUniformBuffer.update();

	updateLodCrossFades(nowMs);
}

export function disposeSharedResources(): void {
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
