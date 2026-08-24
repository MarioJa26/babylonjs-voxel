import {
	addToScene,
	createMeshFromData,
	createStorageBuffer,
	disposeStorageBuffer,
	type EngineContext,
	getCameraPosition,
	type Mesh,
	onBeforeRender,
	type SceneContext,
	type ShaderMaterial,
	type StorageBuffer,
	setShaderStorageBuffer,
	setShaderUniform,
	setThinInstances,
	updateStorageBuffer,
} from "@babylonjs/lite";
import MapFog from "@/code/Maps/MapFog";
import { isEyeUnderwater } from "@/code/Maps/UnderWaterEffect";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { ChunkWorkerPool } from "../Chunk/ChunkWorkerPool";
import type { FarTileGeneratedMessage } from "../Chunk/DataStructures/WorkerMessageType";
import {
	bindFarTileBuffers,
	createFarTileTerrainMaterial,
	createFarTileWaterMaterial,
} from "../Light/FarTileShaderLite";
import { onGpuWorkDone } from "../Light/liteGpuBuffer.js";
import {
	atlasTileSize,
	getDiffuseTexture2D,
} from "../Texture/TextureAtlasFactory";
import { getFarTileLevels, isFarTilesEnabled } from "./FarTileLadder";

/**
 * Main-thread far-tile streaming manager — GPU face-decoding variant.
 *
 * Worker faces (4×u32 words, see FarTileFaceFormat.ts) are copied VERBATIM
 * into a per-level face-word storage buffer; each level renders as ONE shared
 * quad drawn once per face through compact thin instances. The previous CPU
 * expand-to-vertex-buffers pipeline (expandTileFaces + full-level recopy +
 * destroy/recreate uploads on every tile arrival) is gone entirely:
 *
 *   - tile arrival   = memcpy words into an arena slot + ranged GPU write
 *   - tile eviction  = zero-fill the slot + ranged GPU write
 *   - VRAM           = 16 B/face words + 16 B/instance record (+ shared quad),
 *                      vs ~216 B/quad of expanded vertex data before
 *
 * Each tile also owns one entry in a workspace-wide `tileOrigins` buffer
 * (vec2 world X/Z); faces reference their tile's origin slot via bits 8-23
 * of word3, stamped main-thread-side at arrival (worker output untouched).
 */

const MAX_TILE_REQUESTS_PER_UPDATE = 24;
const UNLOAD_MARGIN_CHUNKS = 4;

// Bytes per face word record (4 u32).
const FT_FACE_BYTES = 16;
const FT_FACE_WORDS = 4;

// Shared unit quad — same constants PackedChunkMesh uses. Vertex shader
// derives real positions from the face words; this buffer only feeds the
// mandatory position attribute.
const QUAD_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]);
const QUAD_NORMALS = new Float32Array(12);
const QUAD_INDICES = new Uint32Array([0, 2, 1, 0, 3, 2]);

interface FarSlot {
	base: number; // first face index in the arena
	count: number; // face count
}

interface DirtyRange {
	start: number; // face units
	count: number;
}

interface FarMeshLike extends Mesh {
	thinInstances?: {
		matrices: Float32Array;
		count: number;
		compact?: boolean;
		_capacity: number;
		_version: number;
		_gpuBuffer: GPUBuffer | null;
		_gpuBufferStorage: boolean;
		_gpuVersion: number;
		_dirtyMin: number;
		_dirtyMax: number;
	};
}

// ---------------------------------------------------------------------------
// Face-word arena: verbatim worker words + stable per-tile slots.
// ---------------------------------------------------------------------------

let engineRef: EngineContext | null = null;

function disposeBufferAfterGpuWork(buffer: StorageBuffer): void {
	if (!engineRef) return;
	void onGpuWorkDone(engineRef).then(() => disposeStorageBuffer(buffer));
}

class FaceWordArena {
	cpu: Uint32Array = new Uint32Array(0);
	buffer: StorageBuffer | null = null;
	capacityFaces = 0;
	appendedFaces = 0; // high-water extent == instance count target
	holes: FarSlot[] = [];
	dirtyRanges: DirtyRange[] = [];
	instances = new Float32Array(0);
	instanceCapacityFaces = 0;
	initialCapacity: number;
	bufferRebound = false;

