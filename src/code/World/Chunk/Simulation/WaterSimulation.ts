import {
	BlockType,
	getWaterLevel,
	isWaterSource,
} from "../../Texture/BlockType";

export interface WaterBlockAccess {
	getBlock(x: number, y: number, z: number): number;
	getBlockState(x: number, y: number, z: number): number;
	getBlockAndStateInto(
		x: number,
		y: number,
		z: number,
		out: { blockId: number; blockState: number },
	): void;
	setBlock(
		x: number,
		y: number,
		z: number,
		blockId: number,
		state: number,
	): void;
}

export interface WaterScheduler {
	schedule(x: number, y: number, z: number, delay: number): void;
	processFrame(): void;
}

export type BlockAndStateOut = {
	blockId: number;
	blockState: number;
};

const HORIZONTAL_DX = new Int8Array([1, -1, 0, 0]);
const HORIZONTAL_DZ = new Int8Array([0, 0, 1, -1]);
const HORIZONTAL_DIR_COUNT = 4;

const NEIGHBOR_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const NEIGHBOR_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const NEIGHBOR_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);
const NEIGHBOR_COUNT = 6;

const FLOW_SEARCH_DEPTH = 5;
const FLOW_GRID_DIM = FLOW_SEARCH_DEPTH * 2 + 1;
const FLOW_GRID_CENTER = FLOW_SEARCH_DEPTH;
const FLOW_GRID_CELLS = FLOW_GRID_DIM * FLOW_GRID_DIM;

const FLOW_NOT_FOUND = 255;
const FLOW_CACHE_UNKNOWN = -1;
const WATER_SOURCE_STATE = 0;

function packBlockAndState(blockId: number, blockState: number): number {
	return (blockId & 0xffff) | ((blockState & 0xffff) << 16);
}

function unpackBlockId(packed: number): number {
	return packed & 0xffff;
}

function unpackBlockState(packed: number): number {
	return packed >>> 16;
}

export class WaterSimulation {
	private readonly blockAndState: BlockAndStateOut = {
		blockId: 0,
		blockState: 0,
	};

	private readonly flowVisitEpoch = new Int32Array(FLOW_GRID_CELLS);
	private flowEpoch = 0;

	private readonly flowQueueRdx = new Int8Array(FLOW_GRID_CELLS);
	private readonly flowQueueRdz = new Int8Array(FLOW_GRID_CELLS);
	private readonly flowQueueDist = new Uint8Array(FLOW_GRID_CELLS);
	private readonly flowCosts = new Uint8Array(HORIZONTAL_DIR_COUNT);

	/**
	 * Stores the complete packed ID/state value, not only the ID. This lets
	 * flowInto reuse both values without performing another world lookup.
	 */
	private readonly flowDirectionTargetPacked = new Int32Array(
		HORIZONTAL_DIR_COUNT,
	);

	private readonly flowGridPacked = new Int32Array(FLOW_GRID_CELLS);
	private readonly flowHoleGridPacked = new Int32Array(FLOW_GRID_CELLS);

	constructor(
		private readonly blocks: WaterBlockAccess,
		private readonly scheduler: WaterScheduler,
	) {}

	private isReplaceableBlock(blockId: number): boolean {
		return (
			blockId === BlockType.Air ||
			blockId === BlockType.GrassCross ||
			blockId === BlockType.SavannahGrassCross ||
			blockId === BlockType.Grass006Cross
		);
	}

	private isSolidBlock(blockId: number): boolean {
		return (
			blockId !== BlockType.Air &&
			blockId !== BlockType.Water &&
			blockId !== BlockType.GrassCross &&
			blockId !== BlockType.SavannahGrassCross &&
			blockId !== BlockType.Grass006Cross &&
			blockId !== BlockType.Torch
		);
	}

	private scheduleNeighborUpdates(
		worldX: number,
		worldY: number,
		worldZ: number,
		excludeDx = 0,
		excludeDy = 0,
		excludeDz = 0,
	): void {
		for (let i = 0; i < NEIGHBOR_COUNT; i++) {
			const dx = NEIGHBOR_DX[i];
			const dy = NEIGHBOR_DY[i];
			const dz = NEIGHBOR_DZ[i];

			if (dx === excludeDx && dy === excludeDy && dz === excludeDz) {
				continue;
			}

			this.scheduler.schedule(worldX + dx, worldY + dy, worldZ + dz, 5);
		}
	}

