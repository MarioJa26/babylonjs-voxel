import { unpackBlockId } from "../Chunk/DataStructures/BlockEncoding";
import {
	BLOCK_TYPE,
	BLOCK_TYPE_TRANSPARENT,
} from "../Chunk/Worker/ChunkMesherConstants";
import {
	BRICK_RESOLUTION,
	REGION_CHUNK_EXTENT,
	REGION_VOXEL_SIZE,
} from "./VoxelImpostorRegion";

const CHUNK_SIZE = 32;
const DOWNSAMPLE_FACTOR = Math.floor(REGION_VOXEL_SIZE / BRICK_RESOLUTION);

export interface VoxelImpostorBuildRequest {
	task: "buildVoxelImpostor";
	regionX: number;
	regionY: number;
	regionZ: number;
	chunks: ImpostorChunkData[];
}

export interface ImpostorChunkData {
	chunkLocalX: number;
	chunkLocalY: number;
	chunkLocalZ: number;
	voxels: Uint16Array | null;
}

export interface VoxelImpostorBuildResponse {
	type: "VoxelImpostorBuilt";
	regionX: number;
	regionY: number;
	regionZ: number;
	voxelData: Uint8Array;
	isEmpty: boolean;
}

// FIX: helper that looks up a single voxel across chunk boundaries.
// The old inner-loop clamped dx/dy/dz to stay within the source chunk,
// silently dropping voxels near chunk edges and causing systematic
// undersampling at boundaries. This helper resolves the correct chunk
// for any world-voxel coordinate inside the region.
function sampleWorldVoxel(
	worldX: number,
	worldY: number,
	worldZ: number,
	regionX: number,
	regionY: number,
	regionZ: number,
	chunkMap: Map<string, Uint16Array | null>,
): number {
	const chunkAbsX = Math.floor(worldX / CHUNK_SIZE);
	const chunkAbsY = Math.floor(worldY / CHUNK_SIZE);
	const chunkAbsZ = Math.floor(worldZ / CHUNK_SIZE);

	const chunkLocalX = chunkAbsX - regionX * REGION_CHUNK_EXTENT;
	const chunkLocalY = chunkAbsY - regionY * REGION_CHUNK_EXTENT;
	const chunkLocalZ = chunkAbsZ - regionZ * REGION_CHUNK_EXTENT;

	const chunkKey = `${chunkLocalX},${chunkLocalY},${chunkLocalZ}`;
	const chunkVoxels = chunkMap.get(chunkKey);
	if (!chunkVoxels) return 0;

	const localX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
	const localY = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
	const localZ = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

	const idx = localY * CHUNK_SIZE * CHUNK_SIZE + localZ * CHUNK_SIZE + localX;
	return chunkVoxels[idx] ?? 0;
}

export function buildVoxelImpostorBrick(
	request: VoxelImpostorBuildRequest,
): VoxelImpostorBuildResponse {
	const { regionX, regionY, regionZ, chunks } = request;
	const brickSize = BRICK_RESOLUTION;
	const voxelData = new Uint8Array(brickSize * brickSize * brickSize);

	const chunkMap = new Map<string, Uint16Array | null>();
	for (const chunk of chunks) {
		const key = `${chunk.chunkLocalX},${chunk.chunkLocalY},${chunk.chunkLocalZ}`;
		chunkMap.set(key, chunk.voxels);
	}

	let hasSolid = false;

	for (let bz = 0; bz < brickSize; bz++) {
		for (let by = 0; by < brickSize; by++) {
			for (let bx = 0; bx < brickSize; bx++) {
				const worldX = regionX * REGION_VOXEL_SIZE + bx * DOWNSAMPLE_FACTOR;
				const worldY = regionY * REGION_VOXEL_SIZE + by * DOWNSAMPLE_FACTOR;
				const worldZ = regionZ * REGION_VOXEL_SIZE + bz * DOWNSAMPLE_FACTOR;

				const step = DOWNSAMPLE_FACTOR;
				let solidCount = 0;
				const blockCounts = new Map<number, number>();

				// FIX: iterate over every sub-voxel in the downsample cell and
				// resolve each one through sampleWorldVoxel so that voxels
				// spanning chunk boundaries are included rather than skipped.
				for (let dx = 0; dx < step; dx++) {
					for (let dy = 0; dy < step; dy++) {
						for (let dz = 0; dz < step; dz++) {
							const packed = sampleWorldVoxel(
								worldX + dx,
								worldY + dy,
								worldZ + dz,
								regionX,
								regionY,
								regionZ,
								chunkMap,
							);

							if (packed !== 0) {
								solidCount++;
								const blockId = unpackBlockId(packed);
								if (BLOCK_TYPE[blockId] !== BLOCK_TYPE_TRANSPARENT) {
									blockCounts.set(blockId, (blockCounts.get(blockId) || 0) + 1);
								}
							}
						}
					}
				}

				let dominantBlock = 0;
				if (solidCount > step * step * step * 0.25) {
					let maxCount = 0;
					for (const [blockId, count] of blockCounts) {
						if (count > maxCount) {
							maxCount = count;
							dominantBlock = blockId;
						}
					}
					if (dominantBlock === 0 && blockCounts.size > 0) {
						const firstKey = blockCounts.keys().next().value;
						dominantBlock = firstKey !== undefined ? firstKey : 0;
					}
				}

				const idx = bx + by * brickSize + bz * brickSize * brickSize;
				voxelData[idx] = dominantBlock;
				if (dominantBlock > 0) {
					hasSolid = true;
				}
			}
		}
	}

	return {
		type: "VoxelImpostorBuilt",
		regionX,
		regionY,
		regionZ,
		voxelData,
		isEmpty: !hasSolid,
	};
}
