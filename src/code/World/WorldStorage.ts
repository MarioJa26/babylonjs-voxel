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

class WorldStorageImpl {
	private initPromise: Promise<void> | null = null;

	initialize(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
			try {
				await this.clearOldOpfsData();
			} catch (err) {
				console.warn("[WorldStorage] OPFS clear failed:", err);
			}
		})();
		return this.initPromise;
	}

	private async getClient(): Promise<OpfsClient | null> {
		await this.initialize();
		const pool = ChunkWorkerPool.getInstance();
		return pool.getOpfsClient();
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
		const result = new Uint8Array(totalBytes);
		let offset = 0;
		for (const c of chunks) {
			result.set(c, offset);
			offset += c.byteLength;
		}
		return result;
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

	async saveChunks(chunks: Chunk[]): Promise<void> {
		if (GLOBAL_VALUES.DISABLE_CHUNK_SAVING) return;

		const toSave: Chunk[] = [];
		for (const c of chunks) {
			if (c.isBoatChunk) continue;
			if (c.isModified || c.isLightDirty) {
				toSave.push(c);
			}
		}
		if (toSave.length === 0) return;

		const client = await this.getClient();
		if (!client) return;

		await Promise.all(toSave.map((chunk) => this.saveChunk(chunk)));
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

	async loadChunks(
		chunkIds: bigint[],
		options?: LoadChunkOptions,
	): Promise<Map<bigint, SavedChunkData>> {
		const result = new Map<bigint, SavedChunkData>();
		if (GLOBAL_VALUES.DISABLE_CHUNK_LOADING || chunkIds.length === 0) {
			return result;
		}

		const client = await this.getClient();
		if (!client) return result;

		const hits: { chunkId: bigint; data: SavedChunkData }[] = [];
		const fetches = chunkIds.map(async (chunkId) => {
			try {
				const bytes = await client.readVoxel(chunkId, VOXEL_SENTINEL);
				if (!bytes) return;
				const raw = deserializeVoxelData(bytes);
				hits.push({ chunkId, data: raw });
			} catch {}
		});
		await Promise.all(fetches);

		const CONCURRENCY = Math.max(
			1,
			Math.min(4, Math.floor(navigator.hardwareConcurrency || 4)),
		);
		for (let i = 0; i < hits.length; i += CONCURRENCY) {
			const end = Math.min(i + CONCURRENCY, hits.length);
			const batch: Promise<void>[] = [];
			for (let j = i; j < end; j++) {
				const { chunkId, data } = hits[j];
				const includeVoxelData = options?.includeVoxelData ?? true;
				if (data.compressed && includeVoxelData) {
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
					batch.push(
						Promise.all(jobs).then(() => {
							result.set(chunkId, data);
						}),
					);
				} else if (!includeVoxelData) {
					data.blocks = null;
					data.palette = null;
					data.isUniform = undefined;
					data.uniformBlockId = undefined;
					data.lightArray = undefined;
					result.set(chunkId, data);
				} else {
					result.set(chunkId, data);
				}
			}
			await Promise.all(batch);
		}

		return result;
	}

	async clearWorldData(): Promise<void> {
		try {
			const root = await navigator.storage.getDirectory();
			const dirHandle = await root.getDirectoryHandle("b102");
			await dirHandle.removeEntry("meshes.bin");
			await dirHandle.removeEntry("regions", { recursive: true });
		} catch (err) {
			console.error("[WorldStorage] Failed to clear world data:", err);
		}
	}

	private async clearOldOpfsData(): Promise<void> {
		const FLAG = "b102_opfs_v2_cleared";
		if (localStorage.getItem(FLAG)) return;

		const root = await navigator.storage.getDirectory();
		let dirHandle: FileSystemDirectoryHandle;
		try {
			dirHandle = await root.getDirectoryHandle("b102");
		} catch {
			localStorage.setItem(FLAG, "1");
			return;
		}
		try {
			await dirHandle.removeEntry("voxels.bin");
		} catch {}
		try {
			await dirHandle.removeEntry("regions", { recursive: true });
		} catch {}
		try {
			await dirHandle.removeEntry("meshes.bin");
		} catch {}

		localStorage.setItem(FLAG, "1");
	}
}

export const WorldStorage = new WorldStorageImpl();
