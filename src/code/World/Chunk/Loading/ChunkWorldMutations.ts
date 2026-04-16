import { Chunk } from "../Chunk";

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

export class ChunkWorldMutations {
	public constructor(
		private readonly adapter: ChunkWorldMutationsAdapter = {},
	) {}

	public worldToChunkCoord(value: number): number {
		return Math.floor(value / Chunk.SIZE);
	}

	public worldToBlockCoord(value: number): number {
		// Ensure we convert to integer local block coordinate in range [0, Chunk.SIZE-1]
		return ((Math.floor(value) % Chunk.SIZE) + Chunk.SIZE) % Chunk.SIZE;
	}

	public getBlockByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		const coords = this.toLocalBlockCoordinates(worldX, worldY, worldZ);
		if (!coords.chunk) return 0;
		return coords.chunk.getBlock(coords.localX, coords.localY, coords.localZ);
	}

	public getBlockStateByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		const coords = this.toLocalBlockCoordinates(worldX, worldY, worldZ);
		if (!coords.chunk) return 0;
		return coords.chunk.getBlockState(
			coords.localX,
			coords.localY,
			coords.localZ,
		);
	}

	public getLightByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		const coords = this.toLocalBlockCoordinates(worldX, worldY, worldZ);
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
		const coords = this.toLocalBlockCoordinates(worldX, worldY, worldZ);

		if (!coords.chunk) {
			this.adapter.onMissingChunk?.(coords);
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

		const ctx: BlockMutationContext = {
			...coords,
			previousBlockId,
			previousBlockState,
			nextBlockId: blockId,
			nextBlockState: state,
		};

		this.adapter.onBeforeSetBlock?.(ctx);

		coords.chunk.setBlock(
			coords.localX,
			coords.localY,
			coords.localZ,
			blockId,
			state,
		);
		coords.chunk.isModified = true;
		coords.chunk.scheduleRemesh(true);

		if (
			this.isBoundaryLocalCoord(coords.localX, coords.localY, coords.localZ)
		) {
			this.adapter.onBoundaryMutation?.(ctx);
		}

		this.adapter.onAfterSetBlock?.(ctx);
		return true;
	}

	public deleteBlock(worldX: number, worldY: number, worldZ: number): boolean {
		const coords = this.toLocalBlockCoordinates(worldX, worldY, worldZ);

		if (!coords.chunk) {
			this.adapter.onMissingChunk?.(coords);
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

		const ctx: BlockMutationContext = {
			...coords,
			previousBlockId,
			previousBlockState,
			nextBlockId: 0,
			nextBlockState: 0,
		};

		this.adapter.onBeforeDeleteBlock?.(ctx);

		coords.chunk.deleteBlock(coords.localX, coords.localY, coords.localZ);
		coords.chunk.isModified = true;
		coords.chunk.scheduleRemesh(true);

		if (
			this.isBoundaryLocalCoord(coords.localX, coords.localY, coords.localZ)
		) {
			this.adapter.onBoundaryMutation?.(ctx);
		}

		this.adapter.onAfterDeleteBlock?.(ctx);
		return true;
	}

	public toLocalBlockCoordinates(
		worldX: number,
		worldY: number,
		worldZ: number,
	): LocalBlockCoordinates {
		const chunkX = this.worldToChunkCoord(worldX);
		const chunkY = this.worldToChunkCoord(worldY);
		const chunkZ = this.worldToChunkCoord(worldZ);

		const localX = this.worldToBlockCoord(worldX);
		const localY = this.worldToBlockCoord(worldY);
		const localZ = this.worldToBlockCoord(worldZ);

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
			chunk: Chunk.getChunk(chunkX, chunkY, chunkZ),
		};
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
