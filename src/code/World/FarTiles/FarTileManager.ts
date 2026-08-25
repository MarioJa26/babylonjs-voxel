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
import { frameProfiler } from "../../Lib/FrameProfiler";
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
 * into a per-level face-word storage buffer; each level renders through TWO
 * shared-quad thin-instance meshes — straight-indexed for backFace=1 faces,
 * reversed-indexed for backFace=0 — so per-face winding (and therefore
 * backface culling) matches the old CPU-expanded path exactly. Without the
 * split, coplanar opposite-facing boundary skirts at tile/ring edges would
 * z-fight. The previous CPU expand-to-vertex-buffers pipeline
 * (expandTileFaces + full-level recopy + destroy/recreate uploads on every
 * tile arrival) is gone entirely:
 *
 *   - tile arrival   = memcpy words into an arena slot, partition face
 *                      indices into the two winding lists, ranged GPU write
 *   - tile eviction  = zero-fill the slot + remove indices + ranged write
 *   - VRAM           = 16 B/face words + 16 B/instance record (+ shared
 *                      quads), vs ~216 B/quad of expanded vertex data before
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

// GPU upload bytes flushed during the current frame (reset in frame()).
let _farUploadBytesThisFrame = 0;

interface FarSlot {
	base: number; // first face index in the arena
	count: number; // face count
}

interface DirtyRange {
	start: number; // face units
	count: number;
}

interface FarMeshLike extends Mesh {
	isVisible?: boolean;
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
	appendedFaces = 0; // high-water extent (holes included)
	holes: FarSlot[] = [];
	dirtyRanges: DirtyRange[] = [];
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
		// CPU-side zero-fill only (hygiene: growth wholesale-copies the prefix,
		// so cleared holes keep the buffer deterministic). PERF: no GPU upload
		// — both winding lists drop their references to these faces BEFORE
		// free() runs, so the stale GPU words are never consumed.
		const b4 = slot.base * FT_FACE_WORDS;
		const n4 = slot.count * FT_FACE_WORDS;
		this.cpu.fill(0, b4, b4 + n4);
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
			_farUploadBytesThisFrame += r.count * FT_FACE_BYTES;
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

// ---------------------------------------------------------------------------
// Winding meshes
//
// Each level renders its shared face arena through TWO thin-instanced quads:
// the straight-indexed mesh draws backFace=1 faces, the reversed-indexed mesh
// draws backFace=0 faces — restoring the CPU expander's exact per-face
// winding so backface culling works (and coplanar opposite-facing boundary
// skirts culled from behind instead of z-fighting). The per-instance record
// carries the face's absolute index in the arena (instData.x).
// ---------------------------------------------------------------------------

const STRAIGHT_INDICES = new Uint32Array([0, 1, 2, 0, 2, 3]);
const REVERSED_INDICES = new Uint32Array([0, 2, 1, 0, 3, 2]);

class WindingMesh {
	mesh: FarMeshLike | null = null;
	/** Compact instance records; lane x = absolute face index in the arena. */
	records = new Float32Array(0);
	count = 0;
	capacityFaces = 0;
	// PERF: half-open dirty range [dirtyMin, dirtyMax) with an Infinity
	// sentinel. Resetting dirtyMin to 0 pins the range start there after the
	// first sync, so every append re-uploads the ENTIRE instance prefix; with
	// the sentinel only the actually-written records are uploaded.
	dirtyMin = Number.POSITIVE_INFINITY;
	dirtyMax = 0;
	readonly straight: boolean;

	constructor(straight: boolean) {
		this.straight = straight;
	}

	appendFace(faceIndex: number): void {
		this.ensureRecordCapacity(this.count + 1);

		const o = this.count * 4;
		this.records[o] = faceIndex;
		this.records[o + 1] = 0;
		this.records[o + 2] = 0;
		this.records[o + 3] = 0;
		this.count++;
		this.markDirty(this.count - 1, this.count);
	}

