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
import { GLOBAL_VALUES } from "../GlobalValues";
import { Lod2Shader } from "../Light/Lod2Shader";
import { Lod3Shader } from "../Light/Lod3Shader";
import { OpaqueShader } from "../Light/OpaqueShader";
import { TransparentShader } from "../Light/TransparentShader";
import { TextureAtlasFactory } from "../Texture/TextureAtlasFactory";
import { TextureCache } from "../Texture/TextureCache";
import { Chunk } from "./Chunk";
import type { MeshData } from "./DataStructures/MeshData";

type LodCrossFadeState = {
	startMs: number;
	durationMs: number;
	direction: 1 | -1;
	seed: number;
};

export class ChunkMesher {
	static #atlasMaterial: Material | null = null;
	static #transparentMaterial: Material | null = null;
	static #lod3OpaqueMaterial: Material | null = null;
	static #lod3TransparentMaterial: Material | null = null;

	static #lod2OpaqueMaterial: Material | null = null;
	static #lod2TransparentMaterial: Material | null = null;

	static #globalUniformBuffer: UniformBuffer | null = null;
	static #sharedFacePositionBuffer: Buffer | null = null;
	static #activeLodFadeMeshes = new Set<Mesh>();
	static readonly #LOD_FADE_DURATION_MS = 150;

