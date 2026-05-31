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
import { DistantTerrainShader } from "@/code/World/Light/DistantTerrainShader";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { TextureAtlasFactory } from "@/code/World/Texture/TextureAtlasFactory";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";

export class DistantTerrain {
	public static instance: DistantTerrain;
	private mesh: Mesh;
	private waterMesh: Mesh;
	private material: ShaderMaterial;
	private waterMaterial: ShaderMaterial;
	private diffuseAtlasTexture: Texture | null = null;

	// --- Tile lookup texture ---
	private static readonly USE_LA_TILE_TEXTURE = false;

	// PERF: Cached zero vector to avoid Vector3.Zero() allocation in bindCommonUniforms.
	private static readonly _cachedZeroVec = new Vector3(0, 0, 0);

	#surfaceTileLookupTexture: RawTexture;
	#surfaceTileLookupData: Uint8Array;

	#radius: number;
	#gridStep = 1;
	#gridResolution: number;

	// Shared worker-written terrain buffers
	#sharedPositions: Int16Array;
	#sharedNormals: Int8Array;
	#sharedSurfaceTiles: Uint8Array;

	// Reusable vector
	#gridOrigin = new Vector2();

	// GPU buffers (created once, updated)
	#positionVB?: VertexBuffer;
	#normalVB?: VertexBuffer;

