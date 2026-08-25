export const UNDERGROUND_MAX_LOD = 1;

export const UNDERGROUND_SKIP_LOD = 4;

/**
 * ChunkY-only variant for the streaming controller, which decides LODs from
 * coordinates before a Chunk object may exist. Underground (cave) chunks in
 * the near bands are never downsampled — coarse shells would wall off cave
 * interiors and misrender against the full-res bands around them. Bands whose
 * horizontal LOD reaches UNDERGROUND_SKIP_LOD are skipped outright instead;
 * the streaming controller additionally bounds them by a vertical window
 * (see undergroundDesired).
 */
export function maxLodForChunkY(chunkY: number): number {
	return chunkY < 0 ? UNDERGROUND_MAX_LOD : Number.MAX_SAFE_INTEGER;
}