	/** Order-preserving removal of every face index inside `slot`. */
	removeSlot(slot: FarSlot): void {
		const oldCount = this.count;
		if (slot.count === 0 || oldCount === 0) return;
		const lo = slot.base;
		const hi = slot.base + slot.count;

		// Find the first removed record — everything before it is untouched
		// and must not be re-uploaded.
		let read = 0;
		while (read < oldCount) {
			const fi = this.records[read * 4];
			if (fi >= lo && fi < hi) break;
			read++;
		}
		if (read === oldCount) return;

		const firstChanged = read;
		let write = read;
		for (; read < oldCount; read++) {
			const src = read * 4;
			const fi = this.records[src];
			if (fi >= lo && fi < hi) continue;
			if (write !== read) {
				const dst = write * 4;
				this.records[dst] = fi;
				this.records[dst + 1] = this.records[src + 1];
				this.records[dst + 2] = this.records[src + 2];
				this.records[dst + 3] = this.records[src + 3];
			}
			write++;
		}

		this.count = write;
		// Only the shifted surviving suffix needs uploading; records beyond
		// the new draw count are never consumed by the GPU.
		if (write > firstChanged) {
			this.markDirty(firstChanged, write);
		}
	}

	sync(): void {
		const needLen = this.count * 4;
		if (needLen > this.records.length) {
			let cap = this.records.length > 0 ? this.records.length : 1024;
			while (cap < needLen) cap *= 2;
			const next = new Float32Array(cap);
			next.set(this.records);
			this.records = next;
		} else if (
			this.records.length >= 4096 &&
			needLen * 4 <= this.records.length
		) {
			const next = new Float32Array(Math.max(1024, needLen));
			next.set(this.records.subarray(0, needLen));
			this.records = next;
			// Fresh CPU buffer — the replacement GPU buffer needs the active
			// records re-uploaded in full.
			this.markDirty(0, this.count);
		}
		this.capacityFaces = this.records.length / 4;
	}

	clearDirty(): void {
		this.dirtyMin = Number.POSITIVE_INFINITY;
		this.dirtyMax = 0;
	}

	private ensureRecordCapacity(requiredFaces: number): void {
		if (requiredFaces * 4 <= this.records.length) return;

		let cap = this.records.length > 0 ? this.records.length : 1024;
		while (cap < requiredFaces * 4) cap *= 2;
		const next = new Float32Array(cap);
		next.set(this.records.subarray(0, this.count * 4));
		this.records = next;

		// Replacement CPU buffer — the GPU buffer must be re-seeded with the
		// active records (syncThinInstanceCount's growth path handles the
		// full upload).
		if (this.count > 0) {
			this.markDirty(0, this.count);
		}
	}

	private markDirty(start: number, end: number): void {
		if (end <= start) return;
		if (start < this.dirtyMin) this.dirtyMin = start;
		if (end > this.dirtyMax) this.dirtyMax = end;
	}
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
	private terrainStraight: WindingMesh[] = [];
	private terrainReversed: WindingMesh[] = [];
	private waterArena = new FaceWordArena(4096);
	private waterReversed = new WindingMesh(false);

	// Workspace-wide tile-origin table (shared by every material).
	private origins = new Float32Array(0);
	private originsBuffer: StorageBuffer | null = null;
	private originCapacitySlots = 0;
	private nextOriginSlot = 0;
	// BUGFIX: origin slots are REUSED via this free list. They used to be
	// monotonic-only, and the face-word origin index is only 16 bits wide —
	// after 65,536 tile arrivals the packed index wrapped onto stale origins
	// and tiles rendered at wrong world positions. Live tiles number in the
	// hundreds, so reuse keeps every handed-out id far below the wrap.
	private originFreeSlots: number[] = [];
	// Half-open dirty SLOT range for ranged GPU uploads (Infinity = clean).
	private originsDirtyMin = Number.POSITIVE_INFINITY;
	private originsDirtyMax = 0;

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
			this.terrainStraight.push(new WindingMesh(true));
			this.terrainReversed.push(new WindingMesh(false));
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

