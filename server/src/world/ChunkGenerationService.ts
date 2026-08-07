/**
 * ChunkGenerationService — server-side terrain generation.
 * Dynamically imports the client's WorldGenerator (pure computation, no DOM).
 */
import type { WorldGenerator } from "@/code/Generation/WorldGenerator";
import { hashChunk } from "../protocol/encoder.ts";

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

export class ChunkGenerationService {
	private generator: WorldGenerator | null = null;
	private seed = "default";
	private initPromise: Promise<void> | null = null;

	setSeed(seed: string): void {
		if (seed === this.seed && this.generator) return;
		this.seed = seed;
		this.generator = null;
		this.initPromise = null;
	}

	private async ensureInit(): Promise<void> {
		if (this.generator) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			const { WorldGenerator: WG } = await import(
				"@/code/Generation/WorldGenerator"
			);
			const { GenerationParams } = await import(
				"@/code/Generation/NoiseAndParameters/GenerationParams"
			);

			const params = { ...GenerationParams, SEED: this.seed };
			this.generator = new WG(params as any);
		})();

		return this.initPromise;
	}

	async generateChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkData> {
		await this.ensureInit();
		const gen = this.generator!;
		const result = gen.generateChunkData(chunkX, chunkY, chunkZ);

		// Compress blocks for network transfer
		const { blocks, light } = result;
		const compressed = this.compressBlocks(blocks);

		// Compute hash for cache validation
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
	 * Compress chunk blocks into uniform/palette/dense format.
	 * Mirrors the client's chunk.worker.ts compressBlocks().
	 */
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

		// Uniform chunk (all same block)
		if (uniqueBlocks.size === 1) {
			const uniformBlockId = uniqueBlocks.keys().next().value ?? 0;
			return { data: new Uint8Array(0), isUniform: true, uniformBlockId };
		}

		// Palette compression (≤16 unique blocks → nibble packing)
		if (uniqueBlocks.size <= 16) {
			const palette = Array.from(uniqueBlocks.keys());
			const blockToPalette = new Map<number, number>();
			for (let i = 0; i < palette.length; i++) {
				blockToPalette.set(palette[i], i);
			}

			const packed = new Uint8Array(Math.ceil(len / 2));
			// Match client's chunk.worker.ts nibble order:
			// byte i = (low nibble = block[2i]) | (high nibble = block[2i+1] << 4)
			for (let i = 0; i < len; i += 2) {
				const evenIdx = blockToPalette.get(blocks[i]) ?? 0;
				const oddIdx = blockToPalette.get(blocks[i + 1]) ?? 0;
				packed[i >> 1] = (evenIdx & 0x0f) | ((oddIdx & 0x0f) << 4);
			}

			return { data: packed, palette, isUniform: false, uniformBlockId: 0 };
		}

		// Dense format (full Uint8Array copy)
		return { data: new Uint8Array(blocks), isUniform: false, uniformBlockId: 0 };
	}
}