	// Cache global uniforms — updated once per frame.
	static #cachedUniforms = {
		lightDirection: new Vector3(0, 1, 0),
		cameraPosition: new Vector3(0, 0, 0),
		cameraPlanes: new Vector2(0.1, 1000),
		time: 0,
		sunLightIntensity: 1.0,
		wetness: 0,
	};

	// OPTIMIZATION: Scratch Vector3 reused in updateGlobalUniforms to avoid
	// allocating a new object every frame when normalizing the light direction.
	private static _tmpLightDir = new Vector3(0, 0, 0);

	private static lastUpdateFrame = -1;
	private static readonly FACE_VERTEX_TEMPLATE = new Float32Array([
		0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0,
	]);
	private static readonly FACE_INDEX_TEMPLATE = new Uint16Array([
		0, 1, 2, 3, 4, 5,
	]);

	private static ensureMeshMetadata(mesh: Mesh): Record<string, unknown> {
		if (!mesh.metadata || typeof mesh.metadata !== "object") {
			mesh.metadata = {};
		}
		return mesh.metadata as Record<string, unknown>;
	}

	private static getMeshLodLevel(mesh: Mesh | null): number | null {
		if (!mesh?.metadata || typeof mesh.metadata !== "object") {
			return null;
		}
		const lod = (mesh.metadata as Record<string, unknown>).__lodLevel;
		return typeof lod === "number" ? lod : null;
	}

	private static setMeshLodLevel(mesh: Mesh, lod: number): void {
		const metadata = ChunkMesher.ensureMeshMetadata(mesh);
		metadata.__lodLevel = lod;
	}

	private static getMeshFadeState(mesh: Mesh): LodCrossFadeState | null {
		if (!mesh.metadata || typeof mesh.metadata !== "object") {
			return null;
		}
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

	private static clearMeshFadeState(mesh: Mesh): void {
		if (!mesh.metadata || typeof mesh.metadata !== "object") return;
		delete (mesh.metadata as Record<string, unknown>).__lodCrossFade;
	}

	private static setMeshFadeState(mesh: Mesh, state: LodCrossFadeState): void {
		const metadata = ChunkMesher.ensureMeshMetadata(mesh);
		metadata.__lodCrossFade = state;
		ChunkMesher.#activeLodFadeMeshes.add(mesh);
	}

	private static makeFadeSeed(chunk: Chunk): number {
		const hx = Math.imul(chunk.chunkX | 0, 73856093);
		const hy = Math.imul(chunk.chunkY | 0, 19349663);
		const hz = Math.imul(chunk.chunkZ | 0, 83492791);
		const mixed = (hx ^ hy ^ hz) >>> 0;
		return (mixed % 1024) + 1;
	}

	private static beginLodCrossFade(
		chunk: Chunk,
		oldMesh: Mesh | null,
		newMesh: Mesh | null,
	): void {
		if (!oldMesh || !newMesh) return;
		if (oldMesh === newMesh) return;
		if (oldMesh.isDisposed() || newMesh.isDisposed()) return;

		const now = performance.now();
		const seed = ChunkMesher.makeFadeSeed(chunk);
		const durationMs = ChunkMesher.#LOD_FADE_DURATION_MS;

		newMesh.visibility = 0;
		oldMesh.visibility = 1;

		ChunkMesher.setMeshFadeState(newMesh, {
			startMs: now,
			durationMs,
			direction: 1,
			seed,
		});
		ChunkMesher.setMeshFadeState(oldMesh, {
			startMs: now,
			durationMs,
			direction: -1,
			seed,
		});
	}

	private static shouldUseLodCrossFade(
		previousLod: number | null,
		nextLod: number,
	): boolean {
		if (previousLod === null || previousLod === nextLod) return false;
		// LOD0 <-> LOD1 is intentionally instant: quality is very close.
		if (
			(previousLod === 0 && nextLod === 1) ||
			(previousLod === 1 && nextLod === 0)
		) {
			return false;
		}
		return true;
	}

	private static getMeshFadeUniforms(mesh: Mesh | undefined): {
		progress: number;
		direction: number;
		seed: number;
	} {
		if (!mesh) {
			return { progress: 1, direction: 0, seed: 0 };
		}

		const state = ChunkMesher.getMeshFadeState(mesh);
		if (!state) {
			return { progress: 1, direction: 0, seed: 0 };
		}

		const elapsed = (performance.now() - state.startMs) / state.durationMs;
		const t = Math.min(1, Math.max(0, elapsed));
		return {
			// Progress always runs from 0 to 1.
			// Direction decides whether we are fading in or fading out.
			progress: t,
			direction: state.direction,
			seed: state.seed,
		};
	}

	private static updateLodCrossFades(nowMs: number): void {
		if (ChunkMesher.#activeLodFadeMeshes.size === 0) return;

		for (const mesh of Array.from(ChunkMesher.#activeLodFadeMeshes)) {
			if (!mesh || mesh.isDisposed()) {
				ChunkMesher.#activeLodFadeMeshes.delete(mesh);
				continue;
			}

			const state = ChunkMesher.getMeshFadeState(mesh);
			if (!state) {
				ChunkMesher.#activeLodFadeMeshes.delete(mesh);
				continue;
			}

			const t = (nowMs - state.startMs) / state.durationMs;
			const clamped = Math.min(1, Math.max(0, t));
			mesh.visibility = state.direction > 0 ? clamped : 1 - clamped;
			if (t >= 1) {
				ChunkMesher.#activeLodFadeMeshes.delete(mesh);
				ChunkMesher.clearMeshFadeState(mesh);
				if (state.direction < 0) {
					mesh.dispose();
				} else {
					mesh.visibility = 1;
				}
			}
		}
	}

	private static applyLodShaderBindings(material: ShaderMaterial): void {
		material.onBind = (mesh) => {
			const effect = material.getEffect();
			if (!effect) return;

			const fade = ChunkMesher.getMeshFadeUniforms(mesh as Mesh | undefined);
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

	static initAtlas() {
		const scene = Map1.mainScene;
		if (!scene) {
			console.error("ChunkMesher.initAtlas(): scene is not available.");
			return;
		}

		let diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
		let normalAtlasTexture = TextureAtlasFactory.getNormal();

		if (!diffuseAtlasTexture) {
			if (GLOBAL_VALUES.CACHE_TEXTURES) {
				diffuseAtlasTexture = ChunkMesher.createCachedTexture(
					"/texture/diffuse_atlas.png",
					scene,
					{
						noMipmap: false,
						samplingMode: Texture.NEAREST_SAMPLINGMODE,
					},
				);
				normalAtlasTexture = ChunkMesher.createCachedTexture(
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

		// ---------------------------------------------------------------------------
		// Shader registration
		// ---------------------------------------------------------------------------
		Effect.ShadersStore["chunkVertexShader"] = OpaqueShader.chunkVertexShader;
		Effect.ShadersStore["chunkFragmentShader"] =
			OpaqueShader.chunkFragmentShader;

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

		if (!ChunkMesher.#globalUniformBuffer) {
			const engine = scene.getEngine();
			ChunkMesher.#globalUniformBuffer = new UniformBuffer(
				engine,
				undefined,
				true,
				"GlobalUniforms",
			);
			ChunkMesher.#globalUniformBuffer.addUniform("lightDirection", 3);
			ChunkMesher.#globalUniformBuffer.addUniform("cameraPosition", 3);
			ChunkMesher.#globalUniformBuffer.addUniform("sunLightIntensity", 1);
			ChunkMesher.#globalUniformBuffer.addUniform("wetness", 1);
			ChunkMesher.#globalUniformBuffer.addUniform("time", 1);
			ChunkMesher.#globalUniformBuffer.create();
		}

		// ---------------------------------------------------------------------------
		// Opaque material
		// ---------------------------------------------------------------------------
		if (!ChunkMesher.#atlasMaterial) {
			const opaqueBlockShader = new ShaderMaterial(
				"chunkShaderMaterial",
				scene,
				{ vertex: "chunk", fragment: "chunk" },
				{
					attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
					uniforms: [
						"world",
						"worldViewProjection",
						"atlasTileSize",
						"maxAtlasTiles",
					],
					uniformBuffers: ["GlobalUniforms"],
					samplers: ["diffuseTexture", "normalTexture"],
				},
			);
			opaqueBlockShader.backFaceCulling = true;
			opaqueBlockShader.setPrePassRenderer(scene.prePassRenderer!);
			opaqueBlockShader.setFloat(
				"atlasTileSize",
				TextureAtlasFactory.atlasTileSize,
			);
			opaqueBlockShader.setFloat(
				"maxAtlasTiles",
				TextureAtlasFactory.atlasSize,
			);
			opaqueBlockShader.setTexture("diffuseTexture", diffuseAtlasTexture);
			if (normalAtlasTexture) {
				opaqueBlockShader.setTexture("normalTexture", normalAtlasTexture);
			}
			opaqueBlockShader.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			opaqueBlockShader.wireframe = GLOBAL_VALUES.DEBUG;
			opaqueBlockShader.freeze();
			ChunkMesher.#atlasMaterial = opaqueBlockShader;
		} else {
			const opaqueMat = ChunkMesher.#atlasMaterial as ShaderMaterial;
			if (opaqueMat.isFrozen) opaqueMat.unfreeze();
			opaqueMat.wireframe = GLOBAL_VALUES.DEBUG;
			opaqueMat.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
			opaqueMat.setFloat("maxAtlasTiles", TextureAtlasFactory.atlasSize);
			opaqueMat.setTexture("diffuseTexture", diffuseAtlasTexture);
			if (normalAtlasTexture) {
				opaqueMat.setTexture("normalTexture", normalAtlasTexture);
			}
			opaqueMat.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			opaqueMat.freeze();
		}

		// ---------------------------------------------------------------------------
		// Transparent material
		// ---------------------------------------------------------------------------
		if (!ChunkMesher.#transparentMaterial) {
			const transparentMat = new ShaderMaterial(
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
			transparentMat.backFaceCulling = false;
			transparentMat.forceDepthWrite = false;
			transparentMat.needAlphaBlending = () => true;
			transparentMat.setFloat(
				"atlasTileSize",
				TextureAtlasFactory.atlasTileSize,
			);
			transparentMat.setTexture("diffuseTexture", diffuseAtlasTexture);
			if (normalAtlasTexture) {
				transparentMat.setTexture("normalTexture", normalAtlasTexture);
			}
			transparentMat.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			transparentMat.wireframe = GLOBAL_VALUES.DEBUG;
			transparentMat.freeze();
			ChunkMesher.#transparentMaterial = transparentMat;
		} else {
			const transparentMat = ChunkMesher.#transparentMaterial as ShaderMaterial;
			if (transparentMat.isFrozen) transparentMat.unfreeze();
			transparentMat.wireframe = GLOBAL_VALUES.DEBUG;
			transparentMat.setFloat(
				"atlasTileSize",
				TextureAtlasFactory.atlasTileSize,
			);
			transparentMat.setTexture("diffuseTexture", diffuseAtlasTexture);
			if (normalAtlasTexture) {
				transparentMat.setTexture("normalTexture", normalAtlasTexture);
			}
			transparentMat.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			transparentMat.freeze();
		}

		// ---------------------------------------------------------------------------
		// LOD3 opaque material
		// ---------------------------------------------------------------------------
		if (!ChunkMesher.#lod3OpaqueMaterial) {
			const lod3Opaque = new ShaderMaterial(
				"lod3ChunkShaderMaterial",
				scene,
				{ vertex: "lod3Chunk", fragment: "lod3Chunk" },
				{
					attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
					uniforms: [
						"world",
						"worldViewProjection",
						"atlasTileSize",
						"vFogInfos",
						"vFogColor",
						"lodFadeProgress",
						"lodFadeDirection",
						"lodFadeSeed",
					],
					uniformBuffers: ["GlobalUniforms"],
					samplers: ["diffuseTexture"],
				},
			);
			lod3Opaque.backFaceCulling = true;
			lod3Opaque.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
			lod3Opaque.setTexture("diffuseTexture", diffuseAtlasTexture);
			lod3Opaque.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			ChunkMesher.applyLodShaderBindings(lod3Opaque);
			lod3Opaque.wireframe = GLOBAL_VALUES.DEBUG;
			ChunkMesher.#lod3OpaqueMaterial = lod3Opaque;
		} else {
			const lod3Opaque = ChunkMesher.#lod3OpaqueMaterial as ShaderMaterial;
			lod3Opaque.wireframe = GLOBAL_VALUES.DEBUG;
			lod3Opaque.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
			lod3Opaque.setTexture("diffuseTexture", diffuseAtlasTexture);
			lod3Opaque.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			ChunkMesher.applyLodShaderBindings(lod3Opaque);
		}

		// ---------------------------------------------------------------------------
		// LOD3 transparent material
		// ---------------------------------------------------------------------------
		if (!ChunkMesher.#lod3TransparentMaterial) {
			const lod3Transparent = new ShaderMaterial(
				"lod3TransparentChunkShaderMaterial",
				scene,
				{ vertex: "lod3Chunk", fragment: "lod3TransparentChunk" },
				{
					attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
					uniforms: [
						"world",
						"worldViewProjection",
						"atlasTileSize",
						"vFogInfos",
						"vFogColor",
						"lodFadeProgress",
						"lodFadeDirection",
						"lodFadeSeed",
					],
					uniformBuffers: ["GlobalUniforms"],
					samplers: ["diffuseTexture"],
				},
			);
			lod3Transparent.backFaceCulling = false;
			lod3Transparent.forceDepthWrite = false;
			lod3Transparent.needAlphaBlending = () => true;
			lod3Transparent.setFloat(
				"atlasTileSize",
				TextureAtlasFactory.atlasTileSize,
			);
			lod3Transparent.setTexture("diffuseTexture", diffuseAtlasTexture);
			lod3Transparent.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			ChunkMesher.applyLodShaderBindings(lod3Transparent);
			lod3Transparent.wireframe = GLOBAL_VALUES.DEBUG;
			ChunkMesher.#lod3TransparentMaterial = lod3Transparent;
		} else {
			const lod3Transparent =
				ChunkMesher.#lod3TransparentMaterial as ShaderMaterial;
			lod3Transparent.wireframe = GLOBAL_VALUES.DEBUG;
			lod3Transparent.setFloat(
				"atlasTileSize",
				TextureAtlasFactory.atlasTileSize,
			);
			lod3Transparent.setTexture("diffuseTexture", diffuseAtlasTexture);
			lod3Transparent.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			ChunkMesher.applyLodShaderBindings(lod3Transparent);
		}

		// ---------------------------------------------------------------------------
		// LOD2 opaque material
		// ---------------------------------------------------------------------------
		if (!ChunkMesher.#lod2OpaqueMaterial) {
			const lod2Opaque = new ShaderMaterial(
				"lod2ChunkShaderMaterial",
				scene,
				{ vertex: "lod2Chunk", fragment: "lod2Chunk" },
				{
					attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
					uniforms: [
						"world",
						"worldViewProjection",
						"atlasTileSize",
						"vFogInfos",
						"vFogColor",
						"lodFadeProgress",
						"lodFadeDirection",
						"lodFadeSeed",
					],
					uniformBuffers: ["GlobalUniforms"],
					samplers: ["diffuseTexture", "normalTexture"],
				},
			);
			lod2Opaque.backFaceCulling = true;
			lod2Opaque.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
			lod2Opaque.setTexture("diffuseTexture", diffuseAtlasTexture);
			if (normalAtlasTexture) {
				lod2Opaque.setTexture("normalTexture", normalAtlasTexture);
			}
			lod2Opaque.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			ChunkMesher.applyLodShaderBindings(lod2Opaque);
			lod2Opaque.wireframe = GLOBAL_VALUES.DEBUG;
			ChunkMesher.#lod2OpaqueMaterial = lod2Opaque;
		} else {
			const lod2Opaque = ChunkMesher.#lod2OpaqueMaterial as ShaderMaterial;
			lod2Opaque.wireframe = GLOBAL_VALUES.DEBUG;
			lod2Opaque.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
			lod2Opaque.setTexture("diffuseTexture", diffuseAtlasTexture);
			if (normalAtlasTexture) {
				lod2Opaque.setTexture("normalTexture", normalAtlasTexture);
			}
			lod2Opaque.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			ChunkMesher.applyLodShaderBindings(lod2Opaque);
		}

		// ---------------------------------------------------------------------------
		// LOD2 transparent material
		// ---------------------------------------------------------------------------
		if (!ChunkMesher.#lod2TransparentMaterial) {
			const lod2Transparent = new ShaderMaterial(
				"lod2TransparentChunkShaderMaterial",
				scene,
				{ vertex: "lod2Chunk", fragment: "lod2TransparentChunk" },
				{
					attributes: ["position", "faceDataA", "faceDataB", "faceDataC"],
					uniforms: [
						"world",
						"worldViewProjection",
						"atlasTileSize",
						"vFogInfos",
						"vFogColor",
						"lodFadeProgress",
						"lodFadeDirection",
						"lodFadeSeed",
					],
					uniformBuffers: ["GlobalUniforms"],
					samplers: ["diffuseTexture", "normalTexture"],
				},
			);
			lod2Transparent.backFaceCulling = false;
			lod2Transparent.forceDepthWrite = false;
			lod2Transparent.needAlphaBlending = () => true;
			lod2Transparent.setFloat(
				"atlasTileSize",
				TextureAtlasFactory.atlasTileSize,
			);
			lod2Transparent.setTexture("diffuseTexture", diffuseAtlasTexture);
			if (normalAtlasTexture) {
				lod2Transparent.setTexture("normalTexture", normalAtlasTexture);
			}
			lod2Transparent.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			ChunkMesher.applyLodShaderBindings(lod2Transparent);
			lod2Transparent.wireframe = GLOBAL_VALUES.DEBUG;
			ChunkMesher.#lod2TransparentMaterial = lod2Transparent;
		} else {
			const lod2Transparent =
				ChunkMesher.#lod2TransparentMaterial as ShaderMaterial;
			lod2Transparent.wireframe = GLOBAL_VALUES.DEBUG;
			lod2Transparent.setFloat(
				"atlasTileSize",
				TextureAtlasFactory.atlasTileSize,
			);
			lod2Transparent.setTexture("diffuseTexture", diffuseAtlasTexture);
			if (normalAtlasTexture) {
				lod2Transparent.setTexture("normalTexture", normalAtlasTexture);
			}
			lod2Transparent.setUniformBuffer(
				"GlobalUniforms",
				ChunkMesher.#globalUniformBuffer,
			);
			ChunkMesher.applyLodShaderBindings(lod2Transparent);
		}
	}
	private static ensureSharedFacePositionBuffer(): void {
		if (ChunkMesher.#sharedFacePositionBuffer) {
			return;
		}

		const scene = Map1.mainScene;
		const engine = scene.getEngine();

		ChunkMesher.#sharedFacePositionBuffer = new Buffer(
			engine,
			ChunkMesher.FACE_VERTEX_TEMPLATE,
			false,
			3,
			false,
			false,
		);
	}
	public static createMeshFromData(
		chunk: Chunk,
		meshData: {
			opaque: MeshData | null;
			transparent: MeshData | null;
		},
	) {
		const previousOpaqueMesh = chunk.mesh;
		const previousTransparentMesh = chunk.transparentMesh;
		const previousOpaqueLod = ChunkMesher.getMeshLodLevel(previousOpaqueMesh);
		const previousTransparentLod = ChunkMesher.getMeshLodLevel(
			previousTransparentMesh,
		);

		const opaqueMeshData = meshData.opaque;
		const transparentMeshData = meshData.transparent;

		const hasOpaque = !!opaqueMeshData && opaqueMeshData.faceCount > 0;
		const hasTransparent =
			!!transparentMeshData && transparentMeshData.faceCount > 0;

		// Cache raw mesh data only for chunks that may need saving.
		if (chunk.isModified) {
			chunk.opaqueMeshData = hasOpaque ? opaqueMeshData : null;
			chunk.transparentMeshData = hasTransparent ? transparentMeshData : null;
		} else {
			chunk.opaqueMeshData = null;
			chunk.transparentMeshData = null;
		}
		const lodLevel = chunk.lodLevel ?? 0;

		const lodChangedOpaque =
			previousOpaqueLod !== null && previousOpaqueLod !== lodLevel;
		const lodChangedTransparent =
			previousTransparentLod !== null && previousTransparentLod !== lodLevel;

		if (hasOpaque) {
			const opaqueMaterial =
				lodLevel >= 3
					? ChunkMesher.#lod3OpaqueMaterial!
					: lodLevel >= 2
						? ChunkMesher.#lod2OpaqueMaterial!
						: ChunkMesher.#atlasMaterial!;

			chunk.mesh = ChunkMesher.upsertMesh(
				chunk,
				lodChangedOpaque ? null : chunk.mesh,
				opaqueMeshData!,
				"c_opaque",
				opaqueMaterial,
				1,
			);
			ChunkMesher.setMeshLodLevel(chunk.mesh!, lodLevel);
		} else if (chunk.mesh) {
			chunk.mesh.dispose();
			chunk.mesh = null;
		}

		if (hasTransparent) {
			const transparentMaterial =
				lodLevel >= 3
					? ChunkMesher.#lod3TransparentMaterial!
					: lodLevel >= 2
						? ChunkMesher.#lod2TransparentMaterial!
						: ChunkMesher.#transparentMaterial!;

			chunk.transparentMesh = ChunkMesher.upsertMesh(
				chunk,
				lodChangedTransparent ? null : chunk.transparentMesh,
				transparentMeshData!,
				"c_transparent",
				transparentMaterial,
				1,
			);
			ChunkMesher.setMeshLodLevel(chunk.transparentMesh!, lodLevel);
		} else if (chunk.transparentMesh) {
			chunk.transparentMesh.dispose();
			chunk.transparentMesh = null;
		}

		if (lodChangedOpaque && previousOpaqueMesh && chunk.mesh) {
			if (ChunkMesher.shouldUseLodCrossFade(previousOpaqueLod, lodLevel)) {
				ChunkMesher.beginLodCrossFade(chunk, previousOpaqueMesh, chunk.mesh);
			} else {
				previousOpaqueMesh.dispose();
			}
		}

		if (
			lodChangedTransparent &&
			previousTransparentMesh &&
			chunk.transparentMesh
		) {
			if (ChunkMesher.shouldUseLodCrossFade(previousTransparentLod, lodLevel)) {
				ChunkMesher.beginLodCrossFade(
					chunk,
					previousTransparentMesh,
					chunk.transparentMesh,
				);
			} else {
				previousTransparentMesh.dispose();
			}
		}

		if (chunk.colliderDirty) {
			chunk.colliderDirty = false;
		}
	}
	private static upsertMesh(
		chunk: Chunk,
		existingMesh: Mesh | null,
		meshData: MeshData,
		name: string,
		material: Material,
		renderingGroupId = 1,
	): Mesh {
		const scene = Map1.mainScene;
		const engine = scene.getEngine();

		ChunkMesher.ensureSharedFacePositionBuffer();

		let mesh = existingMesh;

		if (!mesh) {
			mesh = new Mesh(name, scene);
			mesh.renderingGroupId = renderingGroupId;
			mesh.material = material;
			mesh.checkCollisions = false;
			mesh.isPickable = false;
			mesh.doNotSyncBoundingInfo = true;
			mesh.ignoreNonUniformScaling = true;

			// Shared static face-position buffer
			mesh.setVerticesBuffer(
				ChunkMesher.#sharedFacePositionBuffer!.createVertexBuffer(
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
			mesh.setIndices(ChunkMesher.FACE_INDEX_TEMPLATE);

			mesh.position.set(
				chunk.chunkX * Chunk.SIZE,
				chunk.chunkY * Chunk.SIZE,
				chunk.chunkZ * Chunk.SIZE,
			);

			const boundsMin = Vector3.Zero();
			const boundsMax = new Vector3(Chunk.SIZE, Chunk.SIZE, Chunk.SIZE);
			mesh.setBoundingInfo(new BoundingInfo(boundsMin, boundsMax));
			mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION;

			mesh.freezeWorldMatrix();
		}

		mesh.renderingGroupId = renderingGroupId;
		mesh.material = material;
		mesh.name = `${name}_${chunk.chunkX}_${chunk.chunkY}_${chunk.chunkZ}`;

		ChunkMesher.upsertFaceVertexBuffer(
			mesh,
			engine,
			"faceDataA",
			meshData.faceDataA,
		);
		ChunkMesher.upsertFaceVertexBuffer(
			mesh,
			engine,
			"faceDataB",
			meshData.faceDataB,
		);
		ChunkMesher.upsertFaceVertexBuffer(
			mesh,
			engine,
			"faceDataC",
			meshData.faceDataC,
		);

		mesh.overridenInstanceCount = meshData.faceCount;

		return mesh;
	}
	private static upsertFaceVertexBuffer(
		mesh: Mesh,
		engine: ReturnType<typeof Map1.mainScene.getEngine>,
		kind: string,
		data: Uint8Array,
	): void {
		const bufferLengths = ChunkMesher.getFaceBufferLengths(mesh);
		const existing = mesh.getVertexBuffer(kind);
		const nextLength = data.length;

		// Fast path: same sized updatable buffer -> update in place
		if (
			existing &&
			existing.isUpdatable() &&
			bufferLengths[kind] === nextLength
		) {
			existing.update(data);
			return;
		}

		// Size changed or old buffer is not updatable -> recreate
		if (existing) {
			existing.dispose();
		}

		mesh.setVerticesBuffer(
			new VertexBuffer(
				engine,
				data,
				kind,
				true, // updatable
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
	private static getFaceBufferLengths(mesh: Mesh): Record<string, number> {
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

	static updateGlobalUniforms(frameId: number) {
		if (ChunkMesher.lastUpdateFrame === frameId) return;
		ChunkMesher.lastUpdateFrame = frameId;

		const scene = Map1.mainScene;
		if (!scene || !ChunkMesher.#globalUniformBuffer) return;

		const camera = scene.activeCamera;
		if (!camera) return;

		const lightDir = GLOBAL_VALUES.skyLightDirection;
		ChunkMesher._tmpLightDir
			.set(lightDir.x, lightDir.y, lightDir.z)
			.normalizeToRef(ChunkMesher._tmpLightDir);

		const u = ChunkMesher.#cachedUniforms;

		u.lightDirection.set(
			-ChunkMesher._tmpLightDir.x,
			-ChunkMesher._tmpLightDir.y,
			-ChunkMesher._tmpLightDir.z,
		);

		const camPos = camera.position;
		u.cameraPosition.set(camPos.x, camPos.y, camPos.z);
		u.cameraPlanes.set(camera.minZ, camera.maxZ);
		const nowMs = performance.now();
		u.time = nowMs / 1000.0;

		const sunElevation = -lightDir.y + 0.1;
		u.sunLightIntensity = Math.min(1.0, Math.max(0.1, sunElevation * 4.0));
		u.wetness = WorldEnvironment.instance
			? WorldEnvironment.instance.wetness
			: 0;

		ChunkMesher.#globalUniformBuffer.updateVector3(
			"lightDirection",
			u.lightDirection,
		);
		ChunkMesher.#globalUniformBuffer.updateVector3(
			"cameraPosition",
			u.cameraPosition,
		);
		ChunkMesher.#globalUniformBuffer.updateFloat(
			"sunLightIntensity",
			u.sunLightIntensity,
		);
		ChunkMesher.#globalUniformBuffer.updateFloat("wetness", u.wetness);
		ChunkMesher.#globalUniformBuffer.updateFloat("time", u.time);
		ChunkMesher.#globalUniformBuffer.update();

		ChunkMesher.updateLodCrossFades(nowMs);
	}

	private static createCachedTexture(
		url: string,
		scene: any,
		args: any,
	): Texture {
		const texture = new Texture(null, scene, args);

		ChunkMesher.loadTextureToCache(url)
			.then((blobUrl) => {
				const revokeOnceLoaded = () => {
					try {
						URL.revokeObjectURL(blobUrl);
					} catch {
						// Ignore revoke failures.
					}
				};

				texture.onLoadObservable.addOnce(revokeOnceLoaded);
				texture.updateURL(blobUrl);
			})
			.catch((e) => {
				console.warn("Texture cache failed, falling back to network", e);
				texture.updateURL(url);
			});

		return texture;
	}

	private static async loadTextureToCache(url: string): Promise<string> {
		const cacheKey = `${url}?v=${GLOBAL_VALUES.TEXTURE_VERSION}`;

		const cachedBlob = await TextureCache.get(cacheKey);
		if (cachedBlob) {
			return URL.createObjectURL(cachedBlob);
		}

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
	public static disposeSharedResources(): void {
		if (ChunkMesher.#sharedFacePositionBuffer) {
			ChunkMesher.#sharedFacePositionBuffer.dispose();
			ChunkMesher.#sharedFacePositionBuffer = null;
		}

		ChunkMesher.#globalUniformBuffer?.dispose();
		ChunkMesher.#globalUniformBuffer = null;

		ChunkMesher.#atlasMaterial?.dispose();
		ChunkMesher.#atlasMaterial = null;

		ChunkMesher.#transparentMaterial?.dispose();
		ChunkMesher.#transparentMaterial = null;

		ChunkMesher.#lod3OpaqueMaterial?.dispose();
		ChunkMesher.#lod3OpaqueMaterial = null;

		ChunkMesher.#lod3TransparentMaterial?.dispose();
		ChunkMesher.#lod3TransparentMaterial = null;

		ChunkMesher.#lod2OpaqueMaterial?.dispose();
		ChunkMesher.#lod2OpaqueMaterial = null;
		ChunkMesher.#lod2TransparentMaterial?.dispose();
		ChunkMesher.#lod2TransparentMaterial = null;

		ChunkMesher.#activeLodFadeMeshes.clear();
		ChunkMesher.lastUpdateFrame = -1;
	}
}
