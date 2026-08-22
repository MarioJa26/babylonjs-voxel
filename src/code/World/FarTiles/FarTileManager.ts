import {
	addToScene,
	createMeshFromData,
	disposeMeshGpu,
	type EngineContext,
	getCameraPosition,
	type Mesh,
	onBeforeRender,
	removeFromScene,
	resizeMeshGeometry,
	type SceneContext,
	setShaderUniform,
} from "@babylonjs/lite";
import MapFog from "@/code/Maps/MapFog";
import { isEyeUnderwater } from "@/code/Maps/UnderWaterEffect";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { ChunkWorkerPool } from "../Chunk/ChunkWorkerPool";
import type { FarTileGeneratedMessage } from "../Chunk/DataStructures/WorkerMessageType";
import {
	createFarTileTerrainMaterial,
	createFarTileWaterMaterial,
} from "../Light/FarTileShaderLite";
import {
	atlasTileSize,
	getDiffuseTexture2D,
} from "../Texture/TextureAtlasFactory";
import { expandTileFaces } from "./FarTileFaceFormat";
import { getFarTileLevels, isFarTilesEnabled } from "./FarTileLadder";

/**
 * Main-thread far-tile streaming manager.
 *
 * Owns the LOD6+ tile meshes: requests missing tiles nearest-first through
 * the worker pool, expands returned compact face data into vertex buffers,
 * and rebuilds one merged Mesh per ladder level (plus a single global water
 * mesh) whenever a level's tile set changes.
 */

const MAX_TILE_REQUESTS_PER_UPDATE = 24;
const UNLOAD_MARGIN_CHUNKS = 4;

interface TileEntry {
	levelIndex: number;
	tx: number;
	tz: number;
	opaque: import("./FarTileFaceFormat").TileVertexData | null;
	waterPositions: Float32Array | null;
	// waterIndices removed - generated on the fly in rebuildWater()
}

interface LevelRenderState {
	mesh: Mesh | null;
	dirty: boolean;
	// Buffer Pooling to prevent O(N^2) GC Stutter
	capacityQuads: number;
	positions: Float32Array | null;
	normals: Float32Array | null;
	uv2: Float32Array | null;
	colors: Float32Array | null;
	indices: Uint32Array | null;
}

class FarTileManagerImpl {
	private static instance: FarTileManagerImpl | null = null;
	private waterPositionsBuf: Float32Array | null = null;
	private waterNormalsBuf: Float32Array | null = null;
	private waterIndicesBuf: Uint32Array | null = null;

	public static getInstance(): FarTileManagerImpl {
		if (!FarTileManagerImpl.instance) {
			FarTileManagerImpl.instance = new FarTileManagerImpl();
		}
		return FarTileManagerImpl.instance;
	}

	public static peekInstance(): FarTileManagerImpl | null {
		return FarTileManagerImpl.instance;
	}

	private engine: EngineContext | null = null;
	private scene: SceneContext | null = null;

	private terrainMaterial: ReturnType<
		typeof createFarTileTerrainMaterial
	> | null = null;
	private waterMaterial: ReturnType<typeof createFarTileWaterMaterial> | null =
		null;

	private readonly levels: LevelRenderState[] = [];
	private waterMesh: Mesh | null = null;
	private waterDirty = false;

	private readonly tiles = new Map<string, TileEntry>();
	private readonly pendingByKey = new Set<string>();
	private readonly keyByRequestId = new Map<number, string>();

	private lastPlayerChunkX = Number.NaN;
	private lastPlayerChunkZ = Number.NaN;

	// Uniform caches (mirrors DistantTerrain's steady-state skip).
	private fogInfosScratch = new Float32Array(4);
	private fogColorScratch = new Float32Array(3);
	private lightDirScratch = new Float32Array(3);
	private lastLx = Number.NaN;
	private lastLy = Number.NaN;
	private lastLz = Number.NaN;
	private lastSunIntensity = Number.NaN;
	private lastUnderWater: boolean | null = null;
	private lastFogStart = Number.NaN;
	private lastFogEnd = Number.NaN;
	private lastFogColorR = Number.NaN;
	private lastFogColorG = Number.NaN;
	private lastFogColorB = Number.NaN;
	private lastFogInvRange = Number.NaN;