	private flowGridIndex(rdx: number, rdz: number): number {
		return (rdz + FLOW_GRID_CENTER) * FLOW_GRID_DIM + rdx + FLOW_GRID_CENTER;
	}

	private cachedFlowCell(
		layer: Int32Array,
		worldX: number,
		worldY: number,
		worldZ: number,
		rdx: number,
		rdz: number,
	): number {
		const index = this.flowGridIndex(rdx, rdz);
		const cached = layer[index];

		if (cached !== FLOW_CACHE_UNKNOWN) {
			return cached;
		}

		this.blocks.getBlockAndStateInto(
			worldX + rdx,
			worldY,
			worldZ + rdz,
			this.blockAndState,
		);

		const packed = packBlockAndState(
			this.blockAndState.blockId,
			this.blockAndState.blockState,
		);

		layer[index] = packed;
		return packed;
	}

	/**
	 * Advances the visit generation while preventing signed Int32 epoch
	 * rollover from making old cells appear visited.
	 */
	private nextFlowEpoch(): number {
		if (this.flowEpoch === 0x7fffffff) {
			this.flowVisitEpoch.fill(0);
			this.flowEpoch = 1;
		} else {
			this.flowEpoch++;
		}

		return this.flowEpoch;
	}

	private findFlowCosts(worldX: number, worldY: number, worldZ: number): void {
		for (
			let directionIndex = 0;
			directionIndex < HORIZONTAL_DIR_COUNT;
			directionIndex++
		) {
			const initialDx = HORIZONTAL_DX[directionIndex];
			const initialDz = HORIZONTAL_DZ[directionIndex];

			this.flowCosts[directionIndex] = FLOW_NOT_FOUND;

			const startPacked = this.cachedFlowCell(
				this.flowGridPacked,
				worldX,
				worldY,
				worldZ,
				initialDx,
				initialDz,
			);

			if (this.isSolidBlock(unpackBlockId(startPacked))) {
				continue;
			}

			const epoch = this.nextFlowEpoch();
			const startIndex = this.flowGridIndex(initialDx, initialDz);

			this.flowVisitEpoch[startIndex] = epoch;
			this.flowQueueRdx[0] = initialDx;
			this.flowQueueRdz[0] = initialDz;
			this.flowQueueDist[0] = 1;

			let queueHead = 0;
			let queueTail = 1;

			while (queueHead < queueTail) {
				const rdx = this.flowQueueRdx[queueHead];
				const rdz = this.flowQueueRdz[queueHead];
				const distance = this.flowQueueDist[queueHead];

				queueHead++;

				const belowPacked = this.cachedFlowCell(
					this.flowHoleGridPacked,
					worldX,
					worldY - 1,
					worldZ,
					rdx,
					rdz,
				);

				if (!this.isSolidBlock(unpackBlockId(belowPacked))) {
					this.flowCosts[directionIndex] = distance;
					break;
				}

				if (distance >= FLOW_SEARCH_DEPTH) {
					continue;
				}

				for (
					let neighborDirection = 0;
					neighborDirection < HORIZONTAL_DIR_COUNT;
					neighborDirection++
				) {
					const neighborRdx = rdx + HORIZONTAL_DX[neighborDirection];
					const neighborRdz = rdz + HORIZONTAL_DZ[neighborDirection];

					if (
						neighborRdx < -FLOW_GRID_CENTER ||
						neighborRdx > FLOW_GRID_CENTER ||
						neighborRdz < -FLOW_GRID_CENTER ||
						neighborRdz > FLOW_GRID_CENTER
					) {
						continue;
					}

					const neighborIndex = this.flowGridIndex(neighborRdx, neighborRdz);

					if (this.flowVisitEpoch[neighborIndex] === epoch) {
						continue;
					}

					const neighborPacked = this.cachedFlowCell(
						this.flowGridPacked,
						worldX,
						worldY,
						worldZ,
						neighborRdx,
						neighborRdz,
					);

					if (this.isSolidBlock(unpackBlockId(neighborPacked))) {
						continue;
					}

					this.flowVisitEpoch[neighborIndex] = epoch;
					this.flowQueueRdx[queueTail] = neighborRdx;
					this.flowQueueRdz[queueTail] = neighborRdz;
					this.flowQueueDist[queueTail] = distance + 1;
					queueTail++;
				}
			}
		}
	}

