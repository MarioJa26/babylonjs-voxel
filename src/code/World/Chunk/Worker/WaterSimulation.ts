import {
	BlockType,
	getWaterLevel,
	isWaterSource,
} from "../../Texture/BlockType";
import {
	type BlockAndStateOut,
	getBlockAndStateByWorldCoordsInto,
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
	setBlock,
} from "../ChunkLoadingSystem";
import { BlockTickScheduler } from "./BlockTickScheduler";

// Reusable out object for the combined block-id/state lookup — consumed
// synchronously at each call site, so sharing it is safe (same pattern as
// ChunkLoadingSystem's own scratch).
const _blockAndState: BlockAndStateOut = { blockId: 0, blockState: 0 };

// Flattened into parallel typed arrays instead of an array of [dx, dz]
// tuples — hot loops index straight into contiguous memory with no nested
// -array indirection and no per-iteration destructuring/iterator overhead.
const HORIZONTAL_DX = new Int8Array([1, -1, 0, 0]);
const HORIZONTAL_DZ = new Int8Array([0, 0, 1, -1]);
const HORIZONTAL_DIR_COUNT = 4;

const NEIGHBOR_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const NEIGHBOR_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const NEIGHBOR_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);
const NEIGHBOR_COUNT = 6;

function scheduleNeighborUpdates(
	worldX: number,
	worldY: number,
	worldZ: number,
	scheduler: BlockTickScheduler,
	// Direction back to the neighbor that caused this update, if any.
	// That neighbor's own state hasn't changed, so re-ticking it is pure
	// churn — excluding it keeps spread to a clean one-ring-per-tick
	// progression instead of pointlessly re-visiting the block we came from.
	excludeDx = 0,
	excludeDy = 0,
	excludeDz = 0,
): void {
	for (let i = 0; i < NEIGHBOR_COUNT; i++) {
		const dx = NEIGHBOR_DX[i];
		const dy = NEIGHBOR_DY[i];
		const dz = NEIGHBOR_DZ[i];
		if (dx === excludeDx && dy === excludeDy && dz === excludeDz) continue;
		scheduler.schedule(worldX + dx, worldY + dy, worldZ + dz, 5);
	}
}

function isSolidBlock(blockId: number): boolean {
	return (
		blockId !== BlockType.Air &&
		blockId !== BlockType.Water &&
		blockId !== BlockType.GrassCross &&
		blockId !== BlockType.SavannahGrassCross &&
		blockId !== BlockType.Grass006Cross &&
		blockId !== BlockType.Torch
	);
}

function canWaterPass(x: number, y: number, z: number): boolean {
	return !isSolidBlock(getBlockByWorldCoords(x, y, z));
}

function isHole(x: number, y: number, z: number): boolean {
	return !isSolidBlock(getBlockByWorldCoords(x, y - 1, z));
}

// --- Flow pathing (vanilla-style edge-seeking) ------------------------

const FLOW_SEARCH_DEPTH = 5; // matches vanilla's getSlopeFindDistance for water
const FLOW_GRID_DIM = FLOW_SEARCH_DEPTH * 2 + 1; // 9
const FLOW_GRID_CENTER = FLOW_SEARCH_DEPTH; // 4
const FLOW_GRID_CELLS = FLOW_GRID_DIM * FLOW_GRID_DIM; // 81
const FLOW_NOT_FOUND = 255;

// All BFS scratch state lives at module scope and is reused across every
// call via epoch-stamping (bump a counter, compare instead of clearing) —
// the same pattern as the OPFS LRU and sunlight-seed scratch buffers.
// queueTail can never exceed FLOW_GRID_CELLS since every grid cell is
// enqueued at most once (guarded by the epoch check before enqueue), so
// these fixed-size typed arrays are a safe, zero-allocation upper bound.
const flowVisitEpoch = new Int32Array(FLOW_GRID_CELLS);
let flowEpoch = 0;
const flowQueueRdx = new Int8Array(FLOW_GRID_CELLS);
const flowQueueRdz = new Int8Array(FLOW_GRID_CELLS);
const flowQueueDist = new Uint8Array(FLOW_GRID_CELLS);
const flowCosts = new Uint8Array(HORIZONTAL_DIR_COUNT);