		frameProfiler.begin("farTiles");

		const levels = getFarTileLevels();
		const pcx = Math.floor(playerWorldX / 32);
		const pcz = Math.floor(playerWorldZ / 32);

		if (pcx === this.lastPlayerChunkX && pcz === this.lastPlayerChunkZ) {
			frameProfiler.end("farTiles");
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

		frameProfiler.end("farTiles");
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
			// partially populating it. BUGFIX: roll back the side that DID
			// allocate, otherwise its faces leak (hole never recovered).
			if (opaqueSlot) arena.free(opaqueSlot);
			if (waterSlot) this.waterArena.free(waterSlot);
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

			// Partition faces into the straight/reversed winding meshes so
			// backface culling sees the intended orientation per face.
			const straight = this.terrainStraight[data.levelIndex];
			const reversed = this.terrainReversed[data.levelIndex];
			const base = opaqueSlot.base;
			for (let j = 0; j < opaqueCount; j++) {
				const backFace = (data.opaqueFaces[j * 4 + 1] >>> 20) & 1;
				if (backFace) straight.appendFace(base + j);
				else reversed.appendFace(base + j);
			}
		}
		if (waterSlot && waterSlot.count > 0) {
			this.waterArena.cpu.set(data.waterFaces, waterSlot.base * FT_FACE_WORDS);
			stampOriginSlot(this.waterArena.cpu, waterSlot, originSlot);
			this.waterArena.pushDirty(waterSlot.base, waterSlot.count);

			const waterBase = waterSlot.base;
			for (let j = 0; j < waterCount; j++) {
				this.waterReversed.appendFace(waterBase + j);
			}
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
		if (arena && entry.opaque) {
			arena.free(entry.opaque);
			this.terrainStraight[entry.levelIndex]?.removeSlot(entry.opaque);
			this.terrainReversed[entry.levelIndex]?.removeSlot(entry.opaque);
		}
		if (entry.water) {
			this.waterArena.free(entry.water);
			this.waterReversed.removeSlot(entry.water);
		}
		// Recycle the origin slot so the 16-bit face-word index can never
		// wrap (see the originFreeSlots note above).
		this.releaseOrigin(entry.originSlot);
	}

	/** Debug/profiling snapshot (HUD "Far" lines). */
	public getDebugStats(): {
		tiles: number;
		pending: number;
		uploadBytes: number;
		levels: {
			faces: number;
			capacity: number;
			straight: number;
			reversed: number;
		}[];
		water: { faces: number; capacity: number; instances: number };
		origins: { used: number; capacity: number; free: number };
	} {
		const levels = this.terrainArenas.map((arena, i) => ({
			faces: arena.appendedFaces,
			capacity: arena.capacityFaces,
			straight: this.terrainStraight[i]?.count ?? 0,
			reversed: this.terrainReversed[i]?.count ?? 0,
		}));
		return {
			tiles: this.tiles.size,
			pending: this.pendingByKey.size,
			uploadBytes: _farUploadBytesThisFrame,
			levels,
			water: {
				faces: this.waterArena.appendedFaces,
				capacity: this.waterArena.capacityFaces,
				instances: this.waterReversed.count,
			},
			origins: {
				used: this.nextOriginSlot - this.originFreeSlots.length,
				capacity: this.originCapacitySlots,
				free: this.originFreeSlots.length,
			},
		};
	}

	public setFarTilesVisible(visible: boolean): void {
		for (const wm of this.terrainStraight) {
			if (wm.mesh) (wm.mesh as FarMeshLike).isVisible = visible;
		}
		for (const wm of this.terrainReversed) {
			if (wm.mesh) (wm.mesh as FarMeshLike).isVisible = visible;
		}
		if (this.waterReversed.mesh) {
			(this.waterReversed.mesh as FarMeshLike).isVisible = visible;
		}
	}

