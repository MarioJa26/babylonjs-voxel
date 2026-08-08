/**
 * ServerWorldStorage — LevelDB-backed chunk storage for the server.
 *
 * Stores full chunk data (blocks + light) using the same VoxelSerializer
 * blob format as singleplayer. On startup, the server checks stored chunks
 * first before generating new ones — terrain persists across restarts.
 *
 * Replaces the old flat JSON edit-log approach. Block edits are now saved
 * as full chunk snapshots, so changing the server.properties seed requires
 * manually deleting the world folder (server-data/worlds/<name>/db/).
 */
import { LevelDbChunkStore } from "@/code/World/Storage/LevelDbChunkStore";
import {
	deserializeVoxelData,
	serializeVoxelData,
} from "@/code/World/Storage/VoxelSerializer";
import { hashChunk } from "../protocol/encoder.ts";

export interface StoredChunkData {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	hash: number;
}

export class ServerWorldStorage {
	private store: LevelDbChunkStore;
	private dirtyChunks = new Set<string>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushPending = false;
	private seed: string;

	constructor(worldName: string, seed: string, basePath = "./server-data") {
		this.seed = seed;
		this.store = new LevelDbChunkStore(worldName, basePath);
	}

	async init(): Promise<void> {
		await this.store.open();
		await this.store.setMeta("seed", this.seed);
		await this.store.setMeta("version", "1");
	}

	async dispose(): Promise<void> {
		await this.store.close();
	}

	/**
	 * Read a chunk from storage. Returns null if not found (needs generation).
	 */
	async readChunk(
		cx: number,
		cy: number,
		cz: number,
	): Promise<StoredChunkData | null> {
		const blob = await this.store.readChunk(cx, cy, cz);
		if (!blob) return null;

		const deserialized = deserializeVoxelData(blob);
		const rawBlocks = deserialized.blocks;
		const blocksU8 =
			rawBlocks instanceof Uint8Array
				? rawBlocks
				: rawBlocks
					? new Uint8Array(
							rawBlocks.buffer,
							rawBlocks.byteOffset,
							rawBlocks.byteLength,
						)
					: new Uint8Array(0);
		const light = deserialized.lightArray;
		const lightU8 = light ? new Uint8Array(light) : new Uint8Array(0);
		const hash = hashChunk(
			blocksU8,
			lightU8,
			deserialized.palette ? Array.from(deserialized.palette) : undefined,
		);

		return {
			chunkX: cx,
			chunkY: cy,
			chunkZ: cz,
			blocks:
				deserialized.blocks instanceof Uint8Array
					? deserialized.blocks
					: new Uint8Array(0),
			light: deserialized.lightArray ?? new Uint8Array(0),
			palette: deserialized.palette
				? Array.from(deserialized.palette)
				: undefined,
			isUniform: deserialized.isUniform ?? false,
			uniformBlockId: deserialized.uniformBlockId ?? 0,
			hash,
		};
	}

	/**
	 * Write a chunk to storage (debounced). Call flush() to persist immediately.
	 */
	writeChunk(data: {
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		blocks: Uint8Array;
		light: Uint8Array;
		palette?: number[];
		isUniform: boolean;
		uniformBlockId: number;
	}): void {
		// Don't pre-compress — LevelDB compresses with Snappy internally.
		const blob = serializeVoxelData(
			data.blocks,
			data.palette ? Uint16Array.from(data.palette) : null,
			data.isUniform,
			data.uniformBlockId,
			data.light,
			false,
		);
		this.store.writeChunk(data.chunkX, data.chunkY, data.chunkZ, blob);

		const key = `${data.chunkX},${data.chunkY},${data.chunkZ}`;
		this.dirtyChunks.add(key);
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushPending) return;
		this.flushPending = true;
		this.flushTimer = setTimeout(() => {
			void this.doFlush();
		}, 500);
	}

	private async doFlush(): Promise<void> {
		this.flushPending = false;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.dirtyChunks.clear();
		await this.store.flush();
	}

	/**
	 * Immediately flush all pending writes.
	 */
	async flush(): Promise<void> {
		await this.doFlush();
	}

	get pendingWrites(): number {
		return this.dirtyChunks.size;
	}
}
