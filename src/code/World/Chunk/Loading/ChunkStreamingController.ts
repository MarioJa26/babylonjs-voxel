import {
	isInitialized as isDistantTerrainReady,
	update as updateDistantTerrain,
} from "@/code/Generation/DistantTerrain/DistantTerrain";
import { structureColumnTopY } from "@/code/Generation/Structure/StructureColumnTops";
import { SURFACE_DENSITY_INFLUENCE_RANGE } from "@/code/Generation/SurfaceGenerator";
import {
	columnMinHeight,
	effectiveColumnTopChunkY,
	getFinalTerrainHeight,
	getTerrainSeedAsInt,
	isOceanFloorBandChunk,
} from "@/code/Generation/TerrainHeightMap";
import { FRAME_WORK_BUDGET, FrameWorkKind } from "@/code/Lib/FrameWorkBudget";
import { isInCave } from "@/code/Lib/GameRuntimeState";
import { CHUNK_SHIFT } from "@/code/Lib/VoxelMath";
import { FarTileManager } from "../../FarTiles/FarTileManager";
import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import { Chunk } from "../Chunk";
import { ChunkWorkerPool } from "../ChunkWorkerPool";
import { packCoords } from "../DataStructures/ChunkCoords";
import {
	ChunkLodRuleSet,
	DistantOnlyChunkCreationRule,
	Lod0ChunkCreationRule,
} from "../LOD/ChunkLodRules";
import {
	maxLodForChunkY,
	UNDERGROUND_CULL_EXEMPT_RADIUS,
	UNDERGROUND_SKIP_LOD,
} from "../LOD/LODUtilities";
import { isStaleLodMesh } from "../LOD/LodCurrency";
import { createMeshFromData } from "../Meshing/ChunkMesher";
import { getChunkFast } from "../Runtime/ChunkRegistry";
import {
	ChunkLifecycle,
	type ChunkLifecycleHost,
	deriveResidencyState,
	ResidencyState,
	setChunkLifecycleHost,
} from "./ChunkLifecycle";
import { chunkForwardScore, chunkPriority } from "./ChunkPriority";
import {
	ChunkResidency,
	forgetChunkResidency,
	residencyForLod,
	setChunkResidency,
} from "./ChunkResidency";

/** Underground (cave) chunks never coarsen: clamp any desired LOD. */
function clampLodForY(chunkY: number, lod: number): number {
	const max = maxLodForChunkY(chunkY);
	return lod > max ? max : lod;
}

/**
 * Engine perf: streaming path only (per candidate chunk, not per voxel).
 * Shared LOD decision for processTarget / initial-shell / loaded-refresh.
 * Returns -1 when the coordinate must be skipped (matches the
 * getCachedDecisionLod miss sentinel). `enforceCreation` gates on
 * `allowsChunkCreation` — true for load paths, false for loaded-refresh
 * (the chunk already exists, creation is moot). The clamp is identity for
 * y >= 0 (maxLodForChunkY), so all three call sites share one shape.
 */
function resolveDesiredLod(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	hDist: number,
	vDist: number,
	previousLod: number,
	lodRuleSet: ChunkLodRuleSet,
	enforceCreation: boolean,
): number {
	if (chunkY < 0) {
		if (!undergroundDesired(chunkX, chunkY, chunkZ, hDist, vDist, lodRuleSet)) {
			return -1;
		}
		return clampLodForY(chunkY, lodRuleSet.horizontalLodForDistance(hDist));
	}
	const decision = lodRuleSet.resolveWithHysteresisFromDistance(
		hDist,
		vDist,
		previousLod,
	);
	if (enforceCreation && !decision.allowsChunkCreation) return -1;
	return clampLodForY(chunkY, decision.lodLevel);
}

/**
 * Engine perf: streaming loops only. Branchless-abs + Chebyshev helpers for
 * the relX/relY/relZ distance boilerplate (7 sites). Trivially inlineable,
 * zero allocation — same ops as the inline ternaries.
 */
function absI(n: number): number {
	return n < 0 ? -n : n;
}

function chebyH(x: number, z: number): number {
	const ax = absI(x);
	const az = absI(z);
	return ax > az ? ax : az;
}

/**
 * Engine perf: unload hot loop only. Shared burial predicate for the two
 * unload branches. `caveState` is threaded in so `isInCave()` is not called
 * per chunk. Zero allocation, same ops as the inline version.
 */
function isBuriedCullable(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	hDist: number,
	caveState: boolean,
): boolean {
	return (
		!caveState &&
		hDist > UNDERGROUND_CULL_EXEMPT_RADIUS &&
		chunkY < columnProfile(chunkX, chunkZ).buriedTopY
	);
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

	// Open water columns are visible from the sky, not sealed caves: the
	// solid band from the seabed chunk up to y=-1 (slopes included) is judged
	// by the surface vertical window instead of the cave cap. Rock below the
	// seabed chunk keeps the culls above. (Burial can never fire inside the
	// band — its boundary sits 1+ chunks below the seabed by construction.)
	let verticalCap = undergroundVerticalRange(lodRuleSet);
	if (isOceanFloorBandChunk(chunkX, chunkY, chunkZ)) {
		const surfaceWindow = lodRuleSet.verticalRadiusFor(0);
		if (surfaceWindow > verticalCap) verticalCap = surfaceWindow;
	}

	return vDist <= verticalCap;
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
	/** Tombstone: dropped from the load path; reconcile/PrepareLoadBatch skip + pool it. */
	cancelled?: boolean;
};

function compareQueuedChunkRequestPriority(
	a: QueuedChunkRequest,
	b: QueuedChunkRequest,
): number {
	return a.priority - b.priority;
}

// Scratch array for LoadedChunkIndex.queryCollect, avoids generator overhead.
const _queryScratch: Chunk[] = [];
// Separate scratch for the unload scan (trailing-slab vs full).
const _unloadScratch: Chunk[] = [];

// Scratch list for sweepOrphanedChunks: candidates that were inspected and found
// healthy (or no longer wanting loading) and so should leave the candidate set.
// Reused across passes so the sweep allocates nothing. See sweepOrphanedChunks.
const _orphanSweepResolved: Chunk[] = [];

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
	/**
	 * Whether the chunk sits in the scheduler's unprocessed unload batch.
	 * The scheduler dequeues unload entries into its batch (removing them
	 * from the set), but they are still Unloading — without this the owner
	 * would derive Loaded at dispose time and reject completeUnload.
	 */
	isInUnloadBatch?(chunk: Chunk): boolean;
	onQueueSnapshotChanged?(): void;
}

// One cached profile per (x,z) column. Previously this was two independent
// caches (column top + burial boundary) with copy-pasted lookup/eviction
// code; they derive from the same heightfield, so one entry serves every
// consumer (sky guard, burial cull, unload symmetry).
export interface ColumnProfile {
	// Exclusive top: first chunk fully above the surface (water-aware).
	topY: number;
	// Largest chunkY whose entire volume lies below the true surface; a
	// target chunk is fully buried when chunkY < buriedTopY.
	buriedTopY: number;
}
const COLUMN_PROFILE_CACHE_MAX = 16384;
const columnProfileCache = new Map<number, ColumnProfile>();
/** World seed the cached profiles were built for (see columnProfile). */
let columnProfileSeed = -1;

// Collision-free column key for signed 32-bit chunk coordinates: 26 bits per
// axis (aliases only beyond ±33.5M chunks — far outside any playable range,
// unlike the old 16-bit XOR-style packing). The stride is 1 << 26, but the
// combine must stay multiplicative: `<<` coerces through signed 32-bit and
// the composite key exceeds 2^31 (see packLodRevision note below).
const COLUMN_KEY_AXIS_STRIDE = 1 << 26;

function packColumnKey(x: number, z: number): number {
	return (x & 0x3ffffff) * COLUMN_KEY_AXIS_STRIDE + (z & 0x3ffffff);
}

let frameInCaveCache = false;
let frameCacheActive = false;

/**
 * Record the residency tier a chunk drops to as it leaves the active set.
 *
 * Called ONLY for chunks actually being unloaded, never for every chunk scanned.
 * `queueUnloading` runs over every loaded chunk on every streaming pass, so
 * computing the packed key eagerly for all of them put a `packCoords` call ahead
 * of the cheap distance comparisons across the entire resident set.
 *
 * A chunk leaving the render distance but whose blob is still cached ends at
 * `Persisted`, not `Absent` — recovery is then a local cache read rather than a
 * network round trip. Buried chunks always end at `Persisted`, since burial is
 * not a distance decision and digging back down should still hit the cache.
 */
function noteChunkEvicted(chunk: Chunk, buried: boolean): void {
	const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);

	setChunkResidency(
		key,
		buried ? ChunkResidency.Persisted : residencyForLod(chunk.lodLevel),
	);
}

// Two allowances on top of the raw 2D heightmap minimum:
// - half a chunk absorbs terrain dips narrower than the corner sampling grid;
// - SURFACE_DENSITY_INFLUENCE_RANGE is how far the TRUE surface (3D density
//   sign flip, see SurfaceGenerator.findTopSurfaceY) can rise above the 2D
//   heightmap estimate. Without it, tall density-amplified mountains keep
//   their whole interior rendered.
const BURIED_SAFETY_MARGIN = Chunk.SIZE / 2 + SURFACE_DENSITY_INFLUENCE_RANGE;

function ensureColumnProfileSeed(): void {
	const seed = getTerrainSeedAsInt();
	if (seed !== columnProfileSeed) {
		columnProfileSeed = seed;
		columnProfileCache.clear();
	}
}

