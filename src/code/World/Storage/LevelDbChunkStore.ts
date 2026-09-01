/**
 * LevelDbChunkStore — Unified LevelDB storage for browser and server.
 *
 * Engine Optimizations Applied:
 * 1. Wave-Bounded Compression/Decompression: IDB batch writes and reads fan
 *    their compress/inflate work out in waves of CODEC_WAVE_SIZE pipelines,
 *    yielding to the event loop between waves (mapInWaves). Concurrency
 *    keeps zlib inflate/deflate saturated while the yields prevent a large
 *    batch from monopolizing the main thread as one "Run microtasks" drain.
 * 2. IDB Transaction Isolation: Separated IDB `onsuccess` callbacks from
 *    `decompressBlob` microtasks. This prevents IDB transactions from being
 *    held open (or prematurely auto-committing) while the JS event loop
 *    processes decompression streams.
 * 3. CLOCK Eviction Math: Eliminated the modulo operator (`%`) in the cache
 *    eviction loop in favor of branch-based bounds checking, and correctly
 *    handles dynamic `order.length` mutations during swap-remove.
 * 4. Cache Lookup Reduction: Collapsed `Map.has()` + `Map.set()` into a single
 *    `Map.get()` check to halve the hash-probe overhead on cache hits.
 */

import { mapInWaves } from "../../Lib/yieldToEventLoop";
import { compressBlob, decompressBlob } from "./BlobCompression";

/**
 * Max concurrent compress/inflate stream pipelines per wave when fanning a
 * batch out. Waves yield to the event loop between batches (macrotask), so
 * a 256-op transaction cannot turn into one giant "Run microtasks" drain.
 */
const CODEC_WAVE_SIZE = 64;

export function chunkKey(cx: number, cy: number, cz: number): string {
	return cx + "," + cy + "," + cz;
}

// Architectural: numeric packed key to avoid per-lookup string allocation (GC).
// Packs into safe integer < 2^53: ((cx+B_XZ)*R_Y + (cy+B_Y))*R_XZ + (cz+B_XZ)
// B_XZ=1<<20 (1048576) covers ±1M chunks, B_Y=1<<10 (1024) covers ±1k vertical chunks (world -32..32).
const PACK_BIAS_XZ = 1 << 20;
const PACK_BIAS_Y = 1 << 10;
const PACK_RANGE_XZ = 1 << 21;
const PACK_RANGE_Y = 1 << 11;
export function packChunkKeyNumeric(
	cx: number,
	cy: number,
	cz: number,
): number {
	return (
		((cx + PACK_BIAS_XZ) * PACK_RANGE_Y + (cy + PACK_BIAS_Y)) * PACK_RANGE_XZ +
		(cz + PACK_BIAS_XZ)
	);
}
export function numericKeyToChunkKey(key: number): string {
	const cz = (key % PACK_RANGE_XZ) - PACK_BIAS_XZ;
	const tmp = (key - (cz + PACK_BIAS_XZ)) / PACK_RANGE_XZ;
	const cy = (tmp % PACK_RANGE_Y) - PACK_BIAS_Y;
	const cx = (tmp - (cy + PACK_BIAS_Y)) / PACK_RANGE_Y - PACK_BIAS_XZ;
	return cx + "," + cy + "," + cz;
}
export function chunkKeyToNumeric(key: string): number {
	const c1 = key.indexOf(",");
	const c2 = key.indexOf(",", c1 + 1);
	const cx = Number(key.slice(0, c1));
	const cy = Number(key.slice(c1 + 1, c2));
	const cz = Number(key.slice(c2 + 1));
	return packChunkKeyNumeric(cx, cy, cz);
}

export interface ChunkCoord {
	cx: number;
	cy: number;
	cz: number;
	key?: string;
}

export interface ChunkReadCoord extends ChunkCoord {
	id?: bigint;
}

export interface ChunkWrite {
	cx: number;
	cy: number;
	cz: number;
	blob: Uint8Array;
	key?: string;
	preCompressed?: boolean;
}

export interface ChunkStorage {
	open(): Promise<void>;
	close?(): Promise<void>;

	readChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<Uint8Array | undefined>;
	readChunks(coords: readonly ChunkCoord[]): Promise<Map<string, Uint8Array>>;

	hasChunk(cx: number, cy: number, cz: number): Promise<boolean>;
	hasChunks(coords: readonly ChunkCoord[]): Promise<Set<string>>;

	writeChunk(
		cx: number,
		cy: number,
		cz: number,
		blob: Uint8Array,
	): Promise<void>;
	writeChunks(writes: readonly ChunkWrite[]): Promise<void>;

	setMetaBytes(key: string, value: Uint8Array): Promise<void>;
	getMetaBytes(key: string): Promise<Uint8Array | undefined>;
	deleteMeta(key: string): Promise<void>;

	flush(): Promise<void>;
	clear(): Promise<void>;

	readonly isReady: boolean;
}

export enum WriteOperationKind {
	Put,
	Delete,
}

export type WriteOperation =
	| {
			kind: WriteOperationKind.Put;
			key: string;
			value: Uint8Array | string;
			preCompressed?: boolean;
	  }
	| {
			kind: WriteOperationKind.Delete;
			key: string;
	  };

type WriteJob = {
	operations: WriteOperation[];
	nextOperation: number;
	resolve: () => void;
	reject: (error: Error) => void;
	settled: boolean;
	cancelled: boolean;
};

enum QueueEntryKind {
	Write = "write",
	Barrier = "barrier",
	Clear = "clear",
}

type QueueEntry =
	| { kind: QueueEntryKind.Write; job: WriteJob }
	| {
			kind: QueueEntryKind.Barrier;
			resolve: () => void;
			reject: (error: Error) => void;
	  }
	| {
			kind: QueueEntryKind.Clear;
			resolve: () => void;
			reject: (error: Error) => void;
			discardPendingWrites: boolean;
			metaGeneration: number;
	  };

type PendingMeta = {
	value: string | Uint8Array | null;
	generation: number;
};

const metaTextEncoder = new TextEncoder();

export class CacheResetError extends Error {
	readonly code = "CACHE_RESET" as const;
	constructor(message = "Chunk cache was reset") {
		super(message);
		this.name = "CacheResetError";
	}
}

