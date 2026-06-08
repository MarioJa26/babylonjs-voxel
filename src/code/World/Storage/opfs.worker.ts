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

let initInFlight: Promise<void> | null = null;

// Batch flush scheduling — avoids per-write OPFS flush overhead.
let dirtyRegionCount = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;
const DIRTY_FLUSH_THRESHOLD = 8;

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
	if (cached) return cached;

	const inflight = regionOpenInflight.get(key);
	if (inflight) return inflight;

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
function markDirty(): void {
	dirtyRegionCount++;
	if (dirtyRegionCount >= DIRTY_FLUSH_THRESHOLD) {
		flushAllRegions();
	} else if (!flushTimer) {
		flushTimer = setTimeout(() => {
			flushTimer = null;
			// Enqueue the flush so it runs inside the serial op queue
			// and never races with read/write operations.
			void _enqueueOp(async () => {
				flushAllRegions();
			});
		}, FLUSH_INTERVAL_MS);
	}
}

function flushAllRegions(): void {
	for (const [, rf] of regionFiles) {
		rf.flush();
	}
	dirtyRegionCount = 0;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
}

// ---------------------------------------------------------------------------
// Store initialization
// ---------------------------------------------------------------------------
async function ensureMeshStore(): Promise<OpfsChunkStore> {
	if (meshStore) return meshStore;
	return openStores().then(() => meshStore!);
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
				const s = await ensureMeshStore();
				const result = await s.read(
					data.keyHi >>> 0,
					data.keyLo >>> 0,
					data.lod | 0,
				);
				postResult(result);
				break;
			}
			case OpfsMsg.WriteMesh: {
				const s = await ensureMeshStore();
				const bytes = toUint8Array(data.data);
				await s.write(data.keyHi >>> 0, data.keyLo >>> 0, data.lod | 0, bytes);
				postResult(true);
				break;
			}
			case OpfsMsg.RemoveMesh: {
				const s = await ensureMeshStore();
				const ok = await s.remove(
					data.keyHi >>> 0,
					data.keyLo >>> 0,
					data.lod | 0,
				);
				postResult(ok);
				break;
			}
			case OpfsMsg.FlushMeshes: {
				const s = await ensureMeshStore();
				await s.flush();
				postResult(true);
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
				postResult(result);
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
					rf.close();
				}
				regionFiles.clear();
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