function columnProfile(x: number, z: number): ColumnProfile {
	const key = packColumnKey(x, z);
	const cached = columnProfileCache.get(key);
	if (cached !== undefined) return cached;

	const seed = getTerrainSeedAsInt();

	// The center sample doubles as columnMinHeight's mid sample (fhc-cached),
	// so this costs one sampling pass per column, not two.
	const centerH = getFinalTerrainHeight(
		x * Chunk.SIZE + 16,
		z * Chunk.SIZE + 16,
	);
	const minH = columnMinHeight(x, z);

	// STRUCTURE-AWARE SKY BOUND. A tower is a solid cylinder standing on the
	// ground; its upper chunks live ABOVE the terrain top. Ask the features
	// how high they reach and use the higher of the two bounds.
	const structureTop =
		seed === 0
			? -1
			: structureColumnTopY(x * Chunk.SIZE + 16, z * Chunk.SIZE + 16, seed);
	const surfaceTop = structureTop > centerH ? structureTop : centerH;

	const profile: ColumnProfile = {
		topY: effectiveColumnTopChunkY(surfaceTop),
		buriedTopY: Math.floor((minH - BURIED_SAFETY_MARGIN) / Chunk.SIZE),
	};
	columnProfileCache.set(key, profile);

	if (columnProfileCache.size > COLUMN_PROFILE_CACHE_MAX) {
		let toEvict = COLUMN_PROFILE_CACHE_MAX >> 2;
		for (const k of columnProfileCache.keys()) {
			columnProfileCache.delete(k);
			if (--toEvict <= 0) break;
		}
	}

	return profile;
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
	return chunkY < columnProfile(chunkX, chunkZ).buriedTopY;
}

export class ChunkStreamingController {
	private static readonly DESIRED_STATE_REVISION_RETENTION = 8;
	/** Full-band refresh scan runs every Nth player-chunk-move (near window
	 *  scans every move — see enqueueLoadedChunksForRefresh). */
	private static readonly OUTER_SCAN_INTERVAL = 4;

	/**
	 * Wall-clock ceiling for one frame's loaded-refresh drain.
	 *
	 * Matches the mesh-ingest budget in ChunkWorkerPool (MESH_INGEST_BUDGET_MS)
	 * so neither half of the per-frame LOD reconciliation can dominate a frame
	 * on its own. The count cap (CHUNK_LOAD_BATCH_LIMIT) still applies; this is
	 * the additional bound that keeps a batch of synchronous mesh applications
	 * from turning into an arbitrarily long frame.
	 */
	private static readonly LOADED_REFRESH_FRAME_BUDGET_MS = 3.5;

	/**
	 * Upper bound on pooled QueuedChunkRequest objects.
	 *
	 * Requests are recycled a whole batch at a time but handed back out one at
	 * a time, so an uncapped pool grows by ~CHUNK_LOAD_BATCH_LIMIT per
	 * PrepareLoadBatch pass and never shrinks.
	 */
	private static readonly FREE_REQUEST_POOL_MAX = 512;

	/**
	 * Max orphaned chunks re-queued per orphan sweep (see sweepOrphanedChunks).
	 */
	private static readonly ORPHAN_SWEEP_MAX_PER_PASS = 128;

	/** Minimum ms between orphan sweeps — the sweep is a safety net, not a hot path. */
	private static readonly ORPHAN_SWEEP_INTERVAL_MS = 250;

	private streamRevision = 0;

	// Player chunk coords captured at start of updateChunksAround (for enqueueLoad priority).
	private _pcx = 0;
	private _pcy = 0;
	private _pcz = 0;

	/** Chunk-space movement direction of the last update (for ahead bonus). */
	private lastMoveDx = 0;
	private lastMoveDz = 0;

	/** Chunks re-queued by the most recent orphan sweep (see sweepOrphanedChunks). */
	public getLastOrphanSweepRescued(): number {
		return this._lastOrphanSweepRescued;
	}

	/** Total chunks re-queued by orphan sweeps this session. */
	public getTotalOrphanSweepRescued(): number {
		return this._totalOrphanSweepRescued;
	}

	// Packed as desiredLod + revision * 8.
	// Keyed by chunk.numericId, because number keys avoid BigInt box churn.
	private desiredStates = new Map<number, number>();
	// Bucketed by revision to avoid O(n) prune iteration (previously 3.8 MB Set churn).
	private desiredStateBuckets = new Map<number, Set<number>>();
	private readonly _freeDesiredSets: Set<number>[] = [];

	private loadQueueRequestMap = new Map<number, QueuedChunkRequest>();
	private readonly _freeRequests: QueuedChunkRequest[] = [];

	/**
	 * Numeric ids of chunks whose request the scheduler has dequeued and is
	 * currently processing (storage read in flight, or awaiting hydration).
	 *
	 * Those chunks are in neither `loadQueue` nor the worker pool, so the
	 * orphan sweep would otherwise mistake them for strays and queue a second
	 * request, making the chunk load twice per pass. Cleared when the batch is
	 * recycled, or when recoverProcessState puts it back on `loadQueue`.
	 */
	private readonly _loadRequestsInFlight = new Set<number>();

	/**
	 * Request objects the scheduler has dequeued and is currently processing,
	 * keyed by chunk numericId. Populated by the host's `moveLoadToInFlight`
	 * (which runs while the map entry still exists), consumed by
	 * `moveInFlightToLoad` (abandon + requeue restores the same object),
	 * `clearInFlight`, and `dropFromLoadPath`.
	 *
	 * Lifecycle mirror rule: an entry lives here exactly while its numericId
	 * lives in `_loadRequestsInFlight`. Every path that deletes from one must
	 * delete from the other (`onLoadRequestsRecovered`,
	 * `onLoadRequestsAbandoned`, `recycleQueuedRequests`, `onChunkDisposed`
	 * all maintain both), or a recycled request object could be resurrected
	 * onto the queue while also sitting in the free pool.
	 */
	private readonly _inFlightRequests = new Map<number, QueuedChunkRequest>();

	/**
	 * ChunkLifecycle host over this controller's load-path state. The read-only
	 * queries back the residency-invariant checker; the side effects are what
	 * the owner performs when a transition is routed through it. Published via
	 * setChunkLifecycleHost in the constructor.
	 *
	 * In-flight requests are retained in `_inFlightRequests` (populated by
	 * `moveLoadToInFlight`, consumed by `moveInFlightToLoad`/`clearInFlight`/
	 * `dropFromLoadPath`) so `abandonLoad(requeue)` restores the SAME request
	 * object — preserving its revision/desiredLod/priority — instead of
	 * allocating a fresh one the scheduler would treat as a duplicate.
	 */
	private readonly _lifecycleHost: ChunkLifecycleHost = {
		isQueuedForLoad: (view) =>
			this.loadQueueRequestMap.has((view as Chunk).numericId),
		isLoadInFlight: (view) =>
			this._loadRequestsInFlight.has((view as Chunk).numericId),
		isGenerating: (view) =>
			ChunkWorkerPool.getInstance().isChunkGenerating(view as Chunk),
		isUnloading: (view) =>
			this.adapter.getUnloadQueueSet().has(view as Chunk) ||
			this.adapter.isInUnloadBatch?.(view as Chunk) === true,
		isRemeshInFlight: (view) =>
			ChunkWorkerPool.getInstance().isRemeshInFlightFor(view as Chunk),

		moveLoadToInFlight: (view) => {
			const chunk = view as Chunk;
			const retained = this.loadQueueRequestMap.get(chunk.numericId);
			if (retained !== undefined) {
				this._inFlightRequests.set(chunk.numericId, retained);
			}
			this.loadQueueRequestMap.delete(chunk.numericId);
			this._loadRequestsInFlight.add(chunk.numericId);
			this._orphanCandidates.delete(chunk);
		},
		clearInFlight: (view) => {
			const numericId = (view as Chunk).numericId;
			this._loadRequestsInFlight.delete(numericId);
			// Drop the retention WITHOUT pooling: the request object is still
			// owned by the scheduler's batch, which recycles it exactly once.
			// Pooling here would hand the same object out twice.
			this._inFlightRequests.delete(numericId);
		},
		enqueueUnload: (view) => {
			this.adapter.getUnloadQueueSet().add(view as Chunk);
		},
		dequeueUnload: (view) => {
			this.adapter.getUnloadQueueSet().delete(view as Chunk);
		},
		dropFromLoadPath: (view) => {
			const chunk = view as Chunk;
			const request = this.loadQueueRequestMap.get(chunk.numericId);
			this.loadQueueRequestMap.delete(chunk.numericId);
			this._loadRequestsInFlight.delete(chunk.numericId);
			// Same no-pool rule as clearInFlight: the scheduler's batch still
			// references this object and recycles it on its own path.
			this._inFlightRequests.delete(chunk.numericId);
			// Tombstone instead of indexOf + splice (O(queue) per evicted chunk).
			// The reconcile loop + PrepareLoadBatch skip + drop + pool cancelled
			// requests. requestMap entry removed immediately. Never pools here.
			if (request) request.cancelled = true;
		},
		enqueueLoad: (view, request) => {
			if (!request) return; // no payload → nothing to enqueue (defensive)
			const chunk = view as Chunk;
			const desiredLod = clampLodForY(chunk.chunkY, request.desiredLod);
			const revision = request.revision;
			const includeVoxelData =
				request.includeVoxelData ?? request.desiredLod <= 1;

			// STALLFIX: this is the single choke point through which every load
			// request enters `loadQueue`, so it is also where the matching desired
			// state must be published. ChunkProcessScheduler.PrepareLoadBatch drops
			// any request whose `revision` disagrees with the recorded desired state.
			this.trackDesiredState(
				chunk.numericId,
				packLodRevision(desiredLod, revision),
				revision,
			);

			const loadQueue = this.adapter.getLoadQueue();
			const numericId = chunk.numericId;
			let req = this.loadQueueRequestMap.get(numericId);
			if (req) {
				req.desiredLod = desiredLod;
				req.revision = revision;
				req.includeVoxelData = includeVoxelData;
				req.priority = this.computePriority(
					chunk,
					desiredLod,
					this._pcx,
					this._pcy,
					this._pcz,
				);
				req.cancelled = false;
			} else {
				const pooled = this._freeRequests.pop();
				if (pooled !== undefined) {
					pooled.chunk = chunk;
					pooled.desiredLod = desiredLod;
					pooled.revision = revision;
					pooled.includeVoxelData = includeVoxelData;
					pooled.priority = this.computePriority(
						chunk,
						desiredLod,
						this._pcx,
						this._pcy,
						this._pcz,
					);
					pooled.cancelled = false;
					req = pooled;
				} else {
					req = {
						chunk,
						desiredLod,
						revision,
						includeVoxelData,
						priority: this.computePriority(
							chunk,
							desiredLod,
							this._pcx,
							this._pcy,
							this._pcz,
						),
						cancelled: false,
					};
				}
				loadQueue.push(req);
				this.loadQueueRequestMap.set(numericId, req);
			}

			const unloadSet = this.adapter.getUnloadQueueSet();
			if (unloadSet.has(chunk)) {
				unloadSet.delete(chunk);
			}

			// The chunk has a request again, so it is no longer an orphan.
			this._orphanCandidates.delete(chunk);

			chunk.isTerrainScheduled = true;
		},
		moveInFlightToLoad: (view) => {
			const chunk = view as Chunk;
			const numericId = chunk.numericId;
			const retained = this._inFlightRequests.get(numericId);
			this._inFlightRequests.delete(numericId);
			this._loadRequestsInFlight.delete(numericId);
			if (retained?.chunk) {
				// Restore the SAME request (revision/desiredLod/priority
				// intact) so the next scheduler pass adopts it instead of
				// treating it as a duplicate. Guarded against double-queue:
				// a newer request may already exist for this chunk.
				if (!this.loadQueueRequestMap.has(numericId)) {
					retained.cancelled = false;
					this.loadQueueRequestMap.set(numericId, retained);
					this.adapter.getLoadQueue().push(retained);
				}
				// Back on loadQueue with a live request — not an orphan.
				this._orphanCandidates.delete(chunk);
			} else {
				// No retained request (recycled/stale): stay visible to the
				// sweep, which rescues with a freshly tracked desired state.
				this.markPotentialOrphan(chunk);
			}
		},
	};