export function isCacheResetError(error: unknown): error is CacheResetError {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as { code?: unknown }).code === "CACHE_RESET"
	);
}

export class LevelDbChunkStore implements ChunkStorage {
	private db: any = null;
	private readonly isBrowser = typeof window !== "undefined";
	private readonly dbPath: string;
	private opened = false;
	private openPromise: Promise<void> | null = null;
	private closing = false;
	private closePromise: Promise<void> | null = null;

	private readonly writeQueue: QueueEntry[] = [];
	private writeQueueHead = 0;
	private writePumpRunning = false;
	private pumpPromise: Promise<void> | null = null;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingBarrierError: Error | null = null;
	private visibilityHandler: (() => void) | null = null;

	private readonly cache = new Map<number, Uint8Array>();
	private readonly touched = new Set<number>();
	private readonly order: number[] = [];
	private readonly orderIndex = new Map<number, number>();
	private hand = 0;
	private readonly maxCacheSize: number;

	private readonly pendingDeletes = new Set<number>();
	private readonly pendingWrites = new Map<number, Promise<void>>();
	private readonly pendingMeta = new Map<string, PendingMeta>();
	private metaGeneration = 0;

	private readonly _hasMany: (keys: string[]) => Promise<Set<string>>;

	private static readonly MAX_TRANSACTION_OPS = 256;
	private static readonly COALESCE_MS = 2;

	constructor(worldName: string, basePath: string, maxCacheSize = 2048) {
		this.dbPath = this.isBrowser
			? `b102:worlds:${worldName}`
			: `${basePath}/worlds/${worldName}/db`;

		this.maxCacheSize = Math.max(0, Math.trunc(maxCacheSize));
		this._hasMany = this.isBrowser ? this._hasManyBrowser : this._hasManyNode;
	}

	private readonly preparedJobsScratch: WriteJob[] = new Array(
		LevelDbChunkStore.MAX_TRANSACTION_OPS,
	);
	private readonly preparedOpsScratch: WriteOperation[] = new Array(
		LevelDbChunkStore.MAX_TRANSACTION_OPS,
	);

	async open(): Promise<void> {
		if (this.opened) return;
		if (this.openPromise !== null) return this.openPromise;

		const promise = this.openInternal();
		this.openPromise = promise;

		try {
			await promise;
			this.opened = true;
		} catch (error) {
			this.db = null;
			this.opened = false;
			throw error;
		} finally {
			if (this.openPromise === promise) this.openPromise = null;
		}
	}

	private async openInternal(): Promise<void> {
		if (this.isBrowser) await this.openBrowser();
		else await this.openNode();
	}

