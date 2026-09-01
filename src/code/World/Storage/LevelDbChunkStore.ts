import { mapInWaves } from "../../Lib/yieldToEventLoop";
import { compressBlob, decompressBlob } from "./BlobCompression";

const CODEC_WAVE_SIZE = 64;

const PACK_BIAS_XZ = 1 << 20;
const PACK_BIAS_Y = 1 << 10;
const PACK_RANGE_XZ = 1 << 21;
const PACK_RANGE_Y = 1 << 11;

const META_PREFIX_CODE = 0x01;
const META_PREFIX = "\x01";

export function chunkKey(cx: number, cy: number, cz: number): string {
	return `${cx},${cy},${cz}`;
}

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
	const biasedCz = key % PACK_RANGE_XZ;
	const tmp = (key - biasedCz) / PACK_RANGE_XZ;
	const biasedCy = tmp % PACK_RANGE_Y;
	const biasedCx = (tmp - biasedCy) / PACK_RANGE_Y;

	return (
		biasedCx -
		PACK_BIAS_XZ +
		"," +
		(biasedCy - PACK_BIAS_Y) +
		"," +
		(biasedCz - PACK_BIAS_XZ)
	);
}

/**
 * Parses without substring allocations.
 *
 * Number() accepts more formats than this parser, including decimals,
 * exponents, whitespace, Infinity, and empty components. Chunk keys produced
 * by chunkKey() are signed base-10 integers, so this fast path is equivalent
 * for valid internal chunk keys.
 */