	private loadedRefreshQueue: Chunk[] = [];
	private loadedRefreshQueueSet = new Set<number>();
	private loadedRefreshQueueHead = 0;

	/** Timestamp (performance.now) of the last orphan sweep; see sweepOrphanedChunks. */
	private _lastOrphanSweepMs = -Infinity;

	/** Chunks rescued by the last orphan sweep pass, and the running total. */
	private _lastOrphanSweepRescued = 0;
	private _totalOrphanSweepRescued = 0;

	/**
	 * Candidates the sweep has inspected and found healthy, cumulative.
	 *
	 * Exists to prove the candidate set is doing its job: this number grows by
	 * roughly the same amount the OLD full-registry scan would have walked, and
	 * the per-frame cost of the sweep is now bounded by THAT instead of by world
	 * residency. If this stays at zero the candidates are never being registered
	 * and orphans would go unnoticed.
	 */
	private _totalOrphanCandidatesInspected = 0;

	/** Cumulative count, for HUD diagnostics. */
	public getTotalOrphanCandidatesInspected(): number {
		return this._totalOrphanCandidatesInspected;
	}

	/**
	 * Chunks that have lost track of their load request.
	 *
	 * PERF/RATIONALE: the sweep used to walk every entry in
	 * `Chunk.chunkInstances`, which holds both loaded and unloaded chunks and
	 * grows with world residency — tens of thousands under a large render
	 * distance, all re-examined 4x/second. Orphans are rare by construction, so
	 * the scan was O(residency) to find O(anomalies).
	 *
	 * This set is the fix: every code path that abandons a request marks the
	 * chunk here, and the sweep inspects only these. Registration is O(1) on a
	 * path that is already doing work, so marking costs nothing measurable.
	 *
	 * Correctness rests on every abandonment path marking, which is why the
	 * marks live next to the abandon branches rather than being inferred. A
	 * chunk can only become an orphan by losing a request, and a request is only
	 * ever removed from `loadQueueRequestMap` in four places, all of which mark.
	 */
	private readonly _orphanCandidates = new Set<Chunk>();

	/**
	 * Flag a chunk whose load request vanished without completing.
	 *
	 * Only chunks that still claim to want loading are registered: a chunk with
	 * `isTerrainScheduled` clear is culled by design, and re-queuing it would
	 * resurrect dead terrain.
	 */
	public markPotentialOrphan(chunk: Chunk): void {
		if (chunk.isTerrainScheduled) {
			this._orphanCandidates.add(chunk);
		}
	}

	/**
	 * Clear the orphan flag — the chunk's request is accounted for again
	 * (queued, in flight, or deliberately given up).
	 */
	public clearPotentialOrphan(chunk: Chunk): void {
		this._orphanCandidates.delete(chunk);
	}

	/**
	 * Is this chunk currently registered as an orphan candidate?
	 *
	 * Diagnostics only — the sweep reads the set directly. Exists so
	 * `validateChunksAround` can prove the registry is complete, which is the
	 * whole safety argument for narrowing the sweep.
	 */
	public isOrphanCandidate(chunk: Chunk): boolean {
		return this._orphanCandidates.has(chunk);
	}

	/**
	 * Size of the orphan candidate set.
	 *
	 * A count that grows without bound means requests are being lost faster than
	 * the sweep can rescue them — the "chunk loading stopped" symptom, visible
	 * here before it shows up as a stalled world.
	 */
	public getOrphanCandidateCount(): number {
		return this._orphanCandidates.size;
	}

	private _cachedCaveLodRuleSet: ChunkLodRuleSet | null = null;
	private _cachedOutdoorLodRuleSet: ChunkLodRuleSet | null = null;

	private _ruleSetGeneration = 0;
	private _refreshArr: Int8Array | null = null;
	private _refreshFallback = new Map<number, number>();
	private _rH = 0;
	private _rZ = 0;
	private _rV = 0;

	private _lastCaveState: boolean | null = null;
	private _lastBandGen = -1;
	private _scanCave = false;
	private _scanGen = -1;
	private _lastBandCave = false;
	private _lastRenderDistance = 0;
	private _lastVerticalRadius = 0;

	public constructor(
		private readonly adapter: ChunkStreamingControllerAdapter,
	) {
		// Publish the ChunkLifecycle host so the residency-invariant checker runs
		// against this controller's live load-path state, and so the owner can
		// drive the transitions routed through it (requestLoad / dispatchLoad /
		// abandonLoad / requestUnload / completeUnload).
		setChunkLifecycleHost(this._lifecycleHost);
	}

	public getDesiredState(numericId: number): number | undefined {
		return this.desiredStates.get(numericId);
	}

	/** Size of the desired-state map; a runaway value means pruning has stalled. */
	public getDesiredStateCount(): number {
		return this.desiredStates.size;
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
		// Invalidate cached decisions on rule-set generation change.
		this.invalidateRefreshCache();
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

			this.ensureRefreshArray(this._cachedCaveLodRuleSet);
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

		this.ensureRefreshArray(this._cachedOutdoorLodRuleSet);
		return this._cachedOutdoorLodRuleSet;
	}

	// Rebuild/invalidate the refresh-decision cache. Direct-indexed Int8Array
	// over (rx, rz, ry, chunkY<0, prevLod); fall back to a Map if too large.
	private invalidateRefreshCache(): void {
		if (this._refreshArr !== null) {
			this._refreshArr.fill(-1);
		} else {
			this._refreshFallback.clear();
		}
	}

	private ensureRefreshArray(lodRuleSet: ChunkLodRuleSet): void {
		const rH = lodRuleSet.maxHorizontalRadius() + 2;
		const rV = lodRuleSet.maxVerticalRadius() + 2;
		const size = (2 * rH + 1) * (2 * rH + 1) * (2 * rV + 1) * 2 * 8;
		if (
			this._refreshArr === null ||
			this._refreshArr.length !== size ||
			this._rH !== rH ||
			this._rV !== rV
		) {
			this.buildRefreshCache(lodRuleSet);
		}
	}

	private buildRefreshCache(lodRuleSet: ChunkLodRuleSet): void {
		const rH = lodRuleSet.maxHorizontalRadius() + 2;
		const rZ = rH;
		const rV = lodRuleSet.maxVerticalRadius() + 2;
		const wX = 2 * rH + 1;
		const wZ = 2 * rZ + 1;
		const wY = 2 * rV + 1;
		const size = wX * wZ * wY * 2 * 8;
		this._rH = rH;
		this._rZ = rZ;
		this._rV = rV;
		if (size > 0 && size <= 4_000_000) {
			this._refreshArr = new Int8Array(size);
			this._refreshArr.fill(-1);
		} else {
			this._refreshArr = null;
			this._refreshFallback.clear();
		}
	}

	private refreshIndex(
		rx: number,
		ry: number,
		rz: number,
		chunkY: number,
		prevLod: number,
	): number {
		const ax = rx + this._rH;
		const az = rz + this._rZ;
		const ay = ry + this._rV;
		const wX = 2 * this._rH + 1;
		const wZ = 2 * this._rZ + 1;
		const wY = 2 * this._rV + 1;
		if (ax < 0 || ax >= wX || az < 0 || az >= wZ || ay < 0 || ay >= wY)
			return -1;
		const sign = chunkY < 0 ? 1 : 0;
		const lod = prevLod & 7;
		return (((ay * wZ + az) * wX + ax) * 2 + sign) * 8 + lod;
	}