	private async openBrowser(): Promise<void> {
		console.log(`[LevelDb] Opening IndexedDB: ${this.dbPath}`);
		this.db = new IndexedDbStore(this.dbPath);
		await this.db.open();
		console.log(`[LevelDb] IndexedDB opened successfully`);

		this.visibilityHandler = () => {
			if (
				typeof document !== "undefined" &&
				document.visibilityState === "hidden"
			) {
				this.forceWritePump();
			}
		};
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", this.visibilityHandler);
		}
	}

	private async openNode(): Promise<void> {
		const { Level } = await import("level");
		const { existsSync, mkdirSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const absPath = resolve(process.cwd(), this.dbPath);
		if (!existsSync(absPath)) mkdirSync(absPath, { recursive: true });

		this.db = new Level(absPath, {
			valueEncoding: "buffer",
			keyEncoding: "utf8",
		});
		await this.db.open();
	}

	close(): Promise<void> {
		if (this.closePromise !== null) return this.closePromise;
		this.closing = true;
		const promise = this.closeInternal().finally(() => {
			this.closePromise = null;
		});
		this.closePromise = promise;
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		this.cancelFlushTimer();
		try {
			await this.drainWritePump();
			if (this.db) {
				await this.db.close();
				this.db = null;
			}
			this.cache.clear();
			this.touched.clear();
			this.pendingMeta.clear();
			this.pendingDeletes.clear();
			this.order.length = 0;
			this.orderIndex.clear();
			this.hand = 0;
			if (this.visibilityHandler !== null) {
				if (typeof document !== "undefined") {
					document.removeEventListener(
						"visibilitychange",
						this.visibilityHandler,
					);
				}
				this.visibilityHandler = null;
			}
			this.opened = false;
		} finally {
			this.closing = false;
		}
	}

	async readChunk(
		cx: number,
		cy: number,
		cz: number,
		key?: string,
	): Promise<Uint8Array | undefined> {
		const nk = packChunkKeyNumeric(cx, cy, cz);
		const k = key ?? chunkKey(cx, cy, cz);
		const pendingDeletes = this.pendingDeletes;

		if (pendingDeletes.has(nk)) return undefined;

		const cached = this.cache.get(nk);
		if (cached !== undefined) {
			this.touched.add(nk);
			return cached;
		}

		const pending = this.pendingWrites.get(nk);
		if (pending !== undefined) {
			await pending.catch(() => {});
			if (pendingDeletes.has(nk)) return undefined;
			const fresh = this.cache.get(nk);
			if (fresh !== undefined) {
				this.touched.add(nk);
				return fresh;
			}
		}

		const db = this.db;
		if (!db) return undefined;

		const value = await db.get(k);
		if (value == null || pendingDeletes.has(nk)) return undefined;

		const data = value instanceof Uint8Array ? value : new Uint8Array(value);
		this.addToCache(nk, data);
		return data;
	}

	async readChunks(
		coords: readonly ChunkCoord[],
	): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();
		const misses: string[] = [];
		const missesNumeric: number[] = [];

		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		let missSeen: Set<number> | null = null;

		for (let i = 0, len = coords.length; i < len; i++) {
			const coord = coords[i];
			const nk = packChunkKeyNumeric(coord.cx, coord.cy, coord.cz);
			if (pendingDeletes.has(nk)) continue;
			const cached = cache.get(nk);
			if (cached !== undefined) {
				touched.add(nk);
				const k = coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz);
				results.set(k, cached);
				continue;
			}
			if (misses.length !== 0) {
				if (missSeen === null) missSeen = new Set(missesNumeric);
				if (missSeen.has(nk)) continue;
				missSeen.add(nk);
			} else if (missSeen === null) {
				// lazy init on second miss
			}
			const k = coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz);
			misses.push(k);
			missesNumeric.push(nk);
		}

		if (misses.length === 0 || !this.db) return results;

		let awaited: Promise<void>[] | null = null;
		for (let i = 0; i < missesNumeric.length; i++) {
			const p = this.pendingWrites.get(missesNumeric[i]);
			if (p !== undefined) (awaited ??= []).push(p.catch(() => {}));
		}

		if (awaited !== null) {
			await Promise.all(awaited);
			let toFetchCount = 0;
			for (let i = 0; i < misses.length; i++) {
				const nk = missesNumeric[i];
				const k = misses[i];
				if (pendingDeletes.has(nk)) continue;
				const cachedNow = cache.get(nk);
				if (cachedNow !== undefined) {
					touched.add(nk);
					results.set(k, cachedNow);
					continue;
				}
				misses[toFetchCount] = k;
				missesNumeric[toFetchCount] = nk;
				toFetchCount++;
			}
			misses.length = toFetchCount;
			missesNumeric.length = toFetchCount;
			if (misses.length === 0) return results;
		}

		const found = await this._getMany(misses);
		for (const [k, data] of found) {
			let nk: number | undefined;
			for (let i = 0; i < misses.length; i++)
				if (misses[i] === k) {
					nk = missesNumeric[i];
					break;
				}
			if (nk === undefined) {
				const parts = k.split(",");
				nk = packChunkKeyNumeric(
					Number(parts[0]),
					Number(parts[1]),
					Number(parts[2]),
				);
			}
			if (pendingDeletes.has(nk)) continue;
			this.addToCache(nk, data);
			results.set(k, data);
		}

		return results;
	}

	// Numeric fast path – zero string alloc on cache hit.
	async readChunksNumeric(
		coords: readonly ChunkCoord[],
	): Promise<Map<number, Uint8Array>> {
		const results = new Map<number, Uint8Array>();
		const missesNumeric: number[] = [];
		const missesStrings: string[] = [];
		let missSeen: Set<number> | null = null;
		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;
		for (let i = 0, len = coords.length; i < len; i++) {
			const c = coords[i];
			const nk = packChunkKeyNumeric(c.cx, c.cy, c.cz);
			if (pendingDeletes.has(nk)) continue;
			const cached = cache.get(nk);
			if (cached !== undefined) {
				touched.add(nk);
				results.set(nk, cached);
				continue;
			}
			if (missesNumeric.length !== 0) {
				if (missSeen === null) missSeen = new Set(missesNumeric);
				if (missSeen.has(nk)) continue;
				missSeen.add(nk);
			}
			missesNumeric.push(nk);
			missesStrings.push(chunkKey(c.cx, c.cy, c.cz));
		}
		if (missesNumeric.length === 0 || !this.db) return results;
		let awaited: Promise<void>[] | null = null;
		for (let i = 0; i < missesNumeric.length; i++) {
			const p = this.pendingWrites.get(missesNumeric[i]);
			if (p !== undefined) (awaited ??= []).push(p.catch(() => {}));
		}
		if (awaited !== null) {
			await Promise.all(awaited);
			let toFetch = 0;
			for (let i = 0; i < missesNumeric.length; i++) {
				const nk = missesNumeric[i];
				if (pendingDeletes.has(nk)) continue;
				const cachedNow = cache.get(nk);
				if (cachedNow !== undefined) {
					touched.add(nk);
					results.set(nk, cachedNow);
					continue;
				}
				missesNumeric[toFetch] = nk;
				missesStrings[toFetch] = missesStrings[i];
				toFetch++;
			}
			missesNumeric.length = toFetch;
			missesStrings.length = toFetch;
			if (toFetch === 0) return results;
		}
		const found = await this._getMany(missesStrings);
		// found is Map<string,Uint8Array> – map back to numeric
		for (let i = 0; i < missesNumeric.length; i++) {
			const nk = missesNumeric[i];
			const sk = missesStrings[i];
			const data = found.get(sk);
			if (data === undefined) continue;
			if (pendingDeletes.has(nk)) continue;
			this.addToCache(nk, data);
			results.set(nk, data);
		}
		return results;
	}

	async hasChunk(
		cx: number,
		cy: number,
		cz: number,
		key?: string,
	): Promise<boolean> {
		const nk = packChunkKeyNumeric(cx, cy, cz);
		const k = key ?? chunkKey(cx, cy, cz);
		const pendingDeletes = this.pendingDeletes;

		if (pendingDeletes.has(nk)) return false;

		if (this.cache.has(nk)) {
			this.touched.add(nk);
			return true;
		}

		const pending = this.pendingWrites.get(nk);
		if (pending !== undefined) {
			await pending.catch(() => {});
			if (pendingDeletes.has(nk)) return false;
			if (this.cache.has(nk)) {
				this.touched.add(nk);
				return true;
			}
		}

		if (!this.db) return false;
		const value = await this.db.get(k);
		return value != null && !pendingDeletes.has(nk);
	}

	async hasChunks(coords: readonly ChunkCoord[]): Promise<Set<string>> {
		const result = new Set<string>();
		const misses: string[] = [];
		const missesNumeric: number[] = [];

		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		let missSeen: Set<number> | null = null;

		for (let i = 0, len = coords.length; i < len; i++) {
			const coord = coords[i];
			const nk = packChunkKeyNumeric(coord.cx, coord.cy, coord.cz);
			if (pendingDeletes.has(nk)) continue;
			if (cache.has(nk)) {
				touched.add(nk);
				result.add(coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz));
				continue;
			}
			if (misses.length !== 0) {
				if (missSeen === null) missSeen = new Set(missesNumeric);
				if (missSeen.has(nk)) continue;
				missSeen.add(nk);
			}
			const k = coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz);
			misses.push(k);
			missesNumeric.push(nk);
		}

		if (misses.length === 0 || !this.db) return result;

		let awaited: Promise<void>[] | null = null;
		for (let i = 0; i < missesNumeric.length; i++) {
			const p = this.pendingWrites.get(missesNumeric[i]);
			if (p !== undefined) (awaited ??= []).push(p.catch(() => {}));
		}

		if (awaited !== null) {
			await Promise.all(awaited);
			let toFetchCount = 0;
			for (let i = 0; i < misses.length; i++) {
				const nk = missesNumeric[i];
				const k = misses[i];
				if (pendingDeletes.has(nk)) continue;
				if (cache.has(nk)) {
					touched.add(nk);
					result.add(k);
					continue;
				}
				misses[toFetchCount] = k;
				missesNumeric[toFetchCount] = nk;
				toFetchCount++;
			}
			misses.length = toFetchCount;
			missesNumeric.length = toFetchCount;
			if (misses.length === 0) return result;
		}

		const found = await this._hasMany(misses);
		for (const k of found) {
			result.add(k);
		}

		return result;
	}

	async hasChunksNumeric(coords: readonly ChunkCoord[]): Promise<Set<number>> {
		const result = new Set<number>();
		const missesNumeric: number[] = [];
		const missesStrings: string[] = [];
		let missSeen: Set<number> | null = null;
		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;
		for (let i = 0; i < coords.length; i++) {
			const c = coords[i];
			const nk = packChunkKeyNumeric(c.cx, c.cy, c.cz);
			if (pendingDeletes.has(nk)) continue;
			if (cache.has(nk)) {
				touched.add(nk);
				result.add(nk);
				continue;
			}
			if (missesNumeric.length !== 0) {
				if (missSeen === null) missSeen = new Set(missesNumeric);
				if (missSeen.has(nk)) continue;
				missSeen.add(nk);
			}
			missesNumeric.push(nk);
			missesStrings.push(chunkKey(c.cx, c.cy, c.cz));
		}
		if (missesNumeric.length === 0 || !this.db) return result;
		let awaited: Promise<void>[] | null = null;
		for (let i = 0; i < missesNumeric.length; i++) {
			const p = this.pendingWrites.get(missesNumeric[i]);
			if (p !== undefined) (awaited ??= []).push(p.catch(() => {}));
		}
		if (awaited !== null) {
			await Promise.all(awaited);
			let toFetch = 0;
			for (let i = 0; i < missesNumeric.length; i++) {
				const nk = missesNumeric[i];
				if (pendingDeletes.has(nk)) continue;
				if (cache.has(nk)) {
					touched.add(nk);
					result.add(nk);
					continue;
				}
				missesNumeric[toFetch] = nk;
				missesStrings[toFetch] = missesStrings[i];
				toFetch++;
			}
			missesNumeric.length = toFetch;
			missesStrings.length = toFetch;
			if (toFetch === 0) return result;
		}
		const found = await this._hasMany(missesStrings);
		for (let i = 0; i < missesNumeric.length; i++) {
			const nk = missesNumeric[i];
			const sk = missesStrings[i];
			if (found.has(sk)) result.add(nk);
		}
		return result;
	}

	async getMeta(key: string): Promise<string | null> {
		const storageKey = `\x01${key}`;
		const pending = this.pendingMeta.get(storageKey);
		if (pending !== undefined) {
			if (pending.value === null) return null;
			return pending.value instanceof Uint8Array ? null : pending.value;
		}
		if (!this.db) return null;
		const value = await this.db.get(storageKey);
		if (value == null) return null;
		return this.isBrowser && value instanceof Uint8Array ? null : String(value);
	}

	async getMetaBytes(key: string): Promise<Uint8Array | undefined> {
		const storageKey = `\x01${key}`;
		const pending = this.pendingMeta.get(storageKey);
		if (pending !== undefined) {
			if (pending.value === null) return undefined;
			return pending.value instanceof Uint8Array
				? pending.value
				: metaTextEncoder.encode(pending.value);
		}
		if (!this.db) return undefined;
		const value = await this.db.get(storageKey);
		if (value == null) return undefined;
		return value instanceof Uint8Array
			? value
			: metaTextEncoder.encode(String(value));
	}

	writeChunk(
		cx: number,
		cy: number,
		cz: number,
		data: Uint8Array,
		key?: string,
		preCompressed?: boolean,
	): Promise<void> {
		const k = key ?? chunkKey(cx, cy, cz);
		return this.enqueueWriteJob([
			{ kind: WriteOperationKind.Put, key: k, value: data, preCompressed },
		]);
	}

	writeChunks(writes: readonly ChunkWrite[]): Promise<void> {
		const len = writes.length;
		if (len === 0) return Promise.resolve();

		const operations = new Array<WriteOperation>(len);
		for (let i = 0; i < len; i++) {
			const write = writes[i];
			operations[i] = {
				kind: WriteOperationKind.Put,
				key: write.key ?? chunkKey(write.cx, write.cy, write.cz),
				value: write.blob,
				preCompressed: write.preCompressed,
			};
		}
		return this.enqueueWriteJob(operations);
	}

	deleteChunk(cx: number, cy: number, cz: number, key?: string): Promise<void> {
		const k = key ?? chunkKey(cx, cy, cz);
		const nk = packChunkKeyNumeric(cx, cy, cz);
		if (!this.db || !this.opened)
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		if (this.closing)
			return Promise.reject(new Error("LevelDbChunkStore is closing"));

		this.pendingDeletes.add(nk);
		this.cache.delete(nk);
		this.touched.delete(nk);
		this.removeFromOrder(nk);

		return this.enqueueWriteJob([{ kind: WriteOperationKind.Delete, key: k }]);
	}

	deleteChunks(coords: readonly ChunkCoord[]): Promise<void> {
		const len = coords.length;
		if (len === 0) return Promise.resolve();
		if (!this.db || !this.opened)
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		if (this.closing)
			return Promise.reject(new Error("LevelDbChunkStore is closing"));

		const operations = new Array<WriteOperation>(len);
		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		for (let i = 0; i < len; i++) {
			const coordinate = coords[i];
			const key =
				coordinate.key ?? chunkKey(coordinate.cx, coordinate.cy, coordinate.cz);
			const nk = packChunkKeyNumeric(
				coordinate.cx,
				coordinate.cy,
				coordinate.cz,
			);

			pendingDeletes.add(nk);
			cache.delete(nk);
			touched.delete(nk);
			this.removeFromOrder(nk);

			operations[i] = { kind: WriteOperationKind.Delete, key };
		}
		return this.enqueueWriteJobUnchecked(operations);
	}

	flush(): Promise<void> {
		if (
			this.writeQueueHead >= this.writeQueue.length &&
			!this.writePumpRunning
		) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			this.writeQueue.push({ kind: QueueEntryKind.Barrier, resolve, reject });
			this.forceWritePump();
		});
	}

	clear(options: { discardPendingWrites?: boolean } = {}): Promise<void> {
		if (!this.db || !this.opened)
			return Promise.reject(new Error("LevelDbChunkStore is not open"));

		const discardPendingWrites = options.discardPendingWrites === true;
		this.cancelFlushTimer();

		return new Promise<void>((resolve, reject) => {
			const clearIndex = this.writeQueue.length;

			if (discardPendingWrites) {
				const resetError = new CacheResetError();
				for (let i = this.writeQueueHead; i < clearIndex; i++) {
					const entry = this.writeQueue[i];
					if (entry.kind !== QueueEntryKind.Write) continue;
					const job = entry.job;
					job.cancelled = true;
					this.rejectJob(job, resetError);
				}
				this.pendingBarrierError ??= resetError;
			}

			this.writeQueue.push({
				kind: QueueEntryKind.Clear,
				resolve,
				reject,
				discardPendingWrites,
				metaGeneration: this.metaGeneration,
			});
			this.forceWritePump();
		});
	}

	setMeta(key: string, value: string): Promise<void> {
		if (!this.db || !this.opened)
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		if (this.closing)
			return Promise.reject(new Error("LevelDbChunkStore is closing"));

		const storageKey = `\x01${key}`;
		const generation = ++this.metaGeneration;
		this.pendingMeta.set(storageKey, { value, generation });

		const promise = this.enqueueWriteJobUnchecked([
			{ kind: WriteOperationKind.Put, key: storageKey, value },
		]);
		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation)
				this.pendingMeta.delete(storageKey);
		});
	}

	setMetaBytes(key: string, value: Uint8Array): Promise<void> {
		if (!this.db || !this.opened)
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		if (this.closing)
			return Promise.reject(new Error("LevelDbChunkStore is closing"));

		const storageKey = `\x01${key}`;
		const generation = ++this.metaGeneration;
		this.pendingMeta.set(storageKey, { value, generation });

		const promise = this.enqueueWriteJobUnchecked([
			{ kind: WriteOperationKind.Put, key: storageKey, value },
		]);
		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation)
				this.pendingMeta.delete(storageKey);
		});
	}

	deleteMeta(key: string): Promise<void> {
		if (!this.db || !this.opened)
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		if (this.closing)
			return Promise.reject(new Error("LevelDbChunkStore is closing"));

		const storageKey = `\x01${key}`;
		const generation = ++this.metaGeneration;
		this.pendingMeta.set(storageKey, { value: null, generation });

		const promise = this.enqueueWriteJobUnchecked([
			{ kind: WriteOperationKind.Delete, key: storageKey },
		]);
		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation)
				this.pendingMeta.delete(storageKey);
		});
	}

	private enqueueWriteJob(operations: WriteOperation[]): Promise<void> {
		if (!this.db || !this.opened)
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		if (this.closing)
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		return this.enqueueWriteJobUnchecked(operations);
	}

	private enqueueWriteJobUnchecked(
		operations: WriteOperation[],
	): Promise<void> {
		const promise = new Promise<void>((resolve, reject) => {
			this.writeQueue.push({
				kind: QueueEntryKind.Write,
				job: {
					operations,
					nextOperation: 0,
					resolve,
					reject,
					settled: false,
					cancelled: false,
				},
			});
		});
		this.scheduleWritePump();

		const pendingWrites = this.pendingWrites;
		let tracked = false;
		for (let i = 0; i < operations.length; i++) {
			const op = operations[i];
			if (op.kind === WriteOperationKind.Put) {
				// Only chunk keys are tracked for read coalescing; meta keys (\x01) use pendingMeta
				if (op.key.charCodeAt(0) !== 0x01) {
					const nk = chunkKeyToNumeric(op.key);
					pendingWrites.set(nk, promise);
					tracked = true;
				}
			}
		}
		if (tracked) {
			const cleanup = () => {
				for (let i = 0; i < operations.length; i++) {
					const op = operations[i];
					if (op.kind !== WriteOperationKind.Put) continue;
					if (op.key.charCodeAt(0) === 0x01) continue;
					const nk = chunkKeyToNumeric(op.key);
					if (pendingWrites.get(nk) === promise) {
						pendingWrites.delete(nk);
					}
				}
			};
			void promise.then(cleanup, cleanup);
		}
		return promise;
	}

	private scheduleWritePump(): void {
		if (this.writePumpRunning) return;

		const head = this.writeQueue[this.writeQueueHead];
		if (
			head?.kind === QueueEntryKind.Barrier ||
			head?.kind === QueueEntryKind.Clear ||
			this.countAvailableOperations() >= LevelDbChunkStore.MAX_TRANSACTION_OPS
		) {
			this.cancelFlushTimer();
			this.startWritePump();
			return;
		}

		if (this.flushTimer !== null) return;

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.startWritePump();
		}, LevelDbChunkStore.COALESCE_MS);
	}

	private forceWritePump(): void {
		this.cancelFlushTimer();
		this.startWritePump();
	}

	private startWritePump(): void {
		if (this.writePumpRunning) return;
		const pump = this.runWritePump();
		this.pumpPromise = pump;
		void pump.catch((error) =>
			console.error("[LevelDb] write pump failed unexpectedly:", error),
		);
	}

	private async runWritePump(): Promise<void> {
		if (this.writePumpRunning) return;
		this.writePumpRunning = true;
		this.cancelFlushTimer();

		try {
			while (this.writeQueueHead < this.writeQueue.length) {
				this.skipCancelledEntries();
				if (this.writeQueueHead >= this.writeQueue.length) break;

				const entry = this.writeQueue[this.writeQueueHead];
				if (entry.kind === QueueEntryKind.Barrier) {
					this.processBarrier(entry);
					continue;
				}
				if (entry.kind === QueueEntryKind.Clear) {
					await this.processClear(entry);
					continue;
				}
				await this.commitNextTransaction();
			}
		} finally {
			this.writePumpRunning = false;
			this.pumpPromise = null;
			if (this.writeQueueHead === this.writeQueue.length) {
				this.writeQueue.length = 0;
				this.writeQueueHead = 0;
			} else {
				this.compactWriteQueue();
				if (!this.closing) this.scheduleWritePump();
			}
		}
	}

	private countAvailableOperations(
		limit = LevelDbChunkStore.MAX_TRANSACTION_OPS,
	): number {
		let count = 0;
		for (
			let i = this.writeQueueHead;
			i < this.writeQueue.length && count < limit;
			i++
		) {
			const entry = this.writeQueue[i];
			if (
				entry.kind === QueueEntryKind.Barrier ||
				entry.kind === QueueEntryKind.Clear
			)
				break;
			const job = entry.job;
			if (job.cancelled) continue;
			count += job.operations.length - job.nextOperation;
		}
		return count;
	}

	private skipCancelledEntries(): void {
		while (this.writeQueueHead < this.writeQueue.length) {
			const entry = this.writeQueue[this.writeQueueHead];
			if (entry.kind !== QueueEntryKind.Write || !entry.job.cancelled) return;
			entry.job.nextOperation = entry.job.operations.length;
			this.writeQueueHead++;
		}
	}

	private compactWriteQueue(): void {
		if (
			this.writeQueueHead === 0 ||
			this.writeQueueHead < this.writeQueue.length >>> 1
		)
			return;
		this.writeQueue.copyWithin(0, this.writeQueueHead);
		this.writeQueue.length -= this.writeQueueHead;
		this.writeQueueHead = 0;
	}

	private async drainWritePump(): Promise<void> {
		this.startWritePump();
		if (this.pumpPromise !== null) await this.pumpPromise;
	}

	private async commitNextTransaction(): Promise<void> {
		const db = this.db;
		if (!db) {
			this.rejectRemainingJobs(new Error("LevelDbChunkStore is not open"));
			return;
		}

		const maxOps = LevelDbChunkStore.MAX_TRANSACTION_OPS;
		const batch = db.batch();

		const preparedJobs = this.preparedJobsScratch;
		const preparedOps = this.preparedOpsScratch;

		let preparedCount = 0;
		let operationCount = 0;
		let queueIndex = this.writeQueueHead;
		const queue = this.writeQueue;

		while (queueIndex < queue.length && operationCount < maxOps) {
			const entry = queue[queueIndex];
			if (entry.kind !== QueueEntryKind.Write) break;

			const job = entry.job;
			if (job.cancelled) {
				queueIndex++;
				continue;
			}

			const operations = job.operations;
			while (job.nextOperation < operations.length && operationCount < maxOps) {
				const operation = operations[job.nextOperation];
				if (operation.kind === WriteOperationKind.Put) {
					batch.put(operation.key, operation.value, operation.preCompressed);
				} else {
					batch.del(operation.key);
				}

				preparedJobs[preparedCount] = job;
				preparedOps[preparedCount] = operation;
				preparedCount++;
				job.nextOperation++;
				operationCount++;
			}

			if (job.nextOperation === operations.length) queueIndex++;
			else break;
		}

		if (operationCount === 0) {
			this.settleFinishedJobs();
			return;
		}

		try {
			await batch.write();
		} catch (error) {
			const commitError =
				error instanceof Error ? error : new Error(String(error));
			this.rejectAffectedJobs(preparedJobs, preparedCount, commitError);
			this.clearPreparedScratch(preparedCount);
			this.skipCancelledEntries();
			return;
		}

		await this.publishCommittedOperations(
			preparedJobs,
			preparedOps,
			preparedCount,
		);
		this.clearPreparedScratch(preparedCount);
		this.skipCancelledEntries();
		this.settleFinishedJobs();
	}

	private clearPreparedScratch(count: number): void {
		const jobs = this.preparedJobsScratch;
		const ops = this.preparedOpsScratch;
		for (let i = 0; i < count; i++) {
			jobs[i] = undefined as unknown as WriteJob;
			ops[i] = undefined as unknown as WriteOperation;
		}
	}

	private processBarrier(entry: {
		resolve: () => void;
		reject: (error: Error) => void;
	}): void {
		const error = this.pendingBarrierError;
		this.pendingBarrierError = null;
		this.writeQueueHead++;
		if (error !== null) entry.reject(error);
		else entry.resolve();
	}

	private async processClear(entry: {
		resolve: () => void;
		reject: (error: Error) => void;
		metaGeneration: number;
	}): Promise<void> {
		const db = this.db;
		this.clearMetaShadowsThrough(entry.metaGeneration);
		this.pendingDeletes.clear();
		this.pendingWrites.clear();
		this.cache.clear();
		this.touched.clear();
		this.order.length = 0;
		this.orderIndex.clear();
		this.hand = 0;
		this.writeQueueHead++;

		if (!db) {
			this.pendingBarrierError = null;
			entry.resolve();
			this.skipCancelledEntries();
			return;
		}

		try {
			await db.clear();
			this.pendingBarrierError = null;
			entry.resolve();
		} catch (error) {
			const clearError =
				error instanceof Error ? error : new Error(String(error));
			this.pendingBarrierError ??= clearError;
			entry.reject(clearError);
		}
		this.skipCancelledEntries();
	}

	private async publishCommittedOperations(
		preparedJobs: readonly WriteJob[],
		preparedOps: readonly WriteOperation[],
		preparedCount: number,
	): Promise<void> {
		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		for (let i = 0; i < preparedCount; i++) {
			const job = preparedJobs[i];
			if (job.cancelled) continue;

			const operation = preparedOps[i];
			const key = operation.key;
			// Meta keys (\x01) are not chunk cache entries.
			if (key.charCodeAt(0) === 0x01) continue;
			const nk = chunkKeyToNumeric(key);

			if (operation.kind === WriteOperationKind.Put) {
				if (operation.value instanceof Uint8Array) {
					pendingDeletes.delete(nk);
					if (operation.preCompressed) {
						try {
							this.addToCache(nk, await decompressBlob(operation.value));
						} catch {}
					} else {
						this.addToCache(nk, operation.value);
					}
				}
			} else {
				pendingDeletes.delete(nk);
				cache.delete(nk);
				touched.delete(nk);
				this.removeFromOrder(nk);
			}
		}
	}

	private settleFinishedJobs(): void {
		while (this.writeQueueHead < this.writeQueue.length) {
			const entry = this.writeQueue[this.writeQueueHead];
			if (entry.kind !== QueueEntryKind.Write) break;
			const job = entry.job;
			if (job.nextOperation !== job.operations.length) break;
			this.writeQueueHead++;
			this.resolveJob(job);
		}
	}

	private rejectAffectedJobs(
		preparedJobs: readonly WriteJob[],
		preparedCount: number,
		error: Error,
	): void {
		let previousJob: WriteJob | undefined;
		for (let i = 0; i < preparedCount; i++) {
			const job = preparedJobs[i];
			if (job === previousJob) continue;
			previousJob = job;
			job.cancelled = true;
			job.nextOperation = job.operations.length;
			this.rejectJob(job, error);
		}
		this.pendingBarrierError ??= error;
	}

	private rejectRemainingJobs(error: Error): void {
		while (this.writeQueueHead < this.writeQueue.length) {
			const entry = this.writeQueue[this.writeQueueHead];
			this.writeQueueHead++;
			if (entry.kind === QueueEntryKind.Write) {
				entry.job.cancelled = true;
				entry.job.nextOperation = entry.job.operations.length;
				this.rejectJob(entry.job, error);
			} else {
				entry.reject(error);
			}
		}
		this.pendingBarrierError ??= error;
	}

	private resolveJob(job: WriteJob): void {
		if (job.settled) return;
		job.settled = true;
		job.resolve();
	}

	private rejectJob(job: WriteJob, error: Error): void {
		if (job.settled) return;
		job.settled = true;
		job.reject(error);
	}

	private clearMetaShadowsThrough(generation: number): void {
		for (const [key, pending] of this.pendingMeta) {
			if (pending.generation <= generation) this.pendingMeta.delete(key);
		}
	}

	private cancelFlushTimer(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	private readonly _hasManyBrowser = async (
		keys: string[],
	): Promise<Set<string>> => {
		const db = this.db as IndexedDbStore | null;
		if (!db) return new Set<string>();
		return db.has(keys);
	};

	private readonly _hasManyNode = async (
		keys: string[],
	): Promise<Set<string>> => {
		const db = this.db;
		const result = new Set<string>();
		if (!db) return result;

		const values: Array<unknown> = await db.getMany(keys);
		for (let i = 0, len = keys.length; i < len; i++) {
			if (values[i] != null) result.add(keys[i]);
		}
		return result;
	};

	private async _getMany(keys: string[]): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();
		const len = keys.length;
		const db = this.db;
		if (len === 0 || !db) return results;

		try {
			const values: Array<unknown> = await db.getMany(keys);
			for (let i = 0; i < len; i++) {
				const value = values[i];
				if (value == null) continue;
				results.set(
					keys[i],
					value instanceof Uint8Array
						? value
						: new Uint8Array(value as ArrayBuffer),
				);
			}
		} catch (err) {
			console.warn(`[LevelDb] _getMany failed for ${len} keys:`, err);
		}
		return results;
	}

	private addToCache(key: number, data: Uint8Array): void {
		const maxCacheSize = this.maxCacheSize;
		if (maxCacheSize === 0) return;

		const cache = this.cache;

		if (cache.get(key) !== undefined) {
			cache.set(key, data);
			this.touched.add(key);
			return;
		}

		if (cache.size >= maxCacheSize) this.evictOne();

		cache.set(key, data);
		const order = this.order;
		order.push(key);
		this.orderIndex.set(key, order.length - 1);
	}

	private evictOne(): void {
		const cache = this.cache;
		const touched = this.touched;
		const order = this.order;

		if (order.length === 0) return;

		let scanned = 0;

		while (true) {
			// Engine optimization: Branch instead of modulo
			if (this.hand >= order.length) this.hand = 0;
			if (order.length === 0) return;

			const key = order[this.hand];

			if (!cache.has(key)) {
				this.removeFromOrder(key);
				scanned++;
				if (scanned > order.length + 1) break;
				continue;
			}

			if (touched.delete(key)) {
				this.hand++;
				scanned++;
				if (scanned > order.length * 2) break;
				continue;
			}

			cache.delete(key);
			this.removeFromOrder(key);
			return;
		}

		if (order.length > 0) {
			if (this.hand >= order.length) this.hand = 0;
			const key = order[this.hand];
			cache.delete(key);
			this.removeFromOrder(key);
		}
	}

	private removeFromOrder(key: number): void {
		const idx = this.orderIndex.get(key);
		if (idx === undefined) return;

		const order = this.order;
		const last = order.length - 1;

		if (idx !== last) {
			const moved = order[last];
			order[idx] = moved;
			this.orderIndex.set(moved, idx);
		}

		order.pop();
		this.orderIndex.delete(key);

		if (this.hand >= order.length) this.hand = 0;
	}

	get cachedEntryCount(): number {
		return this.cache.size;
	}
	get isReady(): boolean {
		return this.db !== null;
	}
}

