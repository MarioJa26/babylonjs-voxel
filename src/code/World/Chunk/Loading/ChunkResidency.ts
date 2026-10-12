/**
 * How much of a chunk is currently resident.
 *
 * PERF/RATIONALE: a chunk has THREE expensive representations — the serialized
 * blob in the local cache, the decoded voxel arrays, and the packed face data in
 * the GPU arena. These were evicted independently, so a chunk could retain all
 * three representations longer than necessary.
 *
 * The ordered tier allows the streaming manager to release representations in
 * recovery-cost order: packed mesh first, decoded voxels second, cached blob last.
 */
export const enum ChunkResidency {
	/** Face data in the arena, decoded voxels held, blob cached. */
	Rendered = 0,

	/** Decoded voxels held, blob cached, packed mesh released. */
	Decoded = 1,

	/** Blob cached only — recover with a cache read, no network. */
	Persisted = 2,

	/** Nothing resident. The next visit requires a full request. */
	Absent = 3,
}

/**
 * LOD beyond which a chunk keeps only its cached blob.
 *
 * Matches DistantOnlyChunkCreationRule, which refuses to create chunks past
 * this LOD.
 */
const PERSISTED_LOD_THRESHOLD = 5;

/*
 * Residency and revision are packed into one number:
 *
 *     packed = revision * 4 + residency
 *
 * ChunkResidency is explicitly constrained to values 0..3, so the bottom two
 * bits conceptually contain the residency tier and the remaining value contains
 * the revision.
 *
 * Arithmetic packing is used instead of bitwise operators because JavaScript
 * bitwise operations coerce values to signed 32-bit integers.
 */
const RESIDENCY_TIER_COUNT = 4;

/**
 * Packed residency state keyed by chunk coordinate.
 *
 * Using a number rather than a ResidencyRecord object avoids one additional
 * heap allocation and object header per tracked chunk.
 */
const residency = new Map<bigint, number>();

function packResidency(tier: ChunkResidency, revision: number): number {
	return revision * RESIDENCY_TIER_COUNT + tier;
}

function unpackResidency(packed: number): ChunkResidency {
	return (packed % RESIDENCY_TIER_COUNT) as ChunkResidency;
}

function unpackRevision(packed: number): number {
	return Math.floor(packed / RESIDENCY_TIER_COUNT);
}

/** Current tier for a chunk. Unknown chunks are Absent. */
export function getChunkResidency(key: bigint): ChunkResidency {
	const packed = residency.get(key);

	return packed === undefined ? ChunkResidency.Absent : unpackResidency(packed);
}

/** Revision for a chunk's residency. Bumped only when the tier changes. */
export function getChunkResidencyRevision(key: bigint): number {
	const packed = residency.get(key);

	return packed === undefined ? 0 : unpackRevision(packed);
}

/**
 * Move a chunk to a new tier.
 *
 * @returns true if the tier actually changed.
 */
export function setChunkResidency(key: bigint, next: ChunkResidency): boolean {
	const packed = residency.get(key);

	if (packed === undefined) {
		residency.set(key, packResidency(next, 1));
		return true;
	}

	if (unpackResidency(packed) === next) {
		return false;
	}

	residency.set(key, packResidency(next, unpackRevision(packed) + 1));

	return true;
}

/**
 * Compute the tier a chunk should occupy for its desired LOD.
 *
 * Ordering follows recovery cost: release arena faces first, retain decoded
 * voxels while useful, and keep the cached blob longest.
 */
export function residencyForLod(lod: number): ChunkResidency {
	return lod <= PERSISTED_LOD_THRESHOLD
		? ChunkResidency.Decoded
		: ChunkResidency.Persisted;
}

/**
 * Drop all residency records.
 *
 * Called on connect and on cache reset. The records are advisory, so clearing
 * them only causes subsequent lookups to report Absent until state is republished.
 */
export function resetChunkResidency(): void {
	residency.clear();
}

/** Drop the record for one fully freed chunk to keep the map bounded. */
export function forgetChunkResidency(key: bigint): void {
	residency.delete(key);
}
