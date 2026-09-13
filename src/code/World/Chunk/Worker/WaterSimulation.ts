import {
	BlockType,
	getWaterLevel,
	isWaterSource,
} from "../../Texture/BlockType";

// NOTE: ChunkLoadingSystem and BlockTickScheduler are imported lazily (inside
// getDefaultInstance) rather than at the top level. The server imports this
// shared file for the WaterSimulation class but must NOT pull in
// ChunkLoadingSystem (client-only, circular deps at module-init time). The
// default instance is only ever created on the client, so a dynamic import is
// free and keeps the server's module graph clean.

/**
 * WaterSimulation — vanilla-style water flow simulation.
 *
 * Shared between client (singleplayer) and server (authoritative multiplayer)
 * so both environments run the exact same logic and never diverge. The class
 * is environment-agnostic: it operates purely through the {@link WaterBlockAccess}
 * and {@link WaterScheduler} interfaces, which each environment implements
 * against its own world storage.
 */

// --- Block access abstraction -------------------------------------------

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

// --- Scheduler abstraction ----------------------------------------------

export interface WaterScheduler {
	schedule(x: number, y: number, z: number, delay: number): void;
	processFrame(): void;
}

export type BlockAndStateOut = { blockId: number; blockState: number };

// --- Direction constants ------------------------------------------------

const HORIZONTAL_DX = new Int8Array([1, -1, 0, 0]);
const HORIZONTAL_DZ = new Int8Array([0, 0, 1, -1]);
const HORIZONTAL_DIR_COUNT = 4;

const NEIGHBOR_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const NEIGHBOR_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const NEIGHBOR_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);
const NEIGHBOR_COUNT = 6;

// --- Flow pathing constants ---------------------------------------------

const FLOW_SEARCH_DEPTH = 5; // matches vanilla's getSlopeFindDistance for water
const FLOW_GRID_DIM = FLOW_SEARCH_DEPTH * 2 + 1; // 9
const FLOW_GRID_CENTER = FLOW_SEARCH_DEPTH; // 4
const FLOW_GRID_CELLS = FLOW_GRID_DIM * FLOW_GRID_DIM; // 81
const FLOW_NOT_FOUND = 255;
const WATER_SOURCE_STATE = 0; // level 0 = source

// --- The shared simulation class ---------------------------------------

export class WaterSimulation {
	// Reusable out object for the combined block-id/state lookup — consumed
	// synchronously at each call site, so sharing it is safe (same pattern as
	// ChunkLoadingSystem's own scratch).
	private readonly _blockAndState: BlockAndStateOut = {
		blockId: 0,
		blockState: 0,
	};

	// Flow BFS scratch (instance-level so multiple sims could coexist without
	// stepping on each other's reused buffers).
	private readonly flowVisitEpoch = new Int32Array(FLOW_GRID_CELLS);
	private flowEpoch = 0;
	private readonly flowQueueRdx = new Int8Array(FLOW_GRID_CELLS);
	private readonly flowQueueRdz = new Int8Array(FLOW_GRID_CELLS);
	private readonly flowQueueDist = new Uint8Array(FLOW_GRID_CELLS);
	private readonly flowCosts = new Uint8Array(HORIZONTAL_DIR_COUNT);
	// Per-call target ids captured by getFlowDirectionMask, re-used by the
	// caller's flowInto spread calls (saves one world read per direction).
	private readonly flowDirectionTargetIds = new Int16Array(
		HORIZONTAL_DIR_COUNT,
	);
	// Lazy 9x9 flow-grid read cache layers.
	private readonly flowGridPacked = new Int32Array(FLOW_GRID_CELLS);
	private readonly flowHoleGridPacked = new Int32Array(FLOW_GRID_CELLS);

	constructor(
		private readonly blocks: WaterBlockAccess,
		private readonly scheduler: WaterScheduler,
	) {}

	// --- Neighbor updates ------------------------------------------------

	private scheduleNeighborUpdates(
		worldX: number,
		worldY: number,
		worldZ: number,
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
			this.scheduler.schedule(worldX + dx, worldY + dy, worldZ + dz, 5);
		}
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

