import type { Chunk } from "../Chunk";

export function scheduleChunkAndNeighborsRemesh(
	chunk: Chunk,
	scheduleRemesh: (chunk: Chunk, priority: boolean) => void,
): void {
	scheduleRemesh(chunk, chunk.lodLevel === 0);
	const n0 = chunk.getNeighbor(-1, 0, 0);
	const n1 = chunk.getNeighbor(0, 0, -1);
	const n2 = chunk.getNeighbor(0, -1, 0);
	const n3 = chunk.getNeighbor(1, 0, 0);
	const n4 = chunk.getNeighbor(0, 0, 1);
	const n5 = chunk.getNeighbor(0, 1, 0);
	if (n0) scheduleRemesh(n0, n0.lodLevel === 0);
	if (n1) scheduleRemesh(n1, n1.lodLevel === 0);
	if (n2) scheduleRemesh(n2, n2.lodLevel === 0);
	if (n3) scheduleRemesh(n3, n3.lodLevel === 0);
	if (n4) scheduleRemesh(n4, n4.lodLevel === 0);
	if (n5) scheduleRemesh(n5, n5.lodLevel === 0);
}

export function hasStableVoxelNeighborsForCachedMesh(chunk: Chunk): boolean {
	const n0 = chunk.getNeighbor(-1, 0, 0);
	if (!n0?.isLoaded || !n0.hasVoxelData) return false;
	const n1 = chunk.getNeighbor(1, 0, 0);
	if (!n1?.isLoaded || !n1.hasVoxelData) return false;
	const n2 = chunk.getNeighbor(0, -1, 0);
	if (!n2?.isLoaded || !n2.hasVoxelData) return false;
	const n3 = chunk.getNeighbor(0, 1, 0);
	if (!n3?.isLoaded || !n3.hasVoxelData) return false;
	const n4 = chunk.getNeighbor(0, 0, -1);
	if (!n4?.isLoaded || !n4.hasVoxelData) return false;
	const n5 = chunk.getNeighbor(0, 0, 1);
	if (!n5?.isLoaded || !n5.hasVoxelData) return false;
	return true;
}

export function maybeRemeshNeighborsNowStable(
	chunk: Chunk,
	scheduleRemesh: (chunk: Chunk, priority: boolean) => void,
): void {
	// PERF: unrolled to avoid allocating a 6-element neighbor array on every
	// call (this runs per generated chunk, once for each of its neighbors).
	maybeRemeshNeighborIfStable(chunk.getNeighbor(-1, 0, 0), scheduleRemesh);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(1, 0, 0), scheduleRemesh);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(0, -1, 0), scheduleRemesh);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(0, 1, 0), scheduleRemesh);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(0, 0, -1), scheduleRemesh);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(0, 0, 1), scheduleRemesh);
}

function maybeRemeshNeighborIfStable(
	neighbor: Chunk | undefined | null,
	scheduleRemesh: (chunk: Chunk, priority: boolean) => void,
): void {
	if (!neighbor?.isLoaded || !neighbor.hasVoxelData) return;
	if (!neighbor.getCachedLODMesh(neighbor.lodLevel)) return;
	if (hasStableVoxelNeighborsForCachedMesh(neighbor)) {
		neighbor.isDirty = true;
		scheduleRemesh(neighbor, neighbor.lodLevel === 0);
	}
}
