import type { Chunk } from "../Chunk";

export const UNDERGROUND_MAX_LOD = 1;

export function shouldSkipLodForChunk(chunk: Chunk, lod: number): boolean {
	return chunk.chunkY < 0 && lod > UNDERGROUND_MAX_LOD;
}

export function clampLodForChunk(chunk: Chunk, lod: number): number {
	return chunk.chunkY < 0 && lod > UNDERGROUND_MAX_LOD
		? UNDERGROUND_MAX_LOD
		: lod;
}

/**
 * ChunkY-only variant for the streaming controller, which decides LODs from
 * coordinates before a Chunk object may exist. Underground (cave) chunks are
 * never downsampled — coarse shells would wall off cave interiors and
 * misrender against the full-res bands around them.
 */
export function maxLodForChunkY(chunkY: number): number {
	return chunkY < 0 ? UNDERGROUND_MAX_LOD : Number.MAX_SAFE_INTEGER;
}

export function normalizeChunkLod(chunk: Chunk): void {
	const lod = chunk.lodLevel ?? 0;
	const clamped = clampLodForChunk(chunk, lod);
	if (clamped !== lod) {
		chunk.lodLevel = clamped;
	}
}