// For each of the 4 cardinal directions, finds the distance (capped at
// FLOW_SEARCH_DEPTH) to the nearest reachable hole along a path that begins
// by stepping that way, writing results into `flowCosts`. This reproduces
// vanilla's real flow pathing (FlowingFluid#getSlopeDistance), which is why
// Minecraft water visibly seeks the nearest edge of a flat pool instead of
// spreading out as a uniform blob — a 1-block-only lookahead only catches
// the case where the drop is immediately adjacent.
function findFlowCosts(worldX: number, worldY: number, worldZ: number): void {
	for (let dirIdx = 0; dirIdx < HORIZONTAL_DIR_COUNT; dirIdx++) {
		const dx0 = HORIZONTAL_DX[dirIdx];
		const dz0 = HORIZONTAL_DZ[dirIdx];

		flowCosts[dirIdx] = FLOW_NOT_FOUND;

		const startX = worldX + dx0;
		const startZ = worldZ + dz0;
		if (!canWaterPass(startX, worldY, startZ)) continue;

		flowEpoch++;
		const epoch = flowEpoch;

		const startGridIdx =
			(dz0 + FLOW_GRID_CENTER) * FLOW_GRID_DIM + (dx0 + FLOW_GRID_CENTER);
		flowVisitEpoch[startGridIdx] = epoch;
		flowQueueRdx[0] = dx0;
		flowQueueRdz[0] = dz0;
		flowQueueDist[0] = 1;

		let queueHead = 0;
		let queueTail = 1;

		while (queueHead < queueTail) {
			const rdx = flowQueueRdx[queueHead];
			const rdz = flowQueueRdz[queueHead];
			const dist = flowQueueDist[queueHead];
			queueHead++;

			const x = worldX + rdx;
			const z = worldZ + rdz;

			if (isHole(x, worldY, z)) {
				flowCosts[dirIdx] = dist;
				break;
			}

			if (dist >= FLOW_SEARCH_DEPTH) continue;

			for (let d = 0; d < HORIZONTAL_DIR_COUNT; d++) {
				const nrdx = rdx + HORIZONTAL_DX[d];
				const nrdz = rdz + HORIZONTAL_DZ[d];
				if (
					nrdx < -FLOW_GRID_CENTER ||
					nrdx > FLOW_GRID_CENTER ||
					nrdz < -FLOW_GRID_CENTER ||
					nrdz > FLOW_GRID_CENTER
				) {
					continue;
				}

				const nGridIdx =
					(nrdz + FLOW_GRID_CENTER) * FLOW_GRID_DIM + (nrdx + FLOW_GRID_CENTER);
				if (flowVisitEpoch[nGridIdx] === epoch) continue;

				const nx = worldX + nrdx;
				const nz = worldZ + nrdz;
				if (!canWaterPass(nx, worldY, nz)) continue;

				flowVisitEpoch[nGridIdx] = epoch;
				flowQueueRdx[queueTail] = nrdx;
				flowQueueRdz[queueTail] = nrdz;
				flowQueueDist[queueTail] = dist + 1;
				queueTail++;
			}
		}
	}
}

// Returns a bitmask over HORIZONTAL_DX/DZ indices (bit i set = flow into
// that direction this tick). A bitmask instead of an array of direction
// pairs means the per-tick spread decision allocates nothing.
function getFlowDirectionMask(
	worldX: number,
	worldY: number,
	worldZ: number,
): number {
	let validMask = 0;
	let dropMask = 0;

	for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
		const dx = HORIZONTAL_DX[i];
		const dz = HORIZONTAL_DZ[i];
		const nx = worldX + dx;
		const nz = worldZ + dz;
		const targetId = getBlockByWorldCoords(nx, worldY, nz);

		let canFlow = false;
		if (
			targetId === BlockType.Air ||
			targetId === BlockType.GrassCross ||
			targetId === BlockType.SavannahGrassCross ||
			targetId === BlockType.Grass006Cross
		) {
			canFlow = true;
		} else if (targetId === BlockType.Water) {
			const targetState = getBlockStateByWorldCoords(nx, worldY, nz);
			if (!isWaterSource(targetId, targetState)) {
				if (getWaterLevel(targetId, targetState) > 0) canFlow = true;
			}
		}
		if (!canFlow) continue;

		validMask |= 1 << i;

		const belowNeighbor = getBlockByWorldCoords(nx, worldY - 1, nz);
		if (!isSolidBlock(belowNeighbor)) dropMask |= 1 << i;
	}

	if (validMask === 0) return 0;
	if (dropMask !== 0) return dropMask;

	findFlowCosts(worldX, worldY, worldZ);

	let minCost = FLOW_NOT_FOUND;
	for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
		if ((validMask & (1 << i)) === 0) continue;
		const cost = flowCosts[i];
		if (cost < minCost) minCost = cost;
	}

	// Nothing reachable within FLOW_SEARCH_DEPTH — fall back to spreading
	// into every valid direction evenly, same as vanilla past its own
	// search radius.
	if (minCost === FLOW_NOT_FOUND) return validMask;

	let bestMask = 0;
	for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
		if ((validMask & (1 << i)) === 0) continue;
		if (flowCosts[i] === minCost) bestMask |= 1 << i;
	}
	return bestMask;
}

