import type { Chunk } from "../Chunk";

type RemeshScheduler = (chunk: Chunk, priority: boolean) => void;

export function scheduleChunkAndNeighborsRemesh(
	chunk: Chunk,
	scheduleRemesh: RemeshScheduler,
	scheduleHealRemesh?: RemeshScheduler,
): void {
	scheduleRemesh(chunk, chunk.lodLevel === 0);

	// Deferred healing coalesces repeated border updates. When unavailable,
	// use the immediate scheduler to preserve the original behavior.
	const heal = scheduleHealRemesh ?? scheduleRemesh;

	scheduleNeighbor(chunk.getNeighbor(-1, 0, 0), heal);
	scheduleNeighbor(chunk.getNeighbor(1, 0, 0), heal);
	scheduleNeighbor(chunk.getNeighbor(0, -1, 0), heal);
	scheduleNeighbor(chunk.getNeighbor(0, 1, 0), heal);
	scheduleNeighbor(chunk.getNeighbor(0, 0, -1), heal);
	scheduleNeighbor(chunk.getNeighbor(0, 0, 1), heal);
}

export function hasStableVoxelNeighborsForCachedMesh(chunk: Chunk): boolean {
	let neighbor = chunk.getNeighbor(-1, 0, 0);
	if (
		neighbor === undefined ||
		neighbor === null ||
		!neighbor.isLoaded ||
		!neighbor.hasVoxelData
	) {
		return false;
	}

	neighbor = chunk.getNeighbor(1, 0, 0);
	if (
		neighbor === undefined ||
		neighbor === null ||
		!neighbor.isLoaded ||
		!neighbor.hasVoxelData
	) {
		return false;
	}

	neighbor = chunk.getNeighbor(0, -1, 0);
	if (
		neighbor === undefined ||
		neighbor === null ||
		!neighbor.isLoaded ||
		!neighbor.hasVoxelData
	) {
		return false;
	}

	neighbor = chunk.getNeighbor(0, 1, 0);
	if (
		neighbor === undefined ||
		neighbor === null ||
		!neighbor.isLoaded ||
		!neighbor.hasVoxelData
	) {
		return false;
	}

	neighbor = chunk.getNeighbor(0, 0, -1);
	if (
		neighbor === undefined ||
		neighbor === null ||
		!neighbor.isLoaded ||
		!neighbor.hasVoxelData
	) {
		return false;
	}

	neighbor = chunk.getNeighbor(0, 0, 1);
	return (
		neighbor !== undefined &&
		neighbor !== null &&
		neighbor.isLoaded &&
		neighbor.hasVoxelData
	);
}

export function maybeRemeshNeighborsNowStable(
	chunk: Chunk,
	scheduleRemesh: RemeshScheduler,
	scheduleHealRemesh?: RemeshScheduler,
): void {
	const heal = scheduleHealRemesh ?? scheduleRemesh;

	maybeRemeshNeighborIfStable(chunk.getNeighbor(-1, 0, 0), heal);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(1, 0, 0), heal);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(0, -1, 0), heal);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(0, 1, 0), heal);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(0, 0, -1), heal);
	maybeRemeshNeighborIfStable(chunk.getNeighbor(0, 0, 1), heal);
}

function scheduleNeighbor(
	neighbor: Chunk | undefined | null,
	scheduleRemesh: RemeshScheduler,
): void {
	if (neighbor === undefined || neighbor === null) return;

	scheduleRemesh(neighbor, neighbor.lodLevel === 0);
}

function maybeRemeshNeighborIfStable(
	neighbor: Chunk | undefined | null,
	scheduleRemesh: RemeshScheduler,
): void {
	if (
		neighbor === undefined ||
		neighbor === null ||
		!neighbor.isLoaded ||
		!neighbor.hasVoxelData
	) {
		return;
	}

	const lodLevel = neighbor.lodLevel;

	if (neighbor.getCachedLODMesh(lodLevel) === undefined) {
		return;
	}

	if (!hasStableVoxelNeighborsForCachedMesh(neighbor)) {
		return;
	}

	neighbor.isDirty = true;
	scheduleRemesh(neighbor, lodLevel === 0);
}