	public init(engine: EngineContext, scene: SceneContext): void {
		if (!isFarTilesEnabled()) return;
		if (this.engine) return;

		this.engine = engine;
		this.scene = scene;

		this.terrainMaterial = createFarTileTerrainMaterial({
			engine,
			scene,
			diffuseTexture: getDiffuseTexture2D(),
			atlasTileSize,
			textureScale: 32,
		});
		this.waterMaterial = createFarTileWaterMaterial();

		for (let i = 0; i < getFarTileLevels().length; i++) {
			this.levels.push({
				mesh: null,
				dirty: false,
				capacityQuads: 0,
				positions: null,
				normals: null,
				uv2: null,
				colors: null,
				indices: null,
			});
		}

		const pool = ChunkWorkerPool.getInstance();
		pool.onFarTileGenerated = (data) => this.handleResult(data);

		onBeforeRender(scene, () => this.frame());
	}

	public isReady(): boolean {
		return this.engine != null;
	}

	// ------------------------------------------------------------------
	// Streaming
	// ------------------------------------------------------------------

	public update(playerWorldX: number, playerWorldZ: number): void {
		if (!this.engine) return;

		const levels = getFarTileLevels();
		const pcx = Math.floor(playerWorldX / 32);
		const pcz = Math.floor(playerWorldZ / 32);

		if (pcx === this.lastPlayerChunkX && pcz === this.lastPlayerChunkZ) {
			return;
		}
		this.lastPlayerChunkX = pcx;
		this.lastPlayerChunkZ = pcz;

		const wanted: {
			key: string;
			levelIndex: number;
			tx: number;
			tz: number;
			dist: number;
		}[] = [];

		for (let li = 0; li < levels.length; li++) {
			const lv = levels[li];
			const span = lv.tileSizeChunks;
			const half = span / 2;

			const txMin = Math.floor((pcx - lv.ringOuterChunks) / span);
			const txMax = Math.floor((pcx + lv.ringOuterChunks) / span);
			const tzMin = Math.floor((pcz - lv.ringOuterChunks) / span);
			const tzMax = Math.floor((pcz + lv.ringOuterChunks) / span);

			for (let tx = txMin; tx <= txMax; tx++) {
				for (let tz = tzMin; tz <= tzMax; tz++) {
					const centerX = tx * span + half;
					const centerZ = tz * span + half;
					const d = Math.max(Math.abs(centerX - pcx), Math.abs(centerZ - pcz));

					if (
						d < lv.ringInnerChunks ||
						d >= lv.ringOuterChunks + UNLOAD_MARGIN_CHUNKS
					) {
						continue;
					}

					const key = `${li}:${tx}:${tz}`;
					if (this.tiles.has(key) || this.pendingByKey.has(key)) continue;

					wanted.push({ key, levelIndex: li, tx, tz, dist: d });
				}
			}
		}

		wanted.sort((a, b) => a.dist - b.dist);

		let requested = 0;
		const pool = ChunkWorkerPool.getInstance();
		for (const w of wanted) {
			if (requested >= MAX_TILE_REQUESTS_PER_UPDATE) break;

			const requestId = pool.scheduleFarTile(w.levelIndex, w.tx, w.tz);
			this.pendingByKey.add(w.key);
			this.keyByRequestId.set(requestId, w.key);
			requested++;
		}

		// Unload tiles beyond their ring + margin.
		for (const [key, entry] of this.tiles) {
			const lv = levels[entry.levelIndex];
			if (!lv) continue;

			const span = lv.tileSizeChunks;
			const centerX = entry.tx * span + span / 2;
			const centerZ = entry.tz * span + span / 2;
			const d = Math.max(Math.abs(centerX - pcx), Math.abs(centerZ - pcz));

			if (d >= lv.ringOuterChunks + UNLOAD_MARGIN_CHUNKS) {
				this.tiles.delete(key);
				this.markLevelDirty(entry.levelIndex);
			}
		}
	}