	public isFarTilesVisible(): boolean {
		const mesh = this.terrainReversed.find((wm) => wm.mesh)?.mesh;
		return mesh ? (mesh as FarMeshLike).isVisible !== false : true;
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

		frameProfiler.begin("farTiles");
		_farUploadBytesThisFrame = 0;

		this.updateUniforms();

		for (const arena of this.terrainArenas) {
			arena.flushDirty();
		}
		this.waterArena.flushDirty();
		for (const wm of this.terrainStraight) wm.sync();
		for (const wm of this.terrainReversed) wm.sync();
		this.waterReversed.sync();
		this.flushOrigins();

		for (let i = 0; i < this.terrainArenas.length; i++) {
			this.ensureLevelMesh(i);
		}
		this.ensureWaterMesh();

		frameProfiler.end("farTiles");
	}

	private ensureLevelMesh(levelIndex: number): void {
		if (!this.engine || !this.scene) return;
		const arena = this.terrainArenas[levelIndex];
		const material = this.terrainMaterials[levelIndex];
		const straight = this.terrainStraight[levelIndex];
		const reversed = this.terrainReversed[levelIndex];
		// Mesh creation binds the arena's storage buffer, so wait until the
		// first tile arrival actually materialized one.
		if (!arena || !material || !arena.buffer || !this.originsBuffer) return;

		if (!straight.mesh) {
			const mesh = createQuadInstanceMesh(
				this.engine,
				`farTilesLod${6 + levelIndex}s`,
				STRAIGHT_INDICES,
			);
			mesh.material = material;
			mesh.pickable = false;
			// Explicit placement AFTER chunk opaque/cutout groups (order 0) —
			// equal-depth coplanar cases resolve toward the real chunks.
			mesh.renderOrder = 90;
			bindFarTileBuffers(material, arena.buffer, this.originsBuffer);
			addToScene(this.scene, mesh);
			straight.mesh = mesh;
		}
		if (!reversed.mesh) {
			const mesh = createQuadInstanceMesh(
				this.engine,
				`farTilesLod${6 + levelIndex}r`,
				REVERSED_INDICES,
			);
			mesh.material = material;
			mesh.pickable = false;
			mesh.renderOrder = 90;
			bindFarTileBuffers(material, arena.buffer, this.originsBuffer);
			addToScene(this.scene, mesh);
			reversed.mesh = mesh;
		}
		if (arena.bufferRebound) {
			bindFarTileBuffers(material, arena.buffer, this.originsBuffer);
		}
		syncThinInstanceCount(straight.mesh, straight);
		syncThinInstanceCount(reversed.mesh, reversed);
		arena.bufferRebound = false;
	}

	private ensureWaterMesh(): void {
		if (!this.engine || !this.scene || !this.waterMaterial) return;
		const arena = this.waterArena;
		if (!arena.buffer || !this.originsBuffer) return;

		if (!this.waterReversed.mesh) {
			const mesh = createQuadInstanceMesh(
				this.engine,
				"farTilesWater",
				REVERSED_INDICES,
			);
			mesh.material = this.waterMaterial;
			mesh.pickable = false;
			// After far terrain (90); chunk water is a transparent-pass mesh
			// (order 1) that always draws after the whole opaque bucket.
			mesh.renderOrder = 95;
			bindFarTileBuffers(this.waterMaterial, arena.buffer, this.originsBuffer);
			addToScene(this.scene, mesh);
			this.waterReversed.mesh = mesh;
		} else if (arena.bufferRebound) {
			bindFarTileBuffers(this.waterMaterial, arena.buffer, this.originsBuffer);
		}
		syncThinInstanceCount(this.waterReversed.mesh, this.waterReversed);
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
		// createStorageBuffer seeded the new GPU buffer with the full CPU
		// contents — no re-upload needed.
		this.originsDirtyMin = Number.POSITIVE_INFINITY;
		this.originsDirtyMax = 0;
	}