	private getFlowDirectionMask(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		this.flowGridPacked.fill(FLOW_CACHE_UNKNOWN);
		this.flowHoleGridPacked.fill(FLOW_CACHE_UNKNOWN);

		let validMask = 0;
		let dropMask = 0;

		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			const dx = HORIZONTAL_DX[i];
			const dz = HORIZONTAL_DZ[i];

			const targetPacked = this.cachedFlowCell(
				this.flowGridPacked,
				worldX,
				worldY,
				worldZ,
				dx,
				dz,
			);

			this.flowDirectionTargetPacked[i] = targetPacked;

			const targetId = unpackBlockId(targetPacked);
			let canFlow = this.isReplaceableBlock(targetId);

			if (targetId === BlockType.Water) {
				const targetState = unpackBlockState(targetPacked);

				canFlow =
					!isWaterSource(targetId, targetState) &&
					getWaterLevel(targetId, targetState) > 0;
			}

			if (!canFlow) {
				continue;
			}

			const directionBit = 1 << i;
			validMask |= directionBit;

			const belowPacked = this.cachedFlowCell(
				this.flowHoleGridPacked,
				worldX,
				worldY - 1,
				worldZ,
				dx,
				dz,
			);

			if (!this.isSolidBlock(unpackBlockId(belowPacked))) {
				dropMask |= directionBit;
			}
		}

		if (validMask === 0) {
			return 0;
		}

		if (dropMask !== 0) {
			return dropMask;
		}

		this.findFlowCosts(worldX, worldY, worldZ);

		let minimumCost = FLOW_NOT_FOUND;

		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			if ((validMask & (1 << i)) === 0) {
				continue;
			}

			const cost = this.flowCosts[i];

