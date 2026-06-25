/// <reference lib="webworker" />

import { OpfsChunkStore } from "./OpfsChunkStore";
import { OpfsMsg } from "./OpfsMessageTypes";
import { RegionFile } from "./RegionFile";

// ---------------------------------------------------------------------------
// Hoist self reference once — avoids repeated casts + property lookups.
// ---------------------------------------------------------------------------
const _self = self as DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Serial op queue — ring buffer, zero-shift drain.
// ---------------------------------------------------------------------------
type QueuedOp = {
	execute: () => Promise<void>;
	resolve: () => void;
	reject: (err: unknown) => void;
};

// Ring buffer with power-of-two capacity so wrap is a bitmask.
const QUEUE_CAP = 256; // must be power of two
const QUEUE_MASK = QUEUE_CAP - 1;
const _opRing: (QueuedOp | undefined)[] = new Array(QUEUE_CAP);
let _ringHead = 0; // next dequeue index
let _ringTail = 0; // next enqueue index
let _opProcessing = false;

function _enqueueOp(fn: () => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const next = (_ringTail + 1) & QUEUE_MASK;
		if (next === _ringHead) {
			// Ring full — fall back to a linear flush (should never happen in practice).
			reject(new Error("[opfs.worker] op queue overflow"));
			return;
		}
		_opRing[_ringTail] = { execute: fn, resolve, reject };
		_ringTail = next;
		if (!_opProcessing) void _drainOpQueue();
	});
}

async function _drainOpQueue(): Promise<void> {
	_opProcessing = true;
	while (_ringHead !== _ringTail) {
		const op = _opRing[_ringHead]!;
		_opRing[_ringHead] = undefined; // release reference for GC
		_ringHead = (_ringHead + 1) & QUEUE_MASK;
		try {
			await op.execute();
			op.resolve();
		} catch (err) {
			op.reject(err);
		}
	}
	_opProcessing = false;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------
let meshStore: OpfsChunkStore | null = null;
let regionsDir: FileSystemDirectoryHandle | null = null;
const regionFiles = new Map<number, RegionFile>();
const regionOpenInflight = new Map<number, Promise<RegionFile>>();
let initInFlight: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// O(1) LRU via doubly-linked list embedded in a Map.
// Avoids indexOf+splice which is O(n) per access on the old array.
// ---------------------------------------------------------------------------
type LruNode = { key: number; prev: LruNode | null; next: LruNode | null };
const _lruMap = new Map<number, LruNode>();
let _lruHead: LruNode | null = null; // oldest (evict candidate)
let _lruTail: LruNode | null = null; // newest

function _lruTouch(key: number): void {
	let node = _lruMap.get(key);
	if (node) {
		// Unlink from current position.
		if (node.prev) node.prev.next = node.next;
		else _lruHead = node.next;
		if (node.next) node.next.prev = node.prev;
		else _lruTail = node.prev;
		node.prev = null;
		node.next = null;
	} else {
		node = { key, prev: null, next: null };
		_lruMap.set(key, node);
	}
	// Append to tail (newest).
	if (_lruTail) {
		_lruTail.next = node;
		node.prev = _lruTail;
	} else _lruHead = node;
	_lruTail = node;
}

function _lruEvict(): number | null {
	if (!_lruHead) return null;
	const node = _lruHead;
	_lruHead = node.next;
	if (_lruHead) _lruHead.prev = null;
	else _lruTail = null;
	_lruMap.delete(node.key);
	node.next = null;
	return node.key;
}

function _lruDelete(key: number): void {
	const node = _lruMap.get(key);
	if (!node) return;
	if (node.prev) node.prev.next = node.next;
	else _lruHead = node.next;
	if (node.next) node.next.prev = node.prev;
	else _lruTail = node.prev;
	_lruMap.delete(key);
}

// ---------------------------------------------------------------------------
// Region key packing — avoids string allocation on every voxel op.
// Coords are in chunk-space / REGION_DIM, typically –512..+512.
// Pack into a 32-bit integer with 10-bit signed fields (offset by 512).
// Supports region coords in [–512, +511].
// ---------------------------------------------------------------------------
const REGION_COORD_OFFSET = 512;
const REGION_COORD_BITS = 10;
const REGION_DIM = 16;
const MAX_OPEN_REGIONS = 128;

function packRegionKey(rx: number, ry: number, rz: number): number {
	// Each field is 10 bits, offset so it's always non-negative.
	return (
		(rx + REGION_COORD_OFFSET) * (1 << (REGION_COORD_BITS * 2)) +
		(ry + REGION_COORD_OFFSET) * (1 << REGION_COORD_BITS) +
		(rz + REGION_COORD_OFFSET)
	);
}

// Human-readable filename still uses rx/ry/rz — only the map key is packed.
function regionFileName(rx: number, ry: number, rz: number): string {
	return `r.${rx}.${ry}.${rz}.bin`;
}

// ---------------------------------------------------------------------------
// localCoord — power-of-two bitmask; handles negatives correctly because
// JS % can return negative, but (n & 15) for negative n gives a negative
// result in JS too. The offset trick below is branchless and correct.
// ---------------------------------------------------------------------------
function localCoord(chunk: number): number {
	// Equivalent to ((chunk % 16) + 16) % 16, but avoids two modulo ops.
	return (chunk & 15) < 0 ? (chunk & 15) + 16 : chunk & 15;
	// Note: for JS, (chunk % 16 + 16) & 15 is safe and branchless:
	// chunk & 15 is only correct for non-negative; use the formula below.
}

// Actually the cleanest branchless form for negative-safe power-of-two mod:
// ((n % M) + M) % M  →  with M=16: ((n % 16) + 16) % 16
// But since M is a power of two: ((n & (M-1)) + M) & (M-1)
// which equals: ((n & 15) + 16) & 15
// This is branchless and avoids the second full-modulo.
// We inline it directly where used below rather than calling a function,
// saving the call overhead on the hot path.

// ---------------------------------------------------------------------------
// Scratch Uint8Array reuse — avoids allocation in toUint8Array().
// ---------------------------------------------------------------------------
function viewOf(data: ArrayBuffer | Uint8Array): Uint8Array {
	// Returns a view without allocating when data is already a Uint8Array.
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

// ---------------------------------------------------------------------------
// Compression helpers — single-chunk fast path avoids final copy.
// ---------------------------------------------------------------------------
async function compressGzip(data: Uint8Array): Promise<Uint8Array> {
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(data);
			controller.close();
		},
	});
	const reader = readable
		.pipeThrough(
			new CompressionStream("gzip") as unknown as ReadableWritablePair<
				Uint8Array,
				Uint8Array
			>,
		)
		.getReader();

	// Fast path: almost always a single output chunk for small payloads.
	const { value: first, done: firstDone } = await reader.read();
	if (firstDone || !first) {
		reader.releaseLock();
		return new Uint8Array(0);
	}
	const { value: second, done: secondDone } = await reader.read();
	if (secondDone || !second) {
		reader.releaseLock();
		return first;
	} // ← zero copy

	// Slow path: multiple chunks (large payloads).
	const chunks: Uint8Array[] = [first, second];
	let totalBytes = first.byteLength + second.byteLength;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done || !value) break;
			chunks.push(value);
			totalBytes += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (let i = 0; i < chunks.length; i++) {
		result.set(chunks[i], offset);
		offset += chunks[i].byteLength;
	}
	return result;
}

