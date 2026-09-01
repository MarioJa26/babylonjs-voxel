import {
	isInitialized as isDistantTerrainReady,
	update as updateDistantTerrain,
} from "@/code/Generation/DistantTerrain/DistantTerrain";
import { SURFACE_DENSITY_INFLUENCE_RANGE } from "@/code/Generation/SurfaceGenerator";
import { getFinalTerrainHeight } from "@/code/Generation/TerrainHeightMap";
import { isInCave } from "@/code/Lib/GameRuntimeState";
import { CHUNK_SHIFT } from "@/code/Lib/VoxelMath";
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
import {
	maxLodForChunkY,
	UNDERGROUND_CULL_EXEMPT_RADIUS,
	UNDERGROUND_SKIP_LOD,
} from "../Worker/LODUtilities";

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

Fully-buried chunks beyond a small exempt core around the player are culled
at every horizontal distance: below the heightmap surface they can only
contain sealed cave interiors, which are invisible from outside at that
distance (DistantHorizons-style surface-only far terrain). Without this,
climbing tall mountains renders their entire buried cave systems. Cave mode
bypasses the cull so the surrounding tunnels keep rendering.
 */
function undergroundDesired(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	hDist: number,
	vDist: number,
	lodRuleSet: ChunkLodRuleSet,
): boolean {
	if (chunkY >= 0) return false;
	if (lodRuleSet.horizontalLodForDistance(hDist) >= UNDERGROUND_SKIP_LOD) {
		return false;
	}
	if (buriedChunkCulled(chunkX, chunkY, chunkZ, hDist)) {
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
// Multiplicative fields stay float-exact (< 2^53) while widening the ranges:
// rx/rz hold ±2047 (render radii beyond that are unrealistic), ry ±127, and
// prevLod 0..7 (DISTANT_LOD_LEVEL = 6). The absolute-y sign bit exists
// because decisions are not purely player-relative: y < 0 routes through
// clampLodForY's LOD-1 cap, so a cached surface-band LOD must never be
// served to an underground coordinate sharing the same relative offsets
// (and vice versa).
function packOffsetKey(
	rx: number,
	ry: number,
	rz: number,
	chunkY: number,
	chunkLod: number,
): number {
	return (
		((rz + 2048) & 0xfff) * 16777216 +
		((rx + 2048) & 0xfff) * 4096 +
		((ry + 128) & 0xff) * 16 +
		((chunkY < 0 ? 1 : 0) << 3) +
		(chunkLod & 7)
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

// Collision-free column key for signed 32-bit chunk coordinates: 26 bits per
// axis (aliases only beyond ±33.5M chunks — far outside any playable range,
// unlike the old 16-bit XOR-style packing). The stride is 1 << 26, but the
// combine must stay multiplicative: `<<` coerces through signed 32-bit and
// the composite key exceeds 2^31 (see packLodRevision note below).
const COLUMN_KEY_AXIS_STRIDE = 1 << 26;

function packColumnKey(x: number, z: number): number {
	return (x & 0x3ffffff) * COLUMN_KEY_AXIS_STRIDE + (z & 0x3ffffff);
}

function columnTopChunkY(x: number, z: number): number {
	const key = packColumnKey(x, z);
	if (frameCacheActive) {
		const fc = frameColTopCache.get(key);
		if (fc !== undefined) return fc;
	}
	const cached = colTopCache.get(key);
	if (cached !== undefined) {
		if (frameCacheActive) frameColTopCache.set(key, cached);
		return cached;
	}

	const h = getFinalTerrainHeight(x * Chunk.SIZE + 16, z * Chunk.SIZE + 16);
	const topY = Math.ceil(h / Chunk.SIZE);
	colTopCache.set(key, topY);
	if (frameCacheActive) frameColTopCache.set(key, topY);

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

// Burial cache for the far-band underground cull in undergroundDesired.
// Value is the largest chunkY whose entire volume lies below the true surface
// over the column pair's chunk footprint; a target chunk is fully buried when
// chunkY < value.
const BURIED_CACHE_MAX = COL_TOP_CACHE_MAX;
const buriedCache = new Map<number, number>();

// Per-frame memoization for height queries — avoids repeated Map lookups +
// noise evals when many Y-levels share the same (x,z) column in one
// updateChunksAround tick (e.g. processMovementRings scans a vertical slab).
const frameBuriedCache = new Map<number, number>();
const frameColTopCache = new Map<number, number>();
let frameInCaveCache = false;
let frameCacheActive = false;

// Two allowances on top of the raw 2D heightmap minimum:
// - half a chunk absorbs terrain dips narrower than the corner sampling grid;
// - SURFACE_DENSITY_INFLUENCE_RANGE is how far the TRUE surface (3D density
//   sign flip, see SurfaceGenerator.findTopSurfaceY) can rise above the 2D
//   heightmap estimate. Without it, tall density-amplified mountains keep
//   their whole interior rendered.
const BURIED_SAFETY_MARGIN = Chunk.SIZE / 2 + SURFACE_DENSITY_INFLUENCE_RANGE;

function buriedTopChunkY(x: number, z: number): number {
	const key = packColumnKey(x, z);
	if (frameCacheActive) {
		const fc = frameBuriedCache.get(key);
		if (fc !== undefined) return fc;
	}
	const cached = buriedCache.get(key);
	if (cached !== undefined) {
		if (frameCacheActive) frameBuriedCache.set(key, cached);
		return cached;
	}

	const wx = x * Chunk.SIZE;
	const wz = z * Chunk.SIZE;
	const mid = Chunk.SIZE >> 1;
	let minH = getFinalTerrainHeight(wx, wz);
	minH = Math.min(minH, getFinalTerrainHeight(wx + Chunk.SIZE, wz));
	minH = Math.min(minH, getFinalTerrainHeight(wx, wz + Chunk.SIZE));
	minH = Math.min(
		minH,
		getFinalTerrainHeight(wx + Chunk.SIZE, wz + Chunk.SIZE),
	);
	minH = Math.min(minH, getFinalTerrainHeight(wx + mid, wz + mid));

	const topY = Math.floor((minH - BURIED_SAFETY_MARGIN) / Chunk.SIZE);
	buriedCache.set(key, topY);
	if (frameCacheActive) frameBuriedCache.set(key, topY);

	if (buriedCache.size > BURIED_CACHE_MAX) {
		let toEvict = BURIED_CACHE_MAX >> 2;
		for (const k of buriedCache.keys()) {
			buriedCache.delete(k);
			if (--toEvict <= 0) break;
		}
	}

	return topY;
}

/**
 * True when the coordinate lies fully below the heightmap surface and is far
 * enough from the player that its (necessarily sealed) interior cannot be
 * seen: DistantHorizons-style surface-only culling. Applies at ALL Y —
 * mountain interiors live in positive chunkY, deep caves below y=0.
 */
function buriedChunkCulled(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	hDist: number,
): boolean {
	if (hDist <= UNDERGROUND_CULL_EXEMPT_RADIUS) return false;
	if (frameCacheActive) {
		if (frameInCaveCache) return false;
	} else {
		if (isInCave()) return false;
	}
	return chunkY < buriedTopChunkY(chunkX, chunkZ);
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
	// Bucketed by revision to avoid O(n) prune iteration (previously 3.8 MB Set churn).
	private desiredStateBuckets = new Map<number, Set<number>>();
	private readonly _freeDesiredSets: Set<number>[] = [];

	private loadQueueRequestMap = new Map<number, QueuedChunkRequest>();
	private readonly _freeRequests: QueuedChunkRequest[] = [];

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

	private trackDesiredState(
		numericId: number,
		packed: number,
		revision: number,
	): void {
		this.desiredStates.set(numericId, packed);
		let bucket = this.desiredStateBuckets.get(revision);
		if (!bucket) {
			const pooled = this._freeDesiredSets.pop();
			if (pooled !== undefined) {
				pooled.clear();
				bucket = pooled;
			} else {
				bucket = new Set<number>();
			}
			this.desiredStateBuckets.set(revision, bucket);
		}
		bucket.add(numericId);
	}

	private pruneDesiredStates(currentRevision: number): void {
		const oldestKept = Math.max(
			0,
			currentRevision -
				ChunkStreamingController.DESIRED_STATE_REVISION_RETENTION,
		);
		// Delete buckets older than oldestKept – O(k) where k = chunks inserted at that revision
		for (const [rev, bucket] of this.desiredStateBuckets) {
			if (rev < oldestKept) {
				for (const id of bucket) {
					// Only delete if still mapping to that old revision (may have been overwritten)
					const cur = this.desiredStates.get(id);
					if (cur !== undefined && unpackRevision(cur) === rev) {
						this.desiredStates.delete(id);
					}
				}
				this.desiredStateBuckets.delete(rev);
				bucket.clear();
				this._freeDesiredSets.push(bucket);
			}
		}
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
		const revision = ++this.streamRevision;

		// Reuse the existing map and its internal capacity instead of allocating
		// a replacement map and leaving the old one for garbage collection.
		if (revision % 512 === 0) {
			this._refreshCache.clear();
		}

		const caveState = isInCave();

		// Activate per-frame memoization for height queries.
		frameBuriedCache.clear();
		frameColTopCache.clear();
		frameInCaveCache = caveState;
		frameCacheActive = true;

		const distantTerrainX = playerWorldX ?? chunkX << CHUNK_SHIFT;
		const distantTerrainZ = playerWorldZ ?? chunkZ << CHUNK_SHIFT;

		try {
			if (isDistantTerrainReady()) {
				updateDistantTerrain(distantTerrainX, distantTerrainZ);
			}

			FarTileManager.update(distantTerrainX, distantTerrainZ);

			const lodRuleSet = this.getLodRuleSet(
				caveState,
				renderDistance,
				verticalRadius,
			);

			// Cache values used repeatedly in the loops below.
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

			// Capture the initial length because this loop compacts the same array.
			for (
				let readIndex = 0, readLength = loadQueue.length;
				readIndex < readLength;
				readIndex++
			) {
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

					const key = packOffsetKey(
						relX,
						relY,
						relZ,
						chunk.chunkY,
						previousLod,
					);

					desiredLod = this.getCachedDecisionLod(key, chunk.isDirty);

					if (desiredLod < 0) {
						desiredLod = lodRuleSet.resolveWithHysteresisFromDistance(
							hDist,
							vDist,
							previousLod,
						).lodLevel;

						this.setCachedDecisionLod(key, desiredLod, chunk.isDirty);
					}
				}

				const loadUndesired =
					chunk.chunkY < 0
						? !undergroundDesired(
								chunk.chunkX,
								chunk.chunkY,
								chunk.chunkZ,
								hDist,
								vDist,
								lodRuleSet,
							)
						: buriedChunkCulled(
								chunk.chunkX,
								chunk.chunkY,
								chunk.chunkZ,
								hDist,
							);

				if (loadUndesired) {
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

				this.trackDesiredState(
					chunk.numericId,
					packLodRevision(desiredLod, revision),
					revision,
				);

				this.loadQueueRequestMap.set(chunk.numericId, request);

				loadQueue[writeIndex++] = request;
			}

			loadQueue.length = writeIndex;

			for (const chunk of unloadQueueSet) {
				const relX = chunk.chunkX - chunkX;
				const relY = chunk.chunkY - chunkY;
				const relZ = chunk.chunkZ - chunkZ;

				const absX = relX < 0 ? -relX : relX;
				const absY = relY < 0 ? -relY : relY;
				const absZ = relZ < 0 ? -relZ : relZ;

				const hDist = absX > absZ ? absX : absZ;
				const vDist = absY;

				const keep =
					chunk.chunkY < 0
						? undergroundDesired(
								chunk.chunkX,
								chunk.chunkY,
								chunk.chunkZ,
								hDist,
								vDist,
								lodRuleSet,
							)
						: !buriedChunkCulled(
								chunk.chunkX,
								chunk.chunkY,
								chunk.chunkZ,
								hDist,
							) &&
							hDist <= operationalRadius &&
							vDist <= operationalVerticalRadius;

				if (keep) {
					unloadQueueSet.delete(chunk);
				}
			}

			const canUseDelta =
				prevChunkX !== undefined &&
				prevChunkY !== undefined &&
				prevChunkZ !== undefined &&
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
				revision % ChunkStreamingController.DESIRED_STATE_REVISION_RETENTION ===
					0
			) {
				this.pruneDesiredStates(revision);
			}

			this.adapter.onQueueSnapshotChanged?.();
		} finally {
			frameCacheActive = false;
		}
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

			// Must run before the cached-decision lookup: offsets are
			// player-relative, so climbing straight up reuses the same keys
			// and would otherwise keep serving pre-cull desired LODs.
			if (buriedChunkCulled(chunk.chunkX, chunk.chunkY, chunk.chunkZ, hDist)) {
				continue;
			}

			const chunkLod = chunk.lodLevel ?? 3;
			const key = packOffsetKey(relX, relY, relZ, chunk.chunkY, chunkLod);

			let decisionLod = this.getCachedDecisionLod(key, chunk.isDirty);

			if (decisionLod < 0) {
				if (chunk.chunkY < 0) {
					if (
						!undergroundDesired(
							chunk.chunkX,
							chunk.chunkY,
							chunk.chunkZ,
							hDist,
							vDist,
							lodRuleSet,
						)
					) {
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

		// Per-frame memoization for height queries (independent from
		// updateChunksAround's frame cache so each phase is self-contained).
		const wasActive = frameCacheActive;
		if (!wasActive) {
			frameBuriedCache.clear();
			frameColTopCache.clear();
			frameCacheActive = true;
		}
		frameInCaveCache = caveState;
		let processed = 0;

		try {
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
		} finally {
			if (!wasActive) frameCacheActive = false;
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

		// ALLOCATION GUARD (profile: 45% of heap churn via `new Chunk` for empty
		// sky cells): skip columns provably above terrain. Reuses per-frame
		// columnTop cache so the height probe is free after first Y in column.
		if (y >= 0 && y > columnTopChunkY(x, z) + 1) {
			return;
		}

		// Surface-only cull: fully-buried coordinates beyond the exempt core
		// are invisible from outside at any Y — never create or refresh them.
		if (buriedChunkCulled(x, y, z, hDist)) {
			return;
		}

		const chunk = getChunk(x, y, z);
		const previousLod = chunk?.lodLevel ?? 3;
		const isDirty = chunk?.isDirty === true;

		const cacheKey = packOffsetKey(relX, relY, relZ, y, previousLod);
		let desiredLod = this.getCachedDecisionLod(cacheKey, isDirty);

		if (desiredLod < 0) {
			if (y < 0) {
				if (!undergroundDesired(x, y, z, hDist, vDist, lodRuleSet)) {
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
			chunk = Chunk.obtain(x, y, z);
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

		this.trackDesiredState(
			chunk.numericId,
			packLodRevision(desiredLod, revision),
			revision,
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

		// Hoisted: buriedChunkCulled consults the same flag per coordinate.
		const caveState = isInCave();

		for (let x = startX; x <= endX; x++) {
			const absX = Math.abs(x - chunkX);

			for (let z = startZ; z <= endZ; z++) {
				const absZ = Math.abs(z - chunkZ);
				const hDist = absX > absZ ? absX : absZ;

				// Outdoors beyond the exempt core, every Y below the burial
				// boundary is guaranteed rejected — skip straight past it
				// instead of paying a rejection pass per coordinate.
				let scanStart = startY;
				if (!caveState && hDist > UNDERGROUND_CULL_EXEMPT_RADIUS) {
					const boundary = buriedTopChunkY(x, z);
					if (scanStart < boundary) scanStart = boundary;
				}

				for (let y = scanStart; y <= -1; y++) {
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

					// Spawn-time surface-only cull. This shell resolves LODs
					// inline instead of via processTargetChunkCoordinate, so
					// without this every buried interior chunk materializes
					// on boot and only clears after the first move. Must run
					// before the cached-decision lookup (player-relative keys
					// repeat across spawns at the same position).
					if (buriedChunkCulled(x, y, z, hDist)) {
						continue;
					}

					const existing = getChunk(x, y, z);
					const previousLod = existing?.lodLevel ?? 3;
					const isDirty = existing?.isDirty === true;
					const cacheKey = packOffsetKey(relX, relY, relZ, y, previousLod);

					let desiredLod = this.getCachedDecisionLod(cacheKey, isDirty);

					if (desiredLod < 0) {
						if (y < 0) {
							if (!undergroundDesired(x, y, z, hDist, vDist, lodRuleSet)) {
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

		// Resolve invariant underground limits once instead of once per chunk.
		const undergroundHorizontalRadius = lodRuleSet.horizontalRadiusFor(
			UNDERGROUND_SKIP_LOD - 1,
		);
		const undergroundVerticalRadius = undergroundVerticalRange(lodRuleSet);
		const caveState = isInCave();

		for (let i = 0, length = _queryScratch.length; i < length; i++) {
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

			if (chunk.chunkY < 0) {
				// Keep unloading behavior symmetrical with undergroundDesired().
				//
				// Previously, an underground chunk within the horizontal band
				// was never unloaded solely because it exceeded the underground
				// vertical range. Over long vertical travel, those chunks could
				// therefore remain resident indefinitely.
				const outsideHorizontalBand = hDist > undergroundHorizontalRadius;
				const outsideVerticalBand = absY > undergroundVerticalRadius;

				// Inline the burial predicate so isInCave() is not called for
				// every chunk in this hot loop.
				const fullyBuriedAndCullable =
					!caveState &&
					hDist > UNDERGROUND_CULL_EXEMPT_RADIUS &&
					chunk.chunkY < buriedTopChunkY(chunk.chunkX, chunk.chunkZ);

				if (
					outsideHorizontalBand ||
					outsideVerticalBand ||
					fullyBuriedAndCullable
				) {
					unloadQueueSet.add(chunk);
				}

				continue;
			}

			const fullyBuriedAndCullable =
				!caveState &&
				hDist > UNDERGROUND_CULL_EXEMPT_RADIUS &&
				chunk.chunkY < buriedTopChunkY(chunk.chunkX, chunk.chunkZ);

			if (
				hDist > removeRadius ||
				absY > verticalRemoveRadius ||
				fullyBuriedAndCullable
			) {
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
			const pooled = this._freeRequests.pop();
			if (pooled !== undefined) {
				pooled.chunk = chunk;
				pooled.desiredLod = desiredLod;
				pooled.revision = revision;
				pooled.includeVoxelData = includeVoxelData;
				pooled.priority = chunk.lodLevel << 4;
				request = pooled;
			} else {
				request = {
					chunk,
					desiredLod,
					revision,
					includeVoxelData,
					priority: chunk.lodLevel << 4,
				};
			}

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

	public recycleQueuedRequests(
		requests: ReadonlyArray<QueuedChunkRequest>,
	): void {
		for (let i = 0; i < requests.length; i++) {
			const r = requests[i] as QueuedChunkRequest;
			// Clear chunk reference to avoid retaining disposed chunks; will be reassigned on reuse.
			(r as unknown as { chunk: Chunk | null }).chunk =
				null as unknown as Chunk;
			this._freeRequests.push(r);
		}
	}

	public onChunkDisposed(numericId: number): void {
		this.loadedRefreshQueueSet.delete(numericId);
	}

	private sortLoadQueue(): void {
		const loadQueue = this.adapter.getLoadQueue();
		if (loadQueue.length <= 64) return;
		// Fast-path: skip sort if already sorted (common after 1-chunk move)
		let sorted = true;
		for (let i = 1; i < loadQueue.length; i++) {
			if (loadQueue[i].priority < loadQueue[i - 1].priority) {
				sorted = false;
				break;
			}
		}
		if (sorted) return;
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
