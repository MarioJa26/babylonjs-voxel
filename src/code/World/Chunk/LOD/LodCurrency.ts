// ---------------------------------------------------------------------------
// LodCurrency: "is the chunk showing the LOD it was told to show?"
//
// WHY THIS EXISTS
// ---------------
// `chunk.lodLevel` is the LOD the streaming controller DECIDED the chunk
// should have. It is assigned the moment the decision is applied — BEFORE
// the mesh for that LOD has been rebuilt — so a chunk routinely claims
// lodLevel 0 while still rendering its old LOD-3 mesh.
//
// That makes `lodLevel` useless as a "what is on screen" signal, and it means
// a rebuild that gets lost (dropped queue entry, lost worker result,
// stale-drop chain) leaves no trace: the chunk looks settled, every
// later decision agrees with it, and nothing re-queues the rebuild. The
// chunk then renders its old, COARSER LOD indefinitely.
//
// `chunk.appliedMeshLod` is the ground truth — the LOD the mesh that is
// actually on screen was built at. The mismatch between the two is the
// stale-LOD condition, and it is what the streaming controller's refresh
// path and the memory HUD use to detect a chunk that needs a rebuild.
//
// This module is intentionally import-free so the predicate can be unit
// tested on its own (mirrors the import-free ChunkLifecycle precedent).
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the fields the LOD-currency check reads.
 * `Chunk` satisfies it without exposing any privates.
 */
export interface LodCurrencyView {
	/** LOD the streaming controller decided this chunk should have. */
	readonly lodLevel: number;
	/** LOD the currently rendered mesh was built at. -1 = no mesh. */
	readonly appliedMeshLod: number;
}

/**
 * Whether the chunk's rendered mesh belongs to a different LOD than the one
 * the streaming controller decided on.
 *
 * A chunk with no mesh at all (`appliedMeshLod < 0`) is NOT stale: it has
 * nothing to replace, and treating it as stale would make the refresh path
 * re-queue chunks that are legitimately waiting for their first build (or
 * that are empty and never get one).
 */
export function isStaleLodMesh(view: LodCurrencyView): boolean {
	return view.appliedMeshLod >= 0 && view.appliedMeshLod !== view.lodLevel;
}