class IndexedDbStore {
	private db: IDBDatabase | null = null;
	private readonly dbName: string;
	private readonly storeName = "chunks";

	constructor(dbName: string) {
		this.dbName = dbName;
	}

	async open(): Promise<void> {
		if (this.db) return;
		this.db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(this.dbName, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(this.storeName))
					db.createObjectStore(this.storeName);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async close(): Promise<void> {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	async get(key: string): Promise<Uint8Array | string | undefined> {
		if (!this.db) throw new Error("IndexedDbStore not open");

		// Engine optimization: Separate IDB read from decompression microtasks
		const raw = await new Promise<Uint8Array | string | undefined>(
			(resolve, reject) => {
				const tx = this.db!.transaction(this.storeName, "readonly");
				const store = tx.objectStore(this.storeName);
				const req = store.get(key);
				req.onsuccess = () => resolve(this.normalizeValue(req.result));
				req.onerror = () => reject(req.error);
			},
		);

		if (raw instanceof Uint8Array) {
			try {
				return await decompressBlob(raw);
			} catch {
				return raw;
			}
		}
		return raw;
	}

	async put(key: string, value: Uint8Array | string): Promise<void> {
		if (!this.db) throw new Error("IndexedDbStore not open");
		const stored =
			value instanceof Uint8Array ? await compressBlob(value) : value;

		await new Promise<void>((resolve, reject) => {
			const tx = this.db!.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);
			const fail = () => reject(tx.error ?? new Error("IndexedDB put failed"));
			tx.oncomplete = () => resolve();
			tx.onerror = fail;
			tx.onabort = fail;
			store.put(stored, key);
		});
	}

	batch(): IndexedDbBatch {
		return new IndexedDbBatch(this.db!, this.storeName);
	}

	async clear(): Promise<void> {
		if (!this.db) return;
		await new Promise<void>((resolve, reject) => {
			const tx = this.db!.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);
			const fail = () =>
				reject(tx.error ?? new Error("IndexedDB clear failed"));
			tx.oncomplete = () => resolve();
			tx.onerror = fail;
			tx.onabort = fail;
			store.clear();
		});
	}

