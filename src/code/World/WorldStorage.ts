import { Chunk } from "./Chunk/Chunk";
import { ChunkWorkerPool } from "./Chunk/ChunkWorkerPool";
import { GLOBAL_VALUES } from "./GLOBAL_VALUES";
import { packChunkKey } from "./Storage/ChunkKey";
import type { OpfsClient } from "./Storage/OpfsClient";
import {
	deserializeEntities,
	deserializeVoxelData,
	type SavedChunkData,
	type SavedChunkEntityData,
	serializeEntities,
	serializeVoxelData,
} from "./Storage/VoxelSerializer";

export type { SavedChunkData, SavedChunkEntityData };

export type LoadChunkOptions = {
	includeVoxelData?: boolean;
};

const VOXEL_SENTINEL = 255;
const ENTITY_SENTINEL = 254;

// PERF: gzip's worst-case expansion on already-small, already-typed voxel/
// light buffers is a handful of stored-block headers (~5 bytes per 64KB) plus
// the fixed 18-byte gzip header/trailer. 512 bytes of headroom on top of the
// uncompressed input size is generous and means the common case never grows
// the output buffer at all.
const GZIP_SAFETY_MARGIN = 512;

/**
 * PERF: doubling-growth helper shared by compress()'s output accumulator.
 * Only exercised if a chunk's compressed output somehow exceeds the safety
 * margin above (should not happen in practice for voxel/light payloads).
 */
function ensureCapacity(
	buf: Uint8Array<ArrayBufferLike>,
	needed: number,
): Uint8Array<ArrayBufferLike> {
	if (buf.length >= needed) return buf;
	let newLen = buf.length * 2;
	while (newLen < needed) newLen *= 2;
	const grown = new Uint8Array(newLen);
	grown.set(buf);
	return grown;
}

class WorldStorageImpl {
	private initPromise: Promise<void> | null = null;

