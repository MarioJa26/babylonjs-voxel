/**
 * ServerWaterBlockAccess — synchronous WaterBlockAccess adapter for the
 * authoritative server.
 *
 * Backed by ServerWorldStorage's in-memory LRU chunk cache, so reads and
 * writes never touch LevelDB. Writes go through setCachedBlock, which mutates
 * the cached dense buffer and marks the chunk dirty for the next async flush.
 *
 * Coordinates are integer world voxel coordinates (the simulation always
 * passes integers). The storage layout matches the client: index =
 * localX + (localY << 5) + (localZ << 10), entries are packed id|state values.
 */

import { CHUNK_SHIFT, CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import {
	unpackBlockId,
	unpackBlockState,
} from "@/code/World/Chunk/DataStructures/BlockEncoding";
import type { WaterBlockAccess } from "@/code/World/Chunk/Worker/WaterSimulation";
import type { ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface WaterBlockChange {
	x: number;
	y: number;
	z: number;
	blockId: number;
	blockState: number;
}

export class ServerWaterBlockAccess implements WaterBlockAccess {
	// Accumulates block changes made by the simulation this tick. Drained by
	// broadcastWaterEdits() after processFrame() so clients stay in sync.
	private readonly pendingChanges: WaterBlockChange[] = [];

	constructor(private readonly storage: ServerWorldStorage) {}

	getBlock(worldX: number, worldY: number, worldZ: number): number {
		const blocks = this.getBlocks(worldX, worldY, worldZ);
		if (!blocks) return 0; // Treat unloaded chunks as air.
		const idx = this.localIndex(worldX, worldY, worldZ);
		return unpackBlockId(blocks[idx]);
	}

	getBlockState(worldX: number, worldY: number, worldZ: number): number {
		const blocks = this.getBlocks(worldX, worldY, worldZ);
		if (!blocks) return 0;
		const idx = this.localIndex(worldX, worldY, worldZ);
		return unpackBlockState(blocks[idx]);
	}

	getBlockAndStateInto(
		worldX: number,
		worldY: number,
		worldZ: number,
		out: { blockId: number; blockState: number },
	): void {
		const blocks = this.getBlocks(worldX, worldY, worldZ);
		if (!blocks) {
			out.blockId = 0;
			out.blockState = 0;
			return;
		}
		const idx = this.localIndex(worldX, worldY, worldZ);
		const packed = blocks[idx];
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
		if (this.storage.setCachedBlock(worldX, worldY, worldZ, blockId, state)) {
			// Only record when the write actually hit a loaded chunk.
			this.pendingChanges.push({
				x: worldX,
				y: worldY,
				z: worldZ,
				blockId,
				blockState: state,
			});
		}
	}

	/** Returns and clears the block changes accumulated since the last drain. */
	drainChanges(): WaterBlockChange[] {
		const changes = this.pendingChanges;
		this.pendingChanges.length = 0;
		// We reused the array object; return a snapshot reference. Since we
		// cleared it, callers get the drained entries. But to be safe against
		// the caller retaining a reference we just filled, swap in a fresh array.
		return changes;
	}

	private getBlocks(worldX: number, worldY: number, worldZ: number) {
		const cx = Math.floor(worldX / CHUNK_SIZE);
		const cy = Math.floor(worldY / CHUNK_SIZE);
		const cz = Math.floor(worldZ / CHUNK_SIZE);
		return this.storage.getCachedChunkBlocks(cx, cy, cz);
	}

	private localIndex(worldX: number, worldY: number, worldZ: number): number {
		const cx = Math.floor(worldX / CHUNK_SIZE);
		const cy = Math.floor(worldY / CHUNK_SIZE);
		const cz = Math.floor(worldZ / CHUNK_SIZE);
		const lx = worldX - cx * CHUNK_SIZE;
		const ly = worldY - cy * CHUNK_SIZE;
		const lz = worldZ - cz * CHUNK_SIZE;
		return lx + (ly << CHUNK_SHIFT) + (lz << (CHUNK_SHIFT * 2));
	}
}