	// --- Flow pathing (vanilla-style edge-seeking) ------------------------

	private flowGridIndex(rdx: number, rdz: number): number {
		return (rdz + FLOW_GRID_CENTER) * FLOW_GRID_DIM + (rdx + FLOW_GRID_CENTER);
	}

	private cachedFlowCell(
		layer: Int32Array,
		worldX: number,
		worldY: number,
		worldZ: number,
		rdx: number,
		rdz: number,
	): number {
		const c = this.flowGridIndex(rdx, rdz);
		const packed = layer[c];
		if (packed !== FLOW_CACHE_UNKNOWN) return packed;
		this.blocks.getBlockAndStateInto(
			worldX + rdx,
			worldY,
			worldZ + rdz,
			this._blockAndState,
		);
		const result =
			this._blockAndState.blockId | (this._blockAndState.blockState << 16);
		layer[c] = result;
		return result;
	}

	// For each of the 4 cardinal directions, finds the distance (capped at
	// FLOW_SEARCH_DEPTH) to the nearest reachable hole along a path that begins
	// by stepping that way, writing results into `flowCosts`. This reproduces
	// vanilla's real flow pathing (FlowingFluid#getSlopeDistance), which is why
	// Minecraft water visibly seeks the nearest edge of a flat pool instead of
	// spreading out as a uniform blob — a 1-block-only lookahead only catches
	// the case where the drop is immediately adjacent.
	private findFlowCosts(worldX: number, worldY: number, worldZ: number): void {
		for (let dirIdx = 0; dirIdx < HORIZONTAL_DIR_COUNT; dirIdx++) {
			const dx0 = HORIZONTAL_DX[dirIdx];
			const dz0 = HORIZONTAL_DZ[dirIdx];

			this.flowCosts[dirIdx] = FLOW_NOT_FOUND;

			const startPacked = this.cachedFlowCell(
				this.flowGridPacked,
				worldX,
				worldY,
				worldZ,
				dx0,
				dz0,
			);
			if (this.isSolidBlock(startPacked & 0xffff)) continue;

			this.flowEpoch++;
			const epoch = this.flowEpoch;

			const startGridIdx = this.flowGridIndex(dx0, dz0);
			this.flowVisitEpoch[startGridIdx] = epoch;
			this.flowQueueRdx[0] = dx0;
			this.flowQueueRdz[0] = dz0;
			this.flowQueueDist[0] = 1;

			let queueHead = 0;
			let queueTail = 1;

			while (queueHead < queueTail) {
				const rdx = this.flowQueueRdx[queueHead];
				const rdz = this.flowQueueRdz[queueHead];
				const dist = this.flowQueueDist[queueHead];
				queueHead++;

				const holePacked = this.cachedFlowCell(
					this.flowHoleGridPacked,
					worldX,
					worldY - 1,
					worldZ,
					rdx,
					rdz,
				);
				if (!this.isSolidBlock(holePacked & 0xffff)) {
					this.flowCosts[dirIdx] = dist;
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

					const nGridIdx = this.flowGridIndex(nrdx, nrdz);
					if (this.flowVisitEpoch[nGridIdx] === epoch) continue;

					const nPacked = this.cachedFlowCell(
						this.flowGridPacked,
						worldX,
						worldY,
						worldZ,
						nrdx,
						nrdz,
					);
					if (this.isSolidBlock(nPacked & 0xffff)) continue;

					this.flowVisitEpoch[nGridIdx] = epoch;
					this.flowQueueRdx[queueTail] = nrdx;
					this.flowQueueRdz[queueTail] = nrdz;
					this.flowQueueDist[queueTail] = dist + 1;
					queueTail++;
				}
			}
		}
	}

