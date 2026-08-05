// ---------------------------------------------------------------------------
// OpfsClient — Thin main-thread proxy for opfs.worker.ts.
// All OPFS operations run inside a single Web Worker so no locks are held
// on the main thread.  Both meshes (evictable LRU) and voxels (persistent
// region files) are handled by the worker.
// ---------------------------------------------------------------------------

import type { MeshData } from "../Chunk/DataStructures/MeshData";
import { OpfsMsg } from "./OpfsMessageTypes";
import type { HydratedVoxelData } from "./VoxelSerializer";

const _packScratch = { hi: 0, lo: 0 };

// Reusable wire message. postMessage structured-clones synchronously at send
// time, so the same object can be recycled every call — no per-op allocation
// and no `{ id, type, ...payload }` spread (which copies every key). Fields
// are wiped each call so stale values never leak across ops. String keys are
// mandated by the postMessage protocol and are read once by the worker, so
// they cost nothing hot; the dominant serialization cost is the Uint8Array.
interface WireMsg {
	id: number;
	type: OpfsMsg;
	keyHi: number;
	keyLo: number;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	lod: number;
	data?: Uint8Array;
	name?: string;
}
const _wireMsg: WireMsg = {
	id: 0,
	type: OpfsMsg.Ping,
	keyHi: 0,
	keyLo: 0,
	chunkX: 0,
	chunkY: 0,
	chunkZ: 0,
	lod: 0,
};

// Separate wire message for raw-mesh writes (WriteMeshRaw) — transfers the raw
// MeshData arrays to the worker for serialization there, avoiding main-thread
// allocation pressure that causes Major GC.
interface WireMeshRawMsg {
	id: number;
	type: OpfsMsg;
	keyHi: number;
	keyLo: number;
	lod: number;
	faceCountO: number;
	faceCountT: number;
	// All six face arrays (opaque A/B/C, transparent A/B/C) packed
	// contiguously into ONE transferable buffer: [oA|oB|oC|tA|tB|tC], each
	// faceCount*4 bytes. Replaces the previous six separate .slice() copies
	// (6 ArrayBuffer allocations per save) with a single allocation; the
	// worker reconstructs zero-copy subarray views.
	meshData?: Uint8Array;
}
const _wireMeshRawMsg: WireMeshRawMsg = {
	id: 0,
	type: OpfsMsg.WriteMeshRaw,
	keyHi: 0,
	keyLo: 0,
	lod: 0,
	faceCountO: 0,
	faceCountT: 0,
};

function _resetWire(type: OpfsMsg): void {
	const m = _wireMsg;
	m.type = type;
	m.keyHi = 0;
	m.keyLo = 0;
	m.chunkX = 0;
	m.chunkY = 0;
	m.chunkZ = 0;
	m.lod = 0;
	m.data = undefined;
	m.name = undefined;
}

const MAX_INFLIGHT = 2048;

if ((MAX_INFLIGHT & (MAX_INFLIGHT - 1)) !== 0) {
	throw new Error("MAX_INFLIGHT must be a power of two");
}

function transferableBytes(data: Uint8Array): Uint8Array {
	if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
		return data;
	}
	return data.slice();
}
const AXIS_BITS = 21n;
const AXIS_MASK = (1n << AXIS_BITS) - 1n;
const AXIS_BIAS = 1n << (AXIS_BITS - 1n);
export class OpfsClient {
	private _worker: Worker;
	private _opResolves: (((v: any) => void) | null)[];
	private _opRejects: (((e: any) => void) | null)[];
	private _nextId = 1;
	private _ready: Promise<void>;

	constructor(worldName: string) {
		this._worker = new Worker(new URL("./opfs.worker.ts", import.meta.url), {
			type: "module",
		});
		this._opResolves = new Array<((v: any) => void) | null>(MAX_INFLIGHT).fill(
			null,
		);
		this._opRejects = new Array<((e: any) => void) | null>(MAX_INFLIGHT).fill(
			null,
		);

		this._ready = new Promise<void>((resolve) => {
			this._worker.onmessage = (e: MessageEvent) => {
				if (e.data?.type === "ready") {
					resolve();
				}
				this._onMessage(e.data);
			};
			this._worker.onerror = (e) =>
				console.error("[OpfsClient] Worker error:", e);
			// SetWorld is posted first so it is enqueued before Ping and any
			// store op — the worker's serial op queue preserves this order.
			this._worker.postMessage({ type: OpfsMsg.SetWorld, name: worldName });
			this._worker.postMessage({ type: OpfsMsg.Ping });
		});
	}