	public handleResult(data: FarTileGeneratedMessage): void {
		const key = this.keyByRequestId.get(data.requestId);
		this.keyByRequestId.delete(data.requestId);

		if (!key) return;
		this.pendingByKey.delete(key);

		// Stale result for an unloaded tile — drop it.
		if (!this.engine) return;
		if (!this.pendingIsStillWanted(data.levelIndex, data.tileX, data.tileZ)) {
			return;
		}

		const levels = getFarTileLevels();
		const lv = levels[data.levelIndex];
		if (!lv) return;

		const originX = data.tileX * lv.tileSizeChunks * 32;
		const originZ = data.tileZ * lv.tileSizeChunks * 32;

		const expanded = expandTileFaces(
			data.opaqueFaces,
			data.waterFaces,
			originX,
			originZ,
		);

		const entry: TileEntry = {
			levelIndex: data.levelIndex,
			tx: data.tileX,
			tz: data.tileZ,
			opaque: expanded.opaque,
			waterPositions: expanded.waterPositions,
		};

		this.tiles.set(key, entry);
		this.markLevelDirty(data.levelIndex);
	}

	private pendingIsStillWanted(
		levelIndex: number,
		tx: number,
		tz: number,
	): boolean {
		if (Number.isNaN(this.lastPlayerChunkX)) return false;

		const levels = getFarTileLevels();
		const lv = levels[levelIndex];
		if (!lv) return false;

		const span = lv.tileSizeChunks;
		const half = span / 2;
		const centerX = tx * span + half;
		const centerZ = tz * span + half;
		const d = Math.max(
			Math.abs(centerX - this.lastPlayerChunkX),
			Math.abs(centerZ - this.lastPlayerChunkZ),
		);

		return (
			d >= lv.ringInnerChunks && d < lv.ringOuterChunks + UNLOAD_MARGIN_CHUNKS
		);
	}

	private markLevelDirty(levelIndex: number): void {
		const state = this.levels[levelIndex];
		if (state) state.dirty = true;
		this.waterDirty = true;
	}

	// ------------------------------------------------------------------
	// Frame pump + mesh rebuild
	// ------------------------------------------------------------------

	private frame(): void {
		if (!this.engine) return;

		this.updateUniforms();

		for (let i = 0; i < this.levels.length; i++) {
			if (!this.levels[i].dirty) continue;
			this.levels[i].dirty = false;
			this.rebuildLevel(i);
		}

		if (this.waterDirty) {
			this.waterDirty = false;
			this.rebuildWater();
		}
	}

	private rebuildLevel(levelIndex: number): void {
		if (!this.engine || !this.scene || !this.terrainMaterial) return;

		let totalQuads = 0;
		for (const entry of this.tiles.values()) {
			if (entry.levelIndex === levelIndex && entry.opaque) {
				totalQuads += entry.opaque.indices.length / 6;
			}
		}

		const state = this.levels[levelIndex];
		if (totalQuads === 0) {
			if (state.mesh) {
				disposeFarMesh(this.scene, state.mesh);
				state.mesh = null;
			}
			return;
		}

		// 1.2x Over-allocation prevents thrashing when multiple tiles load rapidly
		if (!state.positions || totalQuads > state.capacityQuads) {
			const cap = Math.ceil(totalQuads * 1.2);
			state.capacityQuads = cap;
			state.positions = new Float32Array(cap * 4 * 3);
			state.normals = new Float32Array(cap * 4 * 3);
			state.uv2 = new Float32Array(cap * 4 * 2);
			state.colors = new Float32Array(cap * 4 * 4);
			state.indices = new Uint32Array(cap * 4 * 1.5); // 6 indices per quad
		}

		const positions = state.positions!;
		const normals = state.normals!;
		const uv2 = state.uv2!;
		const colors = state.colors!;
		const indices = state.indices!;

		let vOff = 0;
		let iOff = 0;

		for (const entry of this.tiles.values()) {
			if (entry.levelIndex !== levelIndex || !entry.opaque) continue;
			const src = entry.opaque;

			// Fast TypedArray Copy
			positions.set(src.positions, vOff * 3);
			normals.set(src.normals, vOff * 3);
			uv2.set(src.uv2, vOff * 2);
			colors.set(src.colors, vOff * 4);

			for (let i = 0; i < src.indices.length; i++) {
				indices[iOff++] = src.indices[i] + vOff;
			}
			vOff += src.positions.length / 3;
		}

		// Use subarrays to pass exact bounds to WebGL without slicing/copying
		const posView = positions.subarray(0, vOff * 3);
		const normView = normals.subarray(0, vOff * 3);
		const uv2View = uv2.subarray(0, vOff * 2);
		const colorView = colors.subarray(0, vOff * 4);
		const idxView = indices.subarray(0, iOff);

		if (state.mesh) {
			resizeMeshGeometry(
				this.engine,
				state.mesh,
				posView,
				normView,
				idxView,
				undefined,
				uv2View,
				undefined,
				colorView,
			);
		} else {
			const mesh = createMeshFromData(
				this.engine,
				`farTilesLod${6 + levelIndex}`,
				posView,
				normView,
				idxView,
				undefined,
				uv2View,
				undefined,
				colorView,
			);
			mesh.material = this.terrainMaterial;
			mesh.pickable = false;
			addToScene(this.scene, mesh);
			state.mesh = mesh;
		}
	}

