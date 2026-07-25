/// <reference lib="webworker" />

import { serializeMeshPair } from "./MeshSerializer";
import { OpfsChunkStore } from "./OpfsChunkStore";
import { OpfsMsg } from "./OpfsMessageTypes";
import { RegionFile } from "./RegionFile";
import { deserializeVoxelData } from "./VoxelSerializer";

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
const QUEUE_CAP = 4096; // must be power of two
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
// Worker-to-worker channel: OPFS worker forwards decompressed SAB refs
// directly to the terrain/light worker so the main thread never posts
// the SAB payloads itself (saves ~22ms per chunk load).
// ---------------------------------------------------------------------------
let _workerChannelPort: MessagePort | null = null;

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

// ---------------------------------------------------------------------------
// Region key packing — bitwise shift+OR instead of multiplication. This
// guarantees an int32 SMI result directly (no float intermediate) and is
// cheaper than the equivalent `* (1 << n)` form.
// Coords are in chunk-space / REGION_DIM, typically –512..+512.
// Pack into a 32-bit integer with 10-bit signed fields (offset by 512).
// Supports region coords in [–512, +511].
// ---------------------------------------------------------------------------
const REGION_COORD_OFFSET = 512;
const REGION_KEY_SHIFT_HI = 20; // REGION_COORD_BITS * 2
const REGION_KEY_SHIFT_LO = 10; // REGION_COORD_BITS
const REGION_DIM = 16;
const REGION_DIM_SHIFT = 4; // log2(REGION_DIM) — REGION_DIM must stay a power of two
const REGION_LOCAL_MASK = REGION_DIM - 1; // 15
const MAX_OPEN_REGIONS = 128;

function packRegionKey(rx: number, ry: number, rz: number): number {
	return (
		((rx + REGION_COORD_OFFSET) << REGION_KEY_SHIFT_HI) |
		((ry + REGION_COORD_OFFSET) << REGION_KEY_SHIFT_LO) |
		(rz + REGION_COORD_OFFSET)
	);
}

// Human-readable filename still uses rx/ry/rz — only the map key is packed.
function regionFileName(rx: number, ry: number, rz: number): string {
	return `r.${rx}.${ry}.${rz}.bin`;
}

// ---------------------------------------------------------------------------
// Shared chunk-coord -> (region, local) resolver.
// Was previously duplicated three times (Read/Write/RemoveVoxel), each doing
// Math.floor(cx / 16) + a redundant double-mask `((cx & 15) + 16) & 15`.
//
// `>>` already floors correctly for negative two's-complement ints, so
// `cx >> 4` replaces the float division + Math.floor entirely, and plain
// `cx & 15` is already negative-safe (two's-complement masking), so the
// extra "+16) & 15" wrap was a no-op that cost two ops per axis for nothing.
//
// Result is written into a module-level scratch array instead of an
// allocated object/tuple — this function sits on the hottest path in the
// worker (every voxel read/write/remove), so avoiding an allocation here
// matters more than call-site prettiness.
// ---------------------------------------------------------------------------
const _loc = new Int32Array(6); // [rx, ry, rz, lx, ly, lz]

function resolveVoxelLocation(cx: number, cy: number, cz: number): void {
	_loc[0] = cx >> REGION_DIM_SHIFT;
	_loc[1] = cy >> REGION_DIM_SHIFT;
	_loc[2] = cz >> REGION_DIM_SHIFT;
	_loc[3] = cx & REGION_LOCAL_MASK;
	_loc[4] = cy & REGION_LOCAL_MASK;
	_loc[5] = cz & REGION_LOCAL_MASK;
}

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
const _transferArr: ArrayBufferLike[] = [undefined as unknown as ArrayBuffer]; // reused 1-slot transfer list

function postResult(id: number, result: unknown): void {
	_resultMsg.id = id;
	_resultMsg.result = result;
	_self.postMessage(_resultMsg);
	// Clear after send so the previous value isn't retained across turns.
	_resultMsg.result = null;
}