	async has(keys: string[]): Promise<Set<string>> {
		const db = this.db;
		if (!db) throw new Error("IndexedDbStore not open");
		const n = keys.length;
		if (n === 0) return new Set<string>();

		return new Promise<Set<string>>((resolve, reject) => {
			const found = new Set<string>();
			const tx = db.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);
			let settled = false;
			let pending = n;

			const fail = () => {
				if (settled) return;
				settled = true;
				reject(tx.error ?? new Error("IndexedDB has failed"));
			};

			tx.onerror = fail;
			tx.onabort = fail;

			for (let i = 0; i < n; i++) {
				const key = keys[i];
				const req = store.getKey(key);
				req.onsuccess = () => {
					if (req.result !== undefined) found.add(key);
					if (--pending === 0 && !settled) {
						settled = true;
						resolve(found);
					}
				};
				req.onerror = fail;
			}
		});
	}

	async getMany(keys: string[]): Promise<Array<Uint8Array | undefined>> {
		const db = this.db;
		if (!db) throw new Error("IndexedDbStore not open");
		const n = keys.length;
		if (n === 0) return [];

		// Engine optimization: Read all raw values synchronously from IDB's perspective
		// to avoid holding the transaction open during decompression microtasks.
		const rawValues = await new Promise<Array<Uint8Array | string | undefined>>(
			(resolve, reject) => {
				const results = new Array(n);
				const tx = db.transaction(this.storeName, "readonly");
				const store = tx.objectStore(this.storeName);
				let pending = n;
				let settled = false;

				const fail = () => {
					if (settled) return;
					settled = true;
					reject(tx.error ?? new Error("IndexedDB getMany failed"));
				};

				tx.onerror = fail;
				tx.onabort = fail;

				for (let i = 0; i < n; i++) {
					const req = store.get(keys[i]);
					req.onsuccess = () => {
						results[i] = this.normalizeValue(req.result);
						if (--pending === 0 && !settled) {
							settled = true;
							resolve(results);
						}
					};
					req.onerror = fail;
				}
			},
		);

		// Bounded-concurrency decompression: waves of CODEC_WAVE_SIZE with an
		// event-loop yield between waves. A bare Promise.all over every value
		// drains all pipeline completions as one microtask burst and starves
		// rendering (the "Run microtasks" profile hotspot).
		const finalResults = new Array<Uint8Array | undefined>(n);
		const toDecompress: number[] = [];

		for (let i = 0; i < n; i++) {
			if (rawValues[i] instanceof Uint8Array) toDecompress.push(i);
		}

		await mapInWaves(toDecompress, CODEC_WAVE_SIZE, async (i) => {
			const raw = rawValues[i] as Uint8Array;
			finalResults[i] = await decompressBlob(raw).catch(() => raw);
		});

		return finalResults;
	}

	private normalizeValue(value: unknown): Uint8Array | string | undefined {
		if (value instanceof Uint8Array) return value;
		if (value instanceof ArrayBuffer) return new Uint8Array(value);
		if (typeof value === "string") return value;
		return undefined;
	}
}

