import { Chunk } from "./Chunk/Chunk";
import type { MeshData } from "./Chunk/DataStructures/MeshData";
import { getCurrentLodCacheVersion } from "./Chunk/LOD/LodCacheVersion";
import { GLOBAL_VALUES } from "./GLOBAL_VALUES";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SavedChunkData = {
	blocks: Uint8Array | Uint16Array | null;
	palette?: Uint16Array | null;
	uniformBlockId?: number;
	isUniform?: boolean;
	lightArray?: Uint8Array;
	opaqueMesh?: MeshData;
	transparentMesh?: MeshData;
	lodMeshes?: Record<
		number,
		{
			opaque?: MeshData | null;
			transparent?: MeshData | null;
		}
	>;
	lodCacheVersion?: string;
	compressed?: boolean;
};

export type LoadChunkOptions = {
	includeVoxelData?: boolean;
};

export type SavedChunkEntityData = {
	type: string;
	payload: unknown;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type PersistenceLane = "critical" | "background";

type PersistenceJob = {
	run: () => Promise<void>;
	resolve: () => void;
	reject: (reason?: unknown) => void;
};

type PreparedFullChunkSave = {
	id: string;
	chunk: Chunk;
	data: {
		id: string;
		blocks: Uint8Array | null;
		palette: Uint16Array | null;
		uniformBlockId: number;
		isUniform: boolean;
		lightArray: Uint8Array | null;
		opaqueMesh: MeshData | null;
		transparentMesh: MeshData | null;
		lodMeshes: SavedChunkData["lodMeshes"];
		lodCacheVersion: string;
		compressed: true;
	};
};

type PreparedLodOnlySave = {
	id: string;
	chunk: Chunk;
	opaqueMesh: MeshData | null;
	transparentMesh: MeshData | null;
	lodMeshes: SavedChunkData["lodMeshes"];
	lodCacheVersion: string;
};

// ---------------------------------------------------------------------------
// DB constants
// ---------------------------------------------------------------------------

const DB_NAME = "VoxelWorldDB";
const DB_VERSION = 2;
const CHUNK_STORE = "chunks";
const CHUNK_ENTITY_STORE = "chunk_entities";

// ---------------------------------------------------------------------------
// IDBHelper — thin promise wrappers around raw IndexedDB operations
// ---------------------------------------------------------------------------

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function idbTransaction(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onerror = () => {
			console.error("IndexedDB error:", request.error);
			reject(new Error("Failed to open IndexedDB."));
		};

		request.onsuccess = () => {
			console.log("IndexedDB initialized successfully.");
			resolve(request.result);
		};

		request.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;

			if (!db.objectStoreNames.contains(CHUNK_STORE)) {
				db.createObjectStore(CHUNK_STORE, { keyPath: "id" });
				console.log(`Object store '${CHUNK_STORE}' created.`);
			}

			if (!db.objectStoreNames.contains(CHUNK_ENTITY_STORE)) {
				db.createObjectStore(CHUNK_ENTITY_STORE, { keyPath: "chunkId" });
				console.log(`Object store '${CHUNK_ENTITY_STORE}' created.`);
			}
		};
	});
}

// ---------------------------------------------------------------------------
// ChunkSerializer — compression / decompression helpers
// ---------------------------------------------------------------------------

async function compress(data: Uint8Array | Uint16Array): Promise<Uint8Array> {
	// View raw bytes without copying. byteOffset/byteLength handle sliced arrays.
	const inputBytes = new Uint8Array(
		data.buffer,
		data.byteOffset,
		data.byteLength,
	);

	// Only copy when the source is a SharedArrayBuffer — the Streams API rejects SABs.
	const chunk =
		data.buffer instanceof SharedArrayBuffer
			? new Uint8Array(inputBytes)
			: inputBytes;

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});

	// Drain the compressed stream manually instead of going through Response.arrayBuffer().
	// Response buffers internally before handing back the ArrayBuffer, meaning the data
	// exists in memory twice at peak. Draining directly means only the output chunks
	// and the final concat are alive at the same time.
	const reader = readable
		.pipeThrough(
			new CompressionStream("gzip") as unknown as ReadableWritablePair<
				Uint8Array,
				Uint8Array
			>,
		)
		.getReader();

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalBytes += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	// Single allocation + single pass of memcpy to assemble the final buffer.
	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (const c of chunks) {
		result.set(c, offset);
		offset += c.byteLength;
	}
	return result;
}

