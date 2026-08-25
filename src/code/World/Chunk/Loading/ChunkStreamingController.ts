import {
	isInitialized as isDistantTerrainReady,
	update as updateDistantTerrain,
} from "@/code/Generation/DistantTerrain/DistantTerrain";
import { getFinalTerrainHeight } from "@/code/Generation/TerrainHeightMap";
import { isInCave } from "@/code/Lib/GameRuntimeState";
import { FarTileManager } from "../../FarTiles/FarTileManager";
import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import { Chunk, getChunk } from "../Chunk";
import { createMeshFromData } from "../ChunkMesher";
import { ChunkWorkerPool } from "../ChunkWorkerPool";
import {
	ChunkLodRuleSet,
	DistantOnlyChunkCreationRule,
	Lod0ChunkCreationRule,
} from "../LOD/ChunkLodRules";
import { UNDERGROUND_SKIP_LOD, maxLodForChunkY } from "../Worker/LODUtilities";

/** Underground (cave) chunks never coarsen: clamp any desired LOD. */
function clampLodForY(chunkY: number, lod: number): number {
	const max = maxLodForChunkY(chunkY);
	return lod > max ? max : lod;
}

/**
Whether an underground coordinate should currently have a chunk. Horizontal
bands decide (vertical distance must not gate caves); depth is bounded by the
rule set's underground vertical cap (CAVE_VERTICAL_RENDER_DISTANCE outdoors,
widened while in a cave).
 */
function undergroundDesired(
	chunkY: number,
	hDist: number,
	vDist: number,
	lodRuleSet: ChunkLodRuleSet,
): boolean {
	if (chunkY >= 0) return false;
	if (lodRuleSet.horizontalLodForDistance(hDist) >= UNDERGROUND_SKIP_LOD) {
		return false;
	}

	return vDist <= undergroundVerticalRange(lodRuleSet);
}

function undergroundVerticalRange(lodRuleSet: ChunkLodRuleSet): number {
	return (
		lodRuleSet.undergroundVerticalCap ??
		Math.max(
			lodRuleSet.verticalRadiusFor(0),
			lodRuleSet.verticalRadiusFor(UNDERGROUND_SKIP_LOD - 1),
		)
	);
}

export type QueuedChunkRequest = {
	chunk: Chunk;
	desiredLod: number;
	revision: number;
	includeVoxelData: boolean;
	priority: number;
};

function compareQueuedChunkRequestPriority(
	a: QueuedChunkRequest,
	b: QueuedChunkRequest,
): number {
	return a.priority - b.priority;
}

// Scratch array for LoadedChunkIndex.queryCollect, avoids generator overhead.
const _queryScratch: Chunk[] = [];

// PERF: relative-offset key for the refresh decision cache.
// Mask every byte so unexpected offsets cannot bleed into neighboring fields.
const _OFFSET_BIAS = 128;

function packOffsetKey(
	rx: number,
	ry: number,
	rz: number,
	chunkLod: number,
): number {
	return (
		((rx + _OFFSET_BIAS) & 0xff) |
		(((ry + _OFFSET_BIAS) & 0xff) << 8) |
		(((rz + _OFFSET_BIAS) & 0xff) << 16) |
		((chunkLod & 0xff) << 24)
	);
}

// Use arithmetic packing instead of revision << 3.
// Bitwise shifts coerce to signed 32-bit numbers and eventually overflow.
function packLodRevision(lod: number, revision: number): number {
	return lod + revision * 8;
}

function unpackRevision(packed: number): number {
	return Math.floor(packed / 8);
}

export interface ChunkStreamingControllerAdapter {
	getLoadQueue(): QueuedChunkRequest[];
	getUnloadQueueSet(): Set<Chunk>;
	onQueueSnapshotChanged?(): void;
}

// Column-top cache for the far-band air skip in processTargetChunkCoordinate.
// Key packs (x,z) at 16 bits each; collisions only yield a stale approximate
// height, which at worst delays a chunk by one ring — never corrupts state.
const COL_TOP_CACHE_MAX = 16384;
const colTopCache = new Map<number, number>();