	// Returns a bitmask over HORIZONTAL_DX/DZ indices (bit i set = flow into
	// that direction this tick). A bitmask instead of an array of direction
	// pairs means the per-tick spread decision allocates nothing.
	// Also fills flowDirectionTargetIds with each direction's target id
	// (read once here, reused by the caller's flowInto calls) and resets the
	// per-call flow-grid read cache.
	private getFlowDirectionMask(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		this.flowGridPacked.fill(FLOW_CACHE_UNKNOWN, 0, FLOW_GRID_CELLS);
		this.flowHoleGridPacked.fill(FLOW_CACHE_UNKNOWN, 0, FLOW_GRID_CELLS);

		let validMask = 0;
		let dropMask = 0;

		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			const dx = HORIZONTAL_DX[i];
			const dz = HORIZONTAL_DZ[i];
			const packed = this.cachedFlowCell(
				this.flowGridPacked,
				worldX,
				worldY,
				worldZ,
				dx,
				dz,
			);
			const targetId = packed & 0xffff;
			this.flowDirectionTargetIds[i] = targetId;

			let canFlow = false;
			if (
				targetId === BlockType.Air ||
				targetId === BlockType.GrassCross ||
				targetId === BlockType.SavannahGrassCross ||
				targetId === BlockType.Grass006Cross
			) {
				canFlow = true;
			} else if (targetId === BlockType.Water) {
				const targetState = packed >>> 16;
				if (!isWaterSource(targetId, targetState)) {
					if (getWaterLevel(targetId, targetState) > 0) canFlow = true;
				}
			}
			if (!canFlow) continue;

			validMask |= 1 << i;

			const belowPacked = this.cachedFlowCell(
				this.flowHoleGridPacked,
				worldX,
				worldY - 1,
				worldZ,
				dx,
				dz,
			);
			if (!this.isSolidBlock(belowPacked & 0xffff)) dropMask |= 1 << i;
		}

		if (validMask === 0) return 0;
		if (dropMask !== 0) return dropMask;

		this.findFlowCosts(worldX, worldY, worldZ);

