/**
 * Live-chunk census for the memory HUD. A heap snapshot showed ~73k Chunk
 * shells retaining ~2.9 GB; this breakdown identifies which LOD band /
 * voxel state owns them without needing a snapshot.
 *
 * Engine perf: debug-HUD path only (not per-frame, not per-voxel). Iterates
 * loaded chunks with plain property reads and bounded per-LOD getter calls —
 * no allocation except the single result object. The manual
 * opaque/water/cutout summation deliberately avoids a temp-array alloc per
 * cached entry.
 */

import { isStaleLodMesh } from "../LOD/LodCurrency";

// Minimal structural view — Chunk satisfies this without exposing privates.
export interface CensusMeshData {
	readonly faceData: Uint8Array;
}

export interface CensusLODMesh {
	readonly opaque: CensusMeshData | null;
	readonly water: CensusMeshData | null;
	readonly cutout: CensusMeshData | null;
}

export interface CensusChunk {
	readonly hasVoxelData: boolean;
	readonly lodLevel: number;
	/**
	 * LOD the rendered mesh was actually built at (-1 = no mesh). A chunk whose
	 * `appliedMeshLod` differs from `lodLevel` is rendering the WRONG LOD -
	 * the coarse mesh left over from before the chunk moved in closer.
	 */
	readonly appliedMeshLod: number;
	/** A remesh is requested and has not been applied yet. */
	readonly remeshQueued: boolean;
	/** A build was superseded while in flight; the re-run is latched. */
	readonly rerunRemeshAfterInflight: boolean;
	/** The chunk's mesh does not match its voxel data. */
	readonly isDirty: boolean;
	getCachedLODMesh(lod: number): CensusLODMesh | null;
}

export interface ChunkCensus {
	total: number;
	withVoxels: number;
	lodLow: number;
	lodMid: number;
	lodHigh: number;
	/** Chunks whose rendered mesh LOD does not match their decided LOD. */
	staleLod: number;
	/** Stale chunks that still have a remesh request outstanding. */
	staleQueued: number;
	/** Stale chunks with the superseded-build rerun latch set. */
	staleLatched: number;
	/** Stale chunks whose mesh is still marked dirty. */
	staleDirty: number;
	/** Stale chunks whose rendered mesh is COARSER than the decided LOD. */
	staleTooCoarse: number;
	cachedMeshEntries: number;
	cachedMeshBytes: number;
}

/** Per-chunk detail for a stale-LOD chunk, for diagnostics. */
export interface StaleChunkDetail {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	lodLevel: number;
	appliedMeshLod: number;
	remeshQueued: boolean;
	rerunRemeshAfterInflight: boolean;
	isDirty: boolean;
	hasVoxelData: boolean;
	isLoaded: boolean;
}

export function collectStaleChunkDetails(
	chunks: Iterable<CensusChunk & StaleChunkDetail>,
	limit = 32,
): StaleChunkDetail[] {
	const out: StaleChunkDetail[] = [];
	for (const chunk of chunks) {
		if (!isStaleLodMesh(chunk)) continue;
		out.push(chunk);
		if (out.length >= limit) break;
	}
	return out;
}

export function getChunkCensus(
	chunks: Iterable<CensusChunk>,
	lodCount: number,
): ChunkCensus {
	let total = 0;
	let withVoxels = 0;
	let lodLow = 0;
	let lodMid = 0;
	let lodHigh = 0;
	let staleLod = 0;
	let staleQueued = 0;
	let staleLatched = 0;
	let staleDirty = 0;
	let staleTooCoarse = 0;
	let cachedMeshEntries = 0;
	let cachedMeshBytes = 0;

	for (const chunk of chunks) {
		total++;

		if (chunk.hasVoxelData) {
			withVoxels++;
		}

		const lod = chunk.lodLevel;

		if (lod <= 1) {
			lodLow++;
		} else if (lod <= 3) {
			lodMid++;
		} else {
			lodHigh++;
		}

		/*
		 * Stale-LOD detector. `lodLevel` is the DECIDED level and is advanced
		 * before the rebuild lands, so a mismatch here means the chunk is
		 * still showing the mesh of its previous (coarser) LOD.
		 */
		if (isStaleLodMesh(chunk)) {
			staleLod++;
			if (chunk.remeshQueued) staleQueued++;
			if (chunk.rerunRemeshAfterInflight) staleLatched++;
			if (chunk.isDirty) staleDirty++;
			if (chunk.appliedMeshLod > chunk.lodLevel) staleTooCoarse++;
		}

		for (let l = 0; l < lodCount; l++) {
			const entry = chunk.getCachedLODMesh(l);
			if (entry === null) continue;
			cachedMeshEntries++;
			const opaque = entry.opaque;
			if (opaque !== null) {
				cachedMeshBytes += opaque.faceData.byteLength;
			}

			const water = entry.water;
			if (water !== null) {
				cachedMeshBytes += water.faceData.byteLength;
			}

			const cutout = entry.cutout;
			if (cutout !== null) {
				cachedMeshBytes += cutout.faceData.byteLength;
			}
		}
	}

	return {
		total,
		withVoxels,
		lodLow,
		lodMid,
		lodHigh,
		staleLod,
		staleQueued,
		staleLatched,
		staleDirty,
		staleTooCoarse,
		cachedMeshEntries,
		cachedMeshBytes,
	};
}