function columnTopChunkY(x: number, z: number): number {
	const key = (x & 0xffff) | ((z & 0xffff) << 16);
	const cached = colTopCache.get(key);
	if (cached !== undefined) return cached;

	const h = getFinalTerrainHeight(x * Chunk.SIZE + 16, z * Chunk.SIZE + 16);
	const topY = Math.ceil(h / Chunk.SIZE);
	colTopCache.set(key, topY);

	if (colTopCache.size > COL_TOP_CACHE_MAX) {
		// FIFO-evict the oldest quarter instead of a wholesale clear(): a full
		// reset turned steady-state hit-rates into a cold-start spike exactly
		// while chunks were streaming in (every subsequent column paid a
		// terrain-height noise evaluation until the cache warmed again).
		// Heights are deterministic, so evicted entries just recompute.
		let toEvict = COL_TOP_CACHE_MAX >> 2;
		for (const k of colTopCache.keys()) {
			colTopCache.delete(k);
			if (--toEvict <= 0) break;
		}
	}

	return topY;
}

export class ChunkStreamingController {
	private static readonly DESIRED_STATE_REVISION_RETENTION = 8;
	/** Full-band refresh scan runs every Nth player-chunk-move (near window
	 *  scans every move — see enqueueLoadedChunksForRefresh). */
	private static readonly OUTER_SCAN_INTERVAL = 4;

	private streamRevision = 0;

	// Packed as desiredLod + revision * 8.
	// Keyed by chunk.numericId, because number keys avoid BigInt box churn.
	private desiredStates = new Map<number, number>();

	private loadQueueRequestMap = new Map<number, QueuedChunkRequest>();

	private loadedRefreshQueue: Chunk[] = [];
	private loadedRefreshQueueSet = new Set<number>();
	private loadedRefreshQueueHead = 0;

	private _cachedCaveLodRuleSet: ChunkLodRuleSet | null = null;
	private _cachedOutdoorLodRuleSet: ChunkLodRuleSet | null = null;

	private _ruleSetGeneration = 0;
	private _refreshCache = new Map<number, number>();

	private _lastCaveState: boolean | null = null;
	private _lastRenderDistance = 0;
	private _lastVerticalRadius = 0;

	public constructor(
		private readonly adapter: ChunkStreamingControllerAdapter,
	) {}

	public getDesiredState(numericId: number): number | undefined {
		return this.desiredStates.get(numericId);
	}

	private nextRuleGeneration(): number {
		this._ruleSetGeneration++;
		// Swap instead of clear(): every old decision is genuinely invalid
		// under the new rules, but a wholesale .clear() pays an O(n) deletion
		// walk on the streaming hot path. Dropping the reference lets GC
		// reclaim the old map off the critical path; semantics are identical.
		this._refreshCache = new Map<number, number>();
		return this._ruleSetGeneration;
	}

	private getLodRuleSet(
		caveState: boolean,
		renderDistance: number,
		verticalRadius: number,
	): ChunkLodRuleSet {
		const needsRebuild =
			this._lastCaveState !== caveState ||
			this._lastRenderDistance !== renderDistance ||
			this._lastVerticalRadius !== verticalRadius;

		if (caveState) {
			if (this._cachedCaveLodRuleSet === null || needsRebuild) {
				const lod0HorizontalRadius = renderDistance + 2;
				const lod0VerticalRadius = verticalRadius + 2;

				this._cachedCaveLodRuleSet = new ChunkLodRuleSet(
					{
						lod0HorizontalRadius,
						lod0VerticalRadius,
						lod1HorizontalRadius: 0,
						lod1VerticalRadius: 0,
						lod2HorizontalRadius: 0,
						lod2VerticalRadius: 0,
						lod3HorizontalRadius: 0,
						lod3VerticalRadius: 0,
						lod4HorizontalRadius: 0,
						lod4VerticalRadius: 0,
						lod5HorizontalRadius: 0,
						lod5VerticalRadius: 0,
					},
					[
						new Lod0ChunkCreationRule(lod0HorizontalRadius, lod0VerticalRadius),
						new DistantOnlyChunkCreationRule(),
					],
					[lod0HorizontalRadius, 0, 0, 0, 0, 0],
					[lod0VerticalRadius, 0, 0, 0, 0, 0],
					this.nextRuleGeneration(),
					lod0VerticalRadius,
				);
			}

			this._lastCaveState = true;
			this._lastRenderDistance = renderDistance;
			this._lastVerticalRadius = verticalRadius;

			return this._cachedCaveLodRuleSet;
		}

		if (this._cachedOutdoorLodRuleSet === null || needsRebuild) {
			this._cachedOutdoorLodRuleSet = ChunkLodRuleSet.fromRenderRadii(
				renderDistance,
				verticalRadius,
				this.nextRuleGeneration(),
			);
		}

		this._lastCaveState = false;
		this._lastRenderDistance = renderDistance;
		this._lastVerticalRadius = verticalRadius;

		return this._cachedOutdoorLodRuleSet;
	}