			if (cost < minimumCost) {
				minimumCost = cost;
			}
		}

		if (minimumCost === FLOW_NOT_FOUND) {
			return validMask;
		}

		let bestMask = 0;

		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			if ((validMask & (1 << i)) !== 0 && this.flowCosts[i] === minimumCost) {
				bestMask |= 1 << i;
			}
		}

		return bestMask;
	}

	private placeWaterSource(
		worldX: number,
		worldY: number,
		worldZ: number,
	): void {
		this.blocks.setBlock(
			worldX,
			worldY,
			worldZ,
			BlockType.Water,
			WATER_SOURCE_STATE,
		);
	}

	private placeWaterFlowing(
		worldX: number,
		worldY: number,
		worldZ: number,
		level: number,
	): void {
		this.blocks.setBlock(worldX, worldY, worldZ, BlockType.Water, level & 0xf);
	}

	private removeWater(worldX: number, worldY: number, worldZ: number): void {
		this.blocks.setBlock(worldX, worldY, worldZ, BlockType.Air, 0);
	}

	/**
	 * targetPacked avoids another block lookup when the caller has already
	 * read both target ID and target state.
	 */
	private flowInto(
		worldX: number,
		worldY: number,
		worldZ: number,
		newLevel: number,
		excludeDx: number,
		excludeDy: number,
		excludeDz: number,
		targetPacked?: number,
	): boolean {
		let targetId: number;
		let targetState: number;

		if (targetPacked !== undefined) {
			targetId = unpackBlockId(targetPacked);
			targetState = unpackBlockState(targetPacked);
		} else {
			this.blocks.getBlockAndStateInto(
				worldX,
				worldY,
				worldZ,
				this.blockAndState,
			);

			targetId = this.blockAndState.blockId;
			targetState = this.blockAndState.blockState;
		}

		if (targetId === BlockType.Water) {
			if (isWaterSource(targetId, targetState)) {
				return false;
			}

			if (getWaterLevel(targetId, targetState) <= newLevel) {
				return false;
			}
		} else if (!this.isReplaceableBlock(targetId)) {
			return false;
		}

		this.placeWaterFlowing(worldX, worldY, worldZ, newLevel);

		this.scheduler.schedule(worldX, worldY, worldZ, 5);

		this.scheduleNeighborUpdates(
			worldX,
			worldY,
			worldZ,
			excludeDx,
			excludeDy,
			excludeDz,
		);

		return true;
	}

	private checkRetract(
		worldX: number,
		worldY: number,
		worldZ: number,
		level: number,
		aboveId: number,
	): boolean {
		if (aboveId === BlockType.Water) {
			return false;
		}

		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			this.blocks.getBlockAndStateInto(
				worldX + HORIZONTAL_DX[i],
				worldY,
				worldZ + HORIZONTAL_DZ[i],
				this.blockAndState,
			);

			const neighborId = this.blockAndState.blockId;

			if (neighborId !== BlockType.Water) {
				continue;
			}

			const neighborState = this.blockAndState.blockState;

			if (
				isWaterSource(neighborId, neighborState) ||
				getWaterLevel(neighborId, neighborState) < level
			) {
				return false;
			}
		}

		this.removeWater(worldX, worldY, worldZ);
		this.scheduleNeighborUpdates(worldX, worldY, worldZ);

		return true;
	}

	private checkInfiniteSource(
		worldX: number,
		worldY: number,
		worldZ: number,
	): boolean {
		let sourceCount = 0;

		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			this.blocks.getBlockAndStateInto(
				worldX + HORIZONTAL_DX[i],
				worldY,
				worldZ + HORIZONTAL_DZ[i],
				this.blockAndState,
			);

			const neighborId = this.blockAndState.blockId;

			if (
				neighborId === BlockType.Water &&
				isWaterSource(neighborId, this.blockAndState.blockState)
			) {
				sourceCount++;

				if (sourceCount >= 2) {
					return true;
				}
			}
		}

		return false;
	}

	processWaterUpdate(worldX: number, worldY: number, worldZ: number): void {
		this.blocks.getBlockAndStateInto(
			worldX,
			worldY,
			worldZ,
			this.blockAndState,
		);

		const blockId = this.blockAndState.blockId;

		if (blockId !== BlockType.Water) {
			return;
		}

		const level = getWaterLevel(blockId, this.blockAndState.blockState);

		this.blocks.getBlockAndStateInto(
			worldX,
			worldY + 1,
			worldZ,
			this.blockAndState,
		);

		const aboveId = this.blockAndState.blockId;
		const isFedFromAbove = aboveId === BlockType.Water;

		if (level > 0) {
			if (!isFedFromAbove && this.checkInfiniteSource(worldX, worldY, worldZ)) {
				this.placeWaterSource(worldX, worldY, worldZ);

				this.scheduleNeighborUpdates(worldX, worldY, worldZ);

				return;
			}

			if (this.checkRetract(worldX, worldY, worldZ, level, aboveId)) {
				return;
			}
		}

		this.blocks.getBlockAndStateInto(
			worldX,
			worldY - 1,
			worldZ,
			this.blockAndState,
		);

		const belowPacked = packBlockAndState(
			this.blockAndState.blockId,
			this.blockAndState.blockState,
		);

		const belowId = this.blockAndState.blockId;

		const flowedDown = this.flowInto(
			worldX,
			worldY - 1,
			worldZ,
			1,
			0,
			1,
			0,
			belowPacked,
		);

		if (
			(level === 0 || (!flowedDown && level < 7)) &&
			this.isSolidBlock(belowId)
		) {
			const spreadLevel = Math.min(level + 1, 7);

			const directionMask = this.getFlowDirectionMask(worldX, worldY, worldZ);

			for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
				if ((directionMask & (1 << i)) === 0) {
					continue;
				}

				const dx = HORIZONTAL_DX[i];
				const dz = HORIZONTAL_DZ[i];

				this.flowInto(
					worldX + dx,
					worldY,
					worldZ + dz,
					spreadLevel,
					-dx,
					0,
					-dz,
					this.flowDirectionTargetPacked[i],
				);
			}
		}
	}

	private scheduleWaterNeighbors(
		worldX: number,
		worldY: number,
		worldZ: number,
	): void {
		for (let i = 0; i < NEIGHBOR_COUNT; i++) {
			const neighborX = worldX + NEIGHBOR_DX[i];
			const neighborY = worldY + NEIGHBOR_DY[i];
			const neighborZ = worldZ + NEIGHBOR_DZ[i];

			if (
				this.blocks.getBlock(neighborX, neighborY, neighborZ) ===
				BlockType.Water
			) {
				this.scheduler.schedule(neighborX, neighborY, neighborZ, 5);
			}
		}
	}

	scheduleWaterNeighborUpdate(
		worldX: number,
		worldY: number,
		worldZ: number,
	): void {
		this.scheduleWaterNeighbors(worldX, worldY, worldZ);

		this.scheduler.schedule(worldX, worldY, worldZ, 5);
	}

	scheduleBlockBreakWaterUpdates(
		worldX: number,
		worldY: number,
		worldZ: number,
	): void {
		this.scheduleWaterNeighborUpdate(worldX, worldY, worldZ);
	}

	scheduleBlockPlaceWaterUpdates(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
	): void {
		if (blockId !== BlockType.Water) {
			this.scheduleWaterNeighbors(worldX, worldY, worldZ);
		}

		this.scheduler.schedule(worldX, worldY, worldZ, 5);
	}

	checkNewInfiniteSource(worldX: number, worldY: number, worldZ: number): void {
		if (this.blocks.getBlock(worldX, worldY, worldZ) !== BlockType.Air) {
			return;
		}

		if (!this.checkInfiniteSource(worldX, worldY, worldZ)) {
			return;
		}

		this.placeWaterSource(worldX, worldY, worldZ);

		this.scheduleNeighborUpdates(worldX, worldY, worldZ);
	}
}

