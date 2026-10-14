// ---------------------------------------------------------------------------
// ChunkEmptiness: mesh-skippability predicates (extracted from
// ChunkWorkerPool).
//
// A uniform-air chunk has no mesh. A chunk of one opaque cube only emits
// faces at its -X/-Y/-Z boundaries (the +neighbors emit their own slice -1,
// interior pairs are opaque-opaque) — when those three negative neighbors
// are also uniformly opaque cubes, the mesh is provably empty and the worker
// dispatch can be skipped.
// ---------------------------------------------------------------------------
import { getChunk, type Chunk } from "../Chunk";
import {
	FLAG_GREEDY,
	FLAG_PARTIAL,
	FLAG_SOLID,
	FLAG_TRANSPARENT,
	getCachedFlagsAndId,
	getFlagsFromCombined,
} from "../../MeshPipeline/core/BlockInfoCache";

export function isCompletelyEmptyChunk(chunk: Chunk): boolean {
	return chunk.isUniform && chunk.uniformBlockId === 0;
}

/**
 * The engine's "opaque" classification, identical to the mesher's:
 * solid + greedy-participating, neither transparent nor partial-shape.
 * These are full cubes that close every face, so a chunk made entirely
 * of one such block emits no custom geometry either.
 */
export function isOpaqueCubePacked(packed: number): boolean {
	const flags = getFlagsFromCombined(getCachedFlagsAndId(packed));
	return (
		(flags & (FLAG_SOLID | FLAG_GREEDY)) === (FLAG_SOLID | FLAG_GREEDY) &&
		(flags & (FLAG_TRANSPARENT | FLAG_PARTIAL)) === 0
	);
}

export function isUniformOpaqueCubeNeighbor(
	cx: number,
	cy: number,
	cz: number,
): boolean {
	const neighbor = getChunk(cx, cy, cz);
	if (!neighbor?.isLoaded || !neighbor.hasVoxelData) return false;
	return (
		neighbor.isUniform &&
		neighbor.uniformBlockId !== 0 &&
		isOpaqueCubePacked(neighbor.uniformBlockId)
	);
}

export function isUniformSolidMeshSkippable(chunk: Chunk): boolean {
	if (!chunk.isUniform || chunk.uniformBlockId === 0) return false;
	if (!isOpaqueCubePacked(chunk.uniformBlockId)) return false;
	return (
		isUniformOpaqueCubeNeighbor(chunk.chunkX - 1, chunk.chunkY, chunk.chunkZ) &&
		isUniformOpaqueCubeNeighbor(chunk.chunkX, chunk.chunkY - 1, chunk.chunkZ) &&
		isUniformOpaqueCubeNeighbor(chunk.chunkX, chunk.chunkY, chunk.chunkZ - 1)
	);
}