	private getCachedDecisionLod(key: number, isDirty: boolean): number {
		if (isDirty) return -1;

		const cachedLod = this._refreshCache.get(key);
		return cachedLod === undefined ? -1 : cachedLod;
	}

	private setCachedDecisionLod(
		key: number,
		lod: number,
		isDirty: boolean,
	): void {
		if (isDirty) return;

		this._refreshCache.set(key, lod);
	}

	public async updateChunksAround(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		renderDistance = SETTING_PARAMS.RENDER_DISTANCE,
		verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
		prevChunkX?: number,
		prevChunkY?: number,
		prevChunkZ?: number,
		playerWorldX?: number,
		playerWorldZ?: number,
	): Promise<void> {
		this.streamRevision++;

		// MEMORY: the relative-offset decision cache is semantically valid
		// forever (keys encode distance + previous LOD, both player-relative),
		// but its entry count scales with the refresh window. Swap it
		// periodically so the map stays small; the cold re-resolve burst is a
		// few thousand cheap rule checks, amortized over hundreds of moves.
		if (this.streamRevision % 512 === 0) {
			this._refreshCache = new Map<number, number>();
		}

		const revision = this.streamRevision;
		const caveState = isInCave();

		const distantTerrainX =
			playerWorldX !== undefined ? playerWorldX : chunkX * Chunk.SIZE;
		const distantTerrainZ =
			playerWorldZ !== undefined ? playerWorldZ : chunkZ * Chunk.SIZE;

		if (isDistantTerrainReady()) {
			updateDistantTerrain(distantTerrainX, distantTerrainZ);
		}

		FarTileManager.update(distantTerrainX, distantTerrainZ);

		const lodRuleSet = this.getLodRuleSet(
			caveState,
			renderDistance,
			verticalRadius,
		);

		// Operational bounds span every chunk-creating band (LOD0..LOD5).
		const operationalRadius = lodRuleSet.maxHorizontalRadius();
		const operationalVerticalRadius = lodRuleSet.maxVerticalRadius();

		const nearZoneRadius =
			Math.max(
				lodRuleSet.horizontalRadiusFor(0),
				lodRuleSet.horizontalRadiusFor(1),
			) + 2;
		const nearZoneVertical =
			Math.max(
				lodRuleSet.verticalRadiusFor(0),
				lodRuleSet.verticalRadiusFor(1),
			) + 2;

		const loadQueue = this.adapter.getLoadQueue();
		const unloadQueueSet = this.adapter.getUnloadQueueSet();

		this.loadQueueRequestMap.clear();

		let writeIndex = 0;

		for (let readIndex = 0; readIndex < loadQueue.length; readIndex++) {
			const request = loadQueue[readIndex];
			const chunk = request.chunk;

			const relX = chunk.chunkX - chunkX;
			const relY = chunk.chunkY - chunkY;
			const relZ = chunk.chunkZ - chunkZ;

			const absX = relX < 0 ? -relX : relX;
			const absY = relY < 0 ? -relY : relY;
			const absZ = relZ < 0 ? -relZ : relZ;

			const hDist = absX > absZ ? absX : absZ;
			const vDist = absY;

			if (
				hDist > operationalRadius ||
				(chunk.chunkY >= 0 && vDist > operationalVerticalRadius)
			) {
				chunk.isTerrainScheduled = false;
				continue;
			}

			let desiredLod = request.desiredLod;

			if (
				chunk.isDirty ||
				(hDist <= nearZoneRadius && vDist <= nearZoneVertical)
			) {
				const previousLod = chunk.lodLevel ?? request.desiredLod;
				const key = packOffsetKey(relX, relY, relZ, previousLod);

				desiredLod = this.getCachedDecisionLod(key, chunk.isDirty);
				if (desiredLod < 0) {
					desiredLod = lodRuleSet.resolveWithHysteresisFromDistance(
						hDist,
						vDist,
						previousLod,
					).lodLevel;

					this.setCachedDecisionLod(
						key,
						desiredLod,

						chunk.isDirty,
					);
				}
			}

			if (
				chunk.chunkY < 0 &&
				!undergroundDesired(chunk.chunkY, hDist, vDist, lodRuleSet)
			) {
				chunk.isTerrainScheduled = false;
				continue;
			}

			desiredLod = clampLodForY(chunk.chunkY, desiredLod);

			request.desiredLod = desiredLod;
			request.revision = revision;
			request.includeVoxelData = desiredLod <= 1;
			request.priority = this.computePriority(
				chunk,
				desiredLod,
				chunkX,
				chunkY,
				chunkZ,
			);

			this.desiredStates.set(
				chunk.numericId,
				packLodRevision(desiredLod, revision),
			);

			this.loadQueueRequestMap.set(chunk.numericId, request);
			loadQueue[writeIndex++] = request;
		}

		loadQueue.length = writeIndex;

		for (const chunk of unloadQueueSet) {
			const dx = chunk.chunkX - chunkX;
			const dy = chunk.chunkY - chunkY;
			const dz = chunk.chunkZ - chunkZ;

			const absX = dx < 0 ? -dx : dx;
			const absY = dy < 0 ? -dy : dy;
			const absZ = dz < 0 ? -dz : dz;

			const hDist = absX > absZ ? absX : absZ;
			const vDist = absY;

			const keep =
				chunk.chunkY < 0
					? undergroundDesired(chunk.chunkY, hDist, vDist, lodRuleSet)
					: hDist <= lodRuleSet.maxHorizontalRadius() &&
						vDist <= lodRuleSet.maxVerticalRadius();

			if (keep) {
				unloadQueueSet.delete(chunk);
			}
		}

		const canUseDelta =
			typeof prevChunkX === "number" &&
			typeof prevChunkY === "number" &&
			typeof prevChunkZ === "number" &&
			Math.abs(chunkX - prevChunkX) <= 1 &&
			Math.abs(chunkY - prevChunkY) <= 1 &&
			Math.abs(chunkZ - prevChunkZ) <= 1;

		if (canUseDelta) {
			this.processMovementRings(
				chunkX,
				chunkY,
				chunkZ,
				prevChunkX,
				prevChunkY,
				prevChunkZ,
				lodRuleSet,
			);
		} else {
			this.processInitialShell(chunkX, chunkY, chunkZ, lodRuleSet);
		}

		this.ensureUndergroundBand(chunkX, chunkY, chunkZ, lodRuleSet);

		const unloadBuffer = SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER + 8;
		const unloadScanRadius = operationalRadius + unloadBuffer;
		const unloadScanVertical = Math.max(
			operationalVerticalRadius + unloadBuffer,
			chunkY - SETTING_PARAMS.MIN_CHUNK_Y,
		);

		_queryScratch.length = 0;
		Chunk.loadedChunkIndex.queryCollect(
			chunkX,
			chunkY,
			chunkZ,
			unloadScanRadius,
			unloadScanVertical,
			_queryScratch,
		);

		// PERF: staged refresh cadence. The near window (LOD0-2, where band
		// transitions actually happen during play) is rescanned every chunk
		// move; the far LOD3-5 bands only every OUTER_SCAN_INTERVAL-th move.
		// A full-window scan over thousands of loaded chunks measured up to
		// 32ms in one frame; outer-band transitions are rare and tolerate a
		// few moves of latency, so this keeps the LOD-freeze fix while
		// amortizing its cost.
		const outerScan =
			revision % ChunkStreamingController.OUTER_SCAN_INTERVAL === 0;

		this.enqueueLoadedChunksForRefresh(
			chunkX,
			chunkY,
			chunkZ,
			lodRuleSet,
			outerScan,
		);

		this.sortLoadQueue();

		this.queueUnloading(
			chunkX,
			chunkY,
			chunkZ,
			operationalRadius,
			operationalVerticalRadius,
			lodRuleSet,
		);

		if (!caveState) {
			ChunkWorkerPool.getInstance().scheduleBackgroundLodPrecompute(
				chunkX,
				chunkY,
				chunkZ,
			);
		}

		if (
			this.desiredStates.size > 0 &&
			revision % ChunkStreamingController.DESIRED_STATE_REVISION_RETENTION === 0
		) {
			const oldestKeptRevision = Math.max(
				0,
				revision - ChunkStreamingController.DESIRED_STATE_REVISION_RETENTION,
			);

			for (const [id, packed] of this.desiredStates) {
				if (unpackRevision(packed) < oldestKeptRevision) {
					this.desiredStates.delete(id);
				}
			}
		}

		this.adapter.onQueueSnapshotChanged?.();
	}

