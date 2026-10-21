/**
 * ServerWaterBlockAccess — synchronous WaterBlockAccess adapter for the
 * authoritative server.
 *
 * Backed by ServerWorldStorage's in-memory LRU chunk cache. Reads and writes
 * never touch LevelDB. Writes mutate the cached dense buffer and mark the
 * affected chunk dirty for the next asynchronous flush.
 *
 * Coordinates are integer world voxel coordinates.
 *
 * Chunk layout:
 * index = localX + (localY << CHUNK_SHIFT)
 *                    + (localZ << (CHUNK_SHIFT * 2))
 *
 * Entries contain packed block ID and state values.
 */

import { CHUNK_SHIFT, CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import {
	unpackBlockId,
	unpackBlockState,
} from "@/code/World/Chunk/DataStructures/BlockEncoding";
import type { WaterBlockAccess } from "@/code/World/Chunk/Simulation/WaterSimulation";
import type { ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface WaterBlockChange {
	x: number;
	y: number;
	z: number;
	blockId: number;
	blockState: number;
}

export class ServerWaterBlockAccess implements WaterBlockAccess {
	/**
	 * Block changes made since the previous drain.
	 *
	 * This reference is replaced by drainChanges(), allowing the accumulated
	 * array to be returned without cloning it.
	 */
	private pendingChanges: WaterBlockChange[] = [];

	constructor(private readonly storage: ServerWorldStorage) {}

	getBlock(worldX: number, worldY: number, worldZ: number): number {
		const packed = this.getPackedBlock(worldX, worldY, worldZ);
		return packed === undefined ? 0 : unpackBlockId(packed);
	}

	getBlockState(worldX: number, worldY: number, worldZ: number): number {
		const packed = this.getPackedBlock(worldX, worldY, worldZ);
		return packed === undefined ? 0 : unpackBlockState(packed);
	}

	getBlockAndStateInto(
		worldX: number,
		worldY: number,
		worldZ: number,
		out: { blockId: number; blockState: number },
	): void {
		const packed = this.getPackedBlock(worldX, worldY, worldZ);

		if (packed === undefined) {
			out.blockId = 0;
			out.blockState = 0;
			return;
		}

		out.blockId = unpackBlockId(packed);
		out.blockState = unpackBlockState(packed);
	}

	setBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
		state: number,
	): void {
		if (!this.storage.setCachedBlock(worldX, worldY, worldZ, blockId, state)) {
			return;
		}

		this.pendingChanges.push({
			x: worldX,
			y: worldY,
			z: worldZ,
			blockId,
			blockState: state,
		});
	}

	/** Returns and clears all block changes accumulated since the last drain. */
	drainChanges(): WaterBlockChange[] {
		if (this.pendingChanges.length === 0) {
			return [];
		}

		const changes = this.pendingChanges;
		this.pendingChanges = [];
		return changes;
	}

	/**
	 * Returns the packed block entry, or undefined when the owning chunk is
	 * not cached.
	 */
	private getPackedBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number | undefined {
		const chunkX = Math.floor(worldX / CHUNK_SIZE);
		const chunkY = Math.floor(worldY / CHUNK_SIZE);
		const chunkZ = Math.floor(worldZ / CHUNK_SIZE);

		const blocks = this.storage.getCachedChunkBlocks(chunkX, chunkY, chunkZ);

		if (!blocks) {
			return undefined;
		}

		const localX = worldX - chunkX * CHUNK_SIZE;
		const localY = worldY - chunkY * CHUNK_SIZE;
		const localZ = worldZ - chunkZ * CHUNK_SIZE;

		const index =
			localX + (localY << CHUNK_SHIFT) + (localZ << (CHUNK_SHIFT * 2));

		return blocks[index];
	}
}
