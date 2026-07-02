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

export function normalizeChunkLod(chunk: Chunk): void {
	const lod = chunk.lodLevel ?? 0;
	const clamped = clampLodForChunk(chunk, lod);
	if (clamped !== lod) {
		chunk.lodLevel = clamped;
	}
}