let defaultInstance: WaterSimulation | null = null;
let initPromise: Promise<WaterSimulation> | null = null;

async function createDefaultInstance(): Promise<WaterSimulation> {
	if (defaultInstance) {
		return defaultInstance;
	}

	const [chunkLoading, schedulerModule] = await Promise.all([
		import("../ChunkLoadingSystem"),
		import("./BlockTickScheduler"),
	]);

	const simulation = new WaterSimulation(
		{
			getBlock: chunkLoading.getBlockByWorldCoords,
			getBlockState: chunkLoading.getBlockStateByWorldCoords,
			getBlockAndStateInto: chunkLoading.getBlockAndStateByWorldCoordsInto,
			setBlock: chunkLoading.setBlock,
		},
		schedulerModule.BlockTickScheduler.getInstance(),
	);

	defaultInstance = simulation;
	return simulation;
}

export function ensureDefaultInstance(): Promise<WaterSimulation> {
	if (defaultInstance) {
		return Promise.resolve(defaultInstance);
	}

	return (initPromise ??= createDefaultInstance());
}

function getDefaultInstance(): WaterSimulation {
	if (defaultInstance) {
		return defaultInstance;
	}

	void ensureDefaultInstance();

	throw new Error(
		"WaterSimulation default instance is not initialized. " +
			"Await ensureDefaultInstance() during client startup before using " +
			"the synchronous compatibility exports.",
	);
}

export function processWaterUpdate(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	getDefaultInstance().processWaterUpdate(worldX, worldY, worldZ);
}

export function scheduleWaterNeighborUpdate(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	getDefaultInstance().scheduleWaterNeighborUpdate(worldX, worldY, worldZ);
}

export function scheduleBlockBreakWaterUpdates(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	getDefaultInstance().scheduleBlockBreakWaterUpdates(worldX, worldY, worldZ);
}

export function scheduleBlockPlaceWaterUpdates(
	worldX: number,
	worldY: number,
	worldZ: number,
	blockId: number,
): void {
	getDefaultInstance().scheduleBlockPlaceWaterUpdates(
		worldX,
		worldY,
		worldZ,
		blockId,
	);
}

export function checkNewInfiniteSource(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	getDefaultInstance().checkNewInfiniteSource(worldX, worldY, worldZ);
}
