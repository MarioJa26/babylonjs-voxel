import type { Chunk } from "../Chunk";

/**
 * Pending face-connectivity recomputes: written by the block-edit path, drained
 * by OcclusionCuller immediately before a BFS restart.
 *
 * This replaces the O(reachable-chunks) scan OcclusionCuller used to run on
 * every single frame over `_topoVisibleChunks` purely to notice
 * `connectivityDirty` flipping to true. A chunk now pushes itself the moment an
 * edit dirties it, so finding pending work costs `pendingConnectivity.length`
 * once per BFS restart instead of a full reachable-set walk 60 times a second.
 *
 * `chunk.bfsQueuedForConnectivity` is the duplicate guard: a player standing
 * still and mining can never grow the list past one entry per touched chunk,
 * which is also the bound the old scan had.
 */
export const pendingConnectivity: Chunk[] = [];

export function queueConnectivityRecompute(chunk: Chunk): void {
	if (chunk.bfsQueuedForConnectivity) return;
	chunk.bfsQueuedForConnectivity = true;
	pendingConnectivity.push(chunk);
}