	initialize(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
			/*
			try {
				await this.clearOldOpfsData();
			} catch (err) {
				console.warn("[WorldStorage] OPFS clear failed:", err);
			}
				*/
		})();
		return this.initPromise;
	}

	private async getClient(): Promise<OpfsClient | null> {
		await this.initialize();
		const pool = ChunkWorkerPool.getInstance();
		return await pool.ensureOpfsReady();
	}

	// -------------------------------------------------------------------------
	// Compression helpers (kept from old WorldStorage)
	// -------------------------------------------------------------------------

	private async compress(data: Uint8Array | Uint16Array): Promise<Uint8Array> {
		const inputBytes = new Uint8Array(
			data.buffer,
			data.byteOffset,
			data.byteLength,
		);
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
		const reader = readable
			.pipeThrough(
				new CompressionStream("gzip") as unknown as ReadableWritablePair<
					Uint8Array,
					Uint8Array
				>,
			)
			.getReader();

		// PERF: pre-size the output buffer instead of accumulating an array of
		// stream chunks and doing a second full copy pass to merge them
		// afterward (mirrors the pre-sized approach decompressToShared already
		// uses via the gzip trailer's ISIZE field — compression can't know its
		// exact output size ahead of time, but a generous upper bound avoids
		// the common-case growth/copy entirely).
		let outBuf: Uint8Array<ArrayBufferLike> = new Uint8Array(
			inputBytes.byteLength + GZIP_SAFETY_MARGIN,
		);
		let offset = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (offset + value.byteLength > outBuf.length) {
					outBuf = ensureCapacity(outBuf, offset + value.byteLength);
				}
				outBuf.set(value, offset);
				offset += value.byteLength;
			}
		} finally {
			reader.releaseLock();
		}
		return offset === outBuf.length ? outBuf : outBuf.slice(0, offset);
	}

	private async decompressToShared(
		data: Uint8Array,
	): Promise<Uint8Array | Uint16Array> {
		const outputByteLength = this.getGzipISize(data);
		const body: Uint8Array<ArrayBuffer> =
			data.buffer instanceof ArrayBuffer
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
				: new Uint8Array(data);
		const sab = new SharedArrayBuffer(outputByteLength);
		const out = new Uint8Array(sab);

		// PERF: was `new Response(body).body!.pipeThrough(...)`. Constructing a
		// full Response just to obtain a ReadableStream pulls in Fetch API
		// object/header machinery for what is really "wrap this Uint8Array in a
		// stream" — the same lightweight construction compress() already uses
		// above does the same job without it.
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(body);
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

	private getGzipISize(data: Uint8Array): number {
		if (data.byteLength < 18) throw new Error("Invalid gzip data: too small");
		return (
			(data[data.byteLength - 4] |
				(data[data.byteLength - 3] << 8) |
				(data[data.byteLength - 2] << 16) |
				(data[data.byteLength - 1] << 24)) >>>
			0
		);
	}

	private isUint8Array(
		value: Uint8Array | Uint16Array | null | undefined,
	): value is Uint8Array {
		return !!value && value.BYTES_PER_ELEMENT === 1;
	}

	private detachSharedArrayBuffer<T extends ArrayBufferView>(view: T): T {
		if (!view || !(view.buffer instanceof SharedArrayBuffer)) return view;
		if (view instanceof Uint16Array) {
			const copy = new Uint16Array(view.length);
			copy.set(view);
			return copy as unknown as T;
		}
		if (view instanceof Uint8Array) {
			const copy = new Uint8Array(view.length);
			copy.set(view);
			return copy as unknown as T;
		}
		const copy = new Uint8Array(view.byteLength);
		copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
		return copy as unknown as T;
	}

	private packKey(chunkX: number, chunkY: number, chunkZ: number): bigint {
		return packChunkKey(chunkX, chunkY, chunkZ);
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	async saveChunk(chunk: Chunk): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;
		if (chunk.isBoatChunk) return;
		if (!chunk.isModified && !chunk.isLightDirty) return;

		const client = await this.getClient();
		if (!client) return;

		await this.saveChunkWithClient(client, chunk);
	}

	async saveChunks(chunks: Chunk[]): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;

		const toSave: Chunk[] = [];

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (chunk.isBoatChunk) continue;
			if (chunk.isModified || chunk.isLightDirty) {
				toSave.push(chunk);
			}
		}

		if (toSave.length === 0) return;

		const client = await this.getClient();
		if (!client) return;

		const concurrency = Math.max(
			1,
			Math.min(4, Math.floor(navigator.hardwareConcurrency || 4)),
		);

		await mapLimit(toSave, concurrency, async (chunk) => {
			await this.saveChunkWithClient(client, chunk);
		});

		await client.flush();
	}

	async saveAllModifiedChunks(): Promise<void> {
		const modified: Chunk[] = [];
		for (const chunk of Chunk.chunkInstances.values()) {
			if (chunk.needsPersistence() && !chunk.isBoatChunk) {
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

		const client = await this.getClient();
		if (!client) return;

		if (entities.length === 0) {
			try {
				await client.removeVoxel(chunkId, ENTITY_SENTINEL);
			} catch {}
		} else {
			const bytes = serializeEntities(entities);
			try {
				await client.writeVoxel(chunkId, ENTITY_SENTINEL, bytes);
			} catch (err) {
				console.error("[WorldStorage] Entity write failed:", err);
			}
		}
	}

	async loadChunkEntities(chunkId: bigint): Promise<SavedChunkEntityData[]> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING) return [];
		const client = await this.getClient();
		if (!client) return [];

		try {
			const bytes = await client.readVoxel(chunkId, ENTITY_SENTINEL);
			if (!bytes) return [];
			return deserializeEntities(bytes);
		} catch {
			return [];
		}
	}

	async loadChunk(
		chunkId: bigint,
		options?: LoadChunkOptions,
	): Promise<SavedChunkData | null> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING) return null;

		const client = await this.getClient();
		if (!client) return null;

		try {
			const bytes = await client.readVoxel(chunkId, VOXEL_SENTINEL);
			if (!bytes) return null;
			const data = deserializeVoxelData(bytes);
			const includeVoxelData = options?.includeVoxelData ?? true;

			if (data.compressed && includeVoxelData) {
				const jobs: Promise<void>[] = [];
				if (this.isUint8Array(data.blocks)) {
					jobs.push(
						this.decompressToShared(data.blocks).then((result) => {
							data.blocks = result;
						}),
					);
				}
				if (this.isUint8Array(data.lightArray)) {
					jobs.push(
						this.decompressToShared(data.lightArray).then((result) => {
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
			return data;
		} catch (err) {
			console.warn("[WorldStorage] OPFS voxel read failed:", err);
			return null;
		}
	}

	/**
	 * PERF: accepts an optional pre-existing map to populate in place. Callers
	 * that maintain a reusable scratch map (e.g. ChunkProcessScheduler's
	 * per-slice near/far/hydrate maps) can pass it in directly instead of
	 * receiving a freshly allocated Map every call and copying entries out of
	 * it — this method does not clear outMap itself, so the caller is
	 * responsible for clearing it beforehand if overwrite (rather than merge)
	 * semantics are wanted.
	 */
	async loadChunks(
		chunkIds: bigint[],
		options?: LoadChunkOptions,
		outMap?: Map<bigint, SavedChunkData>,
	): Promise<Map<bigint, SavedChunkData>> {
		const result = outMap ?? new Map<bigint, SavedChunkData>();

		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING || chunkIds.length === 0) {
			return result;
		}

		const client = await this.getClient();
		if (!client) return result;

		const includeVoxelData = options?.includeVoxelData ?? true;
		const hits: { chunkId: bigint; data: SavedChunkData }[] = [];

		const hardwareConcurrency = Math.floor(navigator.hardwareConcurrency || 4);

		const readConcurrency = Math.max(2, Math.min(16, hardwareConcurrency * 2));

		await mapLimit(chunkIds, readConcurrency, async (chunkId) => {
			try {
				const bytes = await client.readVoxel(chunkId, VOXEL_SENTINEL);
				if (!bytes) return;

				const raw = deserializeVoxelData(bytes);
				hits.push({ chunkId, data: raw });
			} catch (err) {
				console.warn(
					`[WorldStorage] Failed to read chunk ${chunkId.toString()}, ${err}`,
				);
			}
		});

		if (hits.length === 0) return result;

		if (!includeVoxelData) {
			for (let i = 0; i < hits.length; i++) {
				const { chunkId, data } = hits[i];

				data.blocks = null;
				data.palette = null;
				data.isUniform = undefined;
				data.uniformBlockId = undefined;
				data.lightArray = undefined;

				result.set(chunkId, data);
			}

			return result;
		}

		const decompressConcurrency = Math.max(1, Math.min(4, hardwareConcurrency));

		await mapLimit(hits, decompressConcurrency, async ({ chunkId, data }) => {
			if (data.compressed) {
				const jobs: Promise<void>[] = [];

				if (this.isUint8Array(data.blocks)) {
					jobs.push(
						this.decompressToShared(data.blocks).then((r) => {
							data.blocks = r;
						}),
					);
				}

				if (this.isUint8Array(data.lightArray)) {
					jobs.push(
						this.decompressToShared(data.lightArray).then((r) => {
							data.lightArray = r as Uint8Array;
						}),
					);
				}

				if (jobs.length > 0) {
					await Promise.all(jobs);
				}
			}

			result.set(chunkId, data);
		});

		return result;
	}

	async clearWorldData(): Promise<void> {
		if ("storage" in navigator && "getDirectory" in navigator.storage) {
			const root = await navigator.storage.getDirectory();
			for await (const entry of root.values()) {
				await root.removeEntry(entry.name, { recursive: true });
			}
		}
	}
	private async saveChunkWithClient(
		client: OpfsClient,
		chunk: Chunk,
	): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;
		if (chunk.isBoatChunk) return;
		if (!chunk.isModified && !chunk.isLightDirty) return;

		const key = this.packKey(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
		const blocks = chunk.block_array;
		const light = chunk.light_array;

		const [compressedBlocks, compressedLight] = await Promise.all([
			blocks ? this.compress(blocks) : Promise.resolve(null),
			light ? this.compress(light) : Promise.resolve(null),
		]);

		const bytes = serializeVoxelData(
			compressedBlocks,
			chunk.palette ? this.detachSharedArrayBuffer(chunk.palette) : null,
			chunk.isUniform,
			chunk.uniformBlockId,
			compressedLight,
			true,
		);

		try {
			await client.writeVoxel(key, VOXEL_SENTINEL, bytes);
			chunk.isModified = false;
			chunk.isLightDirty = false;
		} catch (err) {
			console.error("[WorldStorage] OPFS voxel write failed:", err);
		}
	}
}
async function mapLimit<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;

	let nextIndex = 0;
	const workerCount = Math.min(limit, items.length);

	const workers = new Array<Promise<void>>(workerCount);

	for (let worker = 0; worker < workerCount; worker++) {
		workers[worker] = (async () => {
			while (true) {
				const index = nextIndex++;
				if (index >= items.length) return;
				await fn(items[index], index);
			}
		})();
	}

	await Promise.all(workers);
}
export const WorldStorage = new WorldStorageImpl();
