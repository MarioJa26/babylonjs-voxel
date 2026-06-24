/// <reference lib="webworker" />

import { OpfsChunkStore } from "./OpfsChunkStore";
import { OpfsMsg } from "./OpfsMessageTypes";
import { RegionFile } from "./RegionFile";

// ---------------------------------------------------------------------------
// Serial operation queue — ensures only one async handler runs at a time so
// that createSyncAccessHandle() calls never overlap for the same file.
// ---------------------------------------------------------------------------
type QueuedOp = {
	execute: () => Promise<void>;
	resolve: () => void;
	reject: (err: unknown) => void;
};
const _opQueue: QueuedOp[] = [];
let _opProcessing = false;

function _enqueueOp(fn: () => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		_opQueue.push({ execute: fn, resolve, reject });
		if (!_opProcessing) void _drainOpQueue();
	});
}

async function _drainOpQueue(): Promise<void> {
	_opProcessing = true;
	while (_opQueue.length > 0) {
		const op = _opQueue.shift()!;
		try {
			await op.execute();
			op.resolve();
		} catch (err) {
			op.reject(err);
		}
	}
	_opProcessing = false;
}

// Mesh store (evictable cache — single file, OpfsChunkStore)
let meshStore: OpfsChunkStore | null = null;

// Voxel region files (persistent — one file per 16×16×16 region)
let regionsDir: FileSystemDirectoryHandle | null = null;
const regionFiles = new Map<string, RegionFile>();
const regionOpenInflight = new Map<string, Promise<RegionFile>>();
const regionAccessOrder: string[] = []; // LRU tracking — newest at end
const MAX_OPEN_REGIONS = 128;

let initInFlight: Promise<void> | null = null;

// Batch flush scheduling — avoids per-write OPFS flush overhead.
let dirtyRegionCount = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;
const DIRTY_FLUSH_THRESHOLD = 8;
let flushQueued = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const REGION_DIM = 16;

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function localCoord(chunk: number): number {
	return ((chunk % REGION_DIM) + REGION_DIM) % REGION_DIM;
}

function regionKey(rx: number, ry: number, rz: number): string {
	return `${rx},${ry},${rz}`;
}

function touchRegion(key: string): void {
	const idx = regionAccessOrder.indexOf(key);
	if (idx !== -1) regionAccessOrder.splice(idx, 1);
	regionAccessOrder.push(key);
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
	const key = regionKey(rx, ry, rz);

	const cached = regionFiles.get(key);
	if (cached) {
		touchRegion(key);
		return cached;
	}

	const inflight = regionOpenInflight.get(key);
	if (inflight) return inflight;

	// Evict LRU region if at capacity.
	if (regionFiles.size >= MAX_OPEN_REGIONS && regionAccessOrder.length > 0) {
		const lruKey = regionAccessOrder.shift()!;
		const lru = regionFiles.get(lruKey);
		if (lru) {
			lru.close();
			regionFiles.delete(lruKey);
		}
	}

	// Set BEFORE the async work starts so subsequent calls see it immediately.
	let resolveInflight!: (rf: RegionFile) => void;
	let rejectInflight!: (err: unknown) => void;
	const inflightPromise = new Promise<RegionFile>((res, rej) => {
		resolveInflight = res;
		rejectInflight = rej;
	});
	regionOpenInflight.set(key, inflightPromise);

	try {
		const dir = await ensureRegionsDir();
		const fileName = `r.${rx}.${ry}.${rz}.bin`;
		const fileHandle = await dir.getFileHandle(fileName, { create: true });
		const accessHandle = await fileHandle.createSyncAccessHandle();
		let rf: RegionFile;
		try {
			rf = await RegionFile.open(accessHandle, rx, ry, rz);
		} catch (openErr) {
			accessHandle.close();
			throw openErr;
		}
		regionFiles.set(key, rf);
		touchRegion(key);
		resolveInflight(rf);
		return rf;
	} catch (err) {
		rejectInflight(err);
		throw err;
	} finally {
		regionOpenInflight.delete(key);
	}
}