function getGzipISize(data: Uint8Array): number {
	if (data.byteLength < 18) {
		throw new Error("Invalid gzip data: too small");
	}
	return (
		(data[data.byteLength - 4] |
			(data[data.byteLength - 3] << 8) |
			(data[data.byteLength - 2] << 16) |
			(data[data.byteLength - 1] << 24)) >>>
		0
	);
}

async function decompressToShared(
	data: Uint8Array,
): Promise<Uint8Array | Uint16Array> {
	const outputByteLength = getGzipISize(data);

	const body: Uint8Array<ArrayBuffer> =
		data.buffer instanceof ArrayBuffer
			? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
			: new Uint8Array(data);

	const sab = new SharedArrayBuffer(outputByteLength);
	const out = new Uint8Array(sab);

	const reader = new Response(body)
		.body!.pipeThrough(new DecompressionStream("gzip"))
		.getReader();

	let offset = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) {
				out.set(value, offset);
				offset += value.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}

	if (offset !== outputByteLength) {
		throw new Error(
			`Decompressed size mismatch: expected ${outputByteLength}, got ${offset}`,
		);
	}

	return sab.byteLength === Chunk.SIZE3 * 2
		? new Uint16Array(sab)
		: new Uint8Array(sab);
}

function isUint8Array(
	value: Uint8Array | Uint16Array | null | undefined,
): value is Uint8Array {
	return !!value && value.BYTES_PER_ELEMENT === 1;
}

async function prepareFullChunkSave(
	chunk: Chunk,
): Promise<PreparedFullChunkSave> {
	const id = chunk.id.toString();
	const blocks = chunk.block_array;
	const light = chunk.light_array;

	return {
		id,
		chunk,
		data: {
			id,
			blocks: blocks ? await compress(blocks) : null,
			palette: chunk.palette,
			uniformBlockId: chunk.uniformBlockId,
			isUniform: chunk.isUniform,
			lightArray: light ? await compress(light) : null,
			opaqueMesh: chunk.opaqueMeshData ?? null,
			transparentMesh: chunk.transparentMeshData ?? null,
			lodMeshes: chunk.getSerializableLODMeshCache(),
			lodCacheVersion: getCurrentLodCacheVersion(),
			compressed: true,
		},
	};
}

function prepareLodOnlySave(chunk: Chunk): PreparedLodOnlySave {
	return {
		id: chunk.id.toString(),
		chunk,
		opaqueMesh: chunk.opaqueMeshData ?? null,
		transparentMesh: chunk.transparentMeshData ?? null,
		lodMeshes: chunk.getSerializableLODMeshCache(),
		lodCacheVersion: getCurrentLodCacheVersion(),
	};
}

// ---------------------------------------------------------------------------
// PersistenceQueue — serialised job runner with critical / background lanes
// ---------------------------------------------------------------------------

class PersistenceQueue {
	private queues: Record<PersistenceLane, PersistenceJob[]> = {
		critical: [],
		background: [],
	};
	private isRunning = false;

	enqueue(lane: PersistenceLane, run: () => Promise<void>): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.queues[lane].push({ run, resolve, reject });
			this.drain();
		});
	}

	private drain(): void {
		if (this.isRunning) return;
		this.isRunning = true;

		const step = async () => {
			while (true) {
				const job =
					this.queues.critical.shift() ?? this.queues.background.shift();
				if (!job) break;

				try {
					await job.run();
					job.resolve();
				} catch (error) {
					job.reject(error);
				}
			}

			this.isRunning = false;

			if (
				this.queues.critical.length > 0 ||
				this.queues.background.length > 0
			) {
				this.drain();
			}
		};

		void step();
	}
}

// ---------------------------------------------------------------------------
// WorldStorage — public API
// ---------------------------------------------------------------------------

class WorldStorageImpl {
	private db: IDBDatabase | null = null;
	private initPromise: Promise<void> | null = null;

	private pendingChunkSaves = new Map<string, Promise<void>>();
	private pendingLodInvalidationIds = new Set<string>();
	private queue = new PersistenceQueue();

	// -------------------------------------------------------------------------
	// Initialisation
	// -------------------------------------------------------------------------

