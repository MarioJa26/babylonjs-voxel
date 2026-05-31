import { Chunk, getChunk } from "../Chunk";
import { worldToBlockCoord, worldToChunkCoord } from "../ChunkLoadingSystem";

export interface WorldBlockCoordinates {
	worldX: number;
	worldY: number;
	worldZ: number;
}

export interface LocalBlockCoordinates extends WorldBlockCoordinates {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	localX: number;
	localY: number;
	localZ: number;
	chunk: Chunk | undefined;
}

export interface BlockMutationContext extends LocalBlockCoordinates {
	previousBlockId: number;
	previousBlockState: number;
	nextBlockId: number;
	nextBlockState: number;
}

export interface ChunkWorldMutationsAdapter {
	onBeforeSetBlock?(ctx: BlockMutationContext): void;
	onAfterSetBlock?(ctx: BlockMutationContext): void;
	onBeforeDeleteBlock?(ctx: BlockMutationContext): void;
	onAfterDeleteBlock?(ctx: BlockMutationContext): void;
	onMissingChunk?(coords: LocalBlockCoordinates): void;
	onBoundaryMutation?(ctx: BlockMutationContext): void;
}

class ResolvedChunkCoords {
	chunkX = 0;
	chunkY = 0;
	chunkZ = 0;
	localX = 0;
	localY = 0;
	localZ = 0;
	chunk: Chunk | undefined;
}

const _coordScratch = new ResolvedChunkCoords();

// M4: Reusable BlockMutationContext — avoids per-mutation object allocation
const _ctxScratch: BlockMutationContext = {
	worldX: 0,
	worldY: 0,
	worldZ: 0,
	chunkX: 0,
	chunkY: 0,
	chunkZ: 0,
	localX: 0,
	localY: 0,
	localZ: 0,
	chunk: undefined,
	previousBlockId: 0,
	previousBlockState: 0,
	nextBlockId: 0,
	nextBlockState: 0,
};

function resolveCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
): ResolvedChunkCoords {
	const scratch = _coordScratch;
	scratch.chunkX = worldToChunkCoord(worldX);
	scratch.chunkY = worldToChunkCoord(worldY);
	scratch.chunkZ = worldToChunkCoord(worldZ);
	scratch.localX = worldToBlockCoord(worldX);
	scratch.localY = worldToBlockCoord(worldY);
	scratch.localZ = worldToBlockCoord(worldZ);
	scratch.chunk = getChunk(scratch.chunkX, scratch.chunkY, scratch.chunkZ);
	return scratch;
}

export class ChunkWorldMutations {
	public constructor(
		private readonly adapter: ChunkWorldMutationsAdapter = {},
	) {}

	public getBlockByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		const coords = resolveCoords(worldX, worldY, worldZ);
		if (!coords.chunk) return 0;
		return coords.chunk.getBlock(coords.localX, coords.localY, coords.localZ);
	}

	public getLightByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		const coords = resolveCoords(worldX, worldY, worldZ);
		if (!coords.chunk) return 0;
		return coords.chunk.getLight(coords.localX, coords.localY, coords.localZ);
	}

	public setBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
		state: number = 0,
	): boolean {
		const coords = resolveCoords(worldX, worldY, worldZ);

		if (!coords.chunk) {
			return false;
		}

		const previousBlockId = coords.chunk.getBlock(
			coords.localX,
			coords.localY,
			coords.localZ,
		);
		const previousBlockState = coords.chunk.getBlockState(
			coords.localX,
			coords.localY,
			coords.localZ,
		);

		const ctx = _ctxScratch;
		ctx.worldX = worldX;
		ctx.worldY = worldY;
		ctx.worldZ = worldZ;
		ctx.chunkX = coords.chunkX;
		ctx.chunkY = coords.chunkY;
		ctx.chunkZ = coords.chunkZ;
		ctx.localX = coords.localX;
		ctx.localY = coords.localY;
		ctx.localZ = coords.localZ;
		ctx.chunk = coords.chunk;
		ctx.previousBlockId = previousBlockId;
		ctx.previousBlockState = previousBlockState;
		ctx.nextBlockId = blockId;
		ctx.nextBlockState = state;

		this.adapter.onBeforeSetBlock?.(ctx);

		coords.chunk.setBlock(
			coords.localX,
			coords.localY,
			coords.localZ,
			blockId,
			state,
		);

		if (
			this.isBoundaryLocalCoord(coords.localX, coords.localY, coords.localZ)
		) {
			this.adapter.onBoundaryMutation?.(ctx);
		}

		this.adapter.onAfterSetBlock?.(ctx);
		return true;
	}

	public deleteBlock(worldX: number, worldY: number, worldZ: number): boolean {
		const coords = resolveCoords(worldX, worldY, worldZ);

		if (!coords.chunk) {
			return false;
		}

		const previousBlockId = coords.chunk.getBlock(
			coords.localX,
			coords.localY,
			coords.localZ,
		);
		const previousBlockState = coords.chunk.getBlockState(
			coords.localX,
			coords.localY,
			coords.localZ,
		);

		const ctx = _ctxScratch;
		ctx.worldX = worldX;
		ctx.worldY = worldY;
		ctx.worldZ = worldZ;
		ctx.chunkX = coords.chunkX;
		ctx.chunkY = coords.chunkY;
		ctx.chunkZ = coords.chunkZ;
		ctx.localX = coords.localX;
		ctx.localY = coords.localY;
		ctx.localZ = coords.localZ;
		ctx.chunk = coords.chunk;
		ctx.previousBlockId = previousBlockId;
		ctx.previousBlockState = previousBlockState;
		ctx.nextBlockId = 0;
		ctx.nextBlockState = 0;

		this.adapter.onBeforeDeleteBlock?.(ctx);

		coords.chunk.deleteBlock(coords.localX, coords.localY, coords.localZ);

		if (
			this.isBoundaryLocalCoord(coords.localX, coords.localY, coords.localZ)
		) {
			this.adapter.onBoundaryMutation?.(ctx);
		}

		this.adapter.onAfterDeleteBlock?.(ctx);
		return true;
	}

	private isBoundaryLocalCoord(
		localX: number,
		localY: number,
		localZ: number,
	): boolean {
		const max = Chunk.SIZE - 1;
		return (
			localX === 0 ||
			localY === 0 ||
			localZ === 0 ||
			localX === max ||
			localY === max ||
			localZ === max
		);
	}
}

export function toLocalBlockCoordinates(
	worldX: number,
	worldY: number,
	worldZ: number,
): LocalBlockCoordinates {
	const chunkX = worldToChunkCoord(worldX);
	const chunkY = worldToChunkCoord(worldY);
	const chunkZ = worldToChunkCoord(worldZ);

	const localX = worldToBlockCoord(worldX);
	const localY = worldToBlockCoord(worldY);
	const localZ = worldToBlockCoord(worldZ);

	return {
		worldX,
		worldY,
		worldZ,
		chunkX,
		chunkY,
		chunkZ,
		localX,
		localY,
		localZ,
		chunk: getChunk(chunkX, chunkY, chunkZ),
	};
}

export function getBlockStateByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
): number {
	const coords = toLocalBlockCoordinates(worldX, worldY, worldZ);
	if (!coords.chunk) return 0;
	return coords.chunk.getBlockState(
		coords.localX,
		coords.localY,
		coords.localZ,
	);
}
