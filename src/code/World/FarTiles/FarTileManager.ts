import {
	addToScene,
	createMeshFromData,
	disposeMeshGpu,
	type EngineContext,
	type Mesh,
	onBeforeRender,
	type SceneContext,
	removeFromScene,
	resizeMeshGeometry,
	setShaderUniform,
	getCameraPosition,
} from "@babylonjs/lite";
import MapFog from "@/code/Maps/MapFog";
import { isEyeUnderwater } from "@/code/Maps/UnderWaterEffect";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { ChunkWorkerPool } from "../Chunk/ChunkWorkerPool";
import {
	createFarTileTerrainMaterial,
	createFarTileWaterMaterial,
} from "../Light/FarTileShaderLite";
import {
	atlasTileSize,
	getDiffuseTexture2D,
} from "../Texture/TextureAtlasFactory";
import type { FarTileGeneratedMessage } from "../Chunk/DataStructures/WorkerMessageType";
import { decodeFarTileFace } from "./FarTileGenerator";
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

interface TileVertexData {
	positions: Float32Array;
	normals: Float32Array;
	uv2: Float32Array;
	colors: Float32Array;
	indices: Uint32Array;
}

interface TileEntry {
	levelIndex: number;
	tx: number;
	tz: number;
	opaque: TileVertexData | null;
	waterPositions: Float32Array | null;
}

interface LevelRenderState {
	mesh: Mesh | null;
	dirty: boolean;
}

// Per-axis corner delta tables (dx,dy,dz per corner), chosen so that
// edge1 x edge2 points along the POSITIVE axis normal with index order
// 0,1,2 / 0,2,3. Negative-facing quads reverse the index order.
const CORNERS_AXIS_X = [0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1];
const CORNERS_AXIS_Y = [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0];
const CORNERS_AXIS_Z = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];

class FarTileManagerImpl {
	private static instance: FarTileManagerImpl | null = null;

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
			this.levels.push({ mesh: null, dirty: false });
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

		const quadCount = totalQuads;
		const vertCount = quadCount * 4;
		const positions = new Float32Array(vertCount * 3);
		const normals = new Float32Array(vertCount * 3);
		const uv2 = new Float32Array(vertCount * 2);
		const colors = new Float32Array(vertCount * 4);
		const indices = new Uint32Array(quadCount * 6);

		let vOff = 0;
		let iOff = 0;

		for (const entry of this.tiles.values()) {
			if (entry.levelIndex !== levelIndex || !entry.opaque) continue;

			const src = entry.opaque;
			positions.set(src.positions, vOff * 3);
			normals.set(src.normals, vOff * 3);
			uv2.set(src.uv2, vOff * 2);
			colors.set(src.colors, vOff * 4);

			for (let i = 0; i < src.indices.length; i++) {
				indices[iOff++] = src.indices[i] + vOff;
			}

			vOff += src.positions.length / 3;
		}