class IndexedDbBatch {
	private ops: Array<
		| {
				type: "put";
				key: string;
				value: Uint8Array | string;
				preCompressed?: boolean;
		  }
		| { type: "delete"; key: string }
	> = [];

	constructor(
		private readonly db: IDBDatabase,
		private readonly storeName: string,
	) {}

	put(key: string, value: Uint8Array | string, preCompressed?: boolean): this {
		this.ops.push({ type: "put", key, value, preCompressed });
		return this;
	}

	del(key: string): this {
		this.ops.push({ type: "delete", key });
		return this;
	}

	delete(key: string): this {
		return this.del(key);
	}

	async write(): Promise<void> {
		const ops = this.ops;
		const n = ops.length;
		if (n === 0) return;

		const stored: Array<Uint8Array | string | null> = new Array(n);
		const toCompress: Array<{ index: number; value: Uint8Array }> = [];

		for (let i = 0; i < n; i++) {
			const op = ops[i];
			if (op.type === "put" && op.value instanceof Uint8Array) {
				if (op.preCompressed) {
					stored[i] = op.value;
				} else {
					toCompress.push({ index: i, value: op.value });
				}
			} else if (op.type === "put") {
				stored[i] = op.value;
			}
		}

		// Bounded-concurrency compression: same rationale as the read path —
		// waves + event-loop yields instead of one Promise.all microtask burst.
		await mapInWaves(toCompress, CODEC_WAVE_SIZE, async (entry) => {
			stored[entry.index] = await compressBlob(entry.value);
		});

		await new Promise<void>((resolve, reject) => {
			const tx = this.db.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);

			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);

			for (let i = 0; i < n; i++) {
				const op = ops[i];
				if (op.type === "put") {
					store.put(stored[i] ?? op.value, op.key);
				} else {
					store.delete(op.key);
				}
			}
		});

		this.ops.length = 0;
	}
}
