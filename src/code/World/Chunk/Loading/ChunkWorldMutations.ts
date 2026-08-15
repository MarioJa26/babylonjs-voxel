import { worldToBlockCoord, worldToChunkCoord } from "@/code/Lib/VoxelMath";
import { Chunk, getChunk } from "../Chunk";

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

const _localCoordsScratch: LocalBlockCoordinates = {
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
};

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

let _lastChunkX = NaN;
let _lastChunkY = NaN;
let _lastChunkZ = NaN;
let _lastChunk: Chunk | undefined;

function resolveCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
): ResolvedChunkCoords {
	const chunkX = worldToChunkCoord(worldX);
	const chunkY = worldToChunkCoord(worldY);
	const chunkZ = worldToChunkCoord(worldZ);

	const scratch = _coordScratch;
	scratch.chunkX = chunkX;
	scratch.chunkY = chunkY;
	scratch.chunkZ = chunkZ;
	scratch.localX = worldToBlockCoord(worldX);
	scratch.localY = worldToBlockCoord(worldY);
	scratch.localZ = worldToBlockCoord(worldZ);

	if (
		chunkX !== _lastChunkX ||
		chunkY !== _lastChunkY ||
		chunkZ !== _lastChunkZ
	) {
		_lastChunkX = chunkX;
		_lastChunkY = chunkY;
		_lastChunkZ = chunkZ;
		_lastChunk = getChunk(chunkX, chunkY, chunkZ);
	}

	scratch.chunk = _lastChunk;
	return scratch;
}

function fillMutationContext(
	ctx: BlockMutationContext,
	worldX: number,
	worldY: number,
	worldZ: number,
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	localX: number,
	localY: number,
	localZ: number,
	chunk: Chunk,
	previousBlockId: number,
	previousBlockState: number,
	nextBlockId: number,
	nextBlockState: number,
): BlockMutationContext {
	ctx.worldX = worldX;
	ctx.worldY = worldY;
	ctx.worldZ = worldZ;
	ctx.chunkX = chunkX;
	ctx.chunkY = chunkY;
	ctx.chunkZ = chunkZ;
	ctx.localX = localX;
	ctx.localY = localY;
	ctx.localZ = localZ;
	ctx.chunk = chunk;
	ctx.previousBlockId = previousBlockId;
	ctx.previousBlockState = previousBlockState;
	ctx.nextBlockId = nextBlockId;
	ctx.nextBlockState = nextBlockState;
	return ctx;
}

function isBoundaryLocalCoord(
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
		const chunk = coords.chunk;

		return chunk
			? chunk.getBlock(coords.localX, coords.localY, coords.localZ)
			: 0;
	}

	public getLightByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		const coords = resolveCoords(worldX, worldY, worldZ);
		const chunk = coords.chunk;

		return chunk
			? chunk.getLight(coords.localX, coords.localY, coords.localZ)
			: 0;
	}

	public setBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
		state: number = 0,
	): boolean {
		const coords = resolveCoords(worldX, worldY, worldZ);
		const chunk = coords.chunk;

		if (!chunk) {
			return false;
		}

		// Copy all scratch-derived values into locals before callbacks.
		// Adapter callbacks may perform nested lookups/mutations that reuse _coordScratch.
		const chunkX = coords.chunkX;
		const chunkY = coords.chunkY;
		const chunkZ = coords.chunkZ;
		const localX = coords.localX;
		const localY = coords.localY;
		const localZ = coords.localZ;

		const previousBlockId = chunk.getBlock(localX, localY, localZ);
		const previousBlockState = chunk.getBlockState(localX, localY, localZ);

		const ctx = fillMutationContext(
			_ctxScratch,
			worldX,
			worldY,
			worldZ,
			chunkX,
			chunkY,
			chunkZ,
			localX,
			localY,
			localZ,
			chunk,
			previousBlockId,
			previousBlockState,
			blockId,
			state,
		);

		const adapter = this.adapter;

		adapter.onBeforeSetBlock?.(ctx);

		chunk.setBlock(localX, localY, localZ, blockId, state);

		if (isBoundaryLocalCoord(localX, localY, localZ)) {
			adapter.onBoundaryMutation?.(ctx);
		}

		adapter.onAfterSetBlock?.(ctx);
		return true;
	}

	public deleteBlock(worldX: number, worldY: number, worldZ: number): boolean {
		const coords = resolveCoords(worldX, worldY, worldZ);
		const chunk = coords.chunk;

		if (!chunk) {
			return false;
		}

		// Copy all scratch-derived values into locals before callbacks.
		// Adapter callbacks may perform nested lookups/mutations that reuse _coordScratch.
		const chunkX = coords.chunkX;
		const chunkY = coords.chunkY;
		const chunkZ = coords.chunkZ;
		const localX = coords.localX;
		const localY = coords.localY;
		const localZ = coords.localZ;

		const previousBlockId = chunk.getBlock(localX, localY, localZ);
		const previousBlockState = chunk.getBlockState(localX, localY, localZ);

		const ctx = fillMutationContext(
			_ctxScratch,
			worldX,
			worldY,
			worldZ,
			chunkX,
			chunkY,
			chunkZ,
			localX,
			localY,
			localZ,
			chunk,
			previousBlockId,
			previousBlockState,
			0,
			0,
		);

		const adapter = this.adapter;

		adapter.onBeforeDeleteBlock?.(ctx);

		chunk.deleteBlock(localX, localY, localZ);

		if (isBoundaryLocalCoord(localX, localY, localZ)) {
			adapter.onBoundaryMutation?.(ctx);
		}

		adapter.onAfterDeleteBlock?.(ctx);
		return true;
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

	const s = _localCoordsScratch;
	s.worldX = worldX;
	s.worldY = worldY;
	s.worldZ = worldZ;
	s.chunkX = chunkX;
	s.chunkY = chunkY;
	s.chunkZ = chunkZ;
	s.localX = worldToBlockCoord(worldX);
	s.localY = worldToBlockCoord(worldY);
	s.localZ = worldToBlockCoord(worldZ);
	s.chunk = getChunk(chunkX, chunkY, chunkZ);

	return s;
}

export function getBlockStateByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
): number {
	const coords = resolveCoords(worldX, worldY, worldZ);
	const chunk = coords.chunk;

	return chunk
		? chunk.getBlockState(coords.localX, coords.localY, coords.localZ)
		: 0;
}