	private rebuildWater(): void {
		if (!this.engine || !this.scene || !this.waterMaterial) return;

		let totalQuads = 0;
		for (const entry of this.tiles.values()) {
			if (entry.waterPositions) totalQuads += entry.waterPositions.length / 12;
		}

		if (totalQuads === 0) {
			if (this.waterMesh) {
				disposeFarMesh(this.scene, this.waterMesh);
				this.waterMesh = null;
			}
			return;
		}

		if (
			!this.waterPositionsBuf ||
			totalQuads > this.waterPositionsBuf.length / 12
		) {
			const cap = Math.ceil(totalQuads * 1.2);
			this.waterPositionsBuf = new Float32Array(cap * 12);
			this.waterNormalsBuf = new Float32Array(cap * 12);
			this.waterIndicesBuf = new Uint32Array(cap * 6);
		}

		const positions = this.waterPositionsBuf;
		const normals = this.waterNormalsBuf!;
		const indices = this.waterIndicesBuf!;

		let vOff = 0;
		let iOff = 0;

		for (const entry of this.tiles.values()) {
			if (!entry.waterPositions) continue; // Only check waterPositions now

			const src = entry.waterPositions;
			const quadCount = src.length / 12;
			const base = vOff;

			positions.set(src, vOff * 3);

			// Generate Indices on the fly (Eliminates worker-side waterIndices generation)
			for (let f = 0; f < quadCount; f++) {
				const b = base + f * 4;
				indices[iOff++] = b;
				indices[iOff++] = b + 2;
				indices[iOff++] = b + 1;
				indices[iOff++] = b;
				indices[iOff++] = b + 3;
				indices[iOff++] = b + 2;
			}

			// Set Normals (Y=1)
			for (let k = 0; k < quadCount; k++) {
				const b = (vOff + k * 4) * 3;
				normals[b + 1] = 1;
				normals[b + 4] = 1;
				normals[b + 7] = 1;
				normals[b + 10] = 1;
			}
			vOff += quadCount * 4;
		}

		const posView = positions.subarray(0, vOff * 3);
		const normView = normals!.subarray(0, vOff * 3);
		const idxView = indices!.subarray(0, iOff);

		if (this.waterMesh) {
			resizeMeshGeometry(
				this.engine,
				this.waterMesh,
				posView,
				normView,
				idxView,
			);
		} else {
			const mesh = createMeshFromData(
				this.engine,
				"farTilesWater",
				posView,
				normView,
				idxView,
			);
			mesh.material = this.waterMaterial;
			mesh.pickable = false;
			addToScene(this.scene, mesh);
			this.waterMesh = mesh;
		}
	}