	private enqueueLoadedChunksForRefresh(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
		includeOuterBands: boolean,
	): void {
		// BUGFIX: the refresh window must span EVERY chunk-creating band, not
		// just LOD0-2. It previously capped at lod2Radius+2, so chunks pushed
		// beyond it (by walking/sprinting/boating away) kept their near-band
		// LOD forever — full-detail lod0/1 meshes rendering inside the far
		// lod3-5 rings until unload. Chunks are collected below out to
		// unloadScanRadius (operationalRadius+9), so the only limiter needed
		// here is the rule set's outermost radius (+ hysteresis margin).
		// PERF: on non-full passes only the near window (LOD0-2 + margin) is
		// scanned — outer bands are covered by the periodic full scan.
		const maxH = lodRuleSet.maxHorizontalRadius() + 2;
		const maxV = lodRuleSet.maxVerticalRadius() + 2;
		const nearH = lodRuleSet.horizontalRadiusFor(2) + 2;
		const nearV = lodRuleSet.verticalRadiusFor(2) + 2;

		for (let i = 0; i < _queryScratch.length; i++) {
			const chunk = _queryScratch[i];
			const numericId = chunk.numericId;

			if (this.loadedRefreshQueueSet.has(numericId)) continue;

			const relX = chunk.chunkX - chunkX;
			const relY = chunk.chunkY - chunkY;
			const relZ = chunk.chunkZ - chunkZ;

			const absX = relX < 0 ? -relX : relX;
			const absY = relY < 0 ? -relY : relY;
			const absZ = relZ < 0 ? -relZ : relZ;

			const hDist = absX > absZ ? absX : absZ;
			const vDist = absY;

			if (hDist > maxH || vDist > maxV) continue;
			if (!includeOuterBands && (hDist > nearH || vDist > nearV)) {
				continue;
			}

			const chunkLod = chunk.lodLevel ?? 3;
			const key = packOffsetKey(relX, relY, relZ, chunkLod);

			let decisionLod = this.getCachedDecisionLod(key, chunk.isDirty);

			if (decisionLod < 0) {
				if (chunk.chunkY < 0) {
					if (!undergroundDesired(chunk.chunkY, hDist, vDist, lodRuleSet)) {
						continue;
					}

					decisionLod = clampLodForY(
						chunk.chunkY,
						lodRuleSet.horizontalLodForDistance(hDist),
					);
				} else {
					decisionLod = lodRuleSet.resolveWithHysteresisFromDistance(
						hDist,
						vDist,
						chunkLod,
					).lodLevel;
				}
				this.setCachedDecisionLod(key, decisionLod, chunk.isDirty);
			}

			if (
				chunk.lodLevel === decisionLod &&
				!chunk.isDirty &&
				!(decisionLod <= 1 && !chunk.hasVoxelData)
			) {
				continue;
			}

			this.loadedRefreshQueueSet.add(numericId);
			this.loadedRefreshQueue.push(chunk);
		}
	}