	constructor(initialCapacity: number) {
		this.initialCapacity = initialCapacity;
	}

	private ensureCpu(faceCount: number): void {
		if (faceCount <= this.capacityFaces) return;
		const maxFaces = maxFarFacesPerArena();
		const cap = Math.min(
			Math.max(faceCount, this.capacityFaces * 4 || this.initialCapacity, 256),
			maxFaces,
		);

		const next = new Uint32Array(cap * FT_FACE_WORDS);
		next.set(this.cpu.subarray(0, this.appendedFaces * FT_FACE_WORDS));
		this.cpu = next;
		this.capacityFaces = cap;

		const old = this.buffer;
		this.buffer = createStorageBuffer(engineRef!, this.cpu, "farTileFaces");
		if (old) disposeBufferAfterGpuWork(old);
		this.bufferRebound = true;
	}

	/** Allocate a contiguous slot; returns null when the arena is full. */
	alloc(count: number): FarSlot | null {
		if (count === 0) return { base: 0, count: 0 };
		if (count > maxFarFacesPerArena()) return null;

		for (let i = 0; i < this.holes.length; i++) {
			const h = this.holes[i];
			if (h.count >= count) {
				this.holes.splice(i, 1);
				if (h.count > count) {
					this.insertHole(h.base + count, h.count - count);
				}
				return { base: h.base, count };
			}
		}

		if (this.appendedFaces + count > this.capacityFaces) {
			this.ensureCpu(this.appendedFaces + count);
			if (this.appendedFaces + count > this.capacityFaces) return null;
		}
		const slot = { base: this.appendedFaces, count };
		this.appendedFaces += count;
		return slot;
	}

	insertHole(base: number, count: number): void {
		let lo = 0;
		while (lo < this.holes.length && this.holes[lo].base < base) lo++;
		this.holes.splice(lo, 0, { base, count });
	}

	free(slot: FarSlot): void {
		if (slot.count === 0) return;
		const b4 = slot.base * FT_FACE_WORDS;
		const n4 = slot.count * FT_FACE_WORDS;
		this.cpu.fill(0, b4, b4 + n4);
		this.pushDirty(slot.base, slot.count);
		this.insertHole(slot.base, slot.count);
	}

	pushDirty(start: number, count: number): void {
		if (count <= 0) return;
		const ranges = this.dirtyRanges;
		const last = ranges.length > 0 ? ranges[ranges.length - 1] : null;
		if (last && last.start + last.count === start) {
			last.count += count;
			return;
		}
		ranges.push({ start, count });
	}

	flushDirty(): void {
		const engine = engineRef;
		if (!engine || !this.buffer) {
			this.dirtyRanges.length = 0;
			return;
		}
		for (const r of this.dirtyRanges) {
			updateStorageBuffer(
				engine,
				this.buffer,
				this.cpu.subarray(
					r.start * FT_FACE_WORDS,
					(r.start + r.count) * FT_FACE_WORDS,
				),
				r.start * FT_FACE_BYTES,
			);
		}
		this.dirtyRanges.length = 0;
	}
}