	async ready(): Promise<void> {
		await this._ready;
	}

	private _dispatch<T = unknown>(
		transfer: Transferable[] = [],
		msg: Record<string, any> = _wireMsg,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			const id = this._nextId++;
			const slot = (id - 1) & (MAX_INFLIGHT - 1);
			if (this._opResolves[slot] !== null) {
				throw new Error(
					`[OpfsClient] inflight slot ${slot} still pending (>${MAX_INFLIGHT} concurrent ops)`,
				);
			}
			this._opResolves[slot] = resolve;
			this._opRejects[slot] = reject;

			msg.id = id;
			this._worker.postMessage(msg, transfer);
			if (msg === _wireMsg) _wireMsg.data = undefined;
		});
	}

	private _onMessage(msg: { id: number; error?: string; result?: any }): void {
		const slot = (msg.id - 1) & (MAX_INFLIGHT - 1);
		const res = this._opResolves[slot];
		const rej = this._opRejects[slot];
		this._opResolves[slot] = null;
		this._opRejects[slot] = null;
		if (!res) return;
		if (msg.error) rej?.(new Error(msg.error));
		else res(msg.result);
	}

	// ── Key packing ─────────────────────────────────────────────

	private _packKey(key: bigint): { hi: number; lo: number } {
		_packScratch.hi = Number((key >> 32n) & 0xffffffffn) >>> 0;
		_packScratch.lo = Number(key & 0xffffffffn) >>> 0;
		return _packScratch;
	}

	private _unpackKey(key: bigint): {
		chunkX: number;
		chunkY: number;
		chunkZ: number;
	} {
		const decode = (v: bigint): number => {
			return Number((v & AXIS_MASK) - AXIS_BIAS);
		};
		return {
			chunkX: decode(key),
			chunkY: decode(key >> AXIS_BITS),
			chunkZ: decode(key >> (AXIS_BITS * 2n)),
		};
	}

	// ── Mesh storage (evictable LRU cache) ─────────────────────

	async readMesh(key: bigint, lod: number): Promise<Uint8Array | null> {
		const { hi, lo } = this._packKey(key);
		_resetWire(OpfsMsg.ReadMesh);
		_wireMsg.keyHi = hi;
		_wireMsg.keyLo = lo;
		_wireMsg.lod = lod;
		return await this._dispatch<Uint8Array | null>();
	}

	async writeMeshRaw(
		key: bigint,
		lod: number,
		opaque: MeshData | null | undefined,
		transparent: MeshData | null | undefined,
	): Promise<void> {
		const { hi, lo } = this._packKey(key);
		const m = _wireMeshRawMsg;
		m.id = 0;
		m.type = OpfsMsg.WriteMeshRaw;
		m.keyHi = hi;
		m.keyLo = lo;
		m.lod = lod;
		const faceCountO = opaque?.faceCount ?? 0;
		const faceCountT = transparent?.faceCount ?? 0;
		m.faceCountO = faceCountO;
		m.faceCountT = faceCountT;

		// Pack the six face arrays into a single transferable buffer instead of
		// allocating six separate .slice() copies. The originals (referenced by
		// chunk cached meshes and merged group members) stay valid on the main
		// thread; only this one combined copy is transferred to the worker.
		const oBytes = faceCountO << 2;
		const tBytes = faceCountT << 2;
		const total = oBytes * 3 + tBytes * 3;

		const transfer: Transferable[] = [];
		if (total > 0) {
			const buf = new Uint8Array(total);
			let off = 0;
			const put = (arr: Uint8Array | undefined, n: number): void => {
				if (arr && arr.length > 0) {
					buf.set(arr.length === n ? arr : arr.subarray(0, n), off);
				}
				off += n;
			};
			put(opaque?.faceDataA, oBytes);
			put(opaque?.faceDataB, oBytes);
			put(opaque?.faceDataC, oBytes);
			put(transparent?.faceDataA, tBytes);
			put(transparent?.faceDataB, tBytes);
			put(transparent?.faceDataC, tBytes);
			m.meshData = buf;
			transfer.push(buf.buffer);
		} else {
			m.meshData = undefined;
		}

		await this._dispatch<void>(transfer, m);
		// Drop the (now detached) buffer reference so it can be GC'd and the
		// reusable wire message is clean for the next call.
		m.meshData = undefined;
		return;
	}

	async removeMesh(key: bigint, lod: number): Promise<boolean> {
		const { hi, lo } = this._packKey(key);
		_resetWire(OpfsMsg.RemoveMesh);
		_wireMsg.keyHi = hi;
		_wireMsg.keyLo = lo;
		_wireMsg.lod = lod;
		return await this._dispatch<boolean>();
	}

	// ── Voxel storage (persistent region files) ────────────────

	async readVoxel(key: bigint, lod: number): Promise<Uint8Array | null> {
		const { chunkX, chunkY, chunkZ } = this._unpackKey(key);
		_resetWire(OpfsMsg.ReadVoxel);
		_wireMsg.chunkX = chunkX;
		_wireMsg.chunkY = chunkY;
		_wireMsg.chunkZ = chunkZ;
		_wireMsg.lod = lod;
		return await this._dispatch<Uint8Array | null>();
	}

	/**
	 * Send a MessageChannel port to the OPFS worker so it can forward
	 * decompressed SAB references directly to the terrain/light worker.
	 * Fire-and-forget (no response expected).
	 */
	public initWorkerChannel(port: MessagePort): void {
		this._worker.postMessage({ type: OpfsMsg.InitWorkerChannel }, [port]);
	}

	async readVoxelDecompressed(
		key: bigint,
		lod: number,
	): Promise<HydratedVoxelData | null> {
		const { chunkX, chunkY, chunkZ } = this._unpackKey(key);
		_resetWire(OpfsMsg.ReadVoxelDecompressed);
		_wireMsg.chunkX = chunkX;
		_wireMsg.chunkY = chunkY;
		_wireMsg.chunkZ = chunkZ;
		_wireMsg.lod = lod;
		return await this._dispatch<HydratedVoxelData | null>();
	}

	async writeVoxel(key: bigint, lod: number, data: Uint8Array): Promise<void> {
		const { chunkX, chunkY, chunkZ } = this._unpackKey(key);
		const bytes = transferableBytes(data);
		_resetWire(OpfsMsg.WriteVoxel);
		_wireMsg.chunkX = chunkX;
		_wireMsg.chunkY = chunkY;
		_wireMsg.chunkZ = chunkZ;
		_wireMsg.lod = lod;
		_wireMsg.data = bytes;
		return await this._dispatch<void>([bytes.buffer]);
	}

	async removeVoxel(key: bigint, lod: number): Promise<void> {
		const { chunkX, chunkY, chunkZ } = this._unpackKey(key);
		_resetWire(OpfsMsg.RemoveVoxel);
		_wireMsg.chunkX = chunkX;
		_wireMsg.chunkY = chunkY;
		_wireMsg.chunkZ = chunkZ;
		_wireMsg.lod = lod;
		return await this._dispatch<void>();
	}

	// ── Batch flush ─────────────────────────────────────────────

	async flush(): Promise<void> {
		_resetWire(OpfsMsg.FlushVoxels);
		const a = this._dispatch<void>();
		_resetWire(OpfsMsg.FlushMeshes);
		const b = this._dispatch<void>();
		await Promise.all([a, b]);
	}

	async getStats(): Promise<{
		slotCount: number;
		usedBytes: number;
		totalBytes: number;
		capacity: number;
		hitCount: number;
		missCount: number;
		evictionCount: number;
	}> {
		_resetWire(OpfsMsg.GetStats);
		return await this._dispatch<{
			slotCount: number;
			usedBytes: number;
			totalBytes: number;
			capacity: number;
			hitCount: number;
			missCount: number;
			evictionCount: number;
		}>();
	}

	// ── Lifecycle ───────────────────────────────────────────────

	static async create(worldName: string): Promise<OpfsClient> {
		const client = new OpfsClient(worldName);
		await client.ready();
		return client;
	}

	async close(): Promise<void> {
		_resetWire(OpfsMsg.Close);
		await this._dispatch<void>();
		this._worker.terminate();
	}

	async clearWorld(): Promise<void> {
		_resetWire(OpfsMsg.ClearWorld);
		await this._dispatch<void>();
		this._worker.terminate();
	}

	/**
	 * Delete a world's OPFS directory (b102/worlds/<name>) after closing all
	 * open handles. Use this instead of clearWorld() to keep other worlds.
	 */
	async removeWorld(name: string): Promise<void> {
		_resetWire(OpfsMsg.RemoveWorld);
		_wireMsg.name = name;
		await this._dispatch<void>();
	}
}