// Same as postResult but transfers the backing buffer (for voxel reads),
// reusing both the message wrapper and the single-slot transfer array
// instead of allocating a fresh `{ id, result }` + `[buffer]` per call.
function postTransferResult(id: number, result: Uint8Array | null): void {
	if (!result) {
		postResult(id, null);
		return;
	}
	_resultMsg.id = id;
	_resultMsg.result = result;
	_transferArr[0] = result.buffer;
	_self.postMessage(_resultMsg, _transferArr);
	_resultMsg.result = null;
	_transferArr[0] = undefined as unknown as ArrayBuffer;
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
			case OpfsMsg.WriteMeshRaw: {
				const opaque = data.aO
					? {
							faceDataA: data.aO,
							faceDataB: data.bO ?? new Uint8Array(0),
							faceDataC: data.cO ?? new Uint8Array(0),
							faceCount: data.faceCountO >>> 0,
						}
					: null;
				const transparent = data.aT
					? {
							faceDataA: data.aT,
							faceDataB: data.bT ?? new Uint8Array(0),
							faceDataC: data.cT ?? new Uint8Array(0),
							faceCount: data.faceCountT >>> 0,
						}
					: null;
				const bytes = serializeMeshPair(opaque, transparent);
				if (bytes) {
					const compressed = await compressGzip(bytes);
					await withMeshRetry((s) =>
						s.write(
							data.keyHi >>> 0,
							data.keyLo >>> 0,
							data.lod | 0,
							compressed,
						),
					);
				}
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
				const isEntity = (data.lod | 0) === 254;
				resolveVoxelLocation(data.chunkX | 0, data.chunkY | 0, data.chunkZ | 0);
				const rf = await getRegionFile(_loc[0], _loc[1], _loc[2]);
				const result = rf.readChunk(_loc[3], _loc[4], _loc[5], isEntity);
				postTransferResult(id, result);
				break;
			}
			case OpfsMsg.ReadVoxelDecompressed: {
				resolveVoxelLocation(data.chunkX | 0, data.chunkY | 0, data.chunkZ | 0);
				const rf2 = await getRegionFile(_loc[0], _loc[1], _loc[2]);
				const raw = rf2.readChunk(_loc[3], _loc[4], _loc[5], false);
				if (!raw) {
					postResult(id, null);
					break;
				}
				const saved = deserializeVoxelData(raw);
				if (saved.compressed) {
					if (saved.blocks && saved.blocks instanceof Uint8Array) {
						saved.blocks = await decompressGzip(saved.blocks);
					}
					if (saved.lightArray) {
						saved.lightArray = await decompressGzip(saved.lightArray);
					}
					saved.compressed = false;
				}

				let blocksSAB: SharedArrayBuffer | null = null;
				let paletteSAB: SharedArrayBuffer | null = null;
				let lightSAB: SharedArrayBuffer | null = null;

				if (saved.blocks) {
					const rawBytes =
						saved.blocks instanceof Uint16Array
							? new Uint8Array(
									saved.blocks.buffer,
									saved.blocks.byteOffset,
									saved.blocks.byteLength,
								)
							: saved.blocks;
					blocksSAB = new SharedArrayBuffer(rawBytes.byteLength);
					new Uint8Array(blocksSAB).set(rawBytes);
				}
				if (saved.palette) {
					const byteLen = saved.palette.byteLength;
					paletteSAB = new SharedArrayBuffer(byteLen);
					new Uint8Array(paletteSAB).set(
						new Uint8Array(
							saved.palette.buffer,
							saved.palette.byteOffset,
							byteLen,
						),
					);
				}
				if (saved.lightArray) {
					lightSAB = new SharedArrayBuffer(saved.lightArray.byteLength);
					new Uint8Array(lightSAB).set(saved.lightArray);
				}

				const cx = data.chunkX | 0;
				const cy = data.chunkY | 0;
				const cz = data.chunkZ | 0;
				const blockBytesPerElement: 1 | 2 =
					saved.blocks?.byteLength === 65536 ? 2 : 1;

				// Forward SAB refs + coords to the terrain/light worker so it
				// can register the chunk without the main thread posting SABs.
				if (_workerChannelPort) {
					_workerChannelPort.postMessage({
						_type: "voxelData",
						chunkX: cx,
						chunkY: cy,
						chunkZ: cz,
						blocksSAB,
						paletteSAB,
						lightSAB,
						blockBytesPerElement,
					});
				}

				postResult(id, {
					blocksSAB,
					paletteSAB,
					isUniform: saved.isUniform ?? false,
					uniformBlockId: saved.uniformBlockId ?? 0,
					lightSAB,
					blockBytesPerElement,
				});
				break;
			}
			case OpfsMsg.WriteVoxel: {
				const isEntity = (data.lod | 0) === 254;
				resolveVoxelLocation(data.chunkX | 0, data.chunkY | 0, data.chunkZ | 0);
				const rf = await getRegionFile(_loc[0], _loc[1], _loc[2]);
				rf.writeChunk(_loc[3], _loc[4], _loc[5], isEntity, viewOf(data.data));
				markDirty();
				postResult(id, true);
				break;
			}
			case OpfsMsg.RemoveVoxel: {
				const isEntity = (data.lod | 0) === 254;
				resolveVoxelLocation(data.chunkX | 0, data.chunkY | 0, data.chunkZ | 0);
				const rf = await getRegionFile(_loc[0], _loc[1], _loc[2]);
				rf.removeChunk(_loc[3], _loc[4], _loc[5], isEntity);
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
				if (_workerChannelPort) {
					_workerChannelPort.close();
					_workerChannelPort = null;
				}
				initInFlight = null;
				postResult(id, true);
				break;
			}
			case OpfsMsg.ClearWorld: {
				// Close all open handles first so removeEntry won't fail
				// with NoModificationAllowedError.
				_flushAllRegions();
				if (meshStore) {
					meshStore.close();
					meshStore = null;
				}
				for (const rf of regionFiles.values()) {
					try {
						rf.flush();
						rf.close();
					} catch {
						/* ignore */
					}
				}
				regionFiles.clear();
				_lruMap.clear();
				_lruHead = null;
				_lruTail = null;
				regionOpenInflight.clear();
				regionsDir = null;
				if (_workerChannelPort) {
					_workerChannelPort.close();
					_workerChannelPort = null;
				}
				initInFlight = null;

				// Now delete all OPFS entries from root.
				try {
					const root = await navigator.storage.getDirectory();
					for await (const entry of root.values()) {
						await root.removeEntry(entry.name, { recursive: true });
					}
				} catch (err) {
					postError(id, err instanceof Error ? err.message : String(err));
					break;
				}
				postResult(id, true);
				break;
			}
			case OpfsMsg.InitWorkerChannel: {
				const port = event.ports?.[0];
				if (port) {
					_workerChannelPort = port;
					_workerChannelPort.start();
				}
				break;
			}
			default:
				postError(id, `Unknown type: ${type}`);
		}
	}).catch((err) => {
		postError(id, err instanceof Error ? err.message : String(err));
	});
});
