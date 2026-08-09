/**
 * ChunkGenerationService — server-side terrain generation.
 *
 * Uses a worker thread pool for parallel chunk generation, request
 * deduplication to avoid duplicate work, and batch dispatch for efficiency.
 *
 * After generation, chunks are persisted to LevelDB storage so they can be
 * served from disk on subsequent requests (no regeneration needed).
 */

import {
	packChunkKeyFast,
	unpackChunkKeyFast,
} from "@/code/World/Storage/ChunkKey.ts";
import { hashChunk } from "@/code/Network/protocol/encoder.ts";
import { ChunkWorkerPool } from "../workers/ChunkWorkerPool.ts";
import { compressBlocks } from "./ChunkCompression.ts";
import type { ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface ChunkData {
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

interface RawChunkResult {
	blocks: Uint8Array;
	light: Uint8Array;
}

export class ChunkGenerationService {
	private pool = new ChunkWorkerPool();
	private seed = "default";
	private initPromise: Promise<void> | null = null;
	// Keyed by packChunkKey(cx,cy,cz) — a single number instead of the
	// template-literal string this used to build ("cx,cy,cz") on every
	// generate/dedup check. Purely internal to this map, no external coupling.
	private dedupMap = new Map<number, Promise<ChunkData>>();
	private storage: ServerWorldStorage | null = null;
	private wasmEnabled = true;

	setSeed(seed: string, wasmEnabled = true): void {
		if (seed === this.seed && this.initPromise) return;
		this.seed = seed;
		this.initPromise = null;
		this.dedupMap.clear();
		this.wasmEnabled = wasmEnabled;
	}

	private async ensurePool(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.pool.initialize(this.seed, this.wasmEnabled);
		return this.initPromise;
	}

	async generateChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkData> {
		const key = packChunkKeyFast(chunkX, chunkY, chunkZ);

		const existing = this.dedupMap.get(key);
		if (existing) return existing;

		const promise = this._doGenerate(chunkX, chunkY, chunkZ);
		this.dedupMap.set(key, promise);

		try {
			return await promise;
		} finally {
			this.dedupMap.delete(key);
		}
	}

	private async _doGenerate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkData> {
		await this.ensurePool();
		const raw = await this.pool.dispatch(chunkX, chunkY, chunkZ);
		const data = this.finalizeChunk(chunkX, chunkY, chunkZ, raw);
		await this.saveChunk(data);
		return data;
	}

	async generateChunksBatch(
		coords: Array<{ chunkX: number; chunkY: number; chunkZ: number }>,
	): Promise<ChunkData[]> {
		await this.ensurePool();

		const results: ChunkData[] = new Array(coords.length);
		const dedupHits: Array<{ index: number; promise: Promise<ChunkData> }> = [];
		const toFetch: Array<{
			index: number;
			cx: number;
			cy: number;
			cz: number;
		}> = [];

		for (let i = 0; i < coords.length; i++) {
			const { chunkX: cx, chunkY: cy, chunkZ: cz } = coords[i];
			const key = packChunkKeyFast(cx, cy, cz);

			const existing = this.dedupMap.get(key);
			if (existing) {
				dedupHits.push({ index: i, promise: existing });
				continue;
			}

			toFetch.push({ index: i, cx, cy, cz });
		}

		// Resolve dedup hits in parallel (they may already be in flight).
		await Promise.all(
			dedupHits.map((hit) =>
				hit.promise.then((data) => {
					results[hit.index] = data;
				}),
			),
		);

		if (toFetch.length > 0) {
			const batchResults = await this.pool.dispatchAll(
				toFetch.map((t) => ({ chunkX: t.cx, chunkY: t.cy, chunkZ: t.cz })),
			);

			// Finalize all chunks (CPU work, but fast compared to generation)
			const finalized = new Array(toFetch.length);
			for (let i = 0; i < toFetch.length; i++) {
				finalized[i] = this.finalizeChunk(
					toFetch[i].cx,
					toFetch[i].cy,
					toFetch[i].cz,
					batchResults[i],
				);
			}

			// Save all chunks in parallel (I/O bound)
			await Promise.all(finalized.map((data) => this.saveChunk(data)));

			for (let i = 0; i < toFetch.length; i++) {
				results[toFetch[i].index] = finalized[i];
			}
		}

		return results;
	}

	private finalizeChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		raw: RawChunkResult,
	): ChunkData {
		const { blocks, light } = raw;
		const compressed = compressBlocks(blocks);
		const hash = hashChunk(compressed.data, light, compressed.palette);

		return {
			chunkX,
			chunkY,
			chunkZ,
			blocks: compressed.data,
			light,
			palette: compressed.palette,
			isUniform: compressed.isUniform,
			uniformBlockId: compressed.uniformBlockId,
			hash,
		};
	}

	/**
	 * Attach a storage backend. After generation, chunks are saved here.
	 */
	setStorage(storage: ServerWorldStorage | null): void {
		this.storage = storage;
	}

	private async saveChunk(data: ChunkData): Promise<void> {
		if (!this.storage) return;
		this.storage.writeChunk(data);
	}

	async terminate(): Promise<void> {
		await this.pool.terminate();
		this.dedupMap.clear();
		this.initPromise = null;
	}
}