	private getCachedDecisionLod(
		rx: number,
		ry: number,
		rz: number,
		chunkY: number,
		prevLod: number,
		isDirty: boolean,
	): number {
		if (isDirty) return -1;
		const arr = this._refreshArr;
		if (arr !== null) {
			const idx = this.refreshIndex(rx, ry, rz, chunkY, prevLod);
			if (idx < 0 || idx >= arr.length) return -1;
			const v = arr[idx];
			return v === undefined ? -1 : v;
		}
		const cached = this._refreshFallback.get(
			packOffsetKey(rx, ry, rz, chunkY, prevLod),
		);
		return cached === undefined ? -1 : cached;
	}

	private setCachedDecisionLod(
		rx: number,
		ry: number,
		rz: number,
		chunkY: number,
		prevLod: number,
		lod: number,
		isDirty: boolean,
	): void {
		if (isDirty) return;
		const arr = this._refreshArr;
		if (arr !== null) {
			const idx = this.refreshIndex(rx, ry, rz, chunkY, prevLod);
			if (idx < 0 || idx >= arr.length) return;
			arr[idx] = lod;
			return;
		}
		this._refreshFallback.set(packOffsetKey(rx, ry, rz, chunkY, prevLod), lod);
	}

	public updateChunksAround(
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
	): void {
		const revision = ++this.streamRevision;

		// Store player chunk coordinates for enqueueLoad priority computation.
		this._pcx = chunkX;
		this._pcy = chunkY;
		this._pcz = chunkZ;

		// ---------------------------------------------------------------------
		// Movement direction
		// ---------------------------------------------------------------------

		if (prevChunkX !== undefined && prevChunkZ !== undefined) {
			const moveX = chunkX - prevChunkX;
			const moveZ = chunkZ - prevChunkZ;

			if (absI(moveX) <= 8 && absI(moveZ) <= 8) {
				this.lastMoveDx = moveX > 0 ? 1 : moveX < 0 ? -1 : 0;
				this.lastMoveDz = moveZ > 0 ? 1 : moveZ < 0 ? -1 : 0;
			} else {
				this.lastMoveDx = 0;
				this.lastMoveDz = 0;
			}
		} else {
			this.lastMoveDx = 0;
			this.lastMoveDz = 0;
		}

		/*
		 * Bound long-lived refresh-cache growth while retaining its allocation.
		 * 512 is a power of two, so use a mask instead of remainder.
		 */

		const caveState = isInCave();

		ensureColumnProfileSeed();
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

			const operationalRadius = lodRuleSet.maxHorizontalRadius();
			const operationalVerticalRadius = lodRuleSet.maxVerticalRadius();

			const lod0HorizontalRadius = lodRuleSet.horizontalRadiusFor(0);
			const lod1HorizontalRadius = lodRuleSet.horizontalRadiusFor(1);
			const lod0VerticalRadius = lodRuleSet.verticalRadiusFor(0);
			const lod1VerticalRadius = lodRuleSet.verticalRadiusFor(1);

			const nearZoneRadius =
				(lod0HorizontalRadius > lod1HorizontalRadius
					? lod0HorizontalRadius
					: lod1HorizontalRadius) + 2;

			const nearZoneVertical =
				(lod0VerticalRadius > lod1VerticalRadius
					? lod0VerticalRadius
					: lod1VerticalRadius) + 2;

			const loadQueue = this.adapter.getLoadQueue();
			const unloadQueueSet = this.adapter.getUnloadQueueSet();
			const requestMap = this.loadQueueRequestMap;

			// requestMap is maintained incrementally (enqueueLoad /
			// moveLoadToInFlight / moveInFlightToLoad / dropFromLoadPath /
			// poolCulledRequest); only compact the queue array here.
			let writeIndex = 0;

			for (
				let readIndex = 0, readLength = loadQueue.length;
				readIndex < readLength;
				readIndex++
			) {
				const request = loadQueue[readIndex];

				// Tombstoned (dropFromLoadPath): drop + pool, no processing.
				if (request.cancelled === true) {
					this.poolCulledRequest(request);
					continue;
				}

				const chunk = request.chunk;

				const chunkXValue = chunk.chunkX;
				const chunkYValue = chunk.chunkY;
				const chunkZValue = chunk.chunkZ;

				const relX = chunkXValue - chunkX;
				const relY = chunkYValue - chunkY;
				const relZ = chunkZValue - chunkZ;

				const absX = relX < 0 ? -relX : relX;
				const absZ = relZ < 0 ? -relZ : relZ;
				const hDist = absX > absZ ? absX : absZ;
				const vDist = relY < 0 ? -relY : relY;
				const isUnderground = chunkYValue < 0;

				if (
					hDist > operationalRadius ||
					(!isUnderground && vDist > operationalVerticalRadius)
				) {
					chunk.isTerrainScheduled = false;
					this.poolCulledRequest(request);
					continue;
				}

				const isDirty = chunk.isDirty;
				let desiredLod = request.desiredLod;

				/*
				 * Dirty and near-player requests are fully reconciled on every pass.
				 * Outer clean requests retain their previous LOD until the periodic
				 * full refresh but still run inexpensive culling checks.
				 */
				if (isDirty || (hDist <= nearZoneRadius && vDist <= nearZoneVertical)) {
					const previousLod = chunk.lodLevel ?? desiredLod;
					desiredLod = isDirty
						? -1
						: this.getCachedDecisionLod(
								relX,
								relY,
								relZ,
								chunkYValue,
								previousLod,
								false,
							);

					if (desiredLod < 0) {
						desiredLod = resolveDesiredLod(
							chunkXValue,
							chunkYValue,
							chunkZValue,
							hDist,
							vDist,
							previousLod,
							lodRuleSet,
							true,
						);

						if (desiredLod < 0) {
							chunk.isTerrainScheduled = false;
							this.poolCulledRequest(request);
							continue;
						}

						if (!isDirty) {
							this.setCachedDecisionLod(
								relX,
								relY,
								relZ,
								chunkYValue,
								previousLod,
								desiredLod,
								false,
							);
						}
					}
				} else {
					let undesired: boolean;

					if (isUnderground) {
						undesired = !undergroundDesired(
							chunkXValue,
							chunkYValue,
							chunkZValue,
							hDist,
							vDist,
							lodRuleSet,
						);
					} else {
						undesired = buriedChunkCulled(
							chunkXValue,
							chunkYValue,
							chunkZValue,
							hDist,
						);
					}

					if (undesired) {
						chunk.isTerrainScheduled = false;
						this.poolCulledRequest(request);
						continue;
					}

					desiredLod = clampLodForY(chunkYValue, desiredLod);
				}

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

				const numericId = chunk.numericId;

				this.trackDesiredState(
					numericId,
					packLodRevision(desiredLod, revision),
					revision,
				);

				loadQueue[writeIndex++] = request;
			}

			loadQueue.length = writeIndex;

			// DEBUG (no-op in prod): requestMap must mirror loadQueue exactly.
			if (requestMap.size !== loadQueue.length) {
				// eslint-disable-next-line no-console
				console.warn(
					"[ChunkStreamingController] requestMap.size !== loadQueue.length",
					requestMap.size,
					loadQueue.length,
				);
			}

			// -----------------------------------------------------------------
			// Cancel unloads for chunks that became desirable again
			// -----------------------------------------------------------------

			for (const chunk of unloadQueueSet) {
				const chunkXValue = chunk.chunkX;
				const chunkYValue = chunk.chunkY;
				const chunkZValue = chunk.chunkZ;

				const relX = chunkXValue - chunkX;
				const relY = chunkYValue - chunkY;
				const relZ = chunkZValue - chunkZ;

				const absX = relX < 0 ? -relX : relX;
				const absZ = relZ < 0 ? -relZ : relZ;
				const hDist = absX > absZ ? absX : absZ;
				const vDist = relY < 0 ? -relY : relY;

				let keep: boolean;

				if (chunkYValue < 0) {
					keep = undergroundDesired(
						chunkXValue,
						chunkYValue,
						chunkZValue,
						hDist,
						vDist,
						lodRuleSet,
					);
				} else {
					keep =
						hDist <= operationalRadius &&
						vDist <= operationalVerticalRadius &&
						!buriedChunkCulled(chunkXValue, chunkYValue, chunkZValue, hDist);
				}

				if (keep) {
					/*
					 * Deleting the current entry during Set iteration is defined:
					 * the deleted entry is not revisited.
					 */
					unloadQueueSet.delete(chunk);
				}
			}

			// -----------------------------------------------------------------
			// Discover newly desired coordinates
			// -----------------------------------------------------------------

			let canUseDelta = false;

			if (
				prevChunkX !== undefined &&
				prevChunkY !== undefined &&
				prevChunkZ !== undefined
			) {
				const deltaX = chunkX - prevChunkX;
				const deltaY = chunkY - prevChunkY;
				const deltaZ = chunkZ - prevChunkZ;

				canUseDelta =
					deltaX >= -1 &&
					deltaX <= 1 &&
					deltaY >= -1 &&
					deltaY <= 1 &&
					deltaZ >= -1 &&
					deltaZ <= 1;
			}

			if (canUseDelta) {
				this.processMovementRings(
					chunkX,
					chunkY,
					chunkZ,
					prevChunkX!,
					prevChunkY!,
					prevChunkZ!,
					lodRuleSet,
				);
			} else if (SETTING_PARAMS.COLUMN_STREAMING_ENABLED) {
				this.processInitialShellColumnOrdered(
					chunkX,
					chunkY,
					chunkZ,
					lodRuleSet,
				);
			} else {
				this.processInitialShell(chunkX, chunkY, chunkZ, lodRuleSet);
			}

			const fullBand =
				!canUseDelta ||
				lodRuleSet.revision !== this._lastBandGen ||
				caveState !== this._lastBandCave;
			if (fullBand) {
				this.ensureUndergroundBand(chunkX, chunkY, chunkZ, lodRuleSet);
			} else {
				this.ensureUndergroundBandDelta(
					chunkX - prevChunkX!,
					chunkY - prevChunkY!,
					chunkZ - prevChunkZ!,
					chunkX,
					chunkY,
					chunkZ,
					lodRuleSet,
				);
			}
			this._lastBandGen = lodRuleSet.revision;
			this._lastBandCave = caveState;

			// -----------------------------------------------------------------
			// Collect loaded chunks for refresh and unloading
			// -----------------------------------------------------------------

			const unloadBuffer = SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER + 8;

			const unloadScanRadius = operationalRadius + unloadBuffer;

			const minimumVerticalScan = chunkY - SETTING_PARAMS.MIN_CHUNK_Y;

			const bufferedVerticalScan = operationalVerticalRadius + unloadBuffer;

			const unloadScanVertical =
				bufferedVerticalScan > minimumVerticalScan
					? bufferedVerticalScan
					: minimumVerticalScan;

			const queryScratch = _queryScratch;
			queryScratch.length = 0;

			const includeOuterBands =
				revision % ChunkStreamingController.OUTER_SCAN_INTERVAL === 0;

			// Full scan every OUTER_SCAN_INTERVAL revisions + on any non-delta
			// update + cave/rule-set change as a safety net; otherwise only a
			// near window for refresh and a trailing slab for unload.
			const fullScan =
				!canUseDelta ||
				includeOuterBands ||
				caveState !== this._scanCave ||
				lodRuleSet.revision !== this._scanGen;

			if (fullScan) {
				Chunk.loadedChunkIndex.queryCollect(
					chunkX,
					chunkY,
					chunkZ,
					unloadScanRadius,
					unloadScanVertical,
					queryScratch,
				);
			} else {
				const nearH = lodRuleSet.horizontalRadiusFor(2) + 2;
				const nearV = lodRuleSet.verticalRadiusFor(2) + 2;
				Chunk.loadedChunkIndex.queryCollect(
					chunkX,
					chunkY,
					chunkZ,
					nearH,
					nearV,
					queryScratch,
				);
			}

			this.enqueueLoadedChunksForRefresh(
				chunkX,
				chunkY,
				chunkZ,
				lodRuleSet,
				includeOuterBands,
			);

			this.sortLoadQueue();

			const unloadScratch = _unloadScratch;
			unloadScratch.length = 0;

			if (fullScan) {
				Chunk.loadedChunkIndex.queryCollect(
					chunkX,
					chunkY,
					chunkZ,
					unloadScanRadius,
					unloadScanVertical,
					unloadScratch,
				);
			} else {
				// Trailing-edge slab(s) opposite movement direction, thickness
				// unloadBuffer + 1. `queryCollect` over that box catches chunks
				// newly leaving range; full scan is the safety net.
				const dx = canUseDelta ? chunkX - prevChunkX! : 0;
				const dy = canUseDelta ? chunkY - prevChunkY! : 0;
				const dz = canUseDelta ? chunkZ - prevChunkZ! : 0;
				const removeRadius =
					operationalRadius + SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER;
				const vRemove =
					operationalVerticalRadius +
					SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER;
				const slab = SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER + 1;

				let minX = chunkX - removeRadius,
					maxX = chunkX + removeRadius;
				let minZ = chunkZ - removeRadius,
					maxZ = chunkZ + removeRadius;
				let minY = chunkY - vRemove,
					maxY = chunkY + vRemove;

				if (dx > 0) {
					minX = chunkX - removeRadius - slab;
					maxX = chunkX - removeRadius + slab;
				} else if (dx < 0) {
					minX = chunkX + removeRadius - slab;
					maxX = chunkX + removeRadius + slab;
				}
				if (dz > 0) {
					minZ = chunkZ - removeRadius - slab;
					maxZ = chunkZ - removeRadius + slab;
				} else if (dz < 0) {
					minZ = chunkZ + removeRadius - slab;
					maxZ = chunkZ + removeRadius + slab;
				}
				if (dy > 0) {
					minY = chunkY - vRemove - slab;
					maxY = chunkY - vRemove + slab;
				} else if (dy < 0) {
					minY = chunkY + vRemove - slab;
					maxY = chunkY + vRemove + slab;
				}

				Chunk.loadedChunkIndex.queryCollectBox(
					minX,
					maxX,
					minY,
					maxY,
					minZ,
					maxZ,
					unloadScratch,
				);
			}

			this._scanCave = caveState;
			this._scanGen = lodRuleSet.revision;

			this.queueUnloading(
				chunkX,
				chunkY,
				chunkZ,
				operationalRadius,
				operationalVerticalRadius,
				lodRuleSet,
				unloadScratch,
			);

			if (!caveState) {
				/*
				 * Resolve the singleton once for this branch rather than repeatedly
				 * across helper expressions.
				 */
				ChunkWorkerPool.getInstance().scheduleBackgroundLodPrecompute(
					chunkX,
					chunkY,
					chunkZ,
				);
			}

			if (
				this.desiredStates.size !== 0 &&
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

			const hDist = chebyH(relX, relZ);
			const vDist = absI(relY);

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
			let decisionLod = this.getCachedDecisionLod(
				relX,
				relY,
				relZ,
				chunk.chunkY,
				chunkLod,
				chunk.isDirty,
			);

			if (decisionLod < 0) {
				decisionLod = resolveDesiredLod(
					chunk.chunkX,
					chunk.chunkY,
					chunk.chunkZ,
					hDist,
					vDist,
					chunkLod,
					lodRuleSet,
					false,
				);
				if (decisionLod < 0) continue;
				this.setCachedDecisionLod(
					relX,
					relY,
					relZ,
					chunk.chunkY,
					chunkLod,
					decisionLod,
					chunk.isDirty,
				);
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
		ensureColumnProfileSeed();
		const wasActive = frameCacheActive;
		if (!wasActive) {
			frameCacheActive = true;
		}
		frameInCaveCache = caveState;
		let processed = 0;

		// PERF: this drain runs every frame and, for each queued chunk, may take
		// a synchronous main-thread path — most expensively
		// tryApplyCachedLodTransitionMesh -> createMeshFromData, which rekeys
		// the chunk's merged group and dirties it. A pure count cap therefore
		// allowed one frame to pay for up to maxChunks full mesh applications
		// with no upper bound on wall-clock. Bounding by BOTH count and elapsed
		// time keeps the worst-case frame contribution inside the same budget the
		// mesh drain already uses. `processed !== 0` keeps a minimum of one chunk
		// per frame so the queue can never stall on budget alone.
		//
		// Two deadlines apply, and both must pass: this drain's own local
		// ceiling, and the frame-wide aggregate pool every other chunk-pipeline
		// subsystem also draws from. Checking only the local one is what let a
		// frame run the loaded refresh AND the mesh ingest AND the orphan sweep
		// AND a queue slice, each inside its own limit.
		//
		// NOTE: elapsed time here uses performance.now(), NOT frameClock.
		// frameClock is one sample per frame by design, so every read within a
		// single frame returns the same value and a deadline built on it never
		// fires. It is for agreeing on "now" across subsystems, not for measuring
		// duration. See Lib/FrameClock.
		const startMs = performance.now();
		const budgetMs = ChunkStreamingController.LOADED_REFRESH_FRAME_BUDGET_MS;

		try {
			while (processed < maxChunks) {
				if (
					processed !== 0 &&
					(!FRAME_WORK_BUDGET.canContinue(FrameWorkKind.Streaming, budgetMs) ||
						performance.now() - startMs >= budgetMs)
				) {
					break;
				}

				const chunk = this.dequeueLoadedRefreshChunk();
				if (chunk === undefined) break;

				this.loadedRefreshQueueSet.delete(chunk.numericId);

				if (!chunk.isLoaded) {
					continue;
				}

				const workStartMs = performance.now();

				this.processTargetChunkCoordinate(
					chunk.chunkX,
					chunk.chunkY,
					chunk.chunkZ,
					playerChunkX,
					playerChunkY,
					playerChunkZ,
					lodRuleSet,
				);

				FRAME_WORK_BUDGET.record(
					FrameWorkKind.Streaming,
					performance.now() - workStartMs,
				);
				processed++;
			}
		} finally {
			if (!wasActive) frameCacheActive = false;
		}
	}

	/**
	 * Re-queue chunks that want to be loaded but have no outstanding request.
	 *
	 * STALLFIX. `updateChunksAround` — the only thing that decides what *should*
	 * exist — runs exclusively when the player's chunk coordinate changes
	 * (PlayerLoopController.updateChunksAroundPlayer). Within a run it only
	 * revisits:
	 *   - entries already in `loadQueue`          (reconcile)
	 *   - the leading edge of the movement        (processMovementRings)
	 *   - chunks that are already loaded          (enqueueLoadedChunksForRefresh)
	 *
	 * A chunk that reaches `isTerrainScheduled === true` while NOT loaded and
	 * NOT in `loadQueue` is therefore invisible to all three, forever:
	 * PrepareLoadBatch removes a request from `loadQueue` and drops it when its
	 * revision no longer matches the recorded desired state, without clearing
	 * the flag. Standing still (or moving through the interior, which only ever
	 * scans the new edge) never revisits that coordinate again, so the chunk
	 * stays isTerrainScheduled + !isLoaded forever and its world hole only ever
	 * heals after a teleport that re-runs the full initial shell.
	 *
	 * The second rescued shape is the mirror image: loaded, near LOD, but with
	 * no voxel data (a hydration request that never landed). Those are normally
	 * re-detected by enqueueLoadedChunksForRefresh — but that only runs inside
	 * updateChunksAround, so while the player stands still they are never
	 * re-examined either.
	 *
	 * This is a safety net, not the primary path: it is throttled
	 * (ORPHAN_SWEEP_INTERVAL_MS), capped per pass (ORPHAN_SWEEP_MAX_PER_PASS),
	 * and bounded by wall-clock, so it can never dominate a frame.
	 *
	 * SCOPE: only chunks in `_orphanCandidates` are examined. See that field for
	 * why, and {@link markPotentialOrphan} for where candidates come from. A
	 * candidate that turns out to be healthy, or that no longer wants loading,
	 * is REMOVED as it is inspected — so the set is a work list, not a
	 * permanent record, and it self-prunes every pass.
	 */
	public sweepOrphanedChunks(): number {
		const nowMs = performance.now();
		if (
			nowMs - this._lastOrphanSweepMs <
			ChunkStreamingController.ORPHAN_SWEEP_INTERVAL_MS
		) {
			return this._lastOrphanSweepRescued;
		}
		this._lastOrphanSweepMs = nowMs;

		const candidates = this._orphanCandidates;

		// Nothing was lost since the last pass — by far the common case, and now
		// a single size check instead of a walk of the whole chunk registry.
		if (candidates.size === 0) {
			this._lastOrphanSweepRescued = 0;
			return 0;
		}

		// O(1) membership via the controller's own request map instead of an
		// O(queue) rebuild per sweep.
		const requestMap = this.loadQueueRequestMap;

		const pool = ChunkWorkerPool.getInstance();
		const unloadQueueSet = this.adapter.getUnloadQueueSet();
		const revision = this.streamRevision;
		const budgetMs = ChunkStreamingController.LOADED_REFRESH_FRAME_BUDGET_MS;
		const startedMs = nowMs;

		let rescued = 0;
		let inspected = 0;
		// Rescued chunks are dropped by ensureChunkQueuedForLoad; every other
		// outcome means this candidate is healthy or dead, so collect it here and
		// delete after the walk (deleting during Set iteration is legal in JS but
		// making it explicit keeps the intent readable).
		const resolved = _orphanSweepResolved;

		for (const chunk of candidates) {
			if (rescued >= ChunkStreamingController.ORPHAN_SWEEP_MAX_PER_PASS) {
				break;
			}
			// Same two-deadline rule as the loaded-refresh drain: the sweep's own
			// 3.5 ms ceiling AND the shared frame pool. This runs on the same frame
			// as the refresh drain and the queue slice, so leaving it on its local
			// budget alone lets those three stack.
			if (
				rescued !== 0 &&
				(!FRAME_WORK_BUDGET.canContinue(FrameWorkKind.Streaming, budgetMs) ||
					performance.now() - startedMs >= budgetMs)
			) {
				break;
			}

			// A candidate no longer wanting to load is culled-by-design or already
			// resolved; drop it rather than re-queuing, which would resurrect dead
			// terrain.
			if (!chunk.isTerrainScheduled) {
				resolved.push(chunk);
				continue;
			}
			if (requestMap.has(chunk.numericId)) {
				resolved.push(chunk);
				continue;
			}

			// An unload in progress wins: rescuing would pull the chunk straight
			// back off the dispose queue (ensureChunkQueuedForLoad deletes it from
			// the unload set), so the chunk could never be freed.
			if (unloadQueueSet.has(chunk)) {
				resolved.push(chunk);
				continue;
			}

			// The scheduler already dequeued this chunk's request and is awaiting
			// its storage read — re-queueing now would load it twice per pass.
			if (this._loadRequestsInFlight.has(chunk.numericId)) {
				resolved.push(chunk);
				continue;
			}

			if (!chunk.isLoaded) {
				// Already handed to a terrain worker — leave it alone, otherwise
				// the chunk becomes both a storage load and a generation task.
				if (pool.isTerrainTaskQueued(chunk)) {
					resolved.push(chunk);
					continue;
				}

				this.rescueChunkLoad(chunk, revision);
				rescued++;
				continue;
			}

			// Loaded at near LOD with no voxels: the hydration request was lost.
			if (chunk.lodLevel <= 1 && !chunk.hasVoxelData) {
				this.rescueChunkLoad(chunk, revision);
				rescued++;
				continue;
			}

			// Loaded, has voxels, wants nothing more — healthy.
			resolved.push(chunk);
			inspected++;
		}

		for (let i = 0; i < resolved.length; i++) {
			candidates.delete(resolved[i]);
		}
		resolved.length = 0;

		this._lastOrphanSweepRescued = rescued;
		this._totalOrphanSweepRescued += rescued;
		this._totalOrphanCandidatesInspected += inspected;

		if (rescued > 0) {
			this.adapter.onQueueSnapshotChanged?.();
		}

		return rescued;
	}

	/**
	 * Re-queue a single orphaned chunk, reusing its recorded desired LOD when one
	 * is still available so the new request is valid on the first attempt.
	 */
	private rescueChunkLoad(chunk: Chunk, revision: number): void {
		const desired = this.desiredStates.get(chunk.numericId);
		const desiredLod = desired !== undefined ? desired & 0b111 : chunk.lodLevel;

		this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, desiredLod <= 1);
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
		profile?: ColumnProfile,
	): void {
		const relX = x - playerChunkX;
		const relY = y - playerChunkY;
		const relZ = z - playerChunkZ;
		const hDist = chebyH(relX, relZ);
		const vDist = absI(relY);

		// ALLOCATION GUARD (profile: 45% of heap churn via `new Chunk` for empty
		// sky cells): skip columns provably above terrain. Reuses per-frame
		// columnTop cache so the height probe is free after first Y in column.
		const p = profile ?? columnProfile(x, z);
		if (y >= 0 && y > p.topY + 1) {
			return;
		}

		// Surface-only cull: fully-buried coordinates beyond the exempt core
		// are invisible from outside at any Y — never create or refresh them.
		const caveNow = frameCacheActive ? frameInCaveCache : isInCave();
		if (
			hDist > UNDERGROUND_CULL_EXEMPT_RADIUS &&
			!caveNow &&
			y < p.buriedTopY
		) {
			return;
		}

		const chunk = getChunkFast(x, y, z);
		const previousLod = chunk?.lodLevel ?? 3;
		const isDirty = chunk?.isDirty === true;

		let desiredLod = this.getCachedDecisionLod(
			relX,
			relY,
			relZ,
			y,
			previousLod,
			isDirty,
		);

		if (desiredLod < 0) {
			desiredLod = resolveDesiredLod(
				x,
				y,
				z,
				hDist,
				vDist,
				previousLod,
				lodRuleSet,
				true,
			);
			if (desiredLod < 0) return;

			this.setCachedDecisionLod(
				relX,
				relY,
				relZ,
				y,
				previousLod,
				desiredLod,
				isDirty,
			);
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
				// STALLFIX: this branch used to be the only queueing path that
				// skipped trackDesiredState, so its request carried the current
				// streamRevision while desiredStates still held an older (or
				// pruned) one — and PrepareLoadBatch drops every request whose
				// revision disagrees. The chunk (loaded at near LOD, never
				// hydrated) was therefore re-queued and silently discarded on
				// every single frame, forever. Tracking now happens inside
				// ensureChunkQueuedForLoad, so it cannot be missed again.
				this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);
				this.tryApplyCachedLodTransitionMesh(chunk, desiredLod);
			} else if (chunk.isDirty && !chunk.hasVoxelData && desiredLod >= 2) {
				if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
					chunk.isDirty = false;
				}
			} else if (
				chunk.hasVoxelData &&
				isStaleLodMesh(chunk) &&
				!chunk.remeshQueued
			) {
				/*
				 * STALLFIX (stale LOD). The chunk renders a mesh built for
				 * `appliedMeshLod`, but the decision says it should be at
				 * `desiredLod` — i.e. the rebuild for the finer LOD was
				 * requested and then LOST (dropped queue entry, lost worker
				 * result, stale-drop chain). `chunk.lodLevel` was already
				 * advanced to `desiredLod` when the decision was applied, so
				 * the refresh scan's own guard (`lodLevel === decision`)
				 * keeps skipping this chunk and NOTHING re-queues it: it
				 * would render its old, coarser LOD forever.
				 *
				 * Re-queue it here. `remeshQueued` is false in exactly the
				 * lost-rebuild case; when a build is already pending or in
				 * flight the flag is set and this branch is skipped, so the
				 * normal path is untouched.
				 */
				chunk.scheduleRemesh(true);
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

		// The underground band never includes y >= 0.
		const endY = Math.min(-1, chunkY + verticalRange);
		if (endY < SETTING_PARAMS.MIN_CHUNK_Y) {
			return;
		}

		const startY = Math.max(SETTING_PARAMS.MIN_CHUNK_Y, chunkY - verticalRange);

		if (startY > endY) {
			return;
		}

		const startX = chunkX - bandH;
		const endX = chunkX + bandH;
		const startZ = chunkZ - bandH;
		const endZ = chunkZ + bandH;

		// Use the frame-cached state while an update is active. This avoids
		// another runtime-state lookup and keeps the burial decision consistent
		// throughout the streaming pass.
		const caveState = frameCacheActive ? frameInCaveCache : isInCave();
		const cullRadius = UNDERGROUND_CULL_EXEMPT_RADIUS;

		for (let x = startX; x <= endX; x++) {
			const relX = x - chunkX;

			for (let z = startZ; z <= endZ; z++) {
				const relZ = z - chunkZ;
				const hDist = chebyH(relX, relZ);

				const profile = columnProfile(x, z);
				let columnStartY = startY;

				// Outside caves, coordinates below buriedTopY are guaranteed to
				// be rejected. Jump directly to the first potentially visible chunk.
				if (!caveState && hDist > cullRadius) {
					if (columnStartY < profile.buriedTopY) {
						columnStartY = profile.buriedTopY;
					}
					// The whole scanned part of this column is fully buried.
					if (columnStartY > endY) {
						continue;
					}
				}

				for (let y = columnStartY; y <= endY; y++) {
					this.processTargetChunkCoordinate(
						x,
						y,
						z,
						chunkX,
						chunkY,
						chunkZ,
						lodRuleSet,
						profile,
					);
				}
			}
		}
	}