	// ------------------------------------------------------------------
	// Uniforms
	// ------------------------------------------------------------------

	private updateUniforms(): void {
		if (!this.terrainMaterial || !this.waterMaterial) return;

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

		// Quantize to 1/256 steps so continuous day-cycle drift doesn't
		// re-write every far-tile material UBO each frame.
		const q = (v: number): number => Math.round(v * 256) / 256;
		const lxQ = q(lx);
		const lyQ = q(ly);
		const lzQ = q(lz);
		const sunQ = q(sunLightIntensity);

		const camera = this.scene ? this.scene.camera : null;
		const camPos = camera ? getCameraPosition(camera) : null;
		const isUnderWater = camPos
			? isEyeUnderwater(camPos.x, camPos.y, camPos.z)
			: false;

		const start = MapFog.getFogStart(isUnderWater);
		const end = MapFog.getFogEnd(isUnderWater);
		const fogColor = MapFog.getFogColor(isUnderWater);
		const fogInvRange = 1.0 / Math.max(end - start, 1e-4);

		const staticChanged =
			lxQ !== this.lastLx ||
			lyQ !== this.lastLy ||
			lzQ !== this.lastLz ||
			sunQ !== this.lastSunIntensity;

		const fogChanged =
			isUnderWater !== this.lastUnderWater ||
			start !== this.lastFogStart ||
			end !== this.lastFogEnd ||
			fogColor[0] !== this.lastFogColorR ||
			fogColor[1] !== this.lastFogColorG ||
			fogColor[2] !== this.lastFogColorB ||
			fogInvRange !== this.lastFogInvRange;

		if (!staticChanged && !fogChanged) return;

		const mats = [this.terrainMaterial, this.waterMaterial];

		if (staticChanged) {
			this.lightDirScratch[0] = lxQ;
			this.lightDirScratch[1] = lyQ;
			this.lightDirScratch[2] = lzQ;
			this.lastLx = lxQ;
			this.lastLy = lyQ;
			this.lastLz = lzQ;
			this.lastSunIntensity = sunQ;

			for (const m of mats) {
				setShaderUniform(m, "lightDirection", this.lightDirScratch);
				setShaderUniform(m, "sunLightIntensity", sunQ);
			}
		}

		if (fogChanged) {
			this.fogInfosScratch[0] = 0;
			this.fogInfosScratch[1] = start;
			this.fogInfosScratch[2] = end;
			this.fogInfosScratch[3] = 0;
			this.fogColorScratch[0] = fogColor[0];
			this.fogColorScratch[1] = fogColor[1];
			this.fogColorScratch[2] = fogColor[2];

			this.lastUnderWater = isUnderWater;
			this.lastFogStart = start;
			this.lastFogEnd = end;
			this.lastFogColorR = fogColor[0];
			this.lastFogColorG = fogColor[1];
			this.lastFogColorB = fogColor[2];
			this.lastFogInvRange = fogInvRange;

			for (const m of mats) {
				setShaderUniform(m, "fogInfos", this.fogInfosScratch);
				setShaderUniform(m, "fogColor", this.fogColorScratch);
				setShaderUniform(m, "fogInvRange", fogInvRange);
			}
		}
	}
}

export const FarTileManager = {
	init(engine: EngineContext, scene: SceneContext): void {
		FarTileManagerImpl.getInstance().init(engine, scene);
	},

	update(playerWorldX: number, playerWorldZ: number): void {
		if (!isFarTilesEnabled()) return;
		FarTileManagerImpl.getInstance().update(playerWorldX, playerWorldZ);
	},

	handleResult(data: FarTileGeneratedMessage): void {
		if (!isFarTilesEnabled()) return;
		FarTileManagerImpl.getInstance().handleResult(data);
	},

	isInitialized(): boolean {
		return FarTileManagerImpl.peekInstance()?.isReady() === true;
	},
};

function disposeFarMesh(scene: SceneContext, mesh: Mesh): void {
	try {
		removeFromScene(scene, mesh);
	} catch {
		// already detached
	}
	disposeMeshGpu(mesh);
}
