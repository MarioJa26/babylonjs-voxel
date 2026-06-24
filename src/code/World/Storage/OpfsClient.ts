// ---------------------------------------------------------------------------
// OpfsClient — Thin main-thread proxy for opfs.worker.ts.
// All OPFS operations run inside a single Web Worker so no locks are held
// on the main thread.  Both meshes (evictable LRU) and voxels (persistent
// region files) are handled by the worker.
// ---------------------------------------------------------------------------

import { OpfsMsg } from "./OpfsMessageTypes";

const _packScratch = { hi: 0, lo: 0 };
const MAX_INFLIGHT = 1024;

if ((MAX_INFLIGHT & (MAX_INFLIGHT - 1)) !== 0) {
	throw new Error("MAX_INFLIGHT must be a power of two");
}

function transferableBytes(data: Uint8Array): Uint8Array {
	if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
		return data;
	}
	return data.slice();
}

export class OpfsClient {
	private _worker: Worker;
	private _opResolves: (((v: any) => void) | null)[];
	private _opRejects: (((e: any) => void) | null)[];
	private _nextId = 1;
	private _ready: Promise<void>;

	constructor() {
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
			this._worker.postMessage({ type: OpfsMsg.Ping });
		});
	}

	async ready(): Promise<void> {
		await this._ready;
	}

	private _postMessage(
		type: OpfsMsg,
		payload: Record<string, any> = {},
		transfer: Transferable[] = [],
	): Promise<any> {
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
			this._worker.postMessage({ id, type, ...payload }, transfer);
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
		const AXIS_BITS = 21n;
		const AXIS_MASK = (1n << AXIS_BITS) - 1n;
		const AXIS_BIAS = 1n << (AXIS_BITS - 1n);
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
		return await this._postMessage(OpfsMsg.ReadMesh, {
			keyHi: hi,
			keyLo: lo,
			lod,
		});
	}

	async writeMesh(key: bigint, lod: number, data: Uint8Array): Promise<void> {
		const { hi, lo } = this._packKey(key);
		const bytes = transferableBytes(data);
		await this._postMessage(
			OpfsMsg.WriteMesh,
			{ keyHi: hi, keyLo: lo, lod, data: bytes },
			[bytes.buffer],
		);
	}

	async removeMesh(key: bigint, lod: number): Promise<boolean> {
		const { hi, lo } = this._packKey(key);
		return await this._postMessage(OpfsMsg.RemoveMesh, {
			keyHi: hi,
			keyLo: lo,
			lod,
		});
	}

	// ── Voxel storage (persistent region files) ────────────────

	async readVoxel(key: bigint, lod: number): Promise<Uint8Array | null> {
		const { chunkX, chunkY, chunkZ } = this._unpackKey(key);
		return await this._postMessage(OpfsMsg.ReadVoxel, {
			chunkX,
			chunkY,
			chunkZ,
			lod,
		});
	}

	async writeVoxel(key: bigint, lod: number, data: Uint8Array): Promise<void> {
		const { chunkX, chunkY, chunkZ } = this._unpackKey(key);
		const bytes = transferableBytes(data);
		await this._postMessage(
			OpfsMsg.WriteVoxel,
			{
				chunkX,
				chunkY,
				chunkZ,
				lod,
				data: bytes,
			},
			[bytes.buffer],
		);
	}

	async removeVoxel(key: bigint, lod: number): Promise<void> {
		const { chunkX, chunkY, chunkZ } = this._unpackKey(key);
		await this._postMessage(OpfsMsg.RemoveVoxel, {
			chunkX,
			chunkY,
			chunkZ,
			lod,
		});
	}

	// ── Batch flush ─────────────────────────────────────────────

	async flush(): Promise<void> {
		await Promise.all([
			this._postMessage(OpfsMsg.FlushVoxels),
			this._postMessage(OpfsMsg.FlushMeshes),
		]);
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
		return await this._postMessage(OpfsMsg.GetStats);
	}

	// ── Lifecycle ───────────────────────────────────────────────

	static async create(): Promise<OpfsClient> {
		const client = new OpfsClient();
		await client.ready();
		return client;
	}

	async close(): Promise<void> {
		await this._postMessage(OpfsMsg.Close);
		this._worker.terminate();
	}
}