	initialize(): Promise<void> {
		if (this.initPromise) return this.initPromise;

		this.initPromise = openDatabase().then((db) => {
			this.db = db;
		});

		return this.initPromise;
	}

	private async ensureInitialized(): Promise<boolean> {
		if (this.db) return true;
		try {
			await this.initialize();
			return !!this.db;
		} catch (error) {
			console.warn("WorldStorage initialization failed.", error);
			return false;
		}
	}

	// -------------------------------------------------------------------------
	// Pending-save tracking
	// -------------------------------------------------------------------------

	private trackPendingChunkSaves(
		chunkIds: string[],
		savePromise: Promise<void>,
	): Promise<void> {
		// Register first so the finally closure captures the right reference,
		// then clean up only entries that still point at this promise.
		const tracked = savePromise.finally(() => {
			for (const id of chunkIds) {
				if (this.pendingChunkSaves.get(id) === tracked) {
					this.pendingChunkSaves.delete(id);
				}
			}
		});

		for (const id of chunkIds) {
			this.pendingChunkSaves.set(id, tracked);
		}

		return tracked;
	}

	private async awaitPendingChunkSaves(chunkIds: string[]): Promise<void> {
		// Collect distinct pending promises without building intermediate arrays.
		const seen = new Set<Promise<void>>();
		for (const id of chunkIds) {
			const p = this.pendingChunkSaves.get(id);
			if (p !== undefined) seen.add(p);
		}
		if (seen.size > 0) {
			await Promise.allSettled(seen);
		}
	}

	private enqueuePersistenceJob(
		lane: PersistenceLane,
		chunkIds: string[],
		run: () => Promise<void>,
	): Promise<void> {
		const savePromise = this.queue.enqueue(lane, run);
		return this.trackPendingChunkSaves(chunkIds, savePromise);
	}

	// -------------------------------------------------------------------------
	// Persist helpers
	// -------------------------------------------------------------------------

	private async persistFullChunks(
		prepared: PreparedFullChunkSave[],
	): Promise<void> {
		if (prepared.length === 0) return;

		const tx = this.db!.transaction(CHUNK_STORE, "readwrite");
		const store = tx.objectStore(CHUNK_STORE);

		for (const entry of prepared) {
			store.put(entry.data);
		}

		await idbTransaction(tx);

		for (const entry of prepared) {
			entry.chunk.isModified = false;
			entry.chunk.isLODMeshCacheDirty = false;
			entry.chunk.isLightDirty = false;
		}
	}

	private async persistLodOnlyChunks(
		prepared: PreparedLodOnlySave[],
	): Promise<void> {
		if (prepared.length === 0) return;

		const tx = this.db!.transaction(CHUNK_STORE, "readwrite");
		const store = tx.objectStore(CHUNK_STORE);
		const updatedChunks = new Set<Chunk>();

		for (const entry of prepared) {
			const existing = await idbRequest(store.get(entry.id));

			if (!existing) {
				// No base record yet — escalate to a full save on the next pass.
				entry.chunk.isModified = true;
				continue;
			}

			existing.opaqueMesh = entry.opaqueMesh;
			existing.transparentMesh = entry.transparentMesh;
			existing.lodMeshes = entry.lodMeshes;
			existing.lodCacheVersion = entry.lodCacheVersion;
			store.put(existing);
			updatedChunks.add(entry.chunk);
		}

		await idbTransaction(tx);

		for (const chunk of updatedChunks) {
			if (!chunk.isModified) {
				chunk.isLODMeshCacheDirty = false;
			}
		}
	}

	private async persistLodCacheInvalidation(
		chunkId: string,
		targetVersion: string,
	): Promise<void> {
		const tx = this.db!.transaction(CHUNK_STORE, "readwrite");
		const store = tx.objectStore(CHUNK_STORE);
		const existing = await idbRequest(store.get(chunkId));

		if (existing && existing.lodCacheVersion !== targetVersion) {
			existing.lodMeshes = undefined;
			existing.lodCacheVersion = targetVersion;
			store.put(existing);
		}

		await idbTransaction(tx);
	}

	// -------------------------------------------------------------------------
	// LOD cache version policy
	// -------------------------------------------------------------------------