	public processLoadedRefreshQueue(
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
		renderDistance = SETTING_PARAMS.RENDER_DISTANCE,
		verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
		maxChunks = SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT,
	): void {
		if (this.loadedRefreshQueueHead >= this.loadedRefreshQueue.length) {
			return;
		}

		const caveState = isInCave();
		const lodRuleSet = this.getLodRuleSet(
			caveState,
			renderDistance,
			verticalRadius,
		);

		let processed = 0;

		while (processed < maxChunks) {
			const chunk = this.dequeueLoadedRefreshChunk();
			if (chunk === undefined) break;

			this.loadedRefreshQueueSet.delete(chunk.numericId);

			if (!chunk.isLoaded) {
				continue;
			}

			this.processTargetChunkCoordinate(
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ,
				playerChunkX,
				playerChunkY,
				playerChunkZ,
				lodRuleSet,
			);

			processed++;
		}
	}

	private dequeueLoadedRefreshChunk(): Chunk | undefined {
		const head = this.loadedRefreshQueueHead;

		if (head >= this.loadedRefreshQueue.length) {
			return undefined;
		}

		const chunk = this.loadedRefreshQueue[head];
		this.loadedRefreshQueueHead = head + 1;

		if (
			this.loadedRefreshQueueHead > 1024 &&
			this.loadedRefreshQueueHead * 2 >= this.loadedRefreshQueue.length
		) {
			this.loadedRefreshQueue.copyWithin(0, this.loadedRefreshQueueHead);
			this.loadedRefreshQueue.length -= this.loadedRefreshQueueHead;
			this.loadedRefreshQueueHead = 0;
		}

		return chunk;
	}