	constructor() {
		this.#radius = SETTING_PARAMS.DISTANT_RENDER_DISTANCE;
		const segments = Math.floor((this.#radius * 2) / this.#gridStep);
		this.#gridResolution = segments + 1;
		const size = this.#radius * 2 * Chunk.SIZE;

		// -----------------------------------------------------------------
		// SharedArrayBuffer setup
		// -----------------------------------------------------------------
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

		const vertexCount = this.#gridResolution * this.#gridResolution;

		const positionsBuffer = new SharedArrayBuffer(
			vertexCount * 3 * Int16Array.BYTES_PER_ELEMENT,
		);
		const normalsBuffer = new SharedArrayBuffer(
			vertexCount * 3 * Int8Array.BYTES_PER_ELEMENT,
		);
		const surfaceTilesBuffer = new SharedArrayBuffer(
			vertexCount * 2 * Uint8Array.BYTES_PER_ELEMENT,
		);

		this.#sharedPositions = new Int16Array(positionsBuffer);
		this.#sharedNormals = new Int8Array(normalsBuffer);
		this.#sharedSurfaceTiles = new Uint8Array(surfaceTilesBuffer);

		ChunkWorkerPool.getInstance().initDistantTerrainShared(
			positionsBuffer,
			normalsBuffer,
			surfaceTilesBuffer,
			this.#radius,
			this.#gridStep,
		);

		// ---- Terrain mesh ----
		this.mesh = this.createEmptyGridMesh("distantTerrain", Map1.mainScene);
		this.mesh.sideOrientation = Mesh.FRONTSIDE;

		// ---- Water mesh ----
		this.waterMesh = MeshBuilder.CreateGround(
			"distantWater",
			{
				width: size,
				height: size,
				subdivisions: 1,
				updatable: false,
			},
			Map1.mainScene,
		);

		// ---- Tile lookup texture ----
		if (DistantTerrain.USE_LA_TILE_TEXTURE) {
			this.#surfaceTileLookupData = new Uint8Array(
				this.#gridResolution * this.#gridResolution * 2,
			);
			this.#surfaceTileLookupTexture = RawTexture.CreateLuminanceAlphaTexture(
				this.#surfaceTileLookupData,
				this.#gridResolution,
				this.#gridResolution,
				Map1.mainScene,
				false,
				false,
				Texture.NEAREST_SAMPLINGMODE,
			);
		} else {
			this.#surfaceTileLookupData = new Uint8Array(
				this.#gridResolution * this.#gridResolution * 4,
			);
			this.#surfaceTileLookupTexture = RawTexture.CreateRGBATexture(
				this.#surfaceTileLookupData,
				this.#gridResolution,
				this.#gridResolution,
				Map1.mainScene,
				false,
				false,
				Texture.NEAREST_SAMPLINGMODE,
			);
		}

		this.#surfaceTileLookupTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
		this.#surfaceTileLookupTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

		ChunkWorkerPool.getInstance().onDistantTerrainGenerated = (data) => {
			// Convert chunk coordinates back to world coordinates for positioning
			const worldX = data.centerChunkX * Chunk.SIZE;
			const worldZ = data.centerChunkZ * Chunk.SIZE;
			this.applyTerrainData(
				this.#sharedPositions,
				this.#sharedNormals,
				this.#sharedSurfaceTiles,
				worldX,
				worldZ,
			);
		};
		// ---- Shaders ----
		Effect.ShadersStore["distantTerrainVertexShader"] =
			DistantTerrainShader.distantTerrainVertexShader;
		Effect.ShadersStore["distantTerrainFragmentShader"] =
			DistantTerrainShader.distantTerrainFragmentShader;
		Effect.ShadersStore["distantWaterVertexShader"] =
			DistantTerrainShader.distantWaterVertexShader;
		Effect.ShadersStore["distantWaterFragmentShader"] =
			DistantTerrainShader.distantWaterFragmentShader;

		// ---- Terrain material ----
		this.material = new ShaderMaterial(
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

		this.material.onBind = (mesh) => {
			const effect = this.material.getEffect();
			if (!effect) return;
			this.bindCommonUniforms(effect, mesh.getScene());
		};

		this.material.setFloat("atlasTileSize", TextureAtlasFactory.atlasTileSize);
		this.material.setFloat("textureScale", 32);
		this.material.setFloat("tileGridResolution", this.#gridResolution);
		this.material.setFloat("gridWorldStep", Chunk.SIZE * this.#gridStep);
		this.material.setFloat("useTexture", 0);
		this.material.setTexture(
			"tileLookupTexture",
			this.#surfaceTileLookupTexture,
		);

		this.bindDiffuseTexture();
		this.mesh.material = this.material;

		// ---- Water material ----
		this.waterMaterial = new ShaderMaterial(
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

		this.waterMaterial.onBind = (mesh) => {
			const effect = this.waterMaterial.getEffect();
			if (!effect) return;
			this.bindCommonUniforms(effect, mesh.getScene());
		};

		this.waterMesh.material = this.waterMaterial;

		// ---- Mesh flags ----
		this.mesh.isPickable = false;
		this.mesh.checkCollisions = false;
		this.mesh.receiveShadows = false;
		this.mesh.doNotSyncBoundingInfo = true;
		this.mesh.alwaysSelectAsActiveMesh = true;

		this.waterMesh.isPickable = false;
		this.waterMesh.checkCollisions = false;
		this.waterMesh.receiveShadows = false;
		this.waterMesh.doNotSyncBoundingInfo = true;
		this.waterMesh.alwaysSelectAsActiveMesh = true;
		// If active mesh list was frozen for debugging, include these newly
		// created meshes by rebuilding the frozen list once.
		if (Map1.mainScene._activeMeshesFrozen) {
			Map1.mainScene.unfreezeActiveMeshes();
			Map1.mainScene.freezeActiveMeshes();
		}

		// ---- Worker callback ----
		// Worker only returns center coords; data lives in shared buffers.
	}

	public static getInstance(): DistantTerrain {
		if (!DistantTerrain.instance) {
			DistantTerrain.instance = new DistantTerrain();
		}
		return DistantTerrain.instance;
	}
	public static checkInstance(): boolean {
		return !!DistantTerrain.instance;
	}

	private createEmptyGridMesh(name: string, scene: Scene): Mesh {
		const mesh = new Mesh(name, scene);
		const engine = scene.getEngine();

		const res = this.#gridResolution;
		const vertexCount = res * res;
		const quadCount = (res - 1) * (res - 1);
		const indexCount = quadCount * 6;

		// Choose 16-bit or 32-bit index buffer
		const useUint32 = vertexCount > 65535 && !!engine.getCaps().uintIndices;
		const indices = useUint32
			? new Uint32Array(indexCount)
			: new Uint16Array(indexCount);

		// Build indices once
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
		mesh.setIndices(indices);

		const positions = new Int16Array(vertexCount * 3);
		const normals = new Int8Array(vertexCount * 3);

		for (let i = 1; i < normals.length; i += 3) {
			normals[i] = 127;
		}

		this.#positionVB = new VertexBuffer(
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
		mesh.setVerticesBuffer(this.#positionVB);

		this.#normalVB = new VertexBuffer(
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
		mesh.setVerticesBuffer(this.#normalVB);

		return mesh;
	}

	private bindDiffuseTexture() {
		if (!this.diffuseAtlasTexture) {
			this.diffuseAtlasTexture = TextureAtlasFactory.getDiffuse();
		}

		if (!this.diffuseAtlasTexture) {
			this.diffuseAtlasTexture = new Texture(
				"/texture/diffuse_atlas.png",
				Map1.mainScene,
				{
					noMipmap: false,
					samplingMode: Texture.NEAREST_SAMPLINGMODE,
				},
			);
			TextureAtlasFactory.setDiffuse(this.diffuseAtlasTexture);
		}

		if (this.diffuseAtlasTexture) {
			this.diffuseAtlasTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
			this.diffuseAtlasTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
			this.material.setTexture("diffuseTexture", this.diffuseAtlasTexture);
			this.material.setFloat("useTexture", 1);
		}
	}

	private bindCommonUniforms(effect: Effect, scene: Scene) {
		effect.setVector3("lightDirection", GLOBAL_VALUES.skyLightDirection);

		const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
		const _raw = sunElevation * 4;
		const sunLightIntensity = _raw < 0.1 ? 0.1 : _raw > 1.0 ? 1.0 : _raw;
		effect.setFloat("sunLightIntensity", sunLightIntensity);

		effect.setVector3(
			"cameraPosition",
			scene.activeCamera?.position || DistantTerrain._cachedZeroVec,
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

	public update(worldX: number, worldZ: number) {
		ChunkWorkerPool.getInstance().scheduleDistantTerrain(
			worldToChunkCoord(worldX),
			worldToChunkCoord(worldZ),
			this.#radius,
			SETTING_PARAMS.RENDER_DISTANCE,
			this.#gridStep,
		);
	}

	private applyTerrainData(
		positions: Int16Array,
		normals: Int8Array,
		surfaceTiles: Uint8Array,
		worldX: number,
		worldZ: number,
	) {
		this.mesh.position.set(worldX, -2, worldZ);

		this.waterMesh.position.set(worldX, GenerationParams.SEA_LEVEL, worldZ);
		this.#gridOrigin.x = worldX - this.#radius * Chunk.SIZE;
		this.#gridOrigin.y = worldZ - this.#radius * Chunk.SIZE;
		this.material.setVector2("gridOriginWorld", this.#gridOrigin);

		// Update existing GPU buffers only
		this.#positionVB?.update(positions);
		this.#normalVB?.update(normals);

		// Update tile lookup texture
		if (DistantTerrain.USE_LA_TILE_TEXTURE) {
			if (surfaceTiles.length !== this.#surfaceTileLookupData.length) {
				for (let i = 0, j = 0; i < surfaceTiles.length; i += 2, j += 2) {
					this.#surfaceTileLookupData[j] = surfaceTiles[i];
					this.#surfaceTileLookupData[j + 1] = surfaceTiles[i + 1];
				}
			} else {
				this.#surfaceTileLookupData.set(surfaceTiles);
			}
		} else {
			for (
				let src = 0, dst = 0;
				src < surfaceTiles.length;
				src += 2, dst += 4
			) {
				this.#surfaceTileLookupData[dst] = surfaceTiles[src];
				this.#surfaceTileLookupData[dst + 1] = surfaceTiles[src + 1];
				this.#surfaceTileLookupData[dst + 2] = 0;
				this.#surfaceTileLookupData[dst + 3] = 255;
			}
		}

		this.#surfaceTileLookupTexture.update(this.#surfaceTileLookupData);
	}
	public static resetInstance(): void {
		DistantTerrain.instance = undefined!;
	}
}