interface TileEntry {
	levelIndex: number;
	tx: number;
	tz: number;
	opaque: FarSlot | null;
	water: FarSlot | null;
	originSlot: number;
}

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

	private terrainMaterials: ShaderMaterial[] = [];
	private waterMaterial: ShaderMaterial | null = null;
	private terrainArenas: FaceWordArena[] = [];
	private terrainMeshes: (FarMeshLike | null)[] = [];
	private waterArena = new FaceWordArena(4096);
	private waterMesh: FarMeshLike | null = null;

	// Workspace-wide tile-origin table (shared by every material).
	private origins = new Float32Array(0);
	private originsBuffer: StorageBuffer | null = null;
	private originCapacitySlots = 0;
	private nextOriginSlot = 0;
	private originsDirty = false;

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
		engineRef = engine;

		const diffuse = getDiffuseTexture2D();
		const levels = getFarTileLevels();

		for (let i = 0; i < levels.length; i++) {
			const material = createFarTileTerrainMaterial({
				engine,
				scene,
				diffuseTexture: diffuse,
				atlasTileSize,
				textureScale: 32,
				nameSuffix: String(i),
			});
			this.terrainMaterials.push(material);
			this.terrainArenas.push(new FaceWordArena(8192));
			this.terrainMeshes.push(null);
		}
		this.waterMaterial = createFarTileWaterMaterial();

		this.ensureOrigins(1024);

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

		// Unload tiles outside their window: beyond ringOuter+margin (walked
		// away) OR inside ringInner (approached — real chunks now cover this
		// area, and a lingering far tile would z-fight/poke through them).
		for (const [key, entry] of this.tiles) {
			const lv = levels[entry.levelIndex];
			if (!lv) continue;

			const span = lv.tileSizeChunks;
			const centerX = entry.tx * span + span / 2;
			const centerZ = entry.tz * span + span / 2;
			const d = Math.max(Math.abs(centerX - pcx), Math.abs(centerZ - pcz));

			if (
				d >= lv.ringOuterChunks + UNLOAD_MARGIN_CHUNKS ||
				d < lv.ringInnerChunks
			) {
				this.releaseEntry(entry);
				this.tiles.delete(key);
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

		const arena = this.terrainArenas[data.levelIndex];
		if (!arena) return;

		const opaqueCount = data.opaqueFaces.length >>> 2;
		const waterCount = data.waterFaces.length >>> 2;

		const opaqueSlot = opaqueCount > 0 ? arena.alloc(opaqueCount) : null;
		const waterSlot = waterCount > 0 ? this.waterArena.alloc(waterCount) : null;
		if ((opaqueCount > 0 && !opaqueSlot) || (waterCount > 0 && !waterSlot)) {
			// Arena full (binding-size cap) — drop the tile rather than
			// partially populating it.
			console.warn(
				`[FarTileManager] arena full, dropping tile ${key} ` +
					`(opaque ${opaqueCount}, water ${waterCount}).`,
			);
			return;
		}

		const originSlot = this.allocOrigin(
			data.tileX * lv.tileSizeChunks * 32,
			data.tileZ * lv.tileSizeChunks * 32,
		);

		if (opaqueSlot && opaqueSlot.count > 0) {
			arena.cpu.set(data.opaqueFaces, opaqueSlot.base * FT_FACE_WORDS);
			stampOriginSlot(arena.cpu, opaqueSlot, originSlot);
			arena.pushDirty(opaqueSlot.base, opaqueSlot.count);
		}
		if (waterSlot && waterSlot.count > 0) {
			this.waterArena.cpu.set(data.waterFaces, waterSlot.base * FT_FACE_WORDS);
			stampOriginSlot(this.waterArena.cpu, waterSlot, originSlot);
			this.waterArena.pushDirty(waterSlot.base, waterSlot.count);
		}

		const entry: TileEntry = {
			levelIndex: data.levelIndex,
			tx: data.tileX,
			tz: data.tileZ,
			opaque: opaqueSlot,
			water: waterSlot,
			originSlot,
		};
		this.tiles.set(key, entry);
	}

	private releaseEntry(entry: TileEntry): void {
		const arena = this.terrainArenas[entry.levelIndex];
		if (arena && entry.opaque) arena.free(entry.opaque);
		if (entry.water) this.waterArena.free(entry.water);
		// Origin slots are never reused — stale entries stay unreferenced and
		// the table simply grows with the monotonic slot counter.
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

	// ------------------------------------------------------------------
	// Frame pump + GPU sync
	// ------------------------------------------------------------------

	private frame(): void {
		if (!this.engine) return;

		this.updateUniforms();

		for (const arena of this.terrainArenas) {
			this.syncArena(arena);
		}
		this.syncArena(this.waterArena);
		this.flushOrigins();

		for (let i = 0; i < this.terrainArenas.length; i++) {
			this.ensureLevelMesh(i);
		}
		this.ensureWaterMesh();
	}

	private syncArena(arena: FaceWordArena): void {
		arena.flushDirty();

		// Grow the retained zero-filled instance records to cover the arena's
		// high-water extent. Records stay all-zero forever — the vertex shader
		// selects faces purely via @builtin(instance_index).
		const needLen = arena.appendedFaces * 4;
		if (needLen > arena.instances.length) {
			let cap = arena.instances.length > 0 ? arena.instances.length : 1024;
			while (cap < needLen) cap *= 2;
			const next = new Float32Array(cap);
			next.set(arena.instances);
			arena.instances = next;
			arena.instanceCapacityFaces = cap / 4;
		} else if (
			arena.instances.length >= 4096 &&
			needLen * 4 <= arena.instances.length
		) {
			arena.instances = new Float32Array(Math.max(1024, needLen));
			arena.instanceCapacityFaces = arena.instances.length / 4;
		}
	}

	private ensureLevelMesh(levelIndex: number): void {
		if (!this.engine || !this.scene) return;
		const arena = this.terrainArenas[levelIndex];
		const material = this.terrainMaterials[levelIndex];
		// Mesh creation binds the arena's storage buffer, so wait until the
		// first tile arrival actually materialized one.
		if (!arena || !material || !arena.buffer || !this.originsBuffer) return;

		let mesh = this.terrainMeshes[levelIndex];
		if (!mesh) {
			mesh = createQuadInstanceMesh(
				this.engine,
				`farTilesLod${6 + levelIndex}`,
			);
			mesh.material = material;
			mesh.pickable = false;
			// Explicit placement AFTER chunk opaque/cutout groups (order 0) —
			// equal-depth coplanar cases resolve toward the real chunks.
			mesh.renderOrder = 90;
			bindFarTileBuffers(material, arena.buffer, this.originsBuffer);
			addToScene(this.scene, mesh);
			this.terrainMeshes[levelIndex] = mesh;
		} else if (arena.bufferRebound) {
			bindFarTileBuffers(material, arena.buffer, this.originsBuffer);
		}
		syncThinInstanceCount(mesh, arena);
		arena.bufferRebound = false;
	}

	private ensureWaterMesh(): void {
		if (!this.engine || !this.scene || !this.waterMaterial) return;
		const arena = this.waterArena;
		if (!arena.buffer || !this.originsBuffer) return;

		if (!this.waterMesh) {
			const mesh = createQuadInstanceMesh(this.engine, "farTilesWater");
			mesh.material = this.waterMaterial;
			mesh.pickable = false;
			// After far terrain (90); chunk water is a transparent-pass mesh
			// (order 1) that always draws after the whole opaque bucket.
			mesh.renderOrder = 95;
			bindFarTileBuffers(this.waterMaterial, arena.buffer, this.originsBuffer);
			addToScene(this.scene, mesh);
			this.waterMesh = mesh;
		} else if (arena.bufferRebound) {
			bindFarTileBuffers(this.waterMaterial, arena.buffer, this.originsBuffer);
		}
		syncThinInstanceCount(this.waterMesh, arena);
		arena.bufferRebound = false;
	}

	// ------------------------------------------------------------------
	// Tile-origin table
	// ------------------------------------------------------------------

	private ensureOrigins(slots: number): void {
		if (slots <= this.originCapacitySlots) return;
		const cap = Math.max(slots, this.originCapacitySlots * 2 || 1024);
		const next = new Float32Array(cap * 2);
		next.set(this.origins);
		this.origins = next;
		this.originCapacitySlots = cap;

		if (this.originsBuffer) {
			disposeBufferAfterGpuWork(this.originsBuffer);
		}
		this.originsBuffer = createStorageBuffer(
			this.engine!,
			this.origins,
			"farTileOrigins",
		);
		// Rebind everywhere; materials may not have meshes yet (harmless).
		for (const m of this.terrainMaterials) {
			setShaderStorageBuffer(m, "tileOrigins", this.originsBuffer);
		}
		if (this.waterMaterial) {
			setShaderStorageBuffer(
				this.waterMaterial,
				"tileOrigins",
				this.originsBuffer,
			);
		}
		this.originsDirty = true;
	}

	private allocOrigin(worldX: number, worldZ: number): number {
		const slot = this.nextOriginSlot++;
		if (slot + 1 > this.originCapacitySlots) this.ensureOrigins(slot + 1);
		this.origins[slot * 2] = worldX;
		this.origins[slot * 2 + 1] = worldZ;
		this.originsDirty = true;
		return slot;
	}

	private flushOrigins(): void {
		if (!this.originsDirty || !engineRef || !this.originsBuffer) return;
		this.originsDirty = false;
		updateStorageBuffer(engineRef, this.originsBuffer, this.origins, 0);
	}

	// ------------------------------------------------------------------
	// Uniforms
	// ------------------------------------------------------------------

	private updateUniforms(): void {
		if (this.terrainMaterials.length === 0 || !this.waterMaterial) return;

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

		const mats = [...this.terrainMaterials, this.waterMaterial];

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stamp the tile-origin slot into word3 bits 8-23 of every face in a slot. */
function stampOriginSlot(
	cpu: Uint32Array,
	slot: FarSlot,
	originSlot: number,
): void {
	const mask = (originSlot & 0xffff) << 8;
	let w = slot.base * FT_FACE_WORDS + 3;
	for (let j = 0; j < slot.count; j++) {
		cpu[w] = (cpu[w] & 0xff) | mask;
		w += FT_FACE_WORDS;
	}
}

function createQuadInstanceMesh(
	engine: EngineContext,
	name: string,
): FarMeshLike {
	const mesh = createMeshFromData(
		engine,
		name,
		QUAD_POSITIONS,
		QUAD_NORMALS,
		QUAD_INDICES,
	) as FarMeshLike;

	// Seed compact thin instances at count 0 so an empty level draws nothing
	// (without thinInstances the base quad itself would render).
	setThinInstances(mesh, new Float32Array(4), 1);
	const ti = (mesh as FarMeshLike).thinInstances;
	if (ti) {
		ti.compact = true;
		ti._capacity = 1;
		ti.count = 0;
		ti._dirtyMin = 0;
		ti._dirtyMax = 0;
	}
	return mesh;
}

/**
 * Compact thin-instance sync — same two-path strategy as PackedChunkMesh's
 * setThinInstancesRange: full setThinInstances only when the GPU buffer must
 * (re)grow, otherwise mutate count/dirty-range in place so lite uploads just
 * the changed lanes. Records are always zero here, so even a full upload is
 * trivially cheap.
 */
function syncThinInstanceCount(mesh: FarMeshLike, arena: FaceWordArena): void {
	const count = arena.appendedFaces;
	const capacity = arena.instanceCapacityFaces;
	if (capacity === 0 && count === 0) return;

	const anyMesh = mesh as FarMeshLike;
	let ti = anyMesh.thinInstances;
	const needsGrowth = !ti?._gpuBuffer || capacity > (ti._capacity ?? 0);

	if (needsGrowth && capacity > 0) {
		setThinInstances(mesh, arena.instances, capacity);
		ti = anyMesh.thinInstances;
		if (ti) {
			ti.compact = true;
			ti._capacity = capacity;
			ti.count = count;
			ti._dirtyMin = 0;
			ti._dirtyMax = count;
		}
		return;
	}

	if (!ti) return;
	ti.matrices = arena.instances;
	ti.count = count;
}

function maxFarFacesPerArena(): number {
	const engine = engineRef;
	if (!engine) return 1 << 20;
	const device = (engine as EngineWithDevice)._device;
	const limit =
		typeof device?.limits?.maxStorageBufferBindingSize === "number"
			? device.limits.maxStorageBufferBindingSize
			: 128 * 1024 * 1024;
	return Math.max(1, Math.floor(limit / FT_FACE_BYTES));
}

interface EngineWithDevice extends EngineContext {
	_device?: GPUDevice;
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