async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
	// Use ReadableStream directly (avoids Response allocation round-trip).
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			// Ensure the buffer is a plain ArrayBuffer — DecompressionStream
			// can reject SharedArrayBuffer or detached views.
			const slice =
				data.buffer instanceof ArrayBuffer
					? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
					: new Uint8Array(data);
			controller.enqueue(slice);
			controller.close();
		},
	});
	const reader = readable
		.pipeThrough(
			new DecompressionStream("gzip") as unknown as ReadableWritablePair<
				Uint8Array,
				Uint8Array
			>,
		)
		.getReader();

	const { value: first, done: firstDone } = await reader.read();
	if (firstDone || !first) {
		reader.releaseLock();
		return new Uint8Array(0);
	}
	const { value: second, done: secondDone } = await reader.read();
	if (secondDone || !second) {
		reader.releaseLock();
		return first;
	} // ← zero copy

	const chunks: Uint8Array[] = [first, second];
	let totalBytes = first.byteLength + second.byteLength;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done || !value) break;
			chunks.push(value);
			totalBytes += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (let i = 0; i < chunks.length; i++) {
		result.set(chunks[i], offset);
		offset += chunks[i].byteLength;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Batch flush scheduling
// ---------------------------------------------------------------------------
let dirtyRegionCount = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;
const DIRTY_FLUSH_THRESHOLD = 8;
let flushQueued = false;

function queueFlush(): void {
	if (flushQueued) return;
	flushQueued = true;
	// Enqueue a single flush op — the boolean guard above means this runs once.
	void _enqueueOp(_flushOp);
}

// Pre-allocated op function — avoids closure allocation on every dirty write.
async function _flushOp(): Promise<void> {
	flushQueued = false;
	_flushAllRegions();
}

function _scheduleFlush(): void {
	flushTimer = null;
	queueFlush();
}

function markDirty(): void {
	dirtyRegionCount++;
	if (dirtyRegionCount >= DIRTY_FLUSH_THRESHOLD) {
		queueFlush();
	} else if (!flushTimer) {
		flushTimer = setTimeout(_scheduleFlush, FLUSH_INTERVAL_MS);
	}
}

function _flushAllRegions(): void {
	// for..of over Map is faster than forEach (no callback allocation per call).
	for (const rf of regionFiles.values()) {
		rf.flush();
	}
	dirtyRegionCount = 0;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
}

async function _closeRegionFile(rf: RegionFile): Promise<void> {
	try {
		rf.flush();
		await Promise.resolve(rf.close());
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Store init / open helpers
// ---------------------------------------------------------------------------
async function ensureMeshStore(): Promise<OpfsChunkStore> {
	if (meshStore) return meshStore;
	return openStores().then(() => meshStore!);
}

function resetMeshStore(): void {
	if (meshStore) {
		meshStore.close();
		meshStore = null;
	}
	initInFlight = null;
}

async function withMeshRetry<T>(fn: (s: OpfsChunkStore) => T): Promise<T> {
	try {
		return fn(await ensureMeshStore());
	} catch {
		resetMeshStore();
		return fn(await ensureMeshStore());
	}
}

async function ensureRegionsDir(): Promise<FileSystemDirectoryHandle> {
	if (regionsDir) return regionsDir;
	const root = await navigator.storage.getDirectory();
	const b102 = await root.getDirectoryHandle("b102", { create: true });
	regionsDir = await b102.getDirectoryHandle("regions", { create: true });
	return regionsDir;
}

async function getRegionFile(
	rx: number,
	ry: number,
	rz: number,
): Promise<RegionFile> {
	const key = packRegionKey(rx, ry, rz);

	const cached = regionFiles.get(key);
	if (cached) {
		_lruTouch(key);
		return cached;
	}

	const inflight = regionOpenInflight.get(key);
	if (inflight) return inflight;

	// Evict LRU if at capacity.
	if (regionFiles.size >= MAX_OPEN_REGIONS) {
		const lruKey = _lruEvict();
		if (lruKey !== null) {
			const lru = regionFiles.get(lruKey);
			if (lru) {
				lru.close();
				regionFiles.delete(lruKey);
			}
		}
	}

	let resolveInflight!: (rf: RegionFile) => void;
	let rejectInflight!: (err: unknown) => void;
	const inflightPromise = new Promise<RegionFile>((res, rej) => {
		resolveInflight = res;
		rejectInflight = rej;
	});
	regionOpenInflight.set(key, inflightPromise);

	try {
		const dir = await ensureRegionsDir();
		const fileHandle = await dir.getFileHandle(regionFileName(rx, ry, rz), {
			create: true,
		});
		const accessHandle = await fileHandle.createSyncAccessHandle();
		let rf: RegionFile;
		try {
			rf = await RegionFile.open(accessHandle, rx, ry, rz);
		} catch (openErr) {
			accessHandle.close();
			throw openErr;
		}
		regionFiles.set(key, rf);
		_lruTouch(key);
		resolveInflight(rf);
		return rf;
	} catch (err) {
		rejectInflight(err);
		throw err;
	} finally {
		regionOpenInflight.delete(key);
	}
}

async function openStores(): Promise<void> {
	if (initInFlight) {
		await initInFlight;
		return;
	}
	initInFlight = (async () => {
		const store = new OpfsChunkStore();
		await store.open("meshes.bin");
		meshStore = store;
		await ensureRegionsDir();
	})();
	await initInFlight;
	if (!meshStore) throw new Error("[opfs.worker] Failed to initialise stores");
}

// ---------------------------------------------------------------------------
// Pre-allocated response objects — reused per message to reduce GC pressure.
// The worker is single-threaded (ops are serialized) so this is safe.
// ---------------------------------------------------------------------------
const _resultMsg: { id: number; result: unknown } = { id: 0, result: null };
const _errorMsg: { id: number; error: string } = { id: 0, error: "" };

function postResult(id: number, result: unknown): void {
	_resultMsg.id = id;
	_resultMsg.result = result;
	_self.postMessage(_resultMsg);
	// Clear after send so the previous value isn't retained across turns.
	_resultMsg.result = null;
}

function postError(id: number, message: string): void {
	_errorMsg.id = id;
	_errorMsg.error = message;
	_self.postMessage(_errorMsg);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
_self.addEventListener("message", (event: MessageEvent) => {
	const data = event.data;
	if (!data || typeof data.type !== "number") return;
	const id: number = data.id ?? 0;

	void _enqueueOp(async () => {
		const type: number = data.type;

		switch (type) {
			case OpfsMsg.Ping: {
				postResult(id, "pong");
				_self.postMessage({ type: "ready" });
				break;
			}

			case OpfsMsg.ReadMesh: {
				const raw = await withMeshRetry((s) =>
					s.read(data.keyHi >>> 0, data.keyLo >>> 0, data.lod | 0),
				);
				postResult(id, raw ? await decompressGzip(raw) : null);
				break;
			}
			case OpfsMsg.WriteMesh: {
				const compressed = await compressGzip(viewOf(data.data));
				await withMeshRetry((s) =>
					s.write(data.keyHi >>> 0, data.keyLo >>> 0, data.lod | 0, compressed),
				);
				postResult(id, true);
				break;
			}
			case OpfsMsg.RemoveMesh: {
				postResult(
					id,
					await withMeshRetry((s) =>
						s.remove(data.keyHi >>> 0, data.keyLo >>> 0, data.lod | 0),
					),
				);
				break;
			}
			case OpfsMsg.FlushMeshes: {
				await withMeshRetry((s) => s.flush());
				postResult(id, true);
				break;
			}
			case OpfsMsg.GetStats: {
				postResult(
					id,
					meshStore
						? meshStore.getStats()
						: {
								slotCount: 0,
								usedBytes: 0,
								totalBytes: 0,
								capacity: 0,
								hitCount: 0,
								missCount: 0,
								evictionCount: 0,
							},
				);
				break;
			}

			case OpfsMsg.ReadVoxel: {
				const cx = data.chunkX | 0;
				const cy = data.chunkY | 0;
				const cz = data.chunkZ | 0;
				const rx = Math.floor(cx / REGION_DIM);
				const ry = Math.floor(cy / REGION_DIM);
				const rz = Math.floor(cz / REGION_DIM);
				// Branchless negative-safe mod-16 via bit trick.
				const lx = ((cx & 15) + 16) & 15;
				const ly = ((cy & 15) + 16) & 15;
				const lz = ((cz & 15) + 16) & 15;
				const isEntity = (data.lod | 0) === 254;
				const rf = await getRegionFile(rx, ry, rz);
				const result = rf.readChunk(lx, ly, lz, isEntity);
				if (result) {
					_self.postMessage({ id, result }, [result.buffer]);
				} else {
					postResult(id, null);
				}
				break;
			}
			case OpfsMsg.WriteVoxel: {
				const cx = data.chunkX | 0;
				const cy = data.chunkY | 0;
				const cz = data.chunkZ | 0;
				const rx = Math.floor(cx / REGION_DIM);
				const ry = Math.floor(cy / REGION_DIM);
				const rz = Math.floor(cz / REGION_DIM);
				const lx = ((cx & 15) + 16) & 15;
				const ly = ((cy & 15) + 16) & 15;
				const lz = ((cz & 15) + 16) & 15;
				const isEntity = (data.lod | 0) === 254;
				const rf = await getRegionFile(rx, ry, rz);
				rf.writeChunk(lx, ly, lz, isEntity, viewOf(data.data));
				markDirty();
				postResult(id, true);
				break;
			}
			case OpfsMsg.RemoveVoxel: {
				const cx = data.chunkX | 0;
				const cy = data.chunkY | 0;
				const cz = data.chunkZ | 0;
				const rx = Math.floor(cx / REGION_DIM);
				const ry = Math.floor(cy / REGION_DIM);
				const rz = Math.floor(cz / REGION_DIM);
				const lx = ((cx & 15) + 16) & 15;
				const ly = ((cy & 15) + 16) & 15;
				const lz = ((cz & 15) + 16) & 15;
				const isEntity = (data.lod | 0) === 254;
				const rf = await getRegionFile(rx, ry, rz);
				rf.removeChunk(lx, ly, lz, isEntity);
				markDirty();
				postResult(id, true);
				break;
			}
			case OpfsMsg.FlushVoxels: {
				_flushAllRegions();
				postResult(id, true);
				break;
			}

			case OpfsMsg.Close: {
				_flushAllRegions();
				if (meshStore) {
					await meshStore.close();
					meshStore = null;
				}
				for (const rf of regionFiles.values()) await _closeRegionFile(rf);
				regionFiles.clear();
				_lruMap.clear();
				_lruHead = null;
				_lruTail = null;
				regionOpenInflight.clear();
				regionsDir = null;
				initInFlight = null;
				postResult(id, true);
				break;
			}
			default:
				postError(id, `Unknown type: ${type}`);
		}
	}).catch((err) => {
		postError(id, err instanceof Error ? err.message : String(err));
	});
});