const WATER_SOURCE_STATE = 0; // level 0 = source

function placeWaterSource(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	setBlock(worldX, worldY, worldZ, BlockType.Water, WATER_SOURCE_STATE);
}

function placeWaterFlowing(
	worldX: number,
	worldY: number,
	worldZ: number,
	level: number,
): void {
	setBlock(worldX, worldY, worldZ, BlockType.Water, level & 0xf);
}

function removeWater(worldX: number, worldY: number, worldZ: number): void {
	setBlock(worldX, worldY, worldZ, BlockType.Air, 0);
}

// Attempts to flow water of `newLevel` strength into a target cell.
// - Empty air: filled outright.
// - Existing water: overwritten only if it's strictly weaker (a higher
//   level number) than the incoming flow. Sources are never overwritten.
// - Anything else (solid, or existing water that's equal/stronger): no-op.
// Returns whether the flow actually happened, so callers can tell.
function flowInto(
	worldX: number,
	worldY: number,
	worldZ: number,
	newLevel: number,
	scheduler: BlockTickScheduler,
	excludeDx: number,
	excludeDy: number,
	excludeDz: number,
	targetId?: number,
): boolean {
	const id =
		targetId !== undefined
			? targetId
			: getBlockByWorldCoords(worldX, worldY, worldZ);

	if (id === BlockType.Water) {
		const targetState = getBlockStateByWorldCoords(worldX, worldY, worldZ);
		if (isWaterSource(id, targetState)) return false;

		const targetLevel = getWaterLevel(id, targetState);
		// Only overwrite if incoming water is strictly stronger (lower level number)
		if (targetLevel <= newLevel) return false;
	} else if (
		id !== BlockType.Air &&
		id !== BlockType.GrassCross &&
		id !== BlockType.SavannahGrassCross &&
		id !== BlockType.Grass006Cross
	) {
		return false;
	}

	placeWaterFlowing(worldX, worldY, worldZ, newLevel);
	scheduler.schedule(worldX, worldY, worldZ, 5);
	scheduleNeighborUpdates(
		worldX,
		worldY,
		worldZ,
		scheduler,
		excludeDx,
		excludeDy,
		excludeDz,
	);
	return true;
}

function checkRetract(
	worldX: number,
	worldY: number,
	worldZ: number,
	level: number,
	scheduler: BlockTickScheduler,
	aboveId?: number,
): boolean {
	// A block fed by water directly above it is a falling/waterfall block —
	// always considered supported as long as there's water above it.
	const above =
		aboveId !== undefined
			? aboveId
			: getBlockByWorldCoords(worldX, worldY + 1, worldZ);
	if (above === BlockType.Water) {
		return false;
	}

	let hasSupport = false;
	for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
		const dx = HORIZONTAL_DX[i];
		const dz = HORIZONTAL_DZ[i];
		const nbId = getBlockByWorldCoords(worldX + dx, worldY, worldZ + dz);
		if (nbId !== BlockType.Water) continue;

		const nbState = getBlockStateByWorldCoords(
			worldX + dx,
			worldY,
			worldZ + dz,
		);

		// A source always supports its neighbors. A flowing (non-source)
		// neighbor only counts as support if it's strictly stronger (lower
		// level number) — that's the block this level was actually fed from.
		if (isWaterSource(nbId, nbState)) {
			hasSupport = true;
			break;
		}
		const nbLevel = getWaterLevel(nbId, nbState);
		// Support only comes from strictly stronger neighbor (lower level)
		if (nbLevel < level) {
			hasSupport = true;
			break;
		}
	}

	if (!hasSupport) {
		removeWater(worldX, worldY, worldZ);
		scheduleNeighborUpdates(worldX, worldY, worldZ, scheduler);
		return true;
	}
	return false;
}

// Returns whether this cell has 2+ cardinally-adjacent source blocks —
// vanilla's trigger for turning flowing water into a source (the "infinite
// water" mechanic: two buckets emptied into a 2-wide gap fill it as
// flowing water, which then solidifies into a permanent source).
function checkInfiniteSource(
	worldX: number,
	worldY: number,
	worldZ: number,
): boolean {
	let sourceCount = 0;
	for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
		const dx = HORIZONTAL_DX[i];
		const dz = HORIZONTAL_DZ[i];
		getBlockAndStateByWorldCoordsInto(
			worldX + dx,
			worldY,
			worldZ + dz,
			_blockAndState,
		);
		const nbId = _blockAndState.blockId;
		const nbState = _blockAndState.blockState;
		if (nbId === BlockType.Water && isWaterSource(nbId, nbState)) {
			sourceCount++;
			if (sourceCount >= 2) return true;
		}
	}
	return false;
}