export function chunkKeyToNumeric(key: string): number {
	let index = 0;
	const length = key.length;

	let sign = 1;
	if (key.charCodeAt(index) === 45) {
		sign = -1;
		index++;
	}

	let cx = 0;
	while (index < length) {
		const code = key.charCodeAt(index++);
		if (code === 44) break;
		cx = cx * 10 + code - 48;
	}
	cx *= sign;

	sign = 1;
	if (key.charCodeAt(index) === 45) {
		sign = -1;
		index++;
	}

	let cy = 0;
	while (index < length) {
		const code = key.charCodeAt(index++);
		if (code === 44) break;
		cy = cy * 10 + code - 48;
	}
	cy *= sign;

	sign = 1;
	if (key.charCodeAt(index) === 45) {
		sign = -1;
		index++;
	}

	let cz = 0;
	while (index < length) {
		cz = cz * 10 + key.charCodeAt(index++) - 48;
	}
	cz *= sign;

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

			/**
			 * Avoids reparsing the string key when tracking and publishing chunk
			 * writes. Undefined for metadata and externally constructed ops.
			 */
			numericKey?: number;
	  }
	| {
			kind: WriteOperationKind.Delete;
			key: string;
			numericKey?: number;
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

	private readonly preparedJobsScratch: WriteJob[] = new Array(
		LevelDbChunkStore.MAX_TRANSACTION_OPS,
	);

	private readonly preparedOpsScratch: WriteOperation[] = new Array(
		LevelDbChunkStore.MAX_TRANSACTION_OPS,
	);

	constructor(worldName: string, basePath: string, maxCacheSize = 2048) {
		this.dbPath = this.isBrowser
			? `b102:worlds:${worldName}`
			: `${basePath}/worlds/${worldName}/db`;

		this.maxCacheSize = Math.max(0, Math.trunc(maxCacheSize));
		this._hasMany = this.isBrowser ? this._hasManyBrowser : this._hasManyNode;
	}

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

		const db = new IndexedDbStore(this.dbPath);
		this.db = db;
		await db.open();

		console.log("[LevelDb] IndexedDB opened successfully");

		const handler = (): void => {
			if (
				typeof document !== "undefined" &&
				document.visibilityState === "hidden"
			) {
				this.forceWritePump();
			}
		};

		this.visibilityHandler = handler;

		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", handler);
		}
	}

	private async openNode(): Promise<void> {
		const { Level } = await import("level");
		const { existsSync, mkdirSync } = await import("node:fs");
		const { resolve } = await import("node:path");

		const absPath = resolve(process.cwd(), this.dbPath);
		if (!existsSync(absPath)) mkdirSync(absPath, { recursive: true });

		const db = new Level(absPath, {
			valueEncoding: "buffer",
			keyEncoding: "utf8",
		});

		this.db = db;
		await db.open();
	}

	close(): Promise<void> {
		if (this.closePromise !== null) return this.closePromise;

		this.closing = true;

		const promise = this.closeInternal().finally(() => {
			this.closePromise = null;
		});

		this.closePromise = promise;
		return promise;
	}

	private async closeInternal(): Promise<void> {
		this.cancelFlushTimer();

		try {
			await this.drainWritePump();

			const db = this.db;
			if (db) {
				await db.close();
				this.db = null;
			}

			this.cache.clear();
			this.touched.clear();
			this.pendingMeta.clear();
			this.pendingDeletes.clear();
			this.pendingWrites.clear();
			this.order.length = 0;
			this.orderIndex.clear();
			this.hand = 0;

			const handler = this.visibilityHandler;
			if (handler !== null) {
				if (typeof document !== "undefined") {
					document.removeEventListener("visibilitychange", handler);
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
		const pendingDeletes = this.pendingDeletes;

		if (pendingDeletes.has(nk)) return undefined;

		const cached = this.cache.get(nk);
		if (cached !== undefined) {
			this.touched.add(nk);
			return cached;
		}

		const pending = this.pendingWrites.get(nk);
		if (pending !== undefined) {
			try {
				await pending;
			} catch {
				// Preserve the original behavior: retry the visible state.
			}

			if (pendingDeletes.has(nk)) return undefined;

			const fresh = this.cache.get(nk);
			if (fresh !== undefined) {
				this.touched.add(nk);
				return fresh;
			}
		}

		const db = this.db;
		if (!db) return undefined;

		/*
		 * Delay allocating the string until the operation actually reaches
		 * the database. Cache hits and pending deletes allocate no key string.
		 */
		const value = await db.get(key ?? chunkKey(cx, cy, cz));
		if (value == null || pendingDeletes.has(nk)) return undefined;

		const data = value instanceof Uint8Array ? value : new Uint8Array(value);

		this.addToCache(nk, data);
		return data;
	}

	async readChunks(
		coords: readonly ChunkCoord[],
	): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();
		const missesNumeric: number[] = [];
		const missesStrings: string[] = [];

		const pendingDeletes = this.pendingDeletes;
		const pendingWrites = this.pendingWrites;
		const cache = this.cache;
		const touched = this.touched;

		let missSeen: Set<number> | null = null;

		for (let i = 0, length = coords.length; i < length; i++) {
			const coord = coords[i];
			const nk = packChunkKeyNumeric(coord.cx, coord.cy, coord.cz);

			if (pendingDeletes.has(nk)) continue;

			const cached = cache.get(nk);
			if (cached !== undefined) {
				touched.add(nk);
				results.set(
					coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz),
					cached,
				);
				continue;
			}

			if (missesNumeric.length !== 0) {
				if (missSeen === null) {
					missSeen = new Set<number>();
					for (let j = 0; j < missesNumeric.length; j++) {
						missSeen.add(missesNumeric[j]);
					}
				}

				if (missSeen.has(nk)) continue;
				missSeen.add(nk);
			}

			missesNumeric.push(nk);
			missesStrings.push(coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz));
		}

		let missCount = missesNumeric.length;
		if (missCount === 0 || !this.db) return results;

		/*
		 * Reuse the numeric-miss array temporarily to collect no extra
		 * bookkeeping objects. Promise.all still needs an array of promises,
		 * but no per-promise catch closure is allocated.
		 */
		let waits: Promise<void>[] | null = null;

		for (let i = 0; i < missCount; i++) {
			const pending = pendingWrites.get(missesNumeric[i]);
			if (pending !== undefined) {
				if (waits === null) waits = [];
				waits.push(pending);
			}
		}

		if (waits !== null) {
			await Promise.allSettled(waits);

			let writeIndex = 0;

			for (let i = 0; i < missCount; i++) {
				const nk = missesNumeric[i];
				const sk = missesStrings[i];

				if (pendingDeletes.has(nk)) continue;

				const cached = cache.get(nk);
				if (cached !== undefined) {
					touched.add(nk);
					results.set(sk, cached);
					continue;
				}

				missesNumeric[writeIndex] = nk;
				missesStrings[writeIndex] = sk;
				writeIndex++;
			}

			missCount = writeIndex;
			missesNumeric.length = writeIndex;
			missesStrings.length = writeIndex;

			if (writeIndex === 0) return results;
		}

		const found = await this._getMany(missesStrings);

		/*
		 * Iterate the request arrays and use Map.get().
		 *
		 * The original iterated found and linearly searched misses for every
		 * result, making this section O(n²), with a split-based fallback that
		 * allocated another array and three substrings.
		 */
		for (let i = 0; i < missCount; i++) {
			const nk = missesNumeric[i];
			if (pendingDeletes.has(nk)) continue;

			const sk = missesStrings[i];
			const data = found.get(sk);
			if (data === undefined) continue;

			this.addToCache(nk, data);
			results.set(sk, data);
		}

		return results;
	}

	async readChunksNumeric(
		coords: readonly ChunkCoord[],
	): Promise<Map<number, Uint8Array>> {
		const results = new Map<number, Uint8Array>();
		const missesNumeric: number[] = [];
		const missesStrings: string[] = [];

		const pendingDeletes = this.pendingDeletes;
		const pendingWrites = this.pendingWrites;
		const cache = this.cache;
		const touched = this.touched;

		let missSeen: Set<number> | null = null;

		for (let i = 0, length = coords.length; i < length; i++) {
			const coord = coords[i];
			const nk = packChunkKeyNumeric(coord.cx, coord.cy, coord.cz);

			if (pendingDeletes.has(nk)) continue;

			const cached = cache.get(nk);
			if (cached !== undefined) {
				touched.add(nk);
				results.set(nk, cached);
				continue;
			}

			if (missesNumeric.length !== 0) {
				if (missSeen === null) {
					missSeen = new Set<number>();
					for (let j = 0; j < missesNumeric.length; j++) {
						missSeen.add(missesNumeric[j]);
					}
				}

				if (missSeen.has(nk)) continue;
				missSeen.add(nk);
			}

			missesNumeric.push(nk);
			missesStrings.push(coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz));
		}

		let missCount = missesNumeric.length;
		if (missCount === 0 || !this.db) return results;

		let waits: Promise<void>[] | null = null;

		for (let i = 0; i < missCount; i++) {
			const pending = pendingWrites.get(missesNumeric[i]);
			if (pending !== undefined) {
				if (waits === null) waits = [];
				waits.push(pending);
			}
		}

		if (waits !== null) {
			await Promise.allSettled(waits);

			let writeIndex = 0;

			for (let i = 0; i < missCount; i++) {
				const nk = missesNumeric[i];

				if (pendingDeletes.has(nk)) continue;

				const cached = cache.get(nk);
				if (cached !== undefined) {
					touched.add(nk);
					results.set(nk, cached);
					continue;
				}

				missesNumeric[writeIndex] = nk;
				missesStrings[writeIndex] = missesStrings[i];
				writeIndex++;
			}

			missCount = writeIndex;
			missesNumeric.length = writeIndex;
			missesStrings.length = writeIndex;

			if (writeIndex === 0) return results;
		}

		const found = await this._getMany(missesStrings);

		for (let i = 0; i < missCount; i++) {
			const nk = missesNumeric[i];
			if (pendingDeletes.has(nk)) continue;

			const data = found.get(missesStrings[i]);
			if (data === undefined) continue;

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
		const pendingDeletes = this.pendingDeletes;

		if (pendingDeletes.has(nk)) return false;

		if (this.cache.get(nk) !== undefined) {
			this.touched.add(nk);
			return true;
		}

		const pending = this.pendingWrites.get(nk);
		if (pending !== undefined) {
			try {
				await pending;
			} catch {
				// Preserve the original behavior: inspect visible state.
			}

			if (pendingDeletes.has(nk)) return false;

			if (this.cache.get(nk) !== undefined) {
				this.touched.add(nk);
				return true;
			}
		}

		const db = this.db;
		if (!db) return false;

		const value = await db.get(key ?? chunkKey(cx, cy, cz));
		return value != null && !pendingDeletes.has(nk);
	}

	async hasChunks(coords: readonly ChunkCoord[]): Promise<Set<string>> {
		const result = new Set<string>();
		const missesNumeric: number[] = [];
		const missesStrings: string[] = [];

		const pendingDeletes = this.pendingDeletes;
		const pendingWrites = this.pendingWrites;
		const cache = this.cache;
		const touched = this.touched;

		let missSeen: Set<number> | null = null;

		for (let i = 0, length = coords.length; i < length; i++) {
			const coord = coords[i];
			const nk = packChunkKeyNumeric(coord.cx, coord.cy, coord.cz);

			if (pendingDeletes.has(nk)) continue;

			if (cache.get(nk) !== undefined) {
				touched.add(nk);
				result.add(coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz));
				continue;
			}

			if (missesNumeric.length !== 0) {
				if (missSeen === null) {
					missSeen = new Set<number>();
					for (let j = 0; j < missesNumeric.length; j++) {
						missSeen.add(missesNumeric[j]);
					}
				}

				if (missSeen.has(nk)) continue;
				missSeen.add(nk);
			}

			missesNumeric.push(nk);
			missesStrings.push(coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz));
		}

		let missCount = missesNumeric.length;
		if (missCount === 0 || !this.db) return result;

		let waits: Promise<void>[] | null = null;

		for (let i = 0; i < missCount; i++) {
			const pending = pendingWrites.get(missesNumeric[i]);
			if (pending !== undefined) {
				if (waits === null) waits = [];
				waits.push(pending);
			}
		}

		if (waits !== null) {
			await Promise.allSettled(waits);

			let writeIndex = 0;

			for (let i = 0; i < missCount; i++) {
				const nk = missesNumeric[i];
				const sk = missesStrings[i];

				if (pendingDeletes.has(nk)) continue;

				if (cache.get(nk) !== undefined) {
					touched.add(nk);
					result.add(sk);
					continue;
				}

				missesNumeric[writeIndex] = nk;
				missesStrings[writeIndex] = sk;
				writeIndex++;
			}

			missCount = writeIndex;
			missesNumeric.length = writeIndex;
			missesStrings.length = writeIndex;

			if (writeIndex === 0) return result;
		}

		const found = await this._hasMany(missesStrings);
		for (const key of found) result.add(key);

		return result;
	}

	async hasChunksNumeric(coords: readonly ChunkCoord[]): Promise<Set<number>> {
		const result = new Set<number>();
		const missesNumeric: number[] = [];
		const missesStrings: string[] = [];

		const pendingDeletes = this.pendingDeletes;
		const pendingWrites = this.pendingWrites;
		const cache = this.cache;
		const touched = this.touched;

		let missSeen: Set<number> | null = null;

		for (let i = 0, length = coords.length; i < length; i++) {
			const coord = coords[i];
			const nk = packChunkKeyNumeric(coord.cx, coord.cy, coord.cz);

			if (pendingDeletes.has(nk)) continue;

			if (cache.get(nk) !== undefined) {
				touched.add(nk);
				result.add(nk);
				continue;
			}

			if (missesNumeric.length !== 0) {
				if (missSeen === null) {
					missSeen = new Set<number>();
					for (let j = 0; j < missesNumeric.length; j++) {
						missSeen.add(missesNumeric[j]);
					}
				}

				if (missSeen.has(nk)) continue;
				missSeen.add(nk);
			}

			missesNumeric.push(nk);
			missesStrings.push(coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz));
		}

		let missCount = missesNumeric.length;
		if (missCount === 0 || !this.db) return result;

		let waits: Promise<void>[] | null = null;

		for (let i = 0; i < missCount; i++) {
			const pending = pendingWrites.get(missesNumeric[i]);
			if (pending !== undefined) {
				if (waits === null) waits = [];
				waits.push(pending);
			}
		}

		if (waits !== null) {
			await Promise.allSettled(waits);

			let writeIndex = 0;

			for (let i = 0; i < missCount; i++) {
				const nk = missesNumeric[i];

				if (pendingDeletes.has(nk)) continue;

				if (cache.get(nk) !== undefined) {
					touched.add(nk);
					result.add(nk);
					continue;
				}

				missesNumeric[writeIndex] = nk;
				missesStrings[writeIndex] = missesStrings[i];
				writeIndex++;
			}

			missCount = writeIndex;
			missesNumeric.length = writeIndex;
			missesStrings.length = writeIndex;

			if (writeIndex === 0) return result;
		}

		const found = await this._hasMany(missesStrings);

		for (let i = 0; i < missCount; i++) {
			if (found.has(missesStrings[i])) {
				result.add(missesNumeric[i]);
			}
		}

		return result;
	}

	async getMeta(key: string): Promise<string | null> {
		const storageKey = META_PREFIX + key;
		const pending = this.pendingMeta.get(storageKey);

		if (pending !== undefined) {
			if (pending.value === null) return null;
			return pending.value instanceof Uint8Array ? null : pending.value;
		}

		const db = this.db;
		if (!db) return null;

		const value = await db.get(storageKey);
		if (value == null) return null;

		return this.isBrowser && value instanceof Uint8Array ? null : String(value);
	}

	async getMetaBytes(key: string): Promise<Uint8Array | undefined> {
		const storageKey = META_PREFIX + key;
		const pending = this.pendingMeta.get(storageKey);

		if (pending !== undefined) {
			if (pending.value === null) return undefined;

			return pending.value instanceof Uint8Array
				? pending.value
				: metaTextEncoder.encode(pending.value);
		}

		const db = this.db;
		if (!db) return undefined;

		const value = await db.get(storageKey);
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
		const numericKey = packChunkKeyNumeric(cx, cy, cz);

		return this.enqueueSingleWrite({
			kind: WriteOperationKind.Put,
			key: key ?? chunkKey(cx, cy, cz),
			value: data,
			preCompressed,
			numericKey,
		});
	}

	writeChunks(writes: readonly ChunkWrite[]): Promise<void> {
		const length = writes.length;
		if (length === 0) return Promise.resolve();

		const operations = new Array<WriteOperation>(length);

		for (let i = 0; i < length; i++) {
			const write = writes[i];

			operations[i] = {
				kind: WriteOperationKind.Put,
				key: write.key ?? chunkKey(write.cx, write.cy, write.cz),
				value: write.blob,
				preCompressed: write.preCompressed,
				numericKey: packChunkKeyNumeric(write.cx, write.cy, write.cz),
			};
		}

		return this.enqueueWriteJob(operations);
	}

	deleteChunk(cx: number, cy: number, cz: number, key?: string): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const nk = packChunkKeyNumeric(cx, cy, cz);

		this.pendingDeletes.add(nk);
		this.cache.delete(nk);
		this.touched.delete(nk);
		this.removeFromOrder(nk);

		return this.enqueueSingleWriteUnchecked({
			kind: WriteOperationKind.Delete,
			key: key ?? chunkKey(cx, cy, cz),
			numericKey: nk,
		});
	}

	deleteChunks(coords: readonly ChunkCoord[]): Promise<void> {
		const length = coords.length;
		if (length === 0) return Promise.resolve();

		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const operations = new Array<WriteOperation>(length);
		const pendingDeletes = this.pendingDeletes;
		const cache = this.cache;
		const touched = this.touched;

		for (let i = 0; i < length; i++) {
			const coord = coords[i];
			const nk = packChunkKeyNumeric(coord.cx, coord.cy, coord.cz);

			pendingDeletes.add(nk);
			cache.delete(nk);
			touched.delete(nk);
			this.removeFromOrder(nk);

			operations[i] = {
				kind: WriteOperationKind.Delete,
				key: coord.key ?? chunkKey(coord.cx, coord.cy, coord.cz),
				numericKey: nk,
			};
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
			this.writeQueue.push({
				kind: QueueEntryKind.Barrier,
				resolve,
				reject,
			});
			this.forceWritePump();
		});
	}

	clear(options: { discardPendingWrites?: boolean } = {}): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

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
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const storageKey = META_PREFIX + key;
		const generation = ++this.metaGeneration;

		this.pendingMeta.set(storageKey, { value, generation });

		const promise = this.enqueueSingleWriteUnchecked({
			kind: WriteOperationKind.Put,
			key: storageKey,
			value,
		});

		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation) {
				this.pendingMeta.delete(storageKey);
			}
		});
	}

	setMetaBytes(key: string, value: Uint8Array): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const storageKey = META_PREFIX + key;
		const generation = ++this.metaGeneration;

		this.pendingMeta.set(storageKey, { value, generation });

		const promise = this.enqueueSingleWriteUnchecked({
			kind: WriteOperationKind.Put,
			key: storageKey,
			value,
		});

		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation) {
				this.pendingMeta.delete(storageKey);
			}
		});
	}

	deleteMeta(key: string): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		const storageKey = META_PREFIX + key;
		const generation = ++this.metaGeneration;

		this.pendingMeta.set(storageKey, {
			value: null,
			generation,
		});

		const promise = this.enqueueSingleWriteUnchecked({
			kind: WriteOperationKind.Delete,
			key: storageKey,
		});

		return promise.finally(() => {
			const current = this.pendingMeta.get(storageKey);
			if (current?.generation === generation) {
				this.pendingMeta.delete(storageKey);
			}
		});
	}

	private enqueueSingleWrite(operation: WriteOperation): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		return this.enqueueSingleWriteUnchecked(operation);
	}

	private enqueueSingleWriteUnchecked(
		operation: WriteOperation,
	): Promise<void> {
		/*
		 * A WriteJob still owns an operations array, so a one-element array is
		 * structurally required here. This helper prevents temporary array
		 * literals at every caller and centralizes tracking.
		 */
		return this.enqueueWriteJobUnchecked([operation]);
	}

	private enqueueWriteJob(operations: WriteOperation[]): Promise<void> {
		if (!this.db || !this.opened) {
			return Promise.reject(new Error("LevelDbChunkStore is not open"));
		}

		if (this.closing) {
			return Promise.reject(new Error("LevelDbChunkStore is closing"));
		}

		return this.enqueueWriteJobUnchecked(operations);
	}

	private enqueueWriteJobUnchecked(
		operations: WriteOperation[],
	): Promise<void> {
		let job!: WriteJob;

		const promise = new Promise<void>((resolve, reject) => {
			job = {
				operations,
				nextOperation: 0,
				resolve,
				reject,
				settled: false,
				cancelled: false,
			};
		});

		this.writeQueue.push({
			kind: QueueEntryKind.Write,
			job,
		});

		this.scheduleWritePump();

		const pendingWrites = this.pendingWrites;
		let tracked = false;

		for (let i = 0, length = operations.length; i < length; i++) {
			const operation = operations[i];

			if (
				operation.kind !== WriteOperationKind.Put ||
				operation.key.charCodeAt(0) === META_PREFIX_CODE
			) {
				continue;
			}

			const nk = operation.numericKey ?? chunkKeyToNumeric(operation.key);

			operation.numericKey = nk;
			pendingWrites.set(nk, promise);
			tracked = true;
		}

		if (tracked) {
			const cleanup = (): void => {
				for (let i = 0, length = operations.length; i < length; i++) {
					const operation = operations[i];

					if (
						operation.kind !== WriteOperationKind.Put ||
						operation.key.charCodeAt(0) === META_PREFIX_CODE
					) {
						continue;
					}

					const nk = operation.numericKey ?? chunkKeyToNumeric(operation.key);

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

		void pump.catch((error) => {
			console.error("[LevelDb] write pump failed unexpectedly:", error);
		});
	}

	private async runWritePump(): Promise<void> {
		if (this.writePumpRunning) return;

		this.writePumpRunning = true;
		this.cancelFlushTimer();

		try {
			while (this.writeQueueHead < this.writeQueue.length) {
				this.skipCancelledEntries();

				if (this.writeQueueHead >= this.writeQueue.length) {
					break;
				}

				const entry = this.writeQueue[this.writeQueueHead];

				if (entry.kind === QueueEntryKind.Barrier) {
					this.processBarrier(entry);
				} else if (entry.kind === QueueEntryKind.Clear) {
					await this.processClear(entry);
				} else {
					await this.commitNextTransaction();
				}
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
			) {
				break;
			}

			const job = entry.job;
			if (!job.cancelled) {
				count += job.operations.length - job.nextOperation;
			}
		}

		return count;
	}

	private skipCancelledEntries(): void {
		while (this.writeQueueHead < this.writeQueue.length) {
			const entry = this.writeQueue[this.writeQueueHead];

			if (entry.kind !== QueueEntryKind.Write || !entry.job.cancelled) {
				return;
			}

			entry.job.nextOperation = entry.job.operations.length;
			this.writeQueueHead++;
		}
	}

	private compactWriteQueue(): void {
		const head = this.writeQueueHead;

		if (head === 0 || head < this.writeQueue.length >>> 1) {
			return;
		}

		this.writeQueue.copyWithin(0, head);
		this.writeQueue.length -= head;
		this.writeQueueHead = 0;
	}

	private async drainWritePump(): Promise<void> {
		this.startWritePump();

		const pump = this.pumpPromise;
		if (pump !== null) await pump;
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
		const queue = this.writeQueue;

		let preparedCount = 0;
		let queueIndex = this.writeQueueHead;

		while (queueIndex < queue.length && preparedCount < maxOps) {
			const entry = queue[queueIndex];
			if (entry.kind !== QueueEntryKind.Write) break;

			const job = entry.job;

			if (job.cancelled) {
				queueIndex++;
				continue;
			}

			const operations = job.operations;

			while (job.nextOperation < operations.length && preparedCount < maxOps) {
				const operation = operations[job.nextOperation++];

				if (operation.kind === WriteOperationKind.Put) {
					batch.put(operation.key, operation.value, operation.preCompressed);
				} else {
					batch.del(operation.key);
				}

				preparedJobs[preparedCount] = job;
				preparedOps[preparedCount] = operation;
				preparedCount++;
			}

			if (job.nextOperation === operations.length) {
				queueIndex++;
			} else {
				break;
			}
		}

		if (preparedCount === 0) {
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
		const operations = this.preparedOpsScratch;

		for (let i = 0; i < count; i++) {
			jobs[i] = undefined as unknown as WriteJob;
			operations[i] = undefined as unknown as WriteOperation;
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

			if (key.charCodeAt(0) === META_PREFIX_CODE) continue;

			const nk = operation.numericKey ?? chunkKeyToNumeric(key);

			operation.numericKey = nk;

			if (operation.kind === WriteOperationKind.Put) {
				if (!(operation.value instanceof Uint8Array)) {
					continue;
				}

				pendingDeletes.delete(nk);

				if (!operation.preCompressed) {
					this.addToCache(nk, operation.value);
					continue;
				}

				try {
					const decompressed = await decompressBlob(operation.value);
					this.addToCache(nk, decompressed);
				} catch {
					// Preserve the original behavior.
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
			if (job.nextOperation !== job.operations.length) {
				break;
			}

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
			const entry = this.writeQueue[this.writeQueueHead++];

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
			if (pending.generation <= generation) {
				this.pendingMeta.delete(key);
			}
		}
	}

	private cancelFlushTimer(): void {
		const timer = this.flushTimer;

		if (timer !== null) {
			clearTimeout(timer);
			this.flushTimer = null;
		}
	}

	private readonly _hasManyBrowser = async (
		keys: string[],
	): Promise<Set<string>> => {
		const db = this.db as IndexedDbStore | null;
		return db ? db.has(keys) : new Set<string>();
	};

	private readonly _hasManyNode = async (
		keys: string[],
	): Promise<Set<string>> => {
		const result = new Set<string>();
		const db = this.db;

		if (!db) return result;

		const values: Array<unknown> = await db.getMany(keys);

		for (let i = 0, length = keys.length; i < length; i++) {
			if (values[i] != null) result.add(keys[i]);
		}

		return result;
	};

	private async _getMany(keys: string[]): Promise<Map<string, Uint8Array>> {
		const results = new Map<string, Uint8Array>();
		const length = keys.length;
		const db = this.db;

		if (length === 0 || !db) return results;

		try {
			const values: Array<unknown> = await db.getMany(keys);

			for (let i = 0; i < length; i++) {
				const value = values[i];
				if (value == null) continue;

				results.set(
					keys[i],
					value instanceof Uint8Array
						? value
						: new Uint8Array(value as ArrayBuffer),
				);
			}
		} catch (error) {
			console.warn(`[LevelDb] _getMany failed for ${length} keys:`, error);
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

		let length = order.length;
		if (length === 0) return;

		let scanned = 0;

		while (length !== 0) {
			if (this.hand >= length) this.hand = 0;

			const key = order[this.hand];

			if (cache.get(key) === undefined) {
				this.removeFromOrder(key);
				length = order.length;

				if (++scanned > length + 1) break;
				continue;
			}

			if (touched.delete(key)) {
				this.hand++;

				if (++scanned > length * 2) break;
				continue;
			}

			cache.delete(key);
			this.removeFromOrder(key);
			return;
		}

		length = order.length;

		if (length !== 0) {
			if (this.hand >= length) this.hand = 0;

			const key = order[this.hand];
			cache.delete(key);
			this.removeFromOrder(key);
		}
	}

	private removeFromOrder(key: number): void {
		const index = this.orderIndex.get(key);
		if (index === undefined) return;

		const order = this.order;
		const lastIndex = order.length - 1;

		if (index !== lastIndex) {
			const moved = order[lastIndex];
			order[index] = moved;
			this.orderIndex.set(moved, index);
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
	private readonly storeName = "chunks";

	constructor(private readonly dbName: string) {}

	async open(): Promise<void> {
		if (this.db) return;

		this.db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(this.dbName, 1);

			request.onupgradeneeded = () => {
				const db = request.result;

				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName);
				}
			};

			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	async close(): Promise<void> {
		const db = this.db;

		if (db) {
			db.close();
			this.db = null;
		}
	}

	async get(key: string): Promise<Uint8Array | string | undefined> {
		const db = this.db;
		if (!db) throw new Error("IndexedDbStore not open");

		const raw = await new Promise<Uint8Array | string | undefined>(
			(resolve, reject) => {
				const tx = db.transaction(this.storeName, "readonly");
				const request = tx.objectStore(this.storeName).get(key);

				request.onsuccess = () => resolve(this.normalizeValue(request.result));
				request.onerror = () => reject(request.error);
			},
		);

		if (!(raw instanceof Uint8Array)) return raw;

		try {
			return await decompressBlob(raw);
		} catch {
			return raw;
		}
	}

	async put(key: string, value: Uint8Array | string): Promise<void> {
		const db = this.db;
		if (!db) throw new Error("IndexedDbStore not open");

		const stored =
			value instanceof Uint8Array ? await compressBlob(value) : value;

		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(this.storeName, "readwrite");

			const fail = (): void => {
				reject(tx.error ?? new Error("IndexedDB put failed"));
			};

			tx.oncomplete = () => resolve();
			tx.onerror = fail;
			tx.onabort = fail;
			tx.objectStore(this.storeName).put(stored, key);
		});
	}

	batch(): IndexedDbBatch {
		const db = this.db;
		if (!db) throw new Error("IndexedDbStore not open");

		return new IndexedDbBatch(db, this.storeName);
	}

	async clear(): Promise<void> {
		const db = this.db;
		if (!db) return;

		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(this.storeName, "readwrite");

			const fail = (): void => {
				reject(tx.error ?? new Error("IndexedDB clear failed"));
			};

			tx.oncomplete = () => resolve();
			tx.onerror = fail;
			tx.onabort = fail;
			tx.objectStore(this.storeName).clear();
		});
	}

	async has(keys: string[]): Promise<Set<string>> {
		const db = this.db;
		if (!db) throw new Error("IndexedDbStore not open");

		const count = keys.length;
		if (count === 0) return new Set<string>();

		return new Promise<Set<string>>((resolve, reject) => {
			const found = new Set<string>();
			const tx = db.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);

			let pending = count;
			let settled = false;

			const fail = (): void => {
				if (settled) return;

				settled = true;
				reject(tx.error ?? new Error("IndexedDB has failed"));
			};

			tx.onerror = fail;
			tx.onabort = fail;

			for (let i = 0; i < count; i++) {
				const key = keys[i];
				const request = store.getKey(key);

				request.onsuccess = () => {
					if (request.result !== undefined) {
						found.add(key);
					}

					if (--pending === 0 && !settled) {
						settled = true;
						resolve(found);
					}
				};

				request.onerror = fail;
			}
		});
	}

	async getMany(keys: string[]): Promise<Array<Uint8Array | undefined>> {
		const db = this.db;
		if (!db) throw new Error("IndexedDbStore not open");

		const count = keys.length;
		if (count === 0) return [];

		/*
		 * Use one result array instead of rawValues plus finalResults.
		 * Chunk records are byte values. String records, which are metadata,
		 * remain undefined just as in the original returned result.
		 */
		const results = await new Promise<Array<Uint8Array | undefined>>(
			(resolve, reject) => {
				const values = new Array<Uint8Array | undefined>(count);
				const tx = db.transaction(this.storeName, "readonly");
				const store = tx.objectStore(this.storeName);

				let pending = count;
				let settled = false;

				const fail = (): void => {
					if (settled) return;

					settled = true;
					reject(tx.error ?? new Error("IndexedDB getMany failed"));
				};

				tx.onerror = fail;
				tx.onabort = fail;

				for (let i = 0; i < count; i++) {
					const request = store.get(keys[i]);

					request.onsuccess = () => {
						const value = request.result;

						if (value instanceof Uint8Array) {
							values[i] = value;
						} else if (value instanceof ArrayBuffer) {
							values[i] = new Uint8Array(value);
						}

						if (--pending === 0 && !settled) {
							settled = true;
							resolve(values);
						}
					};

					request.onerror = fail;
				}
			},
		);

		/*
		 * The index list is substantially smaller than creating a second
		 * count-sized result array. It also preserves bounded waves.
		 */
		const compressedIndexes: number[] = [];

		for (let i = 0; i < count; i++) {
			if (results[i] !== undefined) {
				compressedIndexes.push(i);
			}
		}

		await mapInWaves(compressedIndexes, CODEC_WAVE_SIZE, async (index) => {
			const raw = results[index]!;

			try {
				results[index] = await decompressBlob(raw);
			} catch {
				results[index] = raw;
			}
		});

		return results;
	}

	private normalizeValue(value: unknown): Uint8Array | string | undefined {
		if (value instanceof Uint8Array) return value;
		if (value instanceof ArrayBuffer) {
			return new Uint8Array(value);
		}
		if (typeof value === "string") return value;
		return undefined;
	}
}

const enum IndexedDbOperationType {
	Put,
	Delete,
}

/**
 * Uses parallel arrays rather than one object per operation.
 *
 * A 256-operation batch now allocates the arrays themselves, but does not
 * allocate 256 additional `{ type, key, value, preCompressed }` objects.
 */
class IndexedDbBatch {
	private readonly types: IndexedDbOperationType[] = [];
	private readonly keys: string[] = [];
	private readonly values: Array<Uint8Array | string | undefined> = [];
	private readonly preCompressed: boolean[] = [];

	constructor(
		private readonly db: IDBDatabase,
		private readonly storeName: string,
	) {}

	put(key: string, value: Uint8Array | string, preCompressed = false): this {
		const index = this.types.length;

		this.types[index] = IndexedDbOperationType.Put;
		this.keys[index] = key;
		this.values[index] = value;
		this.preCompressed[index] = preCompressed;

		return this;
	}

	del(key: string): this {
		const index = this.types.length;

		this.types[index] = IndexedDbOperationType.Delete;
		this.keys[index] = key;

		return this;
	}

	delete(key: string): this {
		return this.del(key);
	}

	async write(): Promise<void> {
		const types = this.types;
		const keys = this.keys;
		const values = this.values;
		const preCompressed = this.preCompressed;
		const count = types.length;

		if (count === 0) return;

		/*
		 * Reuse values as the stored-value array. Compressed results replace
		 * their source references in place, avoiding a second count-sized
		 * `stored` array.
		 */
		const indexesToCompress: number[] = [];

		for (let i = 0; i < count; i++) {
			if (
				types[i] === IndexedDbOperationType.Put &&
				values[i] instanceof Uint8Array &&
				!preCompressed[i]
			) {
				indexesToCompress.push(i);
			}
		}

		await mapInWaves(indexesToCompress, CODEC_WAVE_SIZE, async (index) => {
			values[index] = await compressBlob(values[index] as Uint8Array);
		});

		await new Promise<void>((resolve, reject) => {
			const tx = this.db.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);

			const fail = (): void => {
				reject(tx.error ?? new Error("IndexedDB batch write failed"));
			};

			tx.oncomplete = () => resolve();
			tx.onerror = fail;
			tx.onabort = fail;

			for (let i = 0; i < count; i++) {
				if (types[i] === IndexedDbOperationType.Put) {
					store.put(values[i], keys[i]);
				} else {
					store.delete(keys[i]);
				}
			}
		});

		types.length = 0;
		keys.length = 0;
		values.length = 0;
		preCompressed.length = 0;
	}
}