	/**
	 * Incremental variant of ensureUndergroundBand for single-cell moves.
	 * Scans only the leading X slab, Z slab and Y layer of the band (same slab
	 * structure as processMovementRings with r=bandH, Y range
	 * undergroundVerticalRange). Only called when canUseDelta && rule-set
	 * generation + cave state unchanged; full scan otherwise.
	 */
	private ensureUndergroundBandDelta(
		dx: number,
		dy: number,
		dz: number,
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const bandH = lodRuleSet.horizontalRadiusFor(UNDERGROUND_SKIP_LOD - 1);
		const verticalRange = undergroundVerticalRange(lodRuleSet);

		const endY = Math.min(-1, chunkY + verticalRange);
		if (endY < SETTING_PARAMS.MIN_CHUNK_Y) return;
		const startY = Math.max(SETTING_PARAMS.MIN_CHUNK_Y, chunkY - verticalRange);
		if (startY > endY) return;

		const minY = startY;
		const maxY = endY;
		const r = bandH;

		const skipX = dx !== 0 ? (dx > 0 ? chunkX + r : chunkX - r) : 0;
		const skipZ = dz !== 0 ? (dz > 0 ? chunkZ + r : chunkZ - r) : 0;

		if (dx !== 0) {
			const x = skipX;
			for (let y = minY; y <= maxY; y++) {
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
			for (let y = minY; y <= maxY; y++) {
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
			const y = dy > 0 ? maxY : minY;
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

			for (let y = startY; y <= endY; y++) {
				if (y < minY || y >= maxY) continue;

				const relY = y - chunkY;
				const vDist = absI(relY);

				for (let z = startZ; z <= endZ; z++) {
					const relZ = z - chunkZ;
					const hDist = chebyH(relX, relZ);

					// Spawn-time surface-only cull. This shell resolves LODs
					// inline instead of via processTargetChunkCoordinate, so
					// without this every buried interior chunk materializes
					// on boot and only clears after the first move. Must run
					// before the cached-decision lookup (player-relative keys
					// repeat across spawns at the same position).
					if (buriedChunkCulled(x, y, z, hDist)) {
						continue;
					}

					const existing = getChunkFast(x, y, z);
					const previousLod = existing?.lodLevel ?? 3;
					const isDirty = existing?.isDirty === true;
					let desiredLod = this.getCachedDecisionLod(
						relX,
						relY,
						relZ,
						y,
						previousLod,
						isDirty,
					);

					if (desiredLod < 0) {
						desiredLod = resolveDesiredLod(
							x,
							y,
							z,
							hDist,
							vDist,
							previousLod,
							lodRuleSet,
							true,
						);
						if (desiredLod < 0) continue;

						this.setCachedDecisionLod(
							relX,
							relY,
							relZ,
							y,
							previousLod,
							desiredLod,
							isDirty,
						);
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
		scratch: Chunk[] = _queryScratch,
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

		for (let i = 0, length = scratch.length; i < length; i++) {
			const chunk = scratch[i];

			if (chunk.isBoatChunk || unloadQueueSet.has(chunk)) {
				continue;
			}

			const dx = chunk.chunkX - chunkX;
			const dy = chunk.chunkY - chunkY;
			const dz = chunk.chunkZ - chunkZ;

			const absY = absI(dy);

			const hDist = chebyH(dx, dz);

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
				const fullyBuriedAndCullable = isBuriedCullable(
					chunk.chunkX,
					chunk.chunkY,
					chunk.chunkZ,
					hDist,
					caveState,
				);

				if (
					outsideHorizontalBand ||
					outsideVerticalBand ||
					fullyBuriedAndCullable
				) {
					noteChunkEvicted(chunk, fullyBuriedAndCullable);
					// Route through the owner: requestUnload drops any pending
					// load request (map + queue + in-flight) and enqueues the
					// unload. Never-loaded (Absent) chunks no-op here — there is
					// nothing to unload, matching the legacy add-then-skip.
					ChunkLifecycle.requestUnload(chunk);
				}

				continue;
			}

			const fullyBuriedAndCullable = isBuriedCullable(
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ,
				hDist,
				caveState,
			);

			if (
				hDist > removeRadius ||
				absY > verticalRemoveRadius ||
				fullyBuriedAndCullable
			) {
				noteChunkEvicted(chunk, fullyBuriedAndCullable);
				// Same owner routing as the underground branch above.
				ChunkLifecycle.requestUnload(chunk);
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
			targetLod,
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
		// Route through the ChunkLifecycle owner: it owns the "already holds the
		// requested data" guard and delegates the enqueue to the host (this
		// controller's `enqueueLoad`). The enqueue logic — desired-state
		// tracking, request create/update, loadQueue push, unload de-queue,
		// orphan clear, and `isTerrainScheduled = true` — lives in `enqueueLoad`
		// so the invariant "isTerrainScheduled ⟺ queued" is established in one
		// place.
		ChunkLifecycle.requestLoad(chunk, {
			desiredLod,
			revision,
			includeVoxelData,
		});
	}

	public onLoadRequestsDequeued(
		_requests: ReadonlyArray<QueuedChunkRequest>,
	): void {
		// No-op kept for the adapter interface.
		// PrepareLoadBatch already calls ChunkLifecycle.dispatchLoad for every
		// request in validLoadBatch, and only requests whose dispatchLoad
		// returned ResidencyState.Loading reach validLoadBatch. Re-deriving
		// residency here (which queries the worker pool) and re-applying the
		// same bookkeeping was redundant; nothing is left to do.
	}

	/**
	 * Mirror of onLoadRequestsDequeued for requests that the scheduler pushed
	 * back into loadQueue after a failed pass. Without this they would be
	 * invisible to ensureChunkQueuedForLoad, which would then allocate a second
	 * request object for a chunk that already has one queued.
	 */
	public onLoadRequestsRecovered(
		requests: ReadonlyArray<QueuedChunkRequest>,
	): void {
		for (let i = 0; i < requests.length; i++) {
			const request = requests[i];
			if (request.chunk) {
				this.loadQueueRequestMap.set(request.chunk.numericId, request);
				this._loadRequestsInFlight.delete(request.chunk.numericId);
				// Mirror rule: back on loadQueue means no longer in flight.
				this._inFlightRequests.delete(request.chunk.numericId);
				// Back on loadQueue with a live request — not an orphan.
				this._orphanCandidates.delete(request.chunk);
			}
		}
	}

	/**
	 * Terminal cleanup for a batch that is being dropped without being recycled
	 * (scheduler recovery failed). A still-Loading chunk with a retained
	 * request is requeued through the owner (Loading → Scheduled, same object
	 * restored); anything else falls back to clearing the in-flight marks so
	 * the orphan sweep can rescue those chunks, and evicts any stale
	 * request-map entry so a later ensureChunkQueuedForLoad allocates a fresh
	 * request instead of mutating one that is not on `loadQueue`.
	 */
	public onLoadRequestsAbandoned(
		requests: ReadonlyArray<QueuedChunkRequest>,
	): void {
		for (let i = 0; i < requests.length; i++) {
			const request = requests[i];
			if (!request.chunk) continue;

			const numericId = request.chunk.numericId;
			if (
				this._inFlightRequests.has(numericId) &&
				deriveResidencyState(request.chunk, this._lifecycleHost) ===
					ResidencyState.Loading
			) {
				ChunkLifecycle.abandonLoad(request.chunk, "requeue");
				continue;
			}

			this._loadRequestsInFlight.delete(numericId);
			this._inFlightRequests.delete(numericId);

			if (this.loadQueueRequestMap.get(numericId) === request) {
				this.loadQueueRequestMap.delete(numericId);
			}

			// The request is gone and will not be retried by the scheduler, so
			// nothing but the sweep can bring this chunk back. Register it.
			this.markPotentialOrphan(request.chunk);
		}
	}

	public recycleQueuedRequests(
		requests: ReadonlyArray<QueuedChunkRequest>,
	): void {
		const freeRequests = this._freeRequests;
		const requestMap = this.loadQueueRequestMap;
		const inFlight = this._loadRequestsInFlight;
		const maxPoolSize = ChunkStreamingController.FREE_REQUEST_POOL_MAX;

		for (let i = 0; i < requests.length; i++) {
			const request = requests[i];
			const chunk = request.chunk;

			if (!chunk) {
				continue;
			}

			const numericId = chunk.numericId;

			// The scheduler has finished with this in-flight reference, regardless
			// of whether the request completed or was recovered into loadQueue.
			// Mirror rule: retention lives exactly while the in-flight mark does.
			inFlight.delete(numericId);
			this._inFlightRequests.delete(numericId);

			/*
			 * A recovered request may already be back in loadQueue and registered
			 * in loadQueueRequestMap. It must not also enter the free pool because
			 * ensureChunkQueuedForLoad could then reuse and mutate the same object
			 * while it is still a live queue entry.
			 */
			if (requestMap.get(numericId) === request) {
				continue;
			}

			if (freeRequests.length >= maxPoolSize) {
				continue;
			}

			freeRequests.push(request);
		}
	}

	/**
	 * Terminal cleanup for a disposed chunk.
	 *
	 * The candidate set holds strong references, so a disposed chunk left in it
	 * would pin its voxel arrays for the rest of the session. Dropping it here
	 * is the primary defence; the sweep additionally prunes, so a disposal that
	 * somehow bypasses the hook still self-heals within one sweep interval.
	 */
	public onChunkDisposed(chunk: Chunk): void {
		this.loadedRefreshQueueSet.delete(chunk.numericId);
		this._loadRequestsInFlight.delete(chunk.numericId);
		this._inFlightRequests.delete(chunk.numericId);
		this._orphanCandidates.delete(chunk);
	}
	/**
	 * Drop the residency record for a chunk that has been fully freed.
	 *
	 * Separate from the unload QUEUE decision on purpose: a chunk queued for
	 * unload is still recoverable, so its record must survive. Forgetting it
	 * here — once the chunk object is actually gone and no cached blob remains
	 * to rebuild from — is what keeps the residency map bounded across a long
	 * session.
	 */
	public forgetResidency(chunkX: number, chunkY: number, chunkZ: number): void {
		forgetChunkResidency(packCoords(chunkX, chunkY, chunkZ));
	}

	/**
	 * Return a culled (not in-flight) load request to the free pool.
	 *
	 * These requests come straight out of loadQueue in the reconcile loop; they
	 * are never referenced by _inFlightRequests. Respects FREE_REQUEST_POOL_MAX.
	 */
	private poolCulledRequest(request: QueuedChunkRequest): void {
		// keep requestMap in sync for cancelled + culled removals
		const numericId = request.chunk ? request.chunk.numericId : -1;
		if (
			numericId !== -1 &&
			this.loadQueueRequestMap.get(numericId) === request
		) {
			this.loadQueueRequestMap.delete(numericId);
		}
		if (
			this._freeRequests.length >=
			ChunkStreamingController.FREE_REQUEST_POOL_MAX
		) {
			return;
		}
		this._freeRequests.push(request);
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

		// Unified scale (item 2.6): one LOD band + d^2 + forward term, shared
		// with chunkPriority/priorityForChunk. ageMs=0 here.
		const distanceSq = dx * dx + dy * dy + dz * dz;
		const forwardScore = chunkForwardScore(
			chunk.chunkX,
			chunk.chunkY,
			chunk.chunkZ,
		);
		let priority = chunkPriority(distanceSq, forwardScore, desiredLod, 0);

		// Column-ring bonus: approaching columns load first within their LOD
		// band during fast fly. Stays below the 1M LOD band by construction.
		if (SETTING_PARAMS.COLUMN_STREAMING_ENABLED) {
			const moveDx = this.lastMoveDx;
			const moveDz = this.lastMoveDz;
			if ((moveDx !== 0 || moveDz !== 0) && dx * moveDx + dz * moveDz > 0) {
				priority -= SETTING_PARAMS.COLUMN_AHEAD_BONUS;
			}
		}

		return priority;
	}

	/**
	 * Column-ordered variant of processInitialShell for
	 * COLUMN_STREAMING_ENABLED.
	 *
	 * Generates Chebyshev rings directly instead of building and sorting an
	 * intermediate ColumnEntry array. Within each ring, approaching columns are
	 * scanned before non-approaching columns.
	 */
	private processInitialShellColumnOrdered(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const radius = lodRuleSet.maxHorizontalRadius();
		const verticalRadius = lodRuleSet.maxVerticalRadius();

		if (radius < 0) {
			return;
		}

		const worldMinY = SETTING_PARAMS.MIN_CHUNK_Y;
		const worldMaxYExclusive = worldMinY + SETTING_PARAMS.MAX_CHUNK_HEIGHT;

		// Clamp the global vertical range once. Each column narrows this
		// further using its surface and burial bounds.
		const globalStartY = Math.max(worldMinY, chunkY - verticalRadius);
		const globalEndY = Math.min(
			worldMaxYExclusive - 1,
			chunkY + verticalRadius,
		);

		if (globalStartY > globalEndY) {
			return;
		}

		const moveDx = this.lastMoveDx;
		const moveDz = this.lastMoveDz;
		const hasMovement = moveDx !== 0 || moveDz !== 0;

		// Use the streaming pass's cached cave state when available. This keeps
		// burial decisions consistent and avoids repeated isInCave() calls.
		const caveState = frameCacheActive ? frameInCaveCache : isInCave();
		const cullRadius = UNDERGROUND_CULL_EXEMPT_RADIUS;

		// Center is the complete ring at distance zero; the ring index doubles
		// as the column's Chebyshev distance.
		this.processInitialColumnRange(
			chunkX,
			chunkZ,
			0,
			chunkX,
			chunkY,
			chunkZ,
			globalStartY,
			globalEndY,
			caveState,
			cullRadius,
			lodRuleSet,
		);

		for (let ring = 1; ring <= radius; ring++) {
			const minX = chunkX - ring;
			const maxX = chunkX + ring;
			const minZ = chunkZ - ring;
			const maxZ = chunkZ + ring;

			// With no movement, one perimeter pass is sufficient.
			const passCount = hasMovement ? 2 : 1;

			for (let pass = 0; pass < passCount; pass++) {
				// First pass handles approaching columns. The second handles the
				// remaining columns. With no movement, every column is accepted.
				const requireAhead = hasMovement && pass === 0;

				// North and south edges, including corners.
				for (let x = minX; x <= maxX; x++) {
					const relX = x - chunkX;

					const northAhead = relX * moveDx - ring * moveDz > 0;

					if (!hasMovement || northAhead === requireAhead) {
						this.processInitialColumnRange(
							x,
							minZ,
							ring,
							chunkX,
							chunkY,
							chunkZ,
							globalStartY,
							globalEndY,
							caveState,
							cullRadius,
							lodRuleSet,
						);
					}

					const southAhead = relX * moveDx + ring * moveDz > 0;

					if (!hasMovement || southAhead === requireAhead) {
						this.processInitialColumnRange(
							x,
							maxZ,
							ring,
							chunkX,
							chunkY,
							chunkZ,
							globalStartY,
							globalEndY,
							caveState,
							cullRadius,
							lodRuleSet,
						);
					}
				}

				// West and east edges, excluding corners already processed above.
				for (let z = minZ + 1; z < maxZ; z++) {
					const relZ = z - chunkZ;

					const westAhead = -ring * moveDx + relZ * moveDz > 0;

					if (!hasMovement || westAhead === requireAhead) {
						this.processInitialColumnRange(
							minX,
							z,
							ring,
							chunkX,
							chunkY,
							chunkZ,
							globalStartY,
							globalEndY,
							caveState,
							cullRadius,
							lodRuleSet,
						);
					}

					const eastAhead = ring * moveDx + relZ * moveDz > 0;

					if (!hasMovement || eastAhead === requireAhead) {
						this.processInitialColumnRange(
							maxX,
							z,
							ring,
							chunkX,
							chunkY,
							chunkZ,
							globalStartY,
							globalEndY,
							caveState,
							cullRadius,
							lodRuleSet,
						);
					}
				}
			}
		}
	}

	/**
	 * One X/Z column of processInitialShellColumnOrdered, without a per-call
	 * closure.
	 *
	 * Narrows the column's valid Y range once — skipping provably empty sky
	 * levels and guaranteed-buried levels — before any
	 * processTargetChunkCoordinate call. processTargetChunkCoordinate keeps
	 * its per-Y defensive checks; this only avoids calling it for Y levels
	 * those checks would provably reject.
	 */
	private processInitialColumnRange(
		x: number,
		z: number,
		hDist: number,
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
		globalStartY: number,
		globalEndY: number,
		caveState: boolean,
		cullRadius: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const profile = columnProfile(x, z);

		let startY = globalStartY;
		let endY = globalEndY;

		// processTargetChunkCoordinate skips positive chunks above
		// profile.topY + 1. Moving the bound here prevents entering the Y loop
		// for those guaranteed-empty sky coordinates.
		if (endY >= 0) {
			const highestSurfaceChunkY = profile.topY + 1;

			if (startY >= 0) {
				if (startY > highestSurfaceChunkY) {
					return;
				}

				if (endY > highestSurfaceChunkY) {
					endY = highestSurfaceChunkY;
				}
			} else {
				/*
				 * effectiveColumnTopChunkY is at least 1 for every reachable
				 * column (SEA_LEVEL 42 keeps the water branch non-negative), so
				 * the clamp normally targets the surface band. The -1 floor is
				 * defensive: the sky guard in processTargetChunkCoordinate only
				 * ever skips y >= 0, so negative chunks must keep loading even
				 * if a future config ever produced a negative topY.
				 */
				endY = Math.min(endY, Math.max(highestSurfaceChunkY, -1));
			}
		}

		// Outside cave mode and the exempt near-player core, every chunk below
		// buriedTopY is rejected by buriedChunkCulled(). Jump directly to the
		// first potentially visible chunk instead of testing every buried Y.
		if (!caveState && hDist > cullRadius && startY < profile.buriedTopY) {
			startY = profile.buriedTopY;
		}

		for (let y = startY; y <= endY; y++) {
			this.processTargetChunkCoordinate(
				x,
				y,
				z,
				playerChunkX,
				playerChunkY,
				playerChunkZ,
				lodRuleSet,
				profile,
			);
		}
	}
}