	private applyLodCacheVersionPolicy(
		chunkId: string,
		data: SavedChunkData,
	): SavedChunkData {
		const currentVersion = getCurrentLodCacheVersion();
		if (data.lodCacheVersion === currentVersion) return data;

		data.lodMeshes = undefined;
		this.scheduleLodCacheInvalidation(chunkId, currentVersion);
		return data;
	}

	private scheduleLodCacheInvalidation(
		chunkId: string,
		targetVersion: string,
	): void {
		if (this.pendingLodInvalidationIds.has(chunkId)) return;

		this.pendingLodInvalidationIds.add(chunkId);

		const job = this.enqueuePersistenceJob("background", [chunkId], () =>
			this.persistLodCacheInvalidation(chunkId, targetVersion),
		);

		void job.finally(() => {
			this.pendingLodInvalidationIds.delete(chunkId);
		});
	}

	// -------------------------------------------------------------------------
	// Chunk decompression / post-processing
	// -------------------------------------------------------------------------

	private async processLoadedChunk(
		chunkId: bigint,
		data: SavedChunkData,
		options?: LoadChunkOptions,
	): Promise<SavedChunkData> {
		const chunkIdKey = chunkId.toString();
		const includeVoxelData = options?.includeVoxelData ?? true;

		if (data.compressed && includeVoxelData) {
			const jobs: Promise<void>[] = [];

			if (isUint8Array(data.blocks)) {
				jobs.push(
					decompressToShared(data.blocks).then((result) => {
						data.blocks = result;
					}),
				);
			}

			if (isUint8Array(data.lightArray)) {
				jobs.push(
					decompressToShared(data.lightArray).then((result) => {
						data.lightArray = result as Uint8Array;
					}),
				);
			}

			await Promise.all(jobs);
		} else if (!includeVoxelData) {
			data.blocks = null;
			data.palette = null;
			data.isUniform = undefined;
			data.uniformBlockId = undefined;
			data.lightArray = undefined;
		}

		return this.applyLodCacheVersionPolicy(chunkIdKey, data);
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	async saveChunk(chunk: Chunk): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;
		if (chunk.isPersistent || (!chunk.isModified && !chunk.isLODMeshCacheDirty))
			return;
		if (!(await this.ensureInitialized())) return;

		if (chunk.isModified || chunk.isLightDirty) {
			const prepared = await prepareFullChunkSave(chunk);
			await this.enqueuePersistenceJob("critical", [prepared.id], () =>
				this.persistFullChunks([prepared]),
			);
		} else {
			const prepared = prepareLodOnlySave(chunk);
			await this.enqueuePersistenceJob("background", [prepared.id], () =>
				this.persistLodOnlyChunks([prepared]),
			);
		}
	}

	async saveChunks(chunks: Chunk[]): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;

		// Single pass: partition into full-save vs lod-only, skip non-savable.
		const fullSave: Chunk[] = [];
		const lodOnly: Chunk[] = [];

		for (const c of chunks) {
			if (c.isPersistent) continue;
			if (c.isModified || c.isLightDirty) {
				fullSave.push(c);
			} else if (c.isLODMeshCacheDirty) {
				lodOnly.push(c);
			}
		}

		if (fullSave.length === 0 && lodOnly.length === 0) return;
		if (!(await this.ensureInitialized())) return;

		const lanePromises: Promise<void>[] = [];

		if (fullSave.length > 0) {
			// Compress up-front to capture data before async lane execution.
			const prepared = await Promise.all(fullSave.map(prepareFullChunkSave));
			const ids = prepared.map((e) => e.id);

			lanePromises.push(
				this.enqueuePersistenceJob("critical", ids, () =>
					this.persistFullChunks(prepared),
				),
			);
		}

		if (lodOnly.length > 0) {
			const prepared = lodOnly.map(prepareLodOnlySave);
			const ids = prepared.map((e) => e.id);

			lanePromises.push(
				this.enqueuePersistenceJob("background", ids, () =>
					this.persistLodOnlyChunks(prepared),
				),
			);
		}