	private allocOrigin(worldX: number, worldZ: number): number {
		const popped = this.originFreeSlots.pop();
		const slot = popped !== undefined ? popped : this.nextOriginSlot++;
		if (slot + 1 > this.originCapacitySlots) this.ensureOrigins(slot + 1);
		this.origins[slot * 2] = worldX;
		this.origins[slot * 2 + 1] = worldZ;
		// PERF: ranged dirty tracking — flushOrigins used to re-upload the
		// ENTIRE origins buffer on every tile arrival.
		if (slot < this.originsDirtyMin) this.originsDirtyMin = slot;
		if (slot + 1 > this.originsDirtyMax) this.originsDirtyMax = slot + 1;
		return slot;
	}

	private releaseOrigin(slot: number): void {
		this.originFreeSlots.push(slot);
	}

	private flushOrigins(): void {
		if (
			!engineRef ||
			!this.originsBuffer ||
			!Number.isFinite(this.originsDirtyMin)
		) {
			return;
		}
		const lo = this.originsDirtyMin * 2;
		const hi = this.originsDirtyMax * 2;
		this.originsDirtyMin = Number.POSITIVE_INFINITY;
		this.originsDirtyMax = 0;
		updateStorageBuffer(
			engineRef,
			this.originsBuffer,
			this.origins.subarray(lo, hi),
			lo * 4,
		);
		_farUploadBytesThisFrame += (hi - lo) * 4;
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
	indices: Uint32Array,
): FarMeshLike {
	const mesh = createMeshFromData(
		engine,
		name,
		QUAD_POSITIONS,
		QUAD_NORMALS,
		indices,
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
 * the changed lanes. Records carry absolute face indices (written by
 * WindingMesh.appendFace/removeSlot, which track the dirty lane range with
 * an Infinity sentinel).
 */
function syncThinInstanceCount(mesh: FarMeshLike, wm: WindingMesh): void {
	const count = wm.count;
	const capacity = wm.capacityFaces;
	if (capacity === 0 && count === 0) {
		wm.clearDirty();
		return;
	}

	const anyMesh = mesh as FarMeshLike;
	let ti = anyMesh.thinInstances;
	const needsGrowth = !ti?._gpuBuffer || capacity > (ti._capacity ?? 0);

	if (needsGrowth && capacity > 0) {
		setThinInstances(mesh, wm.records, capacity);
		ti = anyMesh.thinInstances;
		if (ti) {
			ti.compact = true;
			ti._capacity = capacity;
			ti.count = count;
			ti._dirtyMin = 0;
			ti._dirtyMax = count;
		}
		wm.clearDirty();
		return;
	}

	if (!ti) {
		wm.clearDirty();
		return;
	}
	ti.matrices = wm.records;
	ti.count = count;

	if (wm.dirtyMax > wm.dirtyMin && Number.isFinite(wm.dirtyMin)) {
		const lo = Math.max(0, wm.dirtyMin);
		const hi = Math.min(count, wm.dirtyMax);
		if (hi > lo) {
			ti._dirtyMin = Math.min(ti._dirtyMin, lo);
			ti._dirtyMax = Math.max(ti._dirtyMax, hi);
		}
	}
	wm.clearDirty();
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

	/** Debug/profiling snapshot (HUD "Far" lines). */
	getDebugStats(): {
		tiles: number;
		pending: number;
		uploadBytes: number;
		levels: {
			faces: number;
			capacity: number;
			straight: number;
			reversed: number;
		}[];
		water: { faces: number; capacity: number; instances: number };
		origins: { used: number; capacity: number; free: number };
	} | null {
		const impl = FarTileManagerImpl.peekInstance();
		if (!impl) return null;
		return impl.getDebugStats();
	},

	/** A/B toggle for GPU-side profiling (F6). */
	setFarTilesVisible(visible: boolean): void {
		FarTileManagerImpl.peekInstance()?.setFarTilesVisible(visible);
	},

	isFarTilesVisible(): boolean {
		return FarTileManagerImpl.peekInstance()?.isFarTilesVisible() ?? true;
	},
};