// ---------------------------------------------------------------------------
// Batch flush helpers
// ---------------------------------------------------------------------------
function queueFlush(): void {
	if (flushQueued) return;
	flushQueued = true;
	void _enqueueOp(async () => {
		flushQueued = false;
		flushAllRegions();
	});
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

function flushAllRegions(): void {
	regionFiles.forEach((rf) => {
		rf.flush();
	});
	dirtyRegionCount = 0;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
}

async function closeRegionFile(rf: RegionFile): Promise<void> {
	try {
		rf.flush();
		await Promise.resolve(rf.close());
	} catch {
		// ignore close errors
	}
}

// ---------------------------------------------------------------------------
// Store initialization
// ---------------------------------------------------------------------------
async function ensureMeshStore(): Promise<OpfsChunkStore> {
	if (meshStore) return meshStore;
	return openStores().then(() => meshStore!);
}

/** Invalidate cached handles and force re-open on next access. */
function resetMeshStore(): void {
	if (meshStore) {
		meshStore.close();
		meshStore = null;
	}
	initInFlight = null;
}

/** Run a mesh-store op; on stale-handle error, reset and retry once. */
async function withMeshRetry<T>(fn: (s: OpfsChunkStore) => T): Promise<T> {
	try {
		const s = await ensureMeshStore();
		return fn(s);
	} catch (err) {
		resetMeshStore();
		const s = await ensureMeshStore();
		return fn(s);
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
// Message handler — protocol: { id, type, ...payload } → { id, result/error }
// ---------------------------------------------------------------------------
self.addEventListener("message", (event: MessageEvent) => {
	const data = event.data;
	if (!data || typeof data.type !== "number") return;
	const id = data.id ?? 0;

	const postResult = (result: any): void => {
		(self as DedicatedWorkerGlobalScope).postMessage({ id, result });
	};
	const postError = (message: string): void => {
		(self as DedicatedWorkerGlobalScope).postMessage({ id, error: message });
	};

	void _enqueueOp(async () => {
		switch (data.type) {
			// ---- Ping (readiness probe) ----
			case OpfsMsg.Ping: {
				postResult("pong");
				(self as DedicatedWorkerGlobalScope).postMessage({ type: "ready" });
				break;
			}

			// ---- Mesh store (OpfsChunkStore — evictable LRU) ----
			case OpfsMsg.ReadMesh: {
				const result = await withMeshRetry((s) =>
					s.read(data.keyHi >>> 0, data.keyLo >>> 0, data.lod | 0),
				);
				postResult(result);
				break;
			}
			case OpfsMsg.WriteMesh: {
				const bytes = toUint8Array(data.data);
				await withMeshRetry((s) =>
					s.write(data.keyHi >>> 0, data.keyLo >>> 0, data.lod | 0, bytes),
				);
				postResult(true);
				break;
			}
			case OpfsMsg.RemoveMesh: {
				const ok = await withMeshRetry((s) =>
					s.remove(data.keyHi >>> 0, data.keyLo >>> 0, data.lod | 0),
				);
				postResult(ok);
				break;
			}
			case OpfsMsg.FlushMeshes: {
				await withMeshRetry((s) => s.flush());
				postResult(true);
				break;
			}
			case OpfsMsg.GetStats: {
				const stats = meshStore
					? meshStore.getStats()
					: {
							slotCount: 0,
							usedBytes: 0,
							totalBytes: 0,
							capacity: 0,
							hitCount: 0,
							missCount: 0,
							evictionCount: 0,
						};
				postResult(stats);
				break;
			}

			// ---- Voxel store (RegionFile — persistent) ----
			case OpfsMsg.ReadVoxel: {
				const cx = data.chunkX | 0;
				const cy = data.chunkY | 0;
				const cz = data.chunkZ | 0;
				const rx = Math.floor(cx / REGION_DIM);
				const ry = Math.floor(cy / REGION_DIM);
				const rz = Math.floor(cz / REGION_DIM);
				const lx = localCoord(cx);
				const ly = localCoord(cy);
				const lz = localCoord(cz);
				const isEntity = (data.lod | 0) === 254;
				const rf = await getRegionFile(rx, ry, rz);
				const result = rf.readChunk(lx, ly, lz, isEntity);

				if (result) {
					postMessage(
						{ id, result },
						[result.buffer], // ✅ still transfer
					);
				} else {
					postMessage({ id, result: null });
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
				const lx = localCoord(cx);
				const ly = localCoord(cy);
				const lz = localCoord(cz);
				const isEntity = (data.lod | 0) === 254;
				const bytes = toUint8Array(data.data);
				const rf = await getRegionFile(rx, ry, rz);
				rf.writeChunk(lx, ly, lz, isEntity, bytes);
				markDirty();
				postResult(true);
				break;
			}
			case OpfsMsg.RemoveVoxel: {
				const cx = data.chunkX | 0;
				const cy = data.chunkY | 0;
				const cz = data.chunkZ | 0;
				const rx = Math.floor(cx / REGION_DIM);
				const ry = Math.floor(cy / REGION_DIM);
				const rz = Math.floor(cz / REGION_DIM);
				const lx = localCoord(cx);
				const ly = localCoord(cy);
				const lz = localCoord(cz);
				const isEntity = (data.lod | 0) === 254;
				const rf = await getRegionFile(rx, ry, rz);
				rf.removeChunk(lx, ly, lz, isEntity);
				markDirty();
				postResult(true);
				break;
			}
			case OpfsMsg.FlushVoxels: {
				flushAllRegions();
				postResult(true);
				break;
			}

			// ---- Shutdown ----
			case OpfsMsg.Close: {
				flushAllRegions();
				if (meshStore) {
					await meshStore.close();
					meshStore = null;
				}
				for (const rf of regionFiles.values()) {
					await closeRegionFile(rf);
				}
				regionFiles.clear();
				regionAccessOrder.length = 0;
				regionOpenInflight.clear();
				regionsDir = null;
				initInFlight = null;
				postResult(true);
				break;
			}
			default:
				postError(`Unknown type: ${data.type}`);
		}
	}).catch((err) => {
		postError(err instanceof Error ? err.message : String(err));
	});
});