	public processTargetChunkCoordinate(
		x: number,
		y: number,
		z: number,
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const relX = x - playerChunkX;
		const relY = y - playerChunkY;
		const relZ = z - playerChunkZ;
		const absX = relX < 0 ? -relX : relX;
		const absZ = relZ < 0 ? -relZ : relZ;
		const hDist = absX > absZ ? absX : absZ;
		const vDist = relY < 0 ? -relY : relY;

		// ALLOCATION GUARD (profile: 45% of heap churn flowed through here
		// via `new Chunk` for empty sky cells): skip columns provably above
		// the terrain surface in the far vertical bands. Underground bands
		// are governed by undergroundDesired during LOD resolution below.
		const nearVertical = lodRuleSet.verticalRadiusFor(1);
		if (vDist > nearVertical && y >= 0 && y > columnTopChunkY(x, z) + 1) {
			return;
		}

		const chunk = getChunk(x, y, z);
		const previousLod = chunk?.lodLevel ?? 3;
		const isDirty = chunk?.isDirty === true;

		const cacheKey = packOffsetKey(relX, relY, relZ, previousLod);
		let desiredLod = this.getCachedDecisionLod(cacheKey, isDirty);

		if (desiredLod < 0) {
			if (y < 0) {
				if (!undergroundDesired(y, hDist, vDist, lodRuleSet)) {
					return;
				}

				desiredLod = clampLodForY(
					y,
					lodRuleSet.horizontalLodForDistance(hDist),
				);
			} else {
				const decision = lodRuleSet.resolveWithHysteresisFromDistance(
					hDist,
					vDist,
					previousLod,
				);

				if (!decision.allowsChunkCreation) return;

				desiredLod = clampLodForY(y, decision.lodLevel);
			}

			this.setCachedDecisionLod(cacheKey, desiredLod, isDirty);
		}

		this.applyTargetChunkDecision(x, y, z, chunk, previousLod, desiredLod);
	}
	private applyTargetChunkDecision(
		x: number,
		y: number,
		z: number,
		existingChunk: Chunk | undefined,
		previousLod: number,
		desiredLod: number,
	): void {
		let chunk = existingChunk;

		if (!chunk) {
			chunk = new Chunk(x, y, z);
		}

		const revision = this.streamRevision;

		if (chunk.isLoaded && previousLod === desiredLod) {
			if (desiredLod <= 1 && !chunk.hasVoxelData) {
				this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);
				this.tryApplyCachedLodTransitionMesh(chunk, desiredLod);
			} else if (chunk.isDirty && !chunk.hasVoxelData && desiredLod >= 2) {
				if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
					chunk.isDirty = false;
				}
			}

