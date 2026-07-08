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

// Cache the most-recently-resolved chunk so repeated world-coordinate
// lookups that fall in the same chunk (the dominant case inside the water
// sim's flow BFS and other tight loops) skip the packCoords() BigInt
// allocation + Map<bigint,Chunk>.get() on every call.
let _lastChunkX = NaN;
let _lastChunkY = NaN;
let _lastChunkZ = NaN;
let _lastChunk: Chunk | undefined;

function resolveCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
): ResolvedChunkCoords {
	const scratch = _coordScratch;
	const cx = worldToChunkCoord(worldX);
	const cy = worldToChunkCoord(worldY);
	const cz = worldToChunkCoord(worldZ);
	scratch.chunkX = cx;
	scratch.chunkY = cy;
	scratch.chunkZ = cz;
	scratch.localX = worldToBlockCoord(worldX);
	scratch.localY = worldToBlockCoord(worldY);
	scratch.localZ = worldToBlockCoord(worldZ);
	if (cx !== _lastChunkX || cy !== _lastChunkY || cz !== _lastChunkZ) {
		_lastChunkX = cx;
		_lastChunkY = cy;
		_lastChunkZ = cz;
		_lastChunk = getChunk(cx, cy, cz);
	}
	scratch.chunk = _lastChunk;
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
	const s = _localCoordsScratch;
	s.worldX = worldX;
	s.worldY = worldY;
	s.worldZ = worldZ;
	s.chunkX = worldToChunkCoord(worldX);
	s.chunkY = worldToChunkCoord(worldY);
	s.chunkZ = worldToChunkCoord(worldZ);
	s.localX = worldToBlockCoord(worldX);
	s.localY = worldToBlockCoord(worldY);
	s.localZ = worldToBlockCoord(worldZ);
	s.chunk = getChunk(s.chunkX, s.chunkY, s.chunkZ);
	return s;
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