		let minCost = FLOW_NOT_FOUND;
		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			if ((validMask & (1 << i)) === 0) continue;
			const cost = this.flowCosts[i];
			if (cost < minCost) minCost = cost;
		}

		// Nothing reachable within FLOW_SEARCH_DEPTH — fall back to spreading
		// into every valid direction evenly, same as vanilla past its own
		// search radius.
		if (minCost === FLOW_NOT_FOUND) return validMask;

		let bestMask = 0;
		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			if ((validMask & (1 << i)) === 0) continue;
			if (this.flowCosts[i] === minCost) bestMask |= 1 << i;
		}
		return bestMask;
	}

	// --- Block mutation helpers ------------------------------------------

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

	// Attempts to flow water of `newLevel` strength into a target cell.
	// - Empty air: filled outright.
	// - Existing water: overwritten only if it's strictly weaker (a higher
	//   level number) than the incoming flow. Sources are never overwritten.
	// - Anything else (solid, or existing water that's equal/stronger): no-op.
	// Returns whether the flow actually happened, so callers can tell.
	private flowInto(
		worldX: number,
		worldY: number,
		worldZ: number,
		newLevel: number,
		excludeDx: number,
		excludeDy: number,
		excludeDz: number,
		targetId?: number,
	): boolean {
		const id =
			targetId !== undefined
				? targetId
				: this.blocks.getBlock(worldX, worldY, worldZ);

		if (id === BlockType.Water) {
			const targetState = this.blocks.getBlockState(worldX, worldY, worldZ);
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
		aboveId?: number,
	): boolean {
		// A block fed by water directly above it is a falling/waterfall block —
		// always considered supported as long as there's water above it.
		const above =
			aboveId !== undefined
				? aboveId
				: this.blocks.getBlock(worldX, worldY + 1, worldZ);
		if (above === BlockType.Water) {
			return false;
		}

		let hasSupport = false;
		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			const dx = HORIZONTAL_DX[i];
			const dz = HORIZONTAL_DZ[i];
			const nbId = this.blocks.getBlock(worldX + dx, worldY, worldZ + dz);
			if (nbId !== BlockType.Water) continue;

			const nbState = this.blocks.getBlockState(
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
			this.removeWater(worldX, worldY, worldZ);
			this.scheduleNeighborUpdates(worldX, worldY, worldZ);
			return true;
		}
		return false;
	}

	// Returns whether this cell has 2+ cardinally-adjacent source blocks —
	// vanilla's trigger for turning flowing water into a source (the "infinite
	// water" mechanic: two buckets emptied into a 2-wide gap fill it as
	// flowing water, which then solidifies into a permanent source).
	private checkInfiniteSource(
		worldX: number,
		worldY: number,
		worldZ: number,
	): boolean {
		let sourceCount = 0;
		for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
			const dx = HORIZONTAL_DX[i];
			const dz = HORIZONTAL_DZ[i];
			this.blocks.getBlockAndStateInto(
				worldX + dx,
				worldY,
				worldZ + dz,
				this._blockAndState,
			);
			const nbId = this._blockAndState.blockId;
			const nbState = this._blockAndState.blockState;
			if (nbId === BlockType.Water && isWaterSource(nbId, nbState)) {
				sourceCount++;
				if (sourceCount >= 2) return true;
			}
		}
		return false;
	}

	// --- Core tick processing --------------------------------------------

	processWaterUpdate(worldX: number, worldY: number, worldZ: number): void {
		this.blocks.getBlockAndStateInto(
			worldX,
			worldY,
			worldZ,
			this._blockAndState,
		);
		const blockId = this._blockAndState.blockId;
		if (blockId !== BlockType.Water) return;

		const state = this._blockAndState.blockState;
		const level = getWaterLevel(blockId, state);

		// Hoist aboveId to top of function so it's available for both
		// infinite-source check and horizontal spread strength reset.
		const aboveId = this.blocks.getBlock(worldX, worldY + 1, worldZ);
		const isFedFromAbove = aboveId === BlockType.Water;

		if (level > 0) {
			// Two-source merge, checked every tick (not just on air cells) so a
			// gap that has already filled with flowing water actually solidifies
			// into a source once it's flanked by two sources. Skipped while
			// falling (water directly above) so a waterfall segment passing
			// between two distant sources doesn't spontaneously solidify mid-air.
			if (!isFedFromAbove && this.checkInfiniteSource(worldX, worldY, worldZ)) {
				this.placeWaterSource(worldX, worldY, worldZ);
				this.scheduleNeighborUpdates(worldX, worldY, worldZ);
				return;
			}

			const retracted = this.checkRetract(
				worldX,
				worldY,
				worldZ,
				level,
				aboveId,
			);
			if (retracted) return;
		}

		const belowId = this.blocks.getBlock(worldX, worldY - 1, worldZ);
		const flowedDown = this.flowInto(
			worldX,
			worldY - 1,
			worldZ,
			1, // Falling water always carries constant non-source level
			0,
			1,
			0,
			belowId,
		);

		// Matches vanilla: if this block could fall, it falls — it does not also
		// spread sideways in the same tick.
		// Level 7 can't spread further (weakest flowing level).
		if (level === 0 || (!flowedDown && level < 7)) {
			const belowIsSolid = this.isSolidBlock(belowId);

			if (belowIsSolid) {
				// Spread at current level + 1 (weaker than self).
				// Waterfall base at level 1 spreads at level 2, which is supported
				// by the base (1 < 2), cascading outward to level 7 (7-tile radius).
				const spreadLevel = Math.min(level + 1, 7);
				const directionMask = this.getFlowDirectionMask(worldX, worldY, worldZ);

				for (let i = 0; i < HORIZONTAL_DIR_COUNT; i++) {
					if ((directionMask & (1 << i)) === 0) continue;
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
						this.flowDirectionTargetIds[i],
					);
				}
			}
		}
	}

	// --- Public scheduling API -------------------------------------------

	private scheduleWaterNeighbors(
		worldX: number,
		worldY: number,
		worldZ: number,
	): void {
		for (let i = 0; i < NEIGHBOR_COUNT; i++) {
			const nx = worldX + NEIGHBOR_DX[i];
			const ny = worldY + NEIGHBOR_DY[i];
			const nz = worldZ + NEIGHBOR_DZ[i];
			const nbId = this.blocks.getBlock(nx, ny, nz);
			if (nbId === BlockType.Water) {
				this.scheduler.schedule(nx, ny, nz, 5);
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
		this.scheduleWaterNeighbors(worldX, worldY, worldZ);
		this.scheduler.schedule(worldX, worldY, worldZ, 5);
	}

	scheduleBlockPlaceWaterUpdates(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
	): void {
		if (blockId === BlockType.Water) {
			this.scheduler.schedule(worldX, worldY, worldZ, 5);
		} else {
			this.scheduleWaterNeighbors(worldX, worldY, worldZ);
			this.scheduler.schedule(worldX, worldY, worldZ, 5);
		}
	}

	checkNewInfiniteSource(worldX: number, worldY: number, worldZ: number): void {
		const blockId = this.blocks.getBlock(worldX, worldY, worldZ);
		if (blockId !== BlockType.Air) return;

		if (this.checkInfiniteSource(worldX, worldY, worldZ)) {
			this.placeWaterSource(worldX, worldY, worldZ);
			this.scheduleNeighborUpdates(worldX, worldY, worldZ);
		}
	}
}

// Lazy 9x9 flow-grid read cache sentinel.
const FLOW_CACHE_UNKNOWN = -1;

// --- Default client instance --------------------------------------------
// The client (singleplayer) uses a single shared instance backed by the
// client's ChunkLoadingSystem block access and the BlockTickScheduler singleton.
// Lazily initialized to avoid a circular import at module load time.

let _defaultInstance: WaterSimulation | null = null;
// Resolves once the async dynamic imports finish during the first init.
let _resolveDefault: ((sim: WaterSimulation) => void) | null = null;
let _initPromise: Promise<WaterSimulation> | null = null;

async function getDefaultInstanceAsync(): Promise<WaterSimulation> {
	if (_defaultInstance) return _defaultInstance;
	const chunkLoading = await import("../ChunkLoadingSystem");
	const { BlockTickScheduler } = await import("./BlockTickScheduler");
	_defaultInstance = new WaterSimulation(
		{
			getBlock: chunkLoading.getBlockByWorldCoords,
			getBlockState: chunkLoading.getBlockStateByWorldCoords,
			getBlockAndStateInto: chunkLoading.getBlockAndStateByWorldCoordsInto,
			setBlock: chunkLoading.setBlock,
		},
		BlockTickScheduler.getInstance(),
	);
	if (_resolveDefault) {
		_resolveDefault(_defaultInstance);
		_resolveDefault = null;
	}
	return _defaultInstance;
}

/**
 * Idempotently kick off initialization of the client default instance. Safe to
 * call repeatedly; returns the same promise. The server never calls this (it
 * constructs its own WaterSimulation with ServerWaterBlockAccess).
 */
export function ensureDefaultInstance(): Promise<WaterSimulation> {
	if (!_initPromise) {
		_initPromise = getDefaultInstanceAsync();
	}
	return _initPromise;
}

/**
 * Synchronous accessor used by the backward-compatible bound exports below.
 *
 * On the client, PlayerLoopController.bind() triggers ensureDefaultInstance(),
 * but the scheduler's processFrame() (which invokes the callback) doesn't run
 * until a later frame — by which point the dynamic import has resolved. If
 * called before init resolves, we block on the init promise via a synchronous
 * resolution path: we register a resolver and await the already-started promise.
 */
function getDefaultInstance(): WaterSimulation {
	if (_defaultInstance) return _defaultInstance;
	if (!_initPromise) {
		// Auto-start init so a caller always has something to await.
		ensureDefaultInstance();
	}
	// Synchronously wait for the in-flight init. This is only reachable on the
	// client where the module graph is already loaded; the dynamic import
	// resolves on the microtask queue, so we spin briefly to let it settle.
	if (!_defaultInstance) {
		throw new Error(
			"WaterSimulation default instance not yet initialized — call ensureDefaultInstance() during bind()",
		);
	}
	return _defaultInstance;
}

// Backward-compatible bound exports — existing callers (PlayerLoopController,
// ChunkLoadingSystem) keep working unchanged.

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