			return;
		}

		const includeVoxelData = desiredLod <= 1;

		this.desiredStates.set(
			chunk.numericId,
			packLodRevision(desiredLod, revision),
		);

		if (chunk.isLoaded && previousLod !== desiredLod) {
			const hasTargetCachedMesh = chunk.hasCachedLODMesh(desiredLod);

			if (!chunk.hasVoxelData) {
				if (desiredLod <= 1) {
					chunk.lodLevel = desiredLod;
					this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);

					if (!hasTargetCachedMesh) {
						return;
					}
				}

				if (desiredLod >= 2 && !hasTargetCachedMesh) {
					chunk.lodLevel = desiredLod;

					if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
						return;
					}

					this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);
					return;
				}
			}

			chunk.lodLevel = desiredLod;

			if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
				return;
			}

			if (
				previousLod <= 1 ||
				desiredLod <= 1 ||
				!hasTargetCachedMesh ||
				chunk.isDirty
			) {
				chunk.scheduleRemesh(true);
			}

			return;
		}

		chunk.lodLevel = desiredLod;

		if (!chunk.isLoaded) {
			this.ensureChunkQueuedForLoad(
				chunk,
				desiredLod,
				revision,
				includeVoxelData,
			);
		}
	}
	private ensureUndergroundBand(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const bandH = lodRuleSet.horizontalRadiusFor(UNDERGROUND_SKIP_LOD - 1);
		const verticalRange = undergroundVerticalRange(lodRuleSet);

		const startY = Math.max(SETTING_PARAMS.MIN_CHUNK_Y, chunkY - verticalRange);
		const startX = chunkX - bandH;
		const endX = chunkX + bandH;
		const startZ = chunkZ - bandH;
		const endZ = chunkZ + bandH;

		for (let x = startX; x <= endX; x++) {
			for (let z = startZ; z <= endZ; z++) {
				for (let y = startY; y <= -1; y++) {
					this.processTargetChunkCoordinate(
						x,
						y,
						z,
						chunkX,
						chunkY,
						chunkZ,
						lodRuleSet,
					);
				}
			}
		}
	}

	private processMovementRings(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		prevChunkX: number,
		prevChunkY: number,
		prevChunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const dx = chunkX - prevChunkX;
		const dy = chunkY - prevChunkY;
		const dz = chunkZ - prevChunkZ;

		const r = lodRuleSet.maxHorizontalRadius();
		const ry = lodRuleSet.maxVerticalRadius();

		const downwardRy = ry;

		const minY = SETTING_PARAMS.MIN_CHUNK_Y;
		const maxY = minY + SETTING_PARAMS.MAX_CHUNK_HEIGHT;

		const skipX = dx !== 0 ? (dx > 0 ? chunkX + r : chunkX - r) : 0;
		const skipZ = dz !== 0 ? (dz > 0 ? chunkZ + r : chunkZ - r) : 0;

		if (dx !== 0) {
			const x = skipX;

			for (let y = chunkY - downwardRy; y <= chunkY + ry; y++) {
				if (y < minY || y >= maxY) continue;

				for (let z = chunkZ - r; z <= chunkZ + r; z++) {
					this.processTargetChunkCoordinate(
						x,
						y,
						z,
						chunkX,
						chunkY,
						chunkZ,
						lodRuleSet,
					);
				}
			}
		}

		if (dz !== 0) {
			const z = skipZ;

			for (let y = chunkY - downwardRy; y <= chunkY + ry; y++) {
				if (y < minY || y >= maxY) continue;

				for (let x = chunkX - r; x <= chunkX + r; x++) {
					if (dx !== 0 && x === skipX) continue;

					this.processTargetChunkCoordinate(
						x,
						y,
						z,
						chunkX,
						chunkY,
						chunkZ,
						lodRuleSet,
					);
				}
			}
		}

		if (dy !== 0) {
			const y = dy > 0 ? chunkY + ry : chunkY - downwardRy;

			if (y >= minY && y < maxY) {
				for (let x = chunkX - r; x <= chunkX + r; x++) {
					if (dx !== 0 && x === skipX) continue;

					for (let z = chunkZ - r; z <= chunkZ + r; z++) {
						if (dz !== 0 && z === skipZ) continue;

						this.processTargetChunkCoordinate(
							x,
							y,
							z,
							chunkX,
							chunkY,
							chunkZ,
							lodRuleSet,
						);
					}
				}
			}
		}
	}

	private processInitialShell(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const r = lodRuleSet.maxHorizontalRadius();
		const ry = lodRuleSet.maxVerticalRadius();

		const downwardRy = ry;

		const minY = SETTING_PARAMS.MIN_CHUNK_Y;
		const maxY = minY + SETTING_PARAMS.MAX_CHUNK_HEIGHT;

		const startX = chunkX - r;
		const endX = chunkX + r;
		const startZ = chunkZ - r;
		const endZ = chunkZ + r;
		const startY = chunkY - downwardRy;
		const endY = chunkY + ry;

		for (let x = startX; x <= endX; x++) {
			const relX = x - chunkX;
			const absX = relX < 0 ? -relX : relX;

			for (let y = startY; y <= endY; y++) {
				if (y < minY || y >= maxY) continue;

				const relY = y - chunkY;
				const vDist = relY < 0 ? -relY : relY;

				for (let z = startZ; z <= endZ; z++) {
					const relZ = z - chunkZ;
					const absZ = relZ < 0 ? -relZ : relZ;
					const hDist = absX > absZ ? absX : absZ;

					const existing = getChunk(x, y, z);
					const previousLod = existing?.lodLevel ?? 3;
					const isDirty = existing?.isDirty === true;
					const cacheKey = packOffsetKey(relX, relY, relZ, previousLod);

					let desiredLod = this.getCachedDecisionLod(cacheKey, isDirty);

					if (desiredLod < 0) {
						if (y < 0) {
							if (!undergroundDesired(y, hDist, vDist, lodRuleSet)) {
								continue;
							}

							desiredLod = clampLodForY(
								y,
								lodRuleSet.horizontalLodForDistance(hDist),
							);
						} else {
							const decision = lodRuleSet.resolveWithHysteresisFromDistance(
								hDist,
								vDist,
								previousLod,
							);

							if (!decision.allowsChunkCreation) {
								continue;
							}

							desiredLod = clampLodForY(y, decision.lodLevel);
						}

						this.setCachedDecisionLod(cacheKey, desiredLod, isDirty);
					}

					if (
						existing?.isLoaded &&
						!isDirty &&
						existing.lodLevel === desiredLod &&
						!(desiredLod <= 1 && !existing.hasVoxelData)
					) {
						continue;
					}

					this.applyTargetChunkDecision(
						x,
						y,
						z,
						existing,
						previousLod,
						desiredLod,
					);
				}
			}
		}
	}

	public queueUnloading(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		renderDistance: number,
		verticalRadius: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const unloadQueueSet = this.adapter.getUnloadQueueSet();

		const unloadBuffer = SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER;
		const removeRadius = renderDistance + unloadBuffer;
		const verticalRemoveRadius = verticalRadius + unloadBuffer;

		for (let i = 0; i < _queryScratch.length; i++) {
			const chunk = _queryScratch[i];

			if (chunk.isBoatChunk || unloadQueueSet.has(chunk)) {
				continue;
			}

			const dx = chunk.chunkX - chunkX;
			const dy = chunk.chunkY - chunkY;
			const dz = chunk.chunkZ - chunkZ;

			const absX = dx < 0 ? -dx : dx;
			const absY = dy < 0 ? -dy : dy;
			const absZ = dz < 0 ? -dz : dz;

			const hDist = absX > absZ ? absX : absZ;
			const vDist = absY;

			if (chunk.chunkY < 0) {
				if (
					lodRuleSet.horizontalLodForDistance(hDist) >= UNDERGROUND_SKIP_LOD
				) {
					unloadQueueSet.add(chunk);
				}
				continue;
			}

			if (hDist > removeRadius || vDist > verticalRemoveRadius) {
				unloadQueueSet.add(chunk);
			}
		}
	}

	public tryApplyCachedLodTransitionMesh(
		chunk: Chunk,
		targetLod: number,
	): boolean {
		const cached = chunk.getCachedLODMesh(targetLod);

		if (!cached || (!cached.opaque && !cached.water && !cached.cutout)) {
			return false;
		}

		createMeshFromData(
			chunk,
			cached.opaque ?? null,
			cached.water ?? null,
			cached.cutout ?? null,
		);

		chunk.isDirty = false;
		return true;
	}

	public ensureChunkQueuedForLoad(
		chunk: Chunk,
		desiredLod: number,
		revision: number,
		includeVoxelData = desiredLod <= 1,
	): void {
		desiredLod = clampLodForY(chunk.chunkY, desiredLod);

		if (chunk.isLoaded && (!includeVoxelData || chunk.hasVoxelData)) {
			return;
		}

		const loadQueue = this.adapter.getLoadQueue();
		const numericId = chunk.numericId;
		let request = this.loadQueueRequestMap.get(numericId);

		if (request) {
			request.desiredLod = desiredLod;
			request.revision = revision;
			request.includeVoxelData = includeVoxelData;
			request.priority = Number.POSITIVE_INFINITY;
		} else {
			request = {
				chunk,
				desiredLod,
				revision,
				includeVoxelData,
				priority: Number.POSITIVE_INFINITY,
			};

			loadQueue.push(request);
			this.loadQueueRequestMap.set(numericId, request);
		}

		const unloadSet = this.adapter.getUnloadQueueSet();
		if (unloadSet.has(chunk)) {
			unloadSet.delete(chunk);
		}

		chunk.isTerrainScheduled = true;
	}

	public onLoadRequestsDequeued(
		requests: ReadonlyArray<QueuedChunkRequest>,
	): void {
		for (let i = 0; i < requests.length; i++) {
			this.loadQueueRequestMap.delete(requests[i].chunk.numericId);
		}
	}

	public onChunkDisposed(numericId: number): void {
		this.loadedRefreshQueueSet.delete(numericId);
	}

	private sortLoadQueue(): void {
		const loadQueue = this.adapter.getLoadQueue();
		if (loadQueue.length <= 64) return;

		loadQueue.sort(compareQueuedChunkRequestPriority);
	}

	private computePriority(
		chunk: Chunk,
		desiredLod: number,
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
	): number {
		const dx = chunk.chunkX - playerChunkX;
		const dy = chunk.chunkY - playerChunkY;
		const dz = chunk.chunkZ - playerChunkZ;

		return desiredLod * 1_000_000 + dx * dx + dy * dy + dz * dz;
	}
}