export function processWaterUpdate(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	const scheduler = BlockTickScheduler.getInstance();

	getBlockAndStateByWorldCoordsInto(worldX, worldY, worldZ, _blockAndState);
	const blockId = _blockAndState.blockId;
	if (blockId !== BlockType.Water) return;

	const state = _blockAndState.blockState;
	const level = getWaterLevel(blockId, state);

	// Hoist aboveId to top of function so it's available for both
	// infinite-source check and horizontal spread strength reset.
	const aboveId = getBlockByWorldCoords(worldX, worldY + 1, worldZ);
	const isFedFromAbove = aboveId === BlockType.Water;

	if (level > 0) {
		// Two-source merge, checked every tick (not just on air cells) so a
		// gap that has already filled with flowing water actually solidifies
		// into a source once it's flanked by two sources. Skipped while
		// falling (water directly above) so a waterfall segment passing
		// between two distant sources doesn't spontaneously solidify mid-air.
		if (!isFedFromAbove && checkInfiniteSource(worldX, worldY, worldZ)) {
			placeWaterSource(worldX, worldY, worldZ);
			scheduleNeighborUpdates(worldX, worldY, worldZ, scheduler);
			return;
		}

		const retracted = checkRetract(
			worldX,
			worldY,
			worldZ,
			level,
			scheduler,
			aboveId,
		);
		if (retracted) return;
	}

	const belowId = getBlockByWorldCoords(worldX, worldY - 1, worldZ);
	const flowedDown = flowInto(
		worldX,
		worldY - 1,
		worldZ,
		1, // Falling water always carries constant non-source level
		scheduler,
		0,
		1,
		0,
		belowId,
	);

	// Matches vanilla: if this block could fall, it falls — it does not also
	// spread sideways in the same tick.
	// Level 7 can't spread further (weakest flowing level).
	if (level === 0 || (!flowedDown && level < 7)) {
		const belowIsSolid = isSolidBlock(belowId);

		if (belowIsSolid) {
			// Spread at current level + 1 (weaker than self).
			// Waterfall base at level 1 spreads at level 2, which is supported
			// by the base (1 < 2), cascading outward to level 7 (7-tile radius).
			const spreadLevel = Math.min(level + 1, 7);
			const directionMask = getFlowDirectionMask(worldX, worldY, worldZ);

			for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
				if ((directionMask & (1 << i)) === 0) continue;
				const dx = HORIZONTAL_DX[i];
				const dz = HORIZONTAL_DZ[i];
				flowInto(
					worldX + dx,
					worldY,
					worldZ + dz,
					spreadLevel,
					scheduler,
					-dx,
					0,
					-dz,
				);
			}
		}
	}
}

function scheduleWaterNeighbors(
	worldX: number,
	worldY: number,
	worldZ: number,
	scheduler: BlockTickScheduler,
): void {
	for (let i = 0; i < NEIGHBOR_COUNT; i++) {
		const nx = worldX + NEIGHBOR_DX[i];
		const ny = worldY + NEIGHBOR_DY[i];
		const nz = worldZ + NEIGHBOR_DZ[i];
		const nbId = getBlockByWorldCoords(nx, ny, nz);
		if (nbId === BlockType.Water) {
			scheduler.schedule(nx, ny, nz, 5);
		}
	}
}

export function scheduleWaterNeighborUpdate(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	scheduleWaterNeighbors(
		worldX,
		worldY,
		worldZ,
		BlockTickScheduler.getInstance(),
	);
}

export function scheduleBlockBreakWaterUpdates(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	const scheduler = BlockTickScheduler.getInstance();
	scheduleWaterNeighbors(worldX, worldY, worldZ, scheduler);
	scheduler.schedule(worldX, worldY, worldZ, 5);
}

export function scheduleBlockPlaceWaterUpdates(
	worldX: number,
	worldY: number,
	worldZ: number,
	blockId: number,
): void {
	const scheduler = BlockTickScheduler.getInstance();
	if (blockId === BlockType.Water) {
		scheduler.schedule(worldX, worldY, worldZ, 5);
	} else {
		scheduleWaterNeighbors(worldX, worldY, worldZ, scheduler);
		scheduler.schedule(worldX, worldY, worldZ, 5);
	}
}

export function checkNewInfiniteSource(
	worldX: number,
	worldY: number,
	worldZ: number,
): void {
	const blockId = getBlockByWorldCoords(worldX, worldY, worldZ);
	if (blockId !== BlockType.Air) return;

	if (checkInfiniteSource(worldX, worldY, worldZ)) {
		placeWaterSource(worldX, worldY, worldZ);
		const scheduler = BlockTickScheduler.getInstance();
		scheduleNeighborUpdates(worldX, worldY, worldZ, scheduler);
	}
}
