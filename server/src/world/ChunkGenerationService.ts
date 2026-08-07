/**
 * ChunkGenerationService — server-side terrain generation.
 *
 * Uses a worker thread pool for parallel chunk generation, request
 * deduplication to avoid duplicate work, and batch dispatch for efficiency.
 */
import { hashChunk } from "../protocol/encoder.ts";
import { ChunkWorkerPool } from "../workers/ChunkWorkerPool.ts";

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

function chunkKey(cx: number, cy: number, cz: number): string {
	return `${cx},${cy},${cz}`;
}

export class ChunkGenerationService {
	private pool = new ChunkWorkerPool();
	private seed = "default";
	private initPromise: Promise<void> | null = null;
	private dedupMap = new Map<string, Promise<ChunkData>>();

	setSeed(seed: string, wasmEnabled = true): void {
		if (seed === this.seed && this.initPromise) return;
		this.seed = seed;
		this.initPromise = null;
		this.dedupMap.clear();
		this.wasmEnabled = wasmEnabled;
	}

	private wasmEnabled = true;

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
		const key = chunkKey(chunkX, chunkY, chunkZ);

		const existing = this.dedupMap.get(key);
		if (existing) return existing;

		const promise = this._doGenerate(chunkX, chunkY, chunkZ);
		this.dedupMap.set(key, promise);

		try {
			const result = await promise;
			return result;
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
		return this.finalizeChunk(chunkX, chunkY, chunkZ, raw);
	}

	async generateChunksBatch(
		coords: Array<{ chunkX: number; chunkY: number; chunkZ: number }>,
	): Promise<ChunkData[]> {
		await this.ensurePool();

		const results: ChunkData[] = new Array(coords.length);
		const toFetch: Array<{
			index: number;
			cx: number;
			cy: number;
			cz: number;
		}> = [];
		const fetches: Array<Promise<RawChunkResult>> = [];

		for (let i = 0; i < coords.length; i++) {
			const { chunkX: cx, chunkY: cy, chunkZ: cz } = coords[i];
			const key = chunkKey(cx, cy, cz);

			const existing = this.dedupMap.get(key);
			if (existing) {
				results[i] = await existing;
				continue;
			}

			toFetch.push({ index: i, cx, cy, cz });
		}

		if (toFetch.length > 0) {
			const batchPromise = this.pool.dispatchAll(
				toFetch.map((t) => ({ chunkX: t.cx, chunkY: t.cy, chunkZ: t.cz })),
			);

			const batchResults = await batchPromise;

			for (let i = 0; i < toFetch.length; i++) {
				const { index, cx, cy, cz } = toFetch[i];
				const chunkData = this.finalizeChunk(cx, cy, cz, batchResults[i]);
				results[index] = chunkData;
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
		const compressed = this.compressBlocks(blocks);
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

	private compressBlocks(blocks: Uint8Array): {
		data: Uint8Array;
		palette?: number[];
		isUniform: boolean;
		uniformBlockId: number;
	} {
		const len = blocks.length;
		const uniqueBlocks = new Map<number, number>();

		for (let i = 0; i < len; i++) {
			const id = blocks[i];
			uniqueBlocks.set(id, (uniqueBlocks.get(id) ?? 0) + 1);
		}

		if (uniqueBlocks.size === 1) {
			const uniformBlockId = uniqueBlocks.keys().next().value ?? 0;
			return { data: new Uint8Array(0), isUniform: true, uniformBlockId };
		}

		if (uniqueBlocks.size <= 16) {
			const palette = Array.from(uniqueBlocks.keys());
			const blockToPalette = new Map<number, number>();
			for (let i = 0; i < palette.length; i++) {
				blockToPalette.set(palette[i], i);
			}

			const packed = new Uint8Array(Math.ceil(len / 2));
			for (let i = 0; i < len; i += 2) {
				const evenIdx = blockToPalette.get(blocks[i]) ?? 0;
				const oddIdx = blockToPalette.get(blocks[i + 1]) ?? 0;
				packed[i >> 1] = (evenIdx & 0x0f) | ((oddIdx & 0x0f) << 4);
			}

			return { data: packed, palette, isUniform: false, uniformBlockId: 0 };
		}

		return {
			data: new Uint8Array(blocks),
			isUniform: false,
			uniformBlockId: 0,
		};
	}

	async terminate(): Promise<void> {
		await this.pool.terminate();
		this.dedupMap.clear();
		this.initPromise = null;
	}
}
