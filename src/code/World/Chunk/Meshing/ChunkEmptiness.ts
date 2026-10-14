// ---------------------------------------------------------------------------
// ChunkEmptiness: mesh-skippability predicates.
//
// Uniform air produces no mesh. A uniformly opaque full-cube chunk can also
// skip meshing when its three negative-axis neighbors are uniformly opaque,
// because those neighbors close every boundary face owned by this chunk.
// ---------------------------------------------------------------------------

import {
	FLAG_GREEDY,
	FLAG_PARTIAL,
	FLAG_SOLID,
	FLAG_TRANSPARENT,
	getCachedFlagsAndId,
	getFlagsFromCombined,
} from "../../MeshPipeline/core/BlockInfoCache";
import { type Chunk, getChunk } from "../Chunk";

const REQUIRED_OPAQUE_CUBE_FLAGS = FLAG_SOLID | FLAG_GREEDY;
const DISALLOWED_OPAQUE_CUBE_FLAGS = FLAG_TRANSPARENT | FLAG_PARTIAL;

export function isCompletelyEmptyChunk(chunk: Chunk): boolean {
	return chunk.isUniform && chunk.uniformBlockId === 0;
}

/**
 * Returns whether the packed block is classified by the mesher as an opaque,
 * greedy full cube with no transparent or partial-shape geometry.
 */
export function isOpaqueCubePacked(packed: number): boolean {
	const flags = getFlagsFromCombined(getCachedFlagsAndId(packed));

	return (
		(flags & REQUIRED_OPAQUE_CUBE_FLAGS) === REQUIRED_OPAQUE_CUBE_FLAGS &&
		(flags & DISALLOWED_OPAQUE_CUBE_FLAGS) === 0
	);
}

/**
 * Returns whether the specified chunk exists, has usable voxel data, and is
 * uniformly filled with an opaque full-cube block.
 */
export function isUniformOpaqueCubeNeighbor(
	cx: number,
	cy: number,
	cz: number,
): boolean {
	const neighbor = getChunk(cx, cy, cz);

	if (
		neighbor === undefined ||
		!neighbor.isLoaded ||
		!neighbor.hasVoxelData ||
		!neighbor.isUniform
	) {
		return false;
	}

	return isOpaqueCubePacked(neighbor.uniformBlockId);
}

/**
 * Returns whether meshing a uniformly solid chunk can be skipped because all
 * faces owned by the chunk are fully occluded.
 */
export function isUniformSolidMeshSkippable(chunk: Chunk): boolean {
	if (!chunk.isUniform) {
		return false;
	}

	const blockId = chunk.uniformBlockId;

	if (!isOpaqueCubePacked(blockId)) {
		return false;
	}

	const { chunkX, chunkY, chunkZ } = chunk;

	return (
		isUniformOpaqueCubeNeighbor(chunkX - 1, chunkY, chunkZ) &&
		isUniformOpaqueCubeNeighbor(chunkX, chunkY - 1, chunkZ) &&
		isUniformOpaqueCubeNeighbor(chunkX, chunkY, chunkZ - 1)
	);
}