		await Promise.all(lanePromises);
	}

	async saveAllModifiedChunks(): Promise<void> {
		const modified: Chunk[] = [];

		for (const chunk of Chunk.chunkInstances.values()) {
			if (chunk.needsPersistence() && !chunk.isPersistent) {
				modified.push(chunk);
			}
		}

		if (modified.length > 0) {
			await this.saveChunks(modified);
		}
	}

	async saveChunkEntities(
		chunkId: bigint,
		entities: SavedChunkEntityData[],
	): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;
		if (!(await this.ensureInitialized())) return;

		const key = chunkId.toString();
		const tx = this.db!.transaction(CHUNK_ENTITY_STORE, "readwrite");
		const store = tx.objectStore(CHUNK_ENTITY_STORE);

		if (entities.length === 0) {
			store.delete(key);
		} else {
			store.put({ chunkId: key, entities });
		}

		return this.trackPendingChunkSaves([key], idbTransaction(tx));
	}

	async loadChunkEntities(chunkId: bigint): Promise<SavedChunkEntityData[]> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING) return [];
		if (!(await this.ensureInitialized())) return [];

		const key = chunkId.toString();
		await this.awaitPendingChunkSaves([key]);

		const tx = this.db!.transaction(CHUNK_ENTITY_STORE, "readonly");
		const store = tx.objectStore(CHUNK_ENTITY_STORE);
		const result = await idbRequest(store.get(key));
		const entities = result?.entities as SavedChunkEntityData[] | undefined;
		return Array.isArray(entities) ? entities : [];
	}

	async loadChunk(
		chunkId: bigint,
		options?: LoadChunkOptions,
	): Promise<SavedChunkData | null> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING) return null;

		if (!(await this.ensureInitialized())) {
			console.warn("DB not initialized, cannot load chunk.");
			return null;
		}

		const key = chunkId.toString();
		await this.awaitPendingChunkSaves([key]);

		const tx = this.db!.transaction(CHUNK_STORE, "readonly");
		const data = await idbRequest(tx.objectStore(CHUNK_STORE).get(key));

		if (!data) return null;
		return this.processLoadedChunk(chunkId, data, options);
	}

	private static readonly CONCURRENCY = Math.max(
		1,
		Math.min(4, Math.floor(navigator.hardwareConcurrency || 4)),
	);

	async loadChunks(
		chunkIds: bigint[],
		options?: LoadChunkOptions,
	): Promise<Map<bigint, SavedChunkData>> {
		const result = new Map<bigint, SavedChunkData>();

		if (
			GLOBAL_VALUES.DISABLE_CHUNK_LOADING ||
			chunkIds.length === 0 ||
			!(await this.ensureInitialized())
		) {
			return result;
		}

		// Await pending saves without allocating a separate string array.
		const seen = new Set<Promise<void>>();
		for (const id of chunkIds) {
			const p = this.pendingChunkSaves.get(id.toString());
			if (p !== undefined) seen.add(p);
		}
		if (seen.size > 0) await Promise.allSettled(seen);

		const tx = this.db!.transaction(CHUNK_STORE, "readonly");
		const store = tx.objectStore(CHUNK_STORE);

		// Fetch all records in parallel, keeping only hits.
		type Hit = { chunkId: bigint; data: SavedChunkData };
		const hits: Hit[] = [];

		await Promise.all(
			chunkIds.map(async (chunkId) => {
				const data = await idbRequest<SavedChunkData | undefined>(
					store.get(chunkId.toString()),
				);
				if (data !== undefined && data !== null) {
					hits.push({ chunkId, data });
				}
			}),
		);

		// Process in batches without slice — track window with indices.
		for (let i = 0; i < hits.length; i += WorldStorageImpl.CONCURRENCY) {
			const end = Math.min(i + WorldStorageImpl.CONCURRENCY, hits.length);
			const batch: Promise<void>[] = [];

			for (let j = i; j < end; j++) {
				const { chunkId, data } = hits[j];
				batch.push(
					this.processLoadedChunk(chunkId, data, options).then((processed) => {
						result.set(chunkId, processed);
					}),
				);
			}

			await Promise.all(batch);
		}

		return result;
	}

	async clearWorldData(): Promise<void> {
		this.db?.close();

		return new Promise((resolve, reject) => {
			const request = indexedDB.deleteDatabase(DB_NAME);

			request.onsuccess = () => {
				console.log("World data cleared.");
				resolve();
			};

			request.onerror = () => {
				console.error("Failed to clear world data:", request.error);
				reject(request.error);
			};

			request.onblocked = () => {
				console.warn("Delete database blocked.");
			};
		});
	}
}

// Singleton export — matches the original static-class usage surface.
export const WorldStorage = new WorldStorageImpl();