		if (state.mesh) {
			resizeMeshGeometry(
				this.engine,
				state.mesh,
				positions,
				normals,
				indices,
				undefined,
				uv2,
				undefined,
				colors,
			);
		} else {
			const mesh = createMeshFromData(
				this.engine,
				`farTilesLod${6 + levelIndex}`,
				positions,
				normals,
				indices,
				undefined,
				uv2,
				undefined,
				colors,
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
			if (entry.waterPositions) {
				totalQuads += entry.waterPositions.length / 12;
			}
		}

		if (totalQuads === 0) {
			if (this.waterMesh) {
				disposeFarMesh(this.scene, this.waterMesh);
				this.waterMesh = null;
			}
			return;
		}

		const vertCount = totalQuads * 4;
		const positions = new Float32Array(vertCount * 3);
		const normals = new Float32Array(vertCount * 3);
		const indices = new Uint32Array(totalQuads * 6);

		let vOff = 0;
		let iOff = 0;

		for (const entry of this.tiles.values()) {
			if (!entry.waterPositions) continue;

			const src = entry.waterPositions;
			for (let i = 0; i < src.length; i += 12) {
				const b = vOff * 3;

				positions[b] = src[i];
				positions[b + 1] = src[i + 1];
				positions[b + 2] = src[i + 2];
				positions[b + 3] = src[i + 3];
				positions[b + 4] = src[i + 4];
				positions[b + 5] = src[i + 5];
				positions[b + 6] = src[i + 6];
				positions[b + 7] = src[i + 7];
				positions[b + 8] = src[i + 8];
				positions[b + 9] = src[i + 9];
				positions[b + 10] = src[i + 10];
				positions[b + 11] = src[i + 11];

				normals[b + 1] = 1;
				normals[b + 4] = 1;
				normals[b + 7] = 1;
				normals[b + 10] = 1;

				indices[iOff++] = vOff;
				indices[iOff++] = vOff + 1;
				indices[iOff++] = vOff + 2;
				indices[iOff++] = vOff;
				indices[iOff++] = vOff + 2;
				indices[iOff++] = vOff + 3;

				vOff += 4;
			}
		}

		if (this.waterMesh) {
			resizeMeshGeometry(
				this.engine,
				this.waterMesh,
				positions,
				normals,
				indices,
			);
		} else {
			const mesh = createMeshFromData(
				this.engine,
				"farTilesWater",
				positions,
				normals,
				indices,
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
			lx !== this.lastLx ||
			ly !== this.lastLy ||
			lz !== this.lastLz ||
			sunLightIntensity !== this.lastSunIntensity;

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
			this.lightDirScratch[0] = lx;
			this.lightDirScratch[1] = ly;
			this.lightDirScratch[2] = lz;
			this.lastLx = lx;
			this.lastLy = ly;
			this.lastLz = lz;
			this.lastSunIntensity = sunLightIntensity;

			for (const m of mats) {
				setShaderUniform(m, "lightDirection", this.lightDirScratch);
				setShaderUniform(m, "sunLightIntensity", sunLightIntensity);
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

// ---------------------------------------------------------------------------
// Face expansion
// ---------------------------------------------------------------------------

interface ExpandedTile {
	opaque: TileVertexData | null;
	waterPositions: Float32Array | null;
}

function expandTileFaces(
	opaqueFaces: Uint32Array,
	waterFaces: Uint32Array,
	originX: number,
	originZ: number,
): ExpandedTile {
	// Upper bound: every face becomes 4 verts.
	const opaqueCount = opaqueFaces.length >> 2;
	const positions = new Float32Array(opaqueCount * 4 * 3);
	const normals = new Float32Array(opaqueCount * 4 * 3);
	const uv2 = new Float32Array(opaqueCount * 4 * 2);
	const colors = new Float32Array(opaqueCount * 4 * 4);
	const indices = new Uint32Array(opaqueCount * 6);

	let vOff = 0;
	let iOff = 0;

	for (let f = 0; f < opaqueCount; f++) {
		const q = decodeFarTileFace(opaqueFaces, f);

		const x = originX + q.x;
		const y = q.y;
		const z = originZ + q.z;
		const { w, h } = q;

		let c: number[];
		let nx = 0;
		let ny = 0;
		let nz = 0;

		if (q.axis === 0) {
			c = CORNERS_AXIS_X;
			nx = q.backFace ? -1 : 1;
		} else if (q.axis === 1) {
			c = CORNERS_AXIS_Y;
			ny = q.backFace ? -1 : 1;
		} else {
			c = CORNERS_AXIS_Z;
			nz = q.backFace ? -1 : 1;
		}

		for (let corner = 0; corner < 4; corner++) {
			const dx = c[corner * 3];
			const dy = c[corner * 3 + 1];
			const dz = c[corner * 3 + 2];

			const vi = vOff + corner;
			positions[vi * 3] = x + dx * w;
			positions[vi * 3 + 1] = y + dy * h;
			positions[vi * 3 + 2] = z + dz * w;

			normals[vi * 3] = nx;
			normals[vi * 3 + 1] = ny;
			normals[vi * 3 + 2] = nz;

			uv2[vi * 2] = q.tileX;
			uv2[vi * 2 + 1] = q.tileY;

			const lightFactor = q.light >= 224 ? 1 : 0.8;
			colors[vi * 4] = lightFactor;
			colors[vi * 4 + 1] = lightFactor;
			colors[vi * 4 + 2] = lightFactor;
			colors[vi * 4 + 3] = 1;
		}

		if (q.backFace) {
			indices[iOff++] = vOff;
			indices[iOff++] = vOff + 2;
			indices[iOff++] = vOff + 1;
			indices[iOff++] = vOff;
			indices[iOff++] = vOff + 3;
			indices[iOff++] = vOff + 2;
		} else {
			indices[iOff++] = vOff;
			indices[iOff++] = vOff + 1;
			indices[iOff++] = vOff + 2;
			indices[iOff++] = vOff;
			indices[iOff++] = vOff + 2;
			indices[iOff++] = vOff + 3;
		}

		vOff += 4;
	}

	// Water: position-only quads (12 floats per quad).
	const waterQuadCount = waterFaces.length >> 2;
	const waterPositions = new Float32Array(waterQuadCount * 12);
	let wOff = 0;

	for (let f = 0; f < waterQuadCount; f++) {
		const q = decodeFarTileFace(waterFaces, f);
		const x = originX + q.x;
		const y = q.y;
		const z = originZ + q.z;

		waterPositions[wOff++] = x;
		waterPositions[wOff++] = y;
		waterPositions[wOff++] = z;
		waterPositions[wOff++] = x;
		waterPositions[wOff++] = y;
		waterPositions[wOff++] = z + q.h;
		waterPositions[wOff++] = x + q.w;
		waterPositions[wOff++] = y;
		waterPositions[wOff++] = z + q.h;
		waterPositions[wOff++] = x + q.w;
		waterPositions[wOff++] = y;
		waterPositions[wOff++] = z;
	}

	return {
		opaque:
			iOff > 0
				? {
						positions: positions.subarray(0, vOff * 3),
						normals: normals.subarray(0, vOff * 3),
						uv2: uv2.subarray(0, vOff * 2),
						colors: colors.subarray(0, vOff * 4),
						indices: indices.subarray(0, iOff),
					}
				: null,
		waterPositions: wOff > 0 ? waterPositions.subarray(0, wOff) : null,
	};
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
