import { yieldToEventLoop } from "../../Lib/yieldToEventLoop";
import type {
	RemoteChunkData,
	RemoteChunkProvider,
	RemoteChunkResult,
} from "../../Network/chunk/RemoteChunkProvider";
import { ChunkResultKind } from "../../Network/protocol/messages";
import {
	FLAG_GREEDY,
	FLAG_PARTIAL,
	FLAG_SOLID,
	FLAG_TRANSPARENT,
	getCachedFlagsAndId,
	getFlagsFromCombined,
} from "../MeshPipeline/core/BlockInfoCache";
import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import { shapeInitPromise } from "../Shape/BlockShapes";
import { getWorldNameFromUrl, worldSeedFor } from "../WorldContext";
import { WorldStorage } from "../WorldStorage";
import { addChunkDisposeHook, Chunk, getChunk } from "./Chunk";
import { precomputeClosedFaceMasks } from "./ChunkFaceMasks";
import { createMeshFromData } from "./ChunkMesher";
import {
	ChunkWorker,
	NEIGHBOR_OFFSETS_26,
	neighborMaskCache,
} from "./chunkWorker";
import { packCoords } from "./DataStructures/ChunkCoords";
import type { MeshData } from "./DataStructures/MeshData";
import { RingBuffer } from "./DataStructures/RingBuffer";
import {
	type DistantTerrainGeneratedMessage,
	type DistantTerrainTask,
	type FarTileGeneratedMessage,
	type FullMeshMessage,
	type LightDirtyMessage,
	type LightRegisterChunkBatchRequest,
	type MeshWorkerResponse,
	type RelightMeshMissMessage,
	TaskType,
	type TerrainGeneratedMessage,
	type WorkerResponseData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";
import { flushDirtyMergedGroups, setRequestFlush } from "./MergedMeshManager";
import {
	normalizeChunkLod,
	shouldSkipLodForChunk,
} from "./Worker/LODUtilities";
import {
	hasStableVoxelNeighborsForCachedMesh,
	maybeRemeshNeighborsNowStable,
	scheduleChunkAndNeighborsRemesh,
} from "./Worker/NeighborHelpers";

export type WorkerMessageData = WorkerResponseData;

function compareLodCandidateScores(a: number, b: number): number {
	return (
		ChunkWorkerPool.getLodCandidateScore(a) -
		ChunkWorkerPool.getLodCandidateScore(b)
	);
}

// Reused across processMeshQueueLoop to avoid a fresh object literal per mesh
// result. Callers must pass the live opaque/water/cutout views immediately.
const _meshApplyScratch: {
	opaque: MeshData | null;
	water: MeshData | null;
	cutout: MeshData | null;
} = {
	opaque: null,
	water: null,
	cutout: null,
};

export type ChunkWorkerPoolDebugStats = {
	workerCount: number;
	idleWorkers: number;
	busyWorkers: number;
	peakBusyWorkers: number;
	remeshQueueLength: number;
	terrainQueueLength: number;
	lodPrecomputeQueueLength: number;
	relightQueueLength: number;
	distantTerrainQueueLength: number;
	meshResultQueueLength: number;
	deferredLightingQueueLength: number;
	deferredLightingSeedStateCount: number;
	deferredLightingPumpScheduled: boolean;
	deferredLightingEnqueuedTotal: number;
	deferredLightingSeedReplacedTotal: number;
	deferredLightingProcessedLastFrame: number;
	deferredLightingProcessedTotal: number;
	deferredLightingDroppedTotal: number;
	dispatchBudgetPerTick: number;
	lastDispatchCount: number;
	totalDispatchCount: number;
	lastMeshDrainMs: number;
	lastMeshProcessed: number;
	totalMeshProcessed: number;
	// Mesh ingestion outcome counters (P0 instrumentation): applied results
	// vs. dropped ones. The dropped fractions are what buffer recycling
	// recovers; a high applied-per-chunk multiplier during load indicates
	// redundant remesh volume.
	meshAppliedTotal: number;
	meshCachedForOtherLodTotal: number;
	meshStaleDroppedTotal: number;
	meshUnknownChunkDroppedTotal: number;
	meshLodSkippedDroppedTotal: number;
	meshRecycledBuffersTotal: number;
	meshRecycledBytesTotal: number;
	totalTerrainDispatches: number;
	totalRemeshDispatches: number;
	totalLodPrecomputeDispatches: number;
	totalRelightDispatches: number;
	totalDistantDispatches: number;
	lightDirtyQueueLength: number;
	lightDirtyProcessedLastFrame: number;
	lightDirtyProcessedTotal: number;
	lightDispatches: number;
	workerDispatchCounts: number[];
	lastDispatchWorkerIndices: number[];
};

// ---------------------------------------------------------------------------
// Packed in-flight key: numericId * 16 + lod.
//
// Important: do NOT use `numericId << 4` here.
// JavaScript bitwise operators coerce to signed 32-bit integers, so large
// numericId values collide and can cause unrelated chunks/LODs to be treated
// as the same in-flight task.
// ---------------------------------------------------------------------------
function packInflightKey(numericId: number, lod: number): number {
	return numericId * 16 + (lod & 0xf);
}

// byteLength > 0 guards against the shared EMPTY_U8 sentinel buffer —
// transferring it would detach a module global. The instanceof check
// excludes SharedArrayBuffer-backed views (never produced by the mesh
// worker, but the static type allows them).
function pushRecyclableBuffer(scratch: ArrayBuffer[], arr: Uint8Array): void {
	const buf = arr.buffer;
	if (buf instanceof ArrayBuffer && buf.byteLength > 0) scratch.push(buf);
}

type WorkerTaskContext = {
	taskType: TaskType;
	chunk?: Chunk;
	lod?: number;
	distantTask?: DistantTerrainTask;
	terrainDeferLighting?: boolean;
} | null;

/** Exhaustiveness guard for the RemoteChunkResult switch. */
function assertNever(value: never): never {
	throw new Error("Unhandled remote chunk result kind");
}

export class ChunkWorkerPool {
	private static instance: ChunkWorkerPool | undefined;
	private static readonly WORKER_ERROR_COOLDOWN_MS = 120;
	private static readonly MIN_AUTO_POOL_SIZE = 2;
	private static readonly MAX_AUTO_POOL_SIZE = 12;
	private static readonly DEFERRED_LIGHTING_BUDGET_MS = 2.0;
	private static readonly DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME = 64;
	private static readonly LAST_DISPATCH_RING_SIZE = 24;

	private static readonly MAX_MESH_QUEUE = 512;

	// T2-11: worker 0's terrainWorker is the dedicated light worker — the
	// only worker whose terrainWorker runs Light* tasks (initLightShared is
	// called on it in the constructor and the HMR replacement path).  Terrain
	// generation is excluded from this worker so light registration, reconcile
	// and propagation never queue behind generation jobs.
	private static readonly LIGHT_WORKER_INDEX = 0;

	private workers: ChunkWorker[] = [];
	private workerTaskContext: WorkerTaskContext[] = [];

	// Remote server-side terrain generation (multiplayer mode)
	private remoteChunkProvider: RemoteChunkProvider | null = null;
	private remoteGenerationEnabled = false;
	// Set as soon as multiplayer mode is entered (before the connection is
	// established). While true but `remoteChunkProvider` is still null, chunk
	// requests are deferred rather than generated locally — the client must
	// not build spawn terrain itself, since the server is authoritative and
	// the local copy would just be discarded once the connection lands.
	private expectingRemoteProvider = false;
	private readonly remoteDeferredChunks = new Set<Chunk>();
	// Chunks the server confirmed as unchanged but the client had no local
	// copy for — retried once before falling back to local generation.
	private remoteNoBlobRetries = new Map<bigint, number>();

	/** True when chunk voxel data comes from the server (multiplayer mode). */
	public isRemoteGenerationEnabled(): boolean {
		return this.remoteGenerationEnabled;
	}
	private remotePendingChunks = new Map<bigint, Chunk>();
	private remoteTaskQueue: Chunk[] = [];
	private remoteTaskQueueSet = new Set<Chunk>();
	private remoteRetryCount = new Map<bigint, number>();
	private readonly MAX_REMOTE_RETRY = 3;
	// Coalescing guard: at most one pump cycle (one batched cache read) is
	// active at a time; continuation cycles are deferred to a microtask
	// (queueMicrotask) for minimal delay between batches.
	private remotePumpScheduled = false;
	private remoteBackpressureTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly MAX_REMOTE_CONCURRENT = 128; // Max concurrent server requests per pump cycle
	private readonly MAX_OUTSTANDING_REMOTE = 1024; // Backpressure cap
	// Batched remesh scheduling for remote chunks: instead of calling
	// scheduleRemesh + scheduleChunkAndNeighborsRemesh per chunk (O(7N) work),
	// collect chunks and flush once per frame (O(N) unique chunks + deduped neighbors).
	private pendingRemoteChunks = new Set<Chunk>();
	private pendingRemeshScheduled = false;

	private distantTerrainSharedInit: {
		positionsBuffer: SharedArrayBuffer;
		normalsBuffer: SharedArrayBuffer;
		surfaceTilesBuffer: SharedArrayBuffer;
		radius: number;
		gridStep: number;
	} | null = null;

	private workerRestartAtMs: number[] = [];

	// --- Remesh queue: binary min-heap keyed by compareRemeshPriority ---
	// taskHeap is a standard 0-indexed array-backed heap; taskHeapPositions
	// tracks each chunk's current index so priority upgrades and disposal
	// removal can be done in O(log n) instead of a linear scan/splice.
	private taskHeap: Chunk[] = [];
	private taskHeapPositions: Map<Chunk, number> = new Map();
	private taskQueuePriority: Map<Chunk, boolean> = new Map();

	private workerDispatchCounts: number[] = [];
	private _lastHeartbeatSeq: number[] = [];
	private lastDispatchRing = new RingBuffer<number>(
		ChunkWorkerPool.LAST_DISPATCH_RING_SIZE,
	);

	private pendingRemeshMap: Map<Chunk, boolean> = new Map();

	private terrainTaskDeferLighting = new Map<bigint, boolean>();
	private terrainTaskQueue: Set<Chunk> = new Set();
	private deferredLightingQueue: Chunk[] = [];
	private deferredLightingQueueReadIdx = 0;
	private deferredLightingQueuedIds = new Set<bigint>();
	private deferredLightingSeedStates = new Map<
		bigint,
		{ queue: Uint16Array; length: number }
	>();
	private deferredLightingPumpScheduled = false;

	// Debug: deferred-light seed length received at generation time, keyed by
	// chunk id.  Only populated while the in-game LightDebugTool is installed.
	private debugLightSeedLengths = new Map<bigint, number>();

	public debugLightSeedLength(chunkId: bigint): number | undefined {
		return this.debugLightSeedLengths.get(chunkId);
	}

	private distantTerrainReadyWorkers = new Set<number>();
	private distantTerrainTaskQueue: DistantTerrainTask[] = [];
	private distantTerrainTaskQueueReadIdx = 0;
	private lodPrecomputeQueue: Array<{ chunk: Chunk; lod: number }> = [];
	private lodPrecomputeQueueReadIdx = 0;
	private pendingLodPrecomputeKeys = new Set<number>();
	private lastPrecomputeScheduleTs = 0;

	// T2-8: light-only remesh queue. Populated by tryScheduleRelightOnly from
	// the light-dirty pump; dispatched with lower priority than block remeshes.
	private relightQueue: Chunk[] = [];
	private relightQueueReadIdx = 0;
	private pendingRelightKeys = new Set<number>();

	// T2-8: block content version of the chunk at the time its current mesh
	// was built (per LOD). A light-dirty chunk whose (lod, blockRevision) match
	// this entry can be re-meshed with a light-only RelightMesh task instead of
	// a full remesh. Deleted on dispose; stale entries simply fall back to full
	// remesh.
	private blockRevisionAtMesh = new Map<
		bigint,
		{ blockRevision: number; lod: number }
	>();

	// ---------------------------------------------------------------------------
	// Idle-worker tracking
	//
	// Invariant: a worker is idle iff it appears in idleWorkerSet.
	//
	// idleWorkerIndices is a flat array used as a queue; _idleReadIdx is the
	// consume pointer.  Only indices in [_idleReadIdx, length) are live idle
	// workers.  Indices before _idleReadIdx have already been dispatched and
	// must never be touched by swap-remove or position-map lookups.
	//
	// idleWorkerIndexPositions maps workerIndex → its position in
	// idleWorkerIndices.  It is only populated for the LIVE portion
	// ([_idleReadIdx, length)), so handleWorkerFailure's swap-remove is always
	// safe to use.
	// ---------------------------------------------------------------------------
	private idleWorkerSet: Set<number> = new Set();
	private idleWorkerIndices: number[] = [];
	private idleWorkerIndexPositions: Map<number, number> = new Map();
	private _idleReadIdx = 0;

	private meshResultQueue: FullMeshMessage[] = [];
	private meshResultQueueReadIdx = 0;
	// Originating worker index per queued result (parallel to meshResultQueue
	// from meshResultQueueReadIdx onward) — recycled buffers go back to the
	// sender's voxel worker.
	private meshResultWorkerIdx: number[] = [];
	// Scratch for recycle-message buffer collection (reused, never retained).
	private readonly _recycleScratch: ArrayBuffer[] = [];
	// Since-last-summary accumulators for the burst ingestion log.
	private _summaryApplied = 0;
	private _summaryDropped = 0;
	// Distinct chunks applied since last summary — distinguishes "world is
	// big, ~1 mesh per chunk" from "chunks re-meshing multiple times".
	private readonly _summaryDistinct = new Set<bigint>();
	private remeshFlushScheduled = false;
	private processQueuePumpScheduled = false;
	private meshDrainScheduled = false;
	private insideMeshDrain = false;

	// PERF: Centralized work-coalescing scheduler. Instead of scheduling
	// independent setTimeout callbacks per subsystem (mesh, lighting, remesh),
	// flag pending work here and drain everything in a single macrotask.
	// The mesh drain and the merged-group flush SHARE this one budget so a
	// chunk storm can never burn ~10ms of main thread in a single tick
	// (5ms drain + 5ms flush previously).
	private static readonly MESH_DRAIN_BUDGET_MS = 5.5;
	private static readonly WORK_PROCESS_QUEUE = 1 << 0;
	private static readonly WORK_MESH = 1 << 1;
	private static readonly WORK_DEFERRED_LIGHT = 1 << 2;
	private static readonly WORK_LIGHT_REG = 1 << 3;
	private static readonly WORK_REMESH_FLUSH = 1 << 4;
	private static readonly WORK_LIGHT_DIRTY = 1 << 5;
	private _pendingWorkFlags = 0;
	private _centralSchedulerScheduled = false;

	private pendingRemeshSaveIds = new Set<bigint>();
	private pendingRemeshSaveTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly REMESH_SAVE_DEBOUNCE_MS = 500;

	private inFlightRemeshKeys = new Set<number>();

	private distantTerrainInFlight = false;
	private nextDistantTerrainRequestId = 1;

	// ---------------------------------------------------------------------------
	// LevelDB chunk storage (replaces OPFS)
	// ---------------------------------------------------------------------------

	// ---------------------------------------------------------------------------
	// Static scratch buffers — avoids per-call allocation on hot paths
	// ---------------------------------------------------------------------------
	private static readonly _flushPendingScratch: Array<[Chunk, boolean]> = [];
	private static readonly _queryScratch: Chunk[] = [];
	private static readonly _dedupScratch: Set<number> = new Set();

	// Pre-bound methods — avoids per-call .bind(this) allocation
	private readonly _boundScheduleRemesh = this.scheduleRemesh.bind(this);
	private readonly _boundScheduleHealRemesh =
		this.scheduleDeferredNeighborHeal.bind(this);
	// SoA scratch for scheduleBackgroundLodPrecompute — avoids per-candidate
	// object allocation.  Indices are grown via .push() to stay on
	// PACKED_SMI_ELEMENTS (array.length = N followed by fill triggers a
	// one-way HOLEY transition in V8).
	private static readonly _lodCandidateChunks: Chunk[] = [];
	private static readonly _lodCandidateLods: number[] = [];
	private static readonly _lodCandidateScores: number[] = [];
	private static readonly _lodCandidateIndices: number[] = [];

	public static getLodCandidateScore(idx: number): number {
		return ChunkWorkerPool._lodCandidateScores[idx];
	}

	// ---------------------------------------------------------------------------
	// Light-worker integration state
	// ---------------------------------------------------------------------------

	private nextLightSeqCounter = 1;
	private lightDirtyQueue: { seq: number; dirtySlots: Uint32Array }[] = [];
	private lightDirtyQueueReadIdx = 0;
	private lightDirtyPumpScheduled = false;
	// Free-list for LightDirty envelope objects — one fresh object per light
	// worker reply used to show up in the allocation profile.
	private static readonly _LIGHT_DIRTY_EMPTY = new Uint32Array(0);
	private static readonly _lightDirtyPool: {
		seq: number;
		dirtySlots: Uint32Array;
	}[] = [];
	private static allocLightDirtyEntry(
		seq: number,
		dirtySlots: Uint32Array,
	): { seq: number; dirtySlots: Uint32Array } {
		const entry = ChunkWorkerPool._lightDirtyPool.pop() ?? {
			seq: 0,
			dirtySlots: ChunkWorkerPool._LIGHT_DIRTY_EMPTY,
		};
		entry.seq = seq;
		entry.dirtySlots = dirtySlots;
		return entry;
	}
	/**
	 * slot -> {pendingSeq, inFlightSeq}.  When the worker reports a new
	 * LightDirty entry for a slot we advance pendingSeq; on drain we look
	 * at the highest pendingSeq we've ever seen for the slot to decide
	 * whether to re-schedule a remesh.
	 */
	private lightSlotPendingSeq: Map<number, number> = new Map();
	private lightChunkByHeaderSlot: Map<number, Chunk> = new Map();
	private lightHeaderBuffer: SharedArrayBuffer | null = null;
	private closedFaceMaskBuffer: SharedArrayBuffer | null = null;

	private debugStats: ChunkWorkerPoolDebugStats = {
		workerCount: 0,
		idleWorkers: 0,
		busyWorkers: 0,
		peakBusyWorkers: 0,
		remeshQueueLength: 0,
		terrainQueueLength: 0,
		lodPrecomputeQueueLength: 0,
		relightQueueLength: 0,
		distantTerrainQueueLength: 0,
		meshResultQueueLength: 0,
		deferredLightingQueueLength: 0,
		deferredLightingSeedStateCount: 0,
		deferredLightingPumpScheduled: false,
		deferredLightingEnqueuedTotal: 0,
		deferredLightingSeedReplacedTotal: 0,
		deferredLightingProcessedLastFrame: 0,
		deferredLightingProcessedTotal: 0,
		deferredLightingDroppedTotal: 0,
		dispatchBudgetPerTick: 0,
		lastDispatchCount: 0,
		totalDispatchCount: 0,
		lastMeshDrainMs: 0,
		lastMeshProcessed: 0,
		totalMeshProcessed: 0,
		meshAppliedTotal: 0,
		meshCachedForOtherLodTotal: 0,
		meshStaleDroppedTotal: 0,
		meshUnknownChunkDroppedTotal: 0,
		meshLodSkippedDroppedTotal: 0,
		meshRecycledBuffersTotal: 0,
		meshRecycledBytesTotal: 0,
		totalTerrainDispatches: 0,
		totalRemeshDispatches: 0,
		totalLodPrecomputeDispatches: 0,
		totalRelightDispatches: 0,
		totalDistantDispatches: 0,
		lightDirtyQueueLength: 0,
		lightDirtyProcessedLastFrame: 0,
		lightDirtyProcessedTotal: 0,
		lightDispatches: 0,
		workerDispatchCounts: [],
		lastDispatchWorkerIndices: [],
	};

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	private getDispatchBudgetPerTick(): number {
		const configured = SETTING_PARAMS.CHUNK_WORKER_DISPATCH_BUDGET_PER_TICK | 0;
		if (configured <= 0) return Number.POSITIVE_INFINITY;
		return Math.max(configured, this.workers.length);
	}

	private hasPendingTasks(): boolean {
		return (
			this.terrainTaskQueue.size > 0 ||
			this.taskHeap.length > 0 ||
			this.lodPrecomputeQueueReadIdx < this.lodPrecomputeQueue.length ||
			this.relightQueueReadIdx < this.relightQueue.length ||
			this.distantTerrainTaskQueueReadIdx < this.distantTerrainTaskQueue.length
		);
	}

	private getEffectiveIdleWorkerCount(): number {
		return Math.max(0, this.idleWorkerIndices.length - this._idleReadIdx);
	}

	private scheduleProcessQueuePump(): void {
		if (this.processQueuePumpScheduled) return;
		this.processQueuePumpScheduled = true;
		if (this.getEffectiveIdleWorkerCount() > 0 && this.hasPendingTasks()) {
			this.processQueue();
			this.processQueuePumpScheduled = false;
		} else {
			this._scheduleCentralWork(ChunkWorkerPool.WORK_PROCESS_QUEUE);
		}
	}

	private updateQueueDebugStats(): void {
		const stats = this.debugStats;
		stats.workerCount = this.workers.length;
		stats.idleWorkers = this.getEffectiveIdleWorkerCount();
		const busy = Math.max(0, stats.workerCount - stats.idleWorkers);
		stats.busyWorkers = busy;
		if (busy > stats.peakBusyWorkers) stats.peakBusyWorkers = busy;
		stats.remeshQueueLength = this.taskHeap.length;
		stats.terrainQueueLength = this.terrainTaskQueue.size;
		stats.lodPrecomputeQueueLength =
			this.lodPrecomputeQueue.length - this.lodPrecomputeQueueReadIdx;
		stats.relightQueueLength =
			this.relightQueue.length - this.relightQueueReadIdx;
		stats.distantTerrainQueueLength =
			this.distantTerrainTaskQueue.length - this.distantTerrainTaskQueueReadIdx;
		stats.meshResultQueueLength =
			this.meshResultQueue.length - this.meshResultQueueReadIdx;
		stats.deferredLightingQueueLength =
			this.deferredLightingQueue.length - this.deferredLightingQueueReadIdx;
		stats.deferredLightingSeedStateCount = this.deferredLightingSeedStates.size;
		stats.deferredLightingPumpScheduled = this.deferredLightingPumpScheduled;
		const budget = this.getDispatchBudgetPerTick();
		stats.dispatchBudgetPerTick = Number.isFinite(budget) ? budget : 0;
	}

	public getDebugStats(): ChunkWorkerPoolDebugStats {
		this.updateQueueDebugStats();
		const stats = this.debugStats;
		const src = this.workerDispatchCounts;
		const dst = stats.workerDispatchCounts;
		dst.length = 0;
		for (let i = 0; i < src.length; i++) dst.push(src[i]);
		this.lastDispatchRing.forEachInto(
			this.debugStats.lastDispatchWorkerIndices,
		);
		return stats;
	}

	private recordWorkerDispatch(workerIndex: number): void {
		if (workerIndex < 0) return;
		if (workerIndex >= this.workerDispatchCounts.length) {
			while (this.workerDispatchCounts.length <= workerIndex) {
				this.workerDispatchCounts.push(0);
			}
		}
		this.workerDispatchCounts[workerIndex]++;
		this.lastDispatchRing.push(workerIndex);
	}

	private setWorkerTaskContext(
		workerIndex: number,
		context: WorkerTaskContext,
	): void {
		this.workerTaskContext[workerIndex] = context;
	}

	// -------------------------------------------------------------------------
	// Chunk / ID resolution
	// -------------------------------------------------------------------------

	private resolveChunkByMessageId(chunkId: bigint): Chunk | undefined {
		return Chunk.chunkInstances.get(chunkId);
	}

	// -------------------------------------------------------------------------
	// In-flight key management
	// -------------------------------------------------------------------------

	private isSameLodRemeshInflight(chunk: Chunk): boolean {
		return this.inFlightRemeshKeys.has(
			packInflightKey(chunk.numericId, chunk.lodLevel ?? 0),
		);
	}

	private clearInflightRemeshByMessage(chunkId: bigint, lod: number): void {
		const chunk = Chunk.chunkInstances.get(chunkId);
		if (!chunk) return;
		this.inFlightRemeshKeys.delete(packInflightKey(chunk.numericId, lod));
	}

	private recordBlockRevisionAtMesh(chunk: Chunk, lod: number): void {
		this.blockRevisionAtMesh.set(chunk.id, {
			blockRevision: chunk.blockRevision,
			lod,
		});
	}

	// -------------------------------------------------------------------------
	// Public callback
	// -------------------------------------------------------------------------

	public onDistantTerrainGenerated:
		| ((data: DistantTerrainGeneratedMessage) => void)
		| null = null;

	// -------------------------------------------------------------------------
	// Idle-worker management
	//
	// All mutations of the idle structures go through these two methods to keep
	// the invariants described at the field declarations in one place.
	// -------------------------------------------------------------------------

	/**
	 * Mark a worker idle.  Idempotent — safe to call even if the worker is
	 * already idle (the set guard short-circuits).
	 *
	 * The worker is appended to idleWorkerIndices and its position is recorded
	 * in idleWorkerIndexPositions so that a later swap-remove in
	 * handleWorkerFailure can find it in O(1).
	 */
	private _markWorkerIdle(workerIndex: number): void {
		if (this.idleWorkerSet.has(workerIndex)) return;
		this.idleWorkerSet.add(workerIndex);
		const pos = this.idleWorkerIndices.length;
		this.idleWorkerIndices.push(workerIndex);
		this.idleWorkerIndexPositions.set(workerIndex, pos);
	}

	/**
	 * Remove a worker from the idle structures entirely.
	 * Uses O(1) swap-remove, but only within the LIVE portion of
	 * idleWorkerIndices (indices >= _idleReadIdx).
	 *
	 * If the worker's recorded position is in the already-consumed prefix
	 * (pos < _idleReadIdx) the entry there is stale — the worker was already
	 * dispatched via the read-index path and idleWorkerSet was cleared then, so
	 * this branch should never be reached.  We guard against it anyway.
	 */
	private _removeWorkerFromIdle(workerIndex: number): void {
		if (!this.idleWorkerSet.has(workerIndex)) return;
		this.idleWorkerSet.delete(workerIndex);

		const pos = this.idleWorkerIndexPositions.get(workerIndex);
		this.idleWorkerIndexPositions.delete(workerIndex);

		if (pos === undefined) return;

		// Guard: position is in the consumed prefix — nothing live to fix up.
		if (pos < this._idleReadIdx) return;

		// Swap-remove within the live portion only.
		const liveEnd = this.idleWorkerIndices.length - 1;
		if (pos !== liveEnd) {
			const swapped = this.idleWorkerIndices[liveEnd];
			this.idleWorkerIndices[pos] = swapped;
			this.idleWorkerIndexPositions.set(swapped, pos);
		}
		this.idleWorkerIndices.length = liveEnd;
	}

	/**
	 * Consume the next idle worker index from the front of the queue.
	 * Advances _idleReadIdx and clears the worker from the idle set/map.
	 * Returns -1 if no idle workers remain.
	 *
	 * Unlike _removeWorkerFromIdle, this intentionally does NOT call
	 * swap-remove — the read-index approach is how the dispatch loop
	 * efficiently walks forward without mutating the array on every pop.
	 * The position map entry is deleted so a subsequent handleWorkerFailure
	 * swap-remove cannot accidentally touch this consumed slot.
	 */
	private _consumeNextIdleWorker(): number {
		if (this._idleReadIdx >= this.idleWorkerIndices.length) return -1;
		const workerIndex = this.idleWorkerIndices[this._idleReadIdx];
		this._idleReadIdx++;
		this.idleWorkerSet.delete(workerIndex);
		this.idleWorkerIndexPositions.delete(workerIndex);
		return workerIndex;
	}

	/**
	 * Compact the idleWorkerIndices array by discarding the consumed prefix.
	 * Called opportunistically inside processQueue when the consumed portion
	 * exceeds half the array length.
	 *
	 * After compaction the position map is rebuilt for the remaining live
	 * entries so swap-remove remains correct.
	 */
	private _compactIdleWorkers(): void {
		if (this._idleReadIdx === 0) return;
		const toDiscard = this._idleReadIdx;
		this.idleWorkerIndices.copyWithin(0, toDiscard);
		this.idleWorkerIndices.length -= toDiscard;
		this._idleReadIdx = 0;
		// Rebuild position map for the compacted live portion.
		this.idleWorkerIndexPositions.clear();
		for (let i = 0; i < this.idleWorkerIndices.length; i++) {
			this.idleWorkerIndexPositions.set(this.idleWorkerIndices[i], i);
		}
	}

	/**
	 * Deterministic column -> worker affinity for terrain generation tasks.
	 *
	 * Every slice of a (chunkX, chunkZ) column hashes to the same worker so
	 * that worker's static column/flora prepass caches (SurfaceGenerator
	 * columnCache / floraCache) are built once per column instead of once per
	 * vertical slice per worker. Worker restarts keep the same index, so the
	 * affinity remains stable after a respawn (the replacement worker's caches
	 * simply go cold once).
	 *
	 * Worker 0 (LIGHT_WORKER_INDEX) is the dedicated light worker and is
	 * skipped when more than one worker exists (see the T2-11 guard in
	 * processQueue); with a single worker, terrain falls back to worker 0.
	 */
	private terrainWorkerForColumn(chunkX: number, chunkZ: number): number {
		const n = this.workers.length;
		if (n <= 1) return 0;
		const h = (Math.imul(chunkX, 73856093) ^ Math.imul(chunkZ, 19349663)) >>> 0;
		return 1 + (h % (n - 1));
	}

	/**
	 * If `preferred` is currently idle (in the live portion of
	 * idleWorkerIndices, at or after _idleReadIdx), swap it to the front so
	 * the next _consumeNextIdleWorker() picks it. Returns true when the
	 * preferred worker is now at the front. Mirrors the distant-terrain
	 * ready-worker swap in processQueue.
	 */
	private _swapPreferredIdleWorkerToFront(preferred: number): boolean {
		const start = this._idleReadIdx;
		for (let i = start; i < this.idleWorkerIndices.length; i++) {
			if (this.idleWorkerIndices[i] !== preferred) continue;
			if (i !== start) {
				const frontWorker = this.idleWorkerIndices[start];
				this.idleWorkerIndices[start] = preferred;
				this.idleWorkerIndices[i] = frontWorker;
				this.idleWorkerIndexPositions.set(preferred, start);
				this.idleWorkerIndexPositions.set(frontWorker, i);
			}
			return true;
		}
		return false;
	}

	// -------------------------------------------------------------------------
	// Worker failure / restart
	// -------------------------------------------------------------------------

	private handleWorkerFailure(workerIndex: number, reason: unknown): void {
		const context = this.workerTaskContext[workerIndex];
		this.workerTaskContext[workerIndex] = null;

		if (context?.taskType === TaskType.DistantTerrain) {
			this.distantTerrainInFlight = false;
		}

		if (context?.taskType === TaskType.FarTile) {
			this.farTilesInFlightCount = Math.max(0, this.farTilesInFlightCount - 1);
		}

		if (
			(context?.taskType === TaskType.Remesh ||
				context?.taskType === TaskType.LodPrecompute ||
				context?.taskType === TaskType.Relight) &&
			context.chunk &&
			typeof context.lod === "number"
		) {
			this.inFlightRemeshKeys.delete(
				packInflightKey(context.chunk.numericId, context.lod),
			);
		}

		// Re-queue interrupted tasks.
		if (context?.taskType === TaskType.Terrain && context.chunk) {
			context.chunk.isTerrainScheduled = false;
			this.scheduleTerrainGeneration(
				context.chunk,
				context.terrainDeferLighting ?? true,
			);
		} else if (
			context?.taskType === TaskType.Remesh &&
			context.chunk?.isLoaded
		) {
			this.scheduleRemesh(context.chunk, true);
		} else if (
			context?.taskType === TaskType.Relight &&
			context.chunk?.isLoaded &&
			typeof context.lod === "number"
		) {
			// Relight's worker-side block grid was lost with the worker —
			// re-queue as a full remesh so it is rebuilt.
			this.scheduleRemesh(context.chunk, true);
		} else if (
			context?.taskType === TaskType.LodPrecompute &&
			context.chunk &&
			typeof context.lod === "number"
		) {
			const key = packInflightKey(context.chunk.numericId, context.lod);
			if (!this.pendingLodPrecomputeKeys.has(key)) {
				this.pendingLodPrecomputeKeys.add(key);
				this.lodPrecomputeQueue.push({
					chunk: context.chunk,
					lod: context.lod,
				});
			}
		} else if (
			context?.taskType === TaskType.DistantTerrain &&
			context.distantTask
		) {
			if (this.distantTerrainTaskQueueReadIdx > 0) {
				this.distantTerrainTaskQueueReadIdx--;
				this.distantTerrainTaskQueue[this.distantTerrainTaskQueueReadIdx] =
					context.distantTask;
			} else {
				this.distantTerrainTaskQueue.push(context.distantTask);
			}
		} else if (context?.taskType === TaskType.FarTile) {
			// Far-tile results are derived data; the manager's request simply
			// times out and re-requests. Nothing to restore here.
		}

		// Remove from idle structures using the safe helper.
		this._removeWorkerFromIdle(workerIndex);
		this.distantTerrainReadyWorkers.delete(workerIndex);

		try {
			this.workers[workerIndex]?.terminate();
		} catch {
			// ignore
		}

		const now = performance.now();
		const earliestRestart =
			(this.workerRestartAtMs[workerIndex] ?? 0) +
			ChunkWorkerPool.WORKER_ERROR_COOLDOWN_MS;
		const delay = Math.max(0, earliestRestart - now);

		const restart = () => {
			const holder: { worker?: ChunkWorker } = {};
			const onMessageTerrain = this.makeTerrainMessageHandler(
				workerIndex,
				() => holder.worker,
			);
			const onMessageMesh = this.makeMeshMessageHandler(
				workerIndex,
				() => holder.worker,
			);
			const onError = (ev: ErrorEvent | Event) => {
				console.error(`Chunk worker ${workerIndex} error`, ev, reason);
				this.handleWorkerFailure(workerIndex, ev);
			};

			const replacement = new ChunkWorker(
				workerIndex,
				onMessageTerrain,
				onMessageMesh,
			);
			replacement.setOnError(onError);
			holder.worker = replacement;

			this.applyWorldSeed(replacement);

			this.workers[workerIndex] = replacement;
			this.workerRestartAtMs[workerIndex] = performance.now();
			this.setWorkerTaskContext(workerIndex, null);

			// Flush pending unregisters before re-registering, so a disposed
			// chunk that got re-created is not dropped by the replacement.
			this.flushPendingUnregisters();

			if (this.lightHeaderBuffer && workerIndex === 0) {
				replacement.initLightShared(this.lightHeaderBuffer);
				if (this.closedFaceMaskBuffer) {
					replacement.postLightSetClosedFaceMask(this.closedFaceMaskBuffer);
				}
				for (const [, chunk] of Chunk.chunkInstances) {
					if (chunk.isLoaded) {
						const snap = chunk.getLightStorageSnapshot();
						replacement.postLightRegisterChunk({
							seq: this.nextLightSeq(),
							chunkId: chunk.id,
							chunkX: chunk.chunkX,
							chunkY: chunk.chunkY,
							chunkZ: chunk.chunkZ,
							headerSlot: chunk.lightHeaderSlot,
							blockSAB: snap.blockSAB,
							lightSAB: snap.lightSAB,
							paletteSAB: snap.paletteSAB,
							blockStorageBytesPerElement: snap.blockStorageBytesPerElement,
						});
					}
				}
			}

			// The replacement voxel worker's registration map is empty:
			// re-register every loaded chunk directly.
			for (const [, chunk] of Chunk.chunkInstances) {
				if (chunk.isLoaded) {
					const snap = chunk.getLightStorageSnapshot();
					replacement.postVoxelRegisterChunk({
						chunkId: chunk.id,
						chunkX: chunk.chunkX,
						chunkY: chunk.chunkY,
						chunkZ: chunk.chunkZ,
						isUniform: chunk.isUniform,
						uniformBlockId: chunk.uniformBlockId,
						blockStorageBytesPerElement: snap.blockStorageBytesPerElement,
						direct: true,
						blockSAB: snap.blockSAB,
						paletteSAB: snap.paletteSAB,
						lightSAB: snap.lightSAB,
					});
				}
			}

			if (this.distantTerrainSharedInit) {
				const {
					positionsBuffer,
					normalsBuffer,
					surfaceTilesBuffer,
					radius,
					gridStep,
				} = this.distantTerrainSharedInit;
				replacement.initDistantTerrainShared(
					positionsBuffer,
					normalsBuffer,
					surfaceTilesBuffer,
					radius,
					gridStep,
				);
			}

			this._markWorkerIdle(workerIndex);
			this.processQueue();
		};

		if (delay > 0) {
			window.setTimeout(restart, delay);
		} else {
			restart();
		}
	}

	// -------------------------------------------------------------------------
	// Light-task public API
	// -------------------------------------------------------------------------

	public nextLightSeq(): number {
		return this.nextLightSeqCounter++;
	}

	public postLightMutate(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		oldPacked: number;
		newPacked: number;
		seq: number;
	}): void {
		this.getLightWorker().postLightMutate(req);
		this.debugStats.lightDispatches++;
	}

	public postLightAddEmission(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		level: number;
		seq: number;
	}): void {
		this.getLightWorker().postLightAddEmission(req);
		this.debugStats.lightDispatches++;
	}

	public postLightSkyReconcile(req: {
		chunkId: bigint;
		headerSlot: number;
		seq: number;
	}): void {
		this.getLightWorker().postLightSkyReconcile(req);
		this.debugStats.lightDispatches++;
	}

	public postLightPropagateDeferred(req: {
		chunkId: bigint;
		headerSlot: number;
		seedQueue: Uint16Array;
		seedLength: number;
		seq: number;
	}): void {
		this.getLightWorker().postLightPropagateDeferred(req);
		this.debugStats.lightDispatches++;
	}

	/**
	 * Called by Chunk.initializeSunlight() when a chunk is loaded without
	 * a pre-computed light_array.  Enqueues into the deferred-light pump
	 * so the BFS runs after the chunk has been registered with the light
	 * worker.  If LightPropagateDeferred still arrives before the worker's
	 * LightRegisterChunk is processed, the worker holds the seed and
	 * replays it once the chunk registers (LightTaskHandlers).
	 */
	public enqueueDeferredLightFromSunlightInit(
		chunk: Chunk,
		seedQueue: Uint16Array,
		seedLength: number,
	): void {
		this.enqueueDeferredLightingRefinement(chunk, seedQueue, seedLength);
	}

	private getLightWorker(): ChunkWorker {
		if (this.workers.length === 0) {
			throw new Error(
				"ChunkWorkerPool has no workers; cannot post light task.",
			);
		}
		return this.workers[ChunkWorkerPool.LIGHT_WORKER_INDEX];
	}

	private broadcastLightRegister(chunk: Chunk): void {
		// Pass SABs directly — no OPFS worker-to-worker channel anymore.
		this.flushPendingUnregisters();
		const snap = chunk.getLightStorageSnapshot();
		this.getLightWorker().postLightRegisterChunk({
			seq: this.nextLightSeq(),
			chunkId: chunk.id,
			chunkX: chunk.chunkX,
			chunkY: chunk.chunkY,
			chunkZ: chunk.chunkZ,
			headerSlot: chunk.lightHeaderSlot,
			blockSAB: snap.blockSAB,
			lightSAB: snap.lightSAB,
			paletteSAB: snap.paletteSAB,
			blockStorageBytesPerElement:
				chunk.block_array instanceof Uint16Array ? 2 : 1,
		});
	}

	/** Full-registration path for fresh-generation chunks (no voxel channel). */
	private broadcastLightRegisterFull(chunk: Chunk): void {
		this.flushPendingUnregisters();
		const snap = chunk.getLightStorageSnapshot();
		this.getLightWorker().postLightRegisterChunk({
			seq: this.nextLightSeq(),
			chunkId: chunk.id,
			chunkX: chunk.chunkX,
			chunkY: chunk.chunkY,
			chunkZ: chunk.chunkZ,
			headerSlot: chunk.lightHeaderSlot,
			blockSAB: snap.blockSAB,
			lightSAB: snap.lightSAB,
			paletteSAB: snap.paletteSAB,
			blockStorageBytesPerElement: snap.blockStorageBytesPerElement,
		});
	}

	private broadcastLightUpdateBuffers(chunk: Chunk): void {
		this.flushPendingUnregisters();
		const snap = chunk.getLightStorageSnapshot();
		this.getLightWorker().postLightUpdateBuffers({
			chunkId: chunk.id,
			headerSlot: chunk.lightHeaderSlot,
			blockSAB: snap.blockSAB,
			paletteSAB: snap.paletteSAB,
			lightSAB: snap.lightSAB,
			blockStorageBytesPerElement: snap.blockStorageBytesPerElement,
		});
	}

	// ---------------------------------------------------------------------------
	// Pending unregister coalescing: dispose bursts (up to 255 chunks/frame)
	// used to post one LightUnregisterChunk + one VoxelUnregisterChunk per
	// worker per chunk (~1500 postMessages).  Unregisters are accumulated and
	// flushed as a single batch message per worker.  Ordering is preserved by
	// flushing before ANY register/update broadcast (see the register entry
	// points) plus a macrotask drain so workers never keep stale entries.
	// ---------------------------------------------------------------------------
	private _pendingLightUnregisterIds: bigint[] = [];
	private _pendingVoxelUnregisterCoords: number[] = [];
	private _unregisterFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private static readonly UNREGISTER_FLUSH_THRESHOLD = 64;

	private broadcastLightUnregister(chunk: Chunk): void {
		this.lightSlotPendingSeq.delete(chunk.lightHeaderSlot);
		this._pendingLightUnregisterIds.push(chunk.id);
		this.flushPendingUnregistersIfNeeded();
		this.schedulePendingUnregisterFlush();
	}

	private broadcastVoxelUnregister(chunk: Chunk): void {
		const coords = this._pendingVoxelUnregisterCoords;
		coords.push(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
		this.flushPendingUnregistersIfNeeded();
		this.schedulePendingUnregisterFlush();
	}

	private flushPendingUnregistersIfNeeded(): void {
		if (
			this._pendingLightUnregisterIds.length >=
				ChunkWorkerPool.UNREGISTER_FLUSH_THRESHOLD ||
			this._pendingVoxelUnregisterCoords.length >=
				ChunkWorkerPool.UNREGISTER_FLUSH_THRESHOLD * 3
		) {
			this.flushPendingUnregisters();
		}
	}

	private schedulePendingUnregisterFlush(): void {
		if (this._unregisterFlushTimer !== null) return;
		this._unregisterFlushTimer = setTimeout(() => {
			this._unregisterFlushTimer = null;
			this.flushPendingUnregisters();
		}, 0);
	}

	private flushPendingUnregisters(): void {
		const ids = this._pendingLightUnregisterIds;
		const coords = this._pendingVoxelUnregisterCoords;
		if (ids.length === 0 && coords.length === 0) return;

		this._pendingLightUnregisterIds = [];
		this._pendingVoxelUnregisterCoords = [];
		if (this._unregisterFlushTimer !== null) {
			clearTimeout(this._unregisterFlushTimer);
			this._unregisterFlushTimer = null;
		}

		if (ids.length > 0) {
			this.getLightWorker().postLightUnregisterChunkBatch(ids);
		}
		if (coords.length > 0) {
			const packedCoords = new Int32Array(coords);
			for (let i = 0; i < this.workers.length; i++) {
				this.workers[i].postVoxelUnregisterChunkBatch(packedCoords);
			}
		}
	}

	/**
	 * Channel-path voxel registration: metadata only (SABs arrive via the
	 * worker-to-worker channel). Mirrors broadcastLightRegister.
	 */
	private broadcastVoxelRegister(chunk: Chunk): void {
		this.flushPendingUnregisters();
		const snap = chunk.getLightStorageSnapshot();
		for (let i = 0; i < this.workers.length; i++) {
			this.workers[i].postVoxelRegisterChunk({
				chunkId: chunk.id,
				chunkX: chunk.chunkX,
				chunkY: chunk.chunkY,
				chunkZ: chunk.chunkZ,
				isUniform: chunk.isUniform,
				uniformBlockId: chunk.uniformBlockId,
				blockStorageBytesPerElement:
					chunk.block_array instanceof Uint16Array ? 2 : 1,
				direct: true,
				blockSAB: snap.blockSAB,
				paletteSAB: snap.paletteSAB,
				lightSAB: snap.lightSAB,
			});
		}
	}

	/** Direct-path voxel registration: SAB handles inline (fresh chunks). */
	private broadcastVoxelRegisterFull(chunk: Chunk): void {
		this.flushPendingUnregisters();
		const snap = chunk.getLightStorageSnapshot();
		for (let i = 0; i < this.workers.length; i++) {
			this.workers[i].postVoxelRegisterChunk({
				chunkId: chunk.id,
				chunkX: chunk.chunkX,
				chunkY: chunk.chunkY,
				chunkZ: chunk.chunkZ,
				isUniform: chunk.isUniform,
				uniformBlockId: chunk.uniformBlockId,
				blockStorageBytesPerElement: snap.blockStorageBytesPerElement,
				direct: true,
				blockSAB: snap.blockSAB,
				paletteSAB: snap.paletteSAB,
				lightSAB: snap.lightSAB,
			});
		}
	}

	/** Storage-layout transition (uniform<->palette<->u16): new SAB handles. */
	private broadcastVoxelUpdateBuffers(chunk: Chunk): void {
		this.flushPendingUnregisters();
		const snap = chunk.getLightStorageSnapshot();
		for (let i = 0; i < this.workers.length; i++) {
			this.workers[i].postVoxelUpdateBuffers({
				chunkId: chunk.id,
				chunkX: chunk.chunkX,
				chunkY: chunk.chunkY,
				chunkZ: chunk.chunkZ,
				isUniform: chunk.isUniform,
				uniformBlockId: chunk.uniformBlockId,
				blockStorageBytesPerElement: snap.blockStorageBytesPerElement,
				blockSAB: snap.blockSAB,
				paletteSAB: snap.paletteSAB,
				lightSAB: snap.lightSAB,
			});
		}
	}

	private _lightRegChunks: Chunk[] = [];
	private _lightRegFlags: boolean[] = [];
	private _lightRegDrainScheduled = false;

	private onLightChunkLoaded(chunk: Chunk, fromChannel: boolean): void {
		this.invalidateNeighborMasks(chunk);
		this.lightChunkByHeaderSlot.set(chunk.lightHeaderSlot, chunk);
		this._lightRegChunks.push(chunk);
		this._lightRegFlags.push(fromChannel);
		if (!this._lightRegDrainScheduled) {
			this._lightRegDrainScheduled = true;
			this._scheduleCentralWork(ChunkWorkerPool.WORK_LIGHT_REG);
		}
	}

	private onLightChunkLayoutChanged(chunk: Chunk): void {
		this.broadcastLightUpdateBuffers(chunk);
		this.broadcastVoxelUpdateBuffers(chunk);
	}

	private onLightChunkDisposed(chunk: Chunk): void {
		this.invalidateNeighborMasks(chunk);
		this.lightChunkByHeaderSlot.delete(chunk.lightHeaderSlot);
		this.broadcastLightUnregister(chunk);
		this.broadcastVoxelUnregister(chunk);
		this.debugLightSeedLengths.delete(chunk.id);

		// Drop any pending deferred-light work for this chunk so a future
		// reload at the same coordinates (which reuses the same coordinate-
		// based chunk id) can re-enqueue without being shadowed by the stale
		// queuedIds entry.  Otherwise the deferred BFS is silently skipped and
		// the chunk's lateral sky-light (cave) lighting never runs.
		this.deferredLightingQueuedIds.delete(chunk.id);
		this.deferredLightingSeedStates.delete(chunk.id);
		const q = this.deferredLightingQueue;
		for (let i = this.deferredLightingQueueReadIdx; i < q.length; i++) {
			if (q[i] === chunk) {
				q[i] = null as unknown as Chunk;
				break;
			}
		}
	}

	private invalidateNeighborMasks(chunk: Chunk): void {
		// The chunk's own mask depends on its neighbors, and its neighbors'
		// masks depend on it — delete all 27 entries defensively.
		neighborMaskCache.delete(chunk);
		for (let i = 0; i < NEIGHBOR_OFFSETS_26.length; i++) {
			const { dx, dy, dz } = NEIGHBOR_OFFSETS_26[i];
			const n = getChunk(
				chunk.chunkX + dx,
				chunk.chunkY + dy,
				chunk.chunkZ + dz,
			);
			if (n) neighborMaskCache.delete(n);
		}
	}

	private processLightDirtyQueue = (): void => {
		this.lightDirtyPumpScheduled = false;
		const start = performance.now();
		let processed = 0;
		const budget = 4; // ms
		const slotMap = this.lightSlotPendingSeq;
		let iterCount = 0;

		while (
			this.lightDirtyQueueReadIdx < this.lightDirtyQueue.length &&
			((iterCount++ & 15) !== 0 || performance.now() - start < budget)
		) {
			const entry = this.lightDirtyQueue[this.lightDirtyQueueReadIdx++];
			const slots = entry.dirtySlots;
			for (let i = 0; i < slots.length; i++) {
				const slot = slots[i];
				const prev = slotMap.get(slot) ?? 0;
				if (entry.seq > prev) slotMap.set(slot, entry.seq);
			}
			processed++;
		}

		// Return consumed envelopes to the free-list — must happen before
		// copyWithin overwrites the consumed prefix below.
		for (let i = 0; i < this.lightDirtyQueueReadIdx; i++) {
			const entry = this.lightDirtyQueue[i];
			entry.dirtySlots = ChunkWorkerPool._LIGHT_DIRTY_EMPTY;
			ChunkWorkerPool._lightDirtyPool.push(entry);
		}

		if (
			this.lightDirtyQueueReadIdx > 64 &&
			this.lightDirtyQueueReadIdx * 2 > this.lightDirtyQueue.length
		) {
			this.lightDirtyQueue.copyWithin(0, this.lightDirtyQueueReadIdx);
			this.lightDirtyQueue.length -= this.lightDirtyQueueReadIdx;
			this.lightDirtyQueueReadIdx = 0;
		}

		this.debugStats.lightDirtyProcessedLastFrame = processed;
		this.debugStats.lightDirtyProcessedTotal += processed;
		this.debugStats.lightDirtyQueueLength =
			this.lightDirtyQueue.length - this.lightDirtyQueueReadIdx;

		if (this.lightDirtyQueueReadIdx < this.lightDirtyQueue.length) {
			this.scheduleLightDirtyPump();
		}

		// Walk the merged dirty slots and schedule remesh.  Only delete the
		// entry when the schedule actually succeeded, so slots for chunks
		// that are mid-terrain-generation or not yet loaded remain in the
		// map and will be retried on the next pump (or when a future
		// LightDirty arrives).
		for (const [slot] of slotMap) {
			const chunk = this.lightChunkByHeaderSlot.get(slot);
			if (chunk?.isLoaded && !chunk.isTerrainScheduled) {
				if (!this.tryScheduleRelightOnly(chunk)) {
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
				}
				slotMap.delete(slot);
			} else if (!chunk) {
				slotMap.delete(slot);
			}
		}
	};

	/**
	 * T2-8: schedule a light-only remesh for a chunk whose block content is
	 * unchanged since its current mesh was built. Returns false (caller falls
	 * back to a full scheduleRemesh) when the chunk has no mesh baseline, when
	 * a full remesh is already pending/in-flight, or when the chunk has no
	 * light array.
	 */
	private tryScheduleRelightOnly(chunk: Chunk): boolean {
		if (!chunk.light_array) return false;

		const baseline = this.blockRevisionAtMesh.get(chunk.id);
		const lod = chunk.lodLevel ?? 0;
		if (
			!baseline ||
			baseline.lod !== lod ||
			baseline.blockRevision !== chunk.blockRevision
		) {
			return false;
		}

		if (
			this.pendingRemeshMap.has(chunk) ||
			this.isSameLodRemeshInflight(chunk)
		) {
			return false;
		}

		const key = packInflightKey(chunk.numericId, lod);
		if (this.pendingRelightKeys.has(key)) return true;

		this.pendingRelightKeys.add(key);
		this.relightQueue.push(chunk);
		this.scheduleProcessQueuePump();
		return true;
	}

	private scheduleLightDirtyPump(): void {
		if (this.lightDirtyPumpScheduled) return;
		this.lightDirtyPumpScheduled = true;
		this._scheduleCentralWork(ChunkWorkerPool.WORK_LIGHT_DIRTY);
	}

	// -------------------------------------------------------------------------
	// Centralized work coalescing
	//
	// Instead of each subsystem scheduling its own setTimeout(…, 0), flag the
	// work here and drain everything in a single macrotask. This eliminates
	// frame-time fragmentation where 4-5 independent callbacks each consumed
	// 1-2ms in separate event-loop ticks.
	// -------------------------------------------------------------------------

	private _scheduleCentralWork(flags: number): void {
		this._pendingWorkFlags |= flags;
		if (this._centralSchedulerScheduled) return;
		this._centralSchedulerScheduled = true;
		setTimeout(this._centralFlush, 0);
	}

	private _centralFlush = (): void => {
		this._centralSchedulerScheduled = false;
		const flags = this._pendingWorkFlags;
		this._pendingWorkFlags = 0;

		if (flags & ChunkWorkerPool.WORK_PROCESS_QUEUE) {
			this.processQueuePumpScheduled = false;
			this.processQueue();
		}
		if (flags & ChunkWorkerPool.WORK_MESH) {
			this.meshDrainScheduled = false;
			this.processMeshQueueLoop();
		}
		if (flags & ChunkWorkerPool.WORK_DEFERRED_LIGHT) {
			this.deferredLightingPumpScheduled = false;
			this.processDeferredLightingQueue();
		}
		if (flags & ChunkWorkerPool.WORK_LIGHT_REG) {
			this._lightRegDrainScheduled = false;
			this._drainLightRegistration();
		}
		if (flags & ChunkWorkerPool.WORK_REMESH_FLUSH) {
			this.remeshFlushScheduled = false;
			this.flushPendingRemeshQueue();
		}
		if (flags & ChunkWorkerPool.WORK_LIGHT_DIRTY) {
			this.lightDirtyPumpScheduled = false;
			this.processLightDirtyQueue();
		}
	};

	private _drainLightRegistration(): void {
		const chunks = this._lightRegChunks;
		const flags = this._lightRegFlags;
		if (chunks.length === 0) return;

		this.flushPendingUnregisters();

		const lightRegistrations: LightRegisterChunkBatchRequest["chunks"] = [];
		const seen = new Set<bigint>();
		const voxelIds: bigint[] = [];
		const voxelCoords: number[] = [];
		const voxelMeta: number[] = [];
		const voxelBlockSABs: (SharedArrayBuffer | null)[] = [];
		const voxelPaletteSABs: (SharedArrayBuffer | null)[] = [];
		const voxelLightSABs: (SharedArrayBuffer | null)[] = [];

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (seen.has(chunk.id)) continue;
			seen.add(chunk.id);

			const snap = chunk.getLightStorageSnapshot();
			const blockStorageBytesPerElement = snap.blockStorageBytesPerElement;

			lightRegistrations.push({
				seq: this.nextLightSeq(),
				chunkId: chunk.id,
				chunkX: chunk.chunkX,
				chunkY: chunk.chunkY,
				chunkZ: chunk.chunkZ,
				headerSlot: chunk.lightHeaderSlot,
				blockSAB: snap.blockSAB,
				lightSAB: snap.lightSAB!,
				paletteSAB: snap.paletteSAB,
				blockStorageBytesPerElement,
			});

			voxelIds.push(chunk.id);
			voxelCoords.push(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
			voxelMeta.push(
				chunk.isUniform ? 1 : 0,
				chunk.uniformBlockId,
				blockStorageBytesPerElement,
			);
			voxelBlockSABs.push(snap.blockSAB);
			voxelPaletteSABs.push(snap.paletteSAB);
			voxelLightSABs.push(snap.lightSAB);
		}
		chunks.length = 0;
		flags.length = 0;

		this.getLightWorker().postLightRegisterChunkBatch(lightRegistrations);

		// PERF: SoA flat arrays, constructed once per drain — structured clone
		// still copies the typed-array backing per worker, but ~32 bytes per
		// chunk instead of an 11-keyed object.
		const voxelChunkIdsArray = new BigInt64Array(voxelIds);
		const voxelCoordsArray = new Int32Array(voxelCoords);
		const voxelMetaArray = new Uint32Array(voxelMeta);

		for (let i = 0; i < this.workers.length; i++) {
			this.workers[i].postVoxelRegisterChunkBatch({
				chunkIds: voxelChunkIdsArray,
				coords: voxelCoordsArray,
				meta: voxelMetaArray,
				blockSABs: voxelBlockSABs,
				paletteSABs: voxelPaletteSABs,
				lightSABs: voxelLightSABs,
			});
		}
	}

	// -------------------------------------------------------------------------
	// Constructor
	// -------------------------------------------------------------------------

	/**
	 * Give a freshly spawned terrain worker the world's generator seed
	 * (explicit stored seed, or the world-name-derived default). Must run
	 * before the first generation task the worker handles.
	 */
	private applyWorldSeed(worker: ChunkWorker): void {
		const worldName = getWorldNameFromUrl();
		if (worldName) {
			worker.setWorldSeed(worldSeedFor(worldName));
		}
	}

	private constructor(poolSize: number) {
		// Allocate the workspace-wide light header SAB and broadcast it to
		// every worker.  Each worker wraps the buffer and keeps a local
		// ChunkViewRegistry.
		this.lightHeaderBuffer = Chunk.initLightHeader();
		for (let i = 0; i < poolSize; i++) {
			const holder: { worker?: ChunkWorker } = {};
			const onMessageTerrain = this.makeTerrainMessageHandler(
				i,
				() => holder.worker,
			);
			const onMessageMesh = this.makeMeshMessageHandler(i, () => holder.worker);
			const onError = (ev: ErrorEvent | Event) => {
				console.error(`Chunk worker ${i} error`, ev);
				this.handleWorkerFailure(i, ev);
			};

			const workerWrapper = new ChunkWorker(i, onMessageTerrain, onMessageMesh);
			workerWrapper.setOnError(onError);
			holder.worker = workerWrapper;

			this.applyWorldSeed(workerWrapper);

			this.workers.push(workerWrapper);
			this._markWorkerIdle(i);
			this.workerTaskContext.push(null);
			this.workerRestartAtMs.push(0);
			this.workerDispatchCounts.push(0);
			this._lastHeartbeatSeq.push(0);

			if (this.lightHeaderBuffer && i === 0) {
				workerWrapper.initLightShared(this.lightHeaderBuffer);
			}
		}

		Chunk.onLightChunkLoaded = (chunk, fromChannel) =>
			this.onLightChunkLoaded(chunk, fromChannel);
		Chunk.onLightChunkLayoutChanged = (chunk) =>
			this.onLightChunkLayoutChanged(chunk);
		Chunk.onLightChunkDisposed = (chunk) => this.onLightChunkDisposed(chunk);
		Chunk._lightPool = {
			postLightMutate: (req) => this.postLightMutate(req),
			postLightAddEmission: (req) => this.postLightAddEmission(req),
			nextLightSeq: () => this.nextLightSeq(),
			enqueueDeferredLightFromSunlightInit: (
				chunk: Chunk,
				queue: Uint16Array,
				length: number,
			) => this.enqueueDeferredLightFromSunlightInit(chunk, queue, length),
		};

		this.updateQueueDebugStats();

		// Ensure dirty merged groups are rebuilt promptly even when no fresh
		// worker mesh-result is pending (cache loads, unloads, LOD changes).
		setRequestFlush(() => this.scheduleMeshFlush());

		this.processMeshQueueLoop();

		// Fire-and-forget: once block shapes finish loading, precompute the
		// per-face closed-mask lookup table and send it to the light worker
		// so it can correctly handle non-full blocks (slabs, stairs, etc.).
		shapeInitPromise
			.then(() => {
				const lut = precomputeClosedFaceMasks();
				const sab = new SharedArrayBuffer(lut.byteLength);
				new Uint8Array(sab).set(lut);
				this.closedFaceMaskBuffer = sab;
				this.workers[0]?.postLightSetClosedFaceMask(sab);
			})
			.catch(() => {
				/* shapes failed to load; worker keeps cube fallback */
			});
	}

	// -------------------------------------------------------------------------
	// Mesh helpers
	// -------------------------------------------------------------------------

	private isCompletelyEmptyChunk(chunk: Chunk): boolean {
		return chunk.isUniform && chunk.uniformBlockId === 0;
	}

	/**
	 * The engine's "opaque" classification, identical to the mesher's:
	 * solid + greedy-participating, neither transparent nor partial-shape.
	 * These are full cubes that close every face, so a chunk made entirely
	 * of one such block emits no custom geometry either.
	 */
	private static isOpaqueCubePacked(packed: number): boolean {
		const flags = getFlagsFromCombined(getCachedFlagsAndId(packed));
		return (
			(flags & (FLAG_SOLID | FLAG_GREEDY)) === (FLAG_SOLID | FLAG_GREEDY) &&
			(flags & (FLAG_TRANSPARENT | FLAG_PARTIAL)) === 0
		);
	}

	/**
	 * A chunk whose voxels are all the same opaque cube only ever emits
	 * faces at its -X/-Y/-Z boundaries (slice -1) — its +boundaries are
	 * emitted by the +neighbors at their own slice -1, and interior pairs
	 * are opaque-opaque. When those three negative neighbors are also
	 * uniformly opaque cubes, every boundary pair is opaque-opaque, so the
	 * chunk's mesh is provably empty: skip the full worker dispatch.
	 */
	private isUniformSolidMeshSkippable(chunk: Chunk): boolean {
		if (!chunk.isUniform || chunk.uniformBlockId === 0) return false;
		if (!ChunkWorkerPool.isOpaqueCubePacked(chunk.uniformBlockId)) return false;
		return (
			this.isUniformOpaqueCubeNeighbor(
				chunk.chunkX - 1,
				chunk.chunkY,
				chunk.chunkZ,
			) &&
			this.isUniformOpaqueCubeNeighbor(
				chunk.chunkX,
				chunk.chunkY - 1,
				chunk.chunkZ,
			) &&
			this.isUniformOpaqueCubeNeighbor(
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ - 1,
			)
		);
	}

	private isUniformOpaqueCubeNeighbor(
		cx: number,
		cy: number,
		cz: number,
	): boolean {
		const neighbor = getChunk(cx, cy, cz);
		if (!neighbor?.isLoaded || !neighbor.hasVoxelData) return false;
		return (
			neighbor.isUniform &&
			neighbor.uniformBlockId !== 0 &&
			ChunkWorkerPool.isOpaqueCubePacked(neighbor.uniformBlockId)
		);
	}

	private clearChunkMeshIfPresent(chunk: Chunk): void {
		if (
			chunk.mesh ||
			chunk.waterMesh ||
			chunk.cutoutMesh ||
			chunk.opaqueMeshData ||
			chunk.waterMeshData ||
			chunk.cutoutMeshData
		) {
			createMeshFromData(chunk, null, null, null);
		}
	}

	// -------------------------------------------------------------------------
	// Deferred lighting
	// -------------------------------------------------------------------------

	private enqueueDeferredLightingRefinement(
		chunk: Chunk,
		seedQueue: Uint16Array,
		seedLength: number,
	): void {
		if (!chunk || seedLength <= 0) return;

		const existing = this.deferredLightingSeedStates.get(chunk.id);
		if (existing) {
			// Merge new seeds into the existing queue, deduplicating.
			// Uses a reusable scratch Set + in-place compaction when the
			// existing buffer has spare capacity, avoiding per-merge
			// Uint16Array allocation.
			const existingLen = existing.length;
			const seen = ChunkWorkerPool._dedupScratch;
			seen.clear();
			for (let i = 0; i < existingLen; i++) {
				seen.add(existing.queue[i]);
			}
			let writeIdx = existingLen;
			const needed = existingLen + seedLength;
			if (existing.queue.length >= needed) {
				for (let i = 0; i < seedLength; i++) {
					const val = seedQueue[i];
					if (!seen.has(val)) {
						existing.queue[writeIdx++] = val;
					}
				}
			} else {
				const merged = new Uint16Array(needed);
				merged.set(existing.queue.subarray(0, existingLen));
				for (let i = 0; i < seedLength; i++) {
					const val = seedQueue[i];
					if (!seen.has(val)) {
						merged[writeIdx++] = val;
					}
				}
				existing.queue = merged;
			}
			existing.length = writeIdx;
			seen.clear();
			this.debugStats.deferredLightingSeedReplacedTotal++;
		} else {
			this.deferredLightingSeedStates.set(chunk.id, {
				queue: seedQueue,
				length: seedLength,
			});
		}

		if (!this.deferredLightingQueuedIds.has(chunk.id)) {
			this.deferredLightingQueuedIds.add(chunk.id);
			this.deferredLightingQueue.push(chunk);
			this.debugStats.deferredLightingEnqueuedTotal++;
		}

		this.scheduleDeferredLightingPump();
	}

	private scheduleDeferredLightingPump(): void {
		if (this.deferredLightingPumpScheduled) return;
		this.deferredLightingPumpScheduled = true;
		this._scheduleCentralWork(ChunkWorkerPool.WORK_DEFERRED_LIGHT);
	}

	private processDeferredLightingQueue(): void {
		const terrainBusy = this.terrainTaskQueue.size > 0;

		const start = performance.now();
		let processed = 0;
		let dropped = 0;
		const budget = ChunkWorkerPool.DEFERRED_LIGHTING_BUDGET_MS;
		// When terrain tasks are in-flight, reduce throughput to avoid
		// starving terrain generation on the shared worker.
		const maxChunks = terrainBusy
			? Math.min(4, ChunkWorkerPool.DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME)
			: ChunkWorkerPool.DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME;
		let iterCount = 0;

		while (
			this.deferredLightingQueueReadIdx < this.deferredLightingQueue.length &&
			processed < maxChunks &&
			((iterCount++ & 15) !== 0 || performance.now() - start < budget)
		) {
			const chunk =
				this.deferredLightingQueue[this.deferredLightingQueueReadIdx++];
			// Slot may have been nulled by onLightChunkDisposed (the chunk was
			// unloaded before the pump reached it); skip it without counting
			// as a dropped chunk.
			if (!chunk) continue;
			this.deferredLightingQueuedIds.delete(chunk.id);

			const seedState = this.deferredLightingSeedStates.get(chunk.id);
			this.deferredLightingSeedStates.delete(chunk.id);

			if (!seedState || !chunk.isLoaded || !chunk.hasVoxelData) {
				dropped++;
				continue;
			}

			// Forward the deferred-light BFS to a worker.  The light-worker
			// will post a LightDirty reply when done; processLightDirtyQueue
			// schedules the remesh, and queuePostRemeshSave persists the
			// chunk after the mesh is rebuilt with the post-BFS light data.
			// Do NOT save here — the worker hasn't finished propagating yet,
			// so the save would capture only the initial top-down seeding.
			this.postLightPropagateDeferred({
				chunkId: chunk.id,
				headerSlot: chunk.lightHeaderSlot,
				seedQueue: seedState.queue,
				seedLength: seedState.length,
				seq: this.nextLightSeq(),
			});
			this.postLightSkyReconcile({
				chunkId: chunk.id,
				headerSlot: chunk.lightHeaderSlot,
				seq: this.nextLightSeq(),
			});
			processed++;
		}

		this.debugStats.deferredLightingProcessedLastFrame = processed;
		this.debugStats.deferredLightingProcessedTotal += processed;
		this.debugStats.deferredLightingDroppedTotal += dropped;

		if (
			this.deferredLightingQueueReadIdx > 64 &&
			this.deferredLightingQueueReadIdx * 2 > this.deferredLightingQueue.length
		) {
			this.deferredLightingQueue.copyWithin(
				0,
				this.deferredLightingQueueReadIdx,
			);
			this.deferredLightingQueue.length -= this.deferredLightingQueueReadIdx;
			this.deferredLightingQueueReadIdx = 0;
		}

		if (this.deferredLightingQueueReadIdx < this.deferredLightingQueue.length) {
			this.scheduleDeferredLightingPump();
		}
	}

	// -------------------------------------------------------------------------
	// Mesh result drain loop — runs every rAF
	// -------------------------------------------------------------------------

	private scheduleMeshFlush = (): void => {
		if (this.meshDrainScheduled || this.insideMeshDrain) return;
		this.meshDrainScheduled = true;
		this._scheduleCentralWork(ChunkWorkerPool.WORK_MESH);
	};

	private processMeshQueueLoop = (): void => {
		this.insideMeshDrain = true;
		try {
			const start = performance.now();
			let iterCount = 0;
			let processed = 0;

			while (
				this.meshResultQueueReadIdx < this.meshResultQueue.length &&
				((iterCount++ & 15) !== 0 ||
					performance.now() - start < ChunkWorkerPool.MESH_DRAIN_BUDGET_MS)
			) {
				const data = this.meshResultQueue[this.meshResultQueueReadIdx];
				const workerIdx =
					this.meshResultWorkerIdx[this.meshResultQueueReadIdx] ?? 0;
				this.meshResultQueueReadIdx++;
				const { chunkId, lod, opaque, water, cutout } = data;
				const chunk = this.resolveChunkByMessageId(chunkId);

				if (!chunk) {
					// Dropped: buffers unreferenced — recycle them.
					this.debugStats.meshUnknownChunkDroppedTotal++;
					this._summaryDropped++;
					this.recycleMeshBuffers(workerIdx, data);
					processed++;
					continue;
				}

				if (data.meshRevision !== chunk.meshRevision) {
					this.debugStats.meshStaleDroppedTotal++;
					this._summaryDropped++;
					this.recycleMeshBuffers(workerIdx, data);
					chunk.isDirty = true;
					chunk.remeshQueued = false;
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0, false);
					processed++;
					continue;
				}

				if (shouldSkipLodForChunk(chunk, lod)) {
					this.debugStats.meshLodSkippedDroppedTotal++;
					this._summaryDropped++;
					this.recycleMeshBuffers(workerIdx, data);
					normalizeChunkLod(chunk);
					chunk.isDirty = true;
					chunk.remeshQueued = false;
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
					processed++;
					continue;
				}

				const opaqueData = opaque ?? null;
				const waterData = water ?? null;
				const cutoutData = cutout ?? null;
				const canCacheMesh =
					lod === 0 || hasStableVoxelNeighborsForCachedMesh(chunk);

				if (canCacheMesh) {
					_meshApplyScratch.opaque = opaqueData;
					_meshApplyScratch.water = waterData;
					_meshApplyScratch.cutout = cutoutData;
					chunk.setCachedLODMesh(lod, _meshApplyScratch);
				}

				if ((chunk.lodLevel ?? 0) === lod) {
					createMeshFromData(chunk, opaqueData, waterData, cutoutData);
					chunk.isDirty = false;
					chunk.remeshQueued = false;
					this.queuePostRemeshSave(chunk);
					this.debugStats.meshAppliedTotal++;
					this._summaryApplied++;
					this._summaryDistinct.add(chunkId);
				} else {
					if (!canCacheMesh) {
						_meshApplyScratch.opaque = opaqueData;
						_meshApplyScratch.water = waterData;
						_meshApplyScratch.cutout = cutoutData;
						chunk.setCachedLODMesh(lod, _meshApplyScratch);
					}

					chunk.isDirty = true;
					chunk.remeshQueued = false;
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
					this.debugStats.meshCachedForOtherLodTotal++;
				}

				processed++;
			}

			// Reentrant marks during the drain are covered by the
			// flushDirtyMergedGroups() below, so the guard must be clear
			// before the end-of-drain re-schedule and the flush.
			this.insideMeshDrain = false;

			this.debugStats.lastMeshProcessed = processed;
			this.debugStats.totalMeshProcessed += processed;
			this.debugStats.lastMeshDrainMs = performance.now() - start;

			if (
				this.meshResultQueueReadIdx > 64 &&
				this.meshResultQueueReadIdx * 2 > this.meshResultQueue.length
			) {
				this.meshResultQueue.copyWithin(0, this.meshResultQueueReadIdx);
				this.meshResultWorkerIdx.copyWithin(0, this.meshResultQueueReadIdx);
				this.meshResultQueue.length -= this.meshResultQueueReadIdx;
				this.meshResultWorkerIdx.length -= this.meshResultQueueReadIdx;
				this.meshResultQueueReadIdx = 0;
			}

			flushDirtyMergedGroups(
				Math.max(
					0.5,
					ChunkWorkerPool.MESH_DRAIN_BUDGET_MS - (performance.now() - start),
				),
			);

			if (this.meshResultQueueReadIdx < this.meshResultQueue.length) {
				this.scheduleMeshFlush();
			} else if (this._summaryApplied + this._summaryDropped >= 256) {
				/*
				// P0 burst summary: one line per ingestion burst so the
				// applied-per-chunk remesh multiplier and the recycled fraction
				// are visible without hooking a profiler. distinct < applied
				// means chunks are being re-meshed within the burst.
				console.info(
					`[MeshIngestion] burst: ${this._summaryApplied} applied ` +
						`(${this._summaryDistinct.size} distinct chunks), ` +
						`${this.debugStats.meshCachedForOtherLodTotal} cached-for-other-lod, ` +
						`${this._summaryDropped} dropped (recycled), ` +
						`${this.debugStats.meshRecycledBuffersTotal} buffers ` +
						`(${(this.debugStats.meshRecycledBytesTotal / 1048576).toFixed(1)} MB) returned to workers, ` +
						`remeshQueue=${this.debugStats.remeshQueueLength}`,
				);
				*/
				this._summaryApplied = 0;
				this._summaryDropped = 0;
				this._summaryDistinct.clear();
			}
		} finally {
			this.insideMeshDrain = false;
		}
	};

	// -------------------------------------------------------------------------
	// Mesh result queue enqueue — shared by the terrain-worker and mesh-worker
	// message handlers.
	//
	// Backpressure fix: when the queue is at MAX_MESH_QUEUE, we overwrite the
	// oldest unread slot (meshResultQueueReadIdx) with the new result but do
	// NOT advance meshResultQueueReadIdx. The previous version incremented the
	// read index after writing into it, which made the entry just written
	// look "already consumed" to the drain loop (which starts reading from
	// meshResultQueueReadIdx) — so under backpressure the *newest* mesh
	// result was the one silently dropped, and since chunk.remeshQueued had
	// already been cleared before dispatch, that chunk's mesh could go
	// missing with no retry. Leaving the read index alone means the slot we
	// just overwrote holds the newest result and is still unread, so the
	// oldest entry is the one discarded instead.
	// -------------------------------------------------------------------------
	private enqueueMeshResult(data: FullMeshMessage, workerIndex: number): void {
		const pending = this.meshResultQueue.length - this.meshResultQueueReadIdx;
		if (
			pending >= ChunkWorkerPool.MAX_MESH_QUEUE &&
			this.meshResultQueueReadIdx < this.meshResultQueue.length
		) {
			// Backpressure discard: the oldest unread result is being replaced —
			// its buffers are unreferenced, so recycle them.
			this.recycleMeshBuffers(
				workerIndex,
				this.meshResultQueue[this.meshResultQueueReadIdx],
			);
			this.meshResultQueue[this.meshResultQueueReadIdx] = data;
			this.meshResultWorkerIdx[this.meshResultQueueReadIdx] = workerIndex;
		} else {
			this.meshResultQueue.push(data);
			this.meshResultWorkerIdx.push(workerIndex);
		}
		if (!this.meshDrainScheduled) {
			this.meshDrainScheduled = true;
			this._scheduleCentralWork(ChunkWorkerPool.WORK_MESH);
		}
	}

	/**
	 * Transfer a dropped mesh result's output buffers back to the sending
	 * worker's voxel worker for reuse. ONLY safe for results that were never
	 * applied: applied results stay referenced by the chunk LOD caches and
	 * MergedMeshManager lastBuilt* pointers until their group rebuilds.
	 */
	private recycleMeshBuffers(workerIndex: number, data: FullMeshMessage): void {
		const scratch = this._recycleScratch;
		scratch.length = 0;

		const o = data.opaque;
		const w = data.water;
		const c = data.cutout;

		if (o) {
			pushRecyclableBuffer(scratch, o.faceDataA);
			pushRecyclableBuffer(scratch, o.faceDataB);
			pushRecyclableBuffer(scratch, o.faceDataC);
		}
		if (w) {
			pushRecyclableBuffer(scratch, w.faceDataA);
			pushRecyclableBuffer(scratch, w.faceDataB);
			pushRecyclableBuffer(scratch, w.faceDataC);
		}
		if (c) {
			pushRecyclableBuffer(scratch, c.faceDataA);
			pushRecyclableBuffer(scratch, c.faceDataB);
			pushRecyclableBuffer(scratch, c.faceDataC);
		}

		if (scratch.length === 0) return;

		let bytes = 0;
		for (let i = 0; i < scratch.length; i++) {
			bytes += scratch[i].byteLength;
		}
		this.debugStats.meshRecycledBuffersTotal += scratch.length;
		this.debugStats.meshRecycledBytesTotal += bytes;

		this.workers[workerIndex]?.postVoxelRecycleBuffers(scratch);
	}

	private queuePostRemeshSave(chunk: Chunk): void {
		if (chunk.isBoatChunk) return;
		if (this.deferredLightingQueuedIds.has(chunk.id)) return;

		this.pendingRemeshSaveIds.add(chunk.id);
		if (this.pendingRemeshSaveTimer !== null) return;

		this.pendingRemeshSaveTimer = setTimeout(() => {
			this.pendingRemeshSaveTimer = null;

			const chunksToSave: Chunk[] = [];
			for (const id of this.pendingRemeshSaveIds) {
				const chunk = Chunk.chunkInstances.get(id);
				if (chunk?.isLoaded && chunk.needsPersistence()) {
					chunksToSave.push(chunk);
				}
			}
			this.pendingRemeshSaveIds.clear();

			if (chunksToSave.length > 0) {
				void WorldStorage.saveChunks(chunksToSave).catch((error) => {
					console.error("Post-remesh chunk save failed:", error);
				});
			}
		}, this.REMESH_SAVE_DEBOUNCE_MS);
	}

	// -------------------------------------------------------------------------
	// Pool size resolution
	// -------------------------------------------------------------------------

	private static resolvePoolSize(explicitPoolSize?: number): number {
		const explicit =
			typeof explicitPoolSize === "number" ? explicitPoolSize | 0 : NaN;
		if (Number.isFinite(explicit) && explicit > 0) return explicit;

		const configured = SETTING_PARAMS.CHUNK_WORKER_POOL_SIZE | 0;
		if (Number.isFinite(configured) && configured > 0) return configured;

		// Each ChunkWorker spawns TWO workers (terrain/light + voxel-mesh), so
		// the effective worker count is 2x the ChunkWorker count. Reserve 2
		// cores for the main thread / render so we never starve the UI thread
		// (which also does mesh assembly, occlusion culling and game logic).
		const detected = Math.max(1, (navigator.hardwareConcurrency ?? 0) | 0);
		const workerBudget = Math.max(2, detected - 2);
		const chunkWorkerCount = Math.floor(workerBudget / 2);
		return Math.max(
			ChunkWorkerPool.MIN_AUTO_POOL_SIZE,
			Math.min(ChunkWorkerPool.MAX_AUTO_POOL_SIZE, chunkWorkerCount),
		);
	}

	public static getInstance(poolSize?: number): ChunkWorkerPool {
		if (!ChunkWorkerPool.instance) {
			const resolvedPoolSize = ChunkWorkerPool.resolvePoolSize(poolSize);
			const instance = new ChunkWorkerPool(resolvedPoolSize);
			ChunkWorkerPool.instance = instance;
			Chunk.onRequestRemesh = (chunk: Chunk, priority: boolean) => {
				// Chunk.scheduleRemesh already advanced meshRevision.
				instance.scheduleRemesh(chunk, priority, false);
			};
		}
		return ChunkWorkerPool.instance;
	}

	// -------------------------------------------------------------------------
	// Remesh scheduling
	// -------------------------------------------------------------------------

	public scheduleRemesh(
		chunk: Chunk | undefined,
		priority = false,
		bumpRevision = true,
	): void {
		if (!chunk?.isLoaded) return;
		if (bumpRevision) chunk.meshRevision++;
		normalizeChunkLod(chunk);
		if (!chunk.hasVoxelData) {
			if (!this.tryApplyCachedLODMesh(chunk, true)) {
				chunk.isDirty = true;
				chunk.remeshQueued = false;
			}
			return;
		}

		const inflight = this.isSameLodRemeshInflight(chunk);

		if (
			this.isCompletelyEmptyChunk(chunk) ||
			this.isUniformSolidMeshSkippable(chunk)
		) {
			if (inflight) {
				chunk.rerunRemeshAfterInflight = true;
			}
			this.pendingRemeshMap.delete(chunk);
			this.taskQueuePriority.delete(chunk);
			this.clearChunkMeshIfPresent(chunk);
			return;
		}

		if (inflight) {
			chunk.rerunRemeshAfterInflight = true;
			return;
		}

		const lodPriority = (chunk.lodLevel ?? 0) === 0;
		const existingPriority = this.pendingRemeshMap.get(chunk) ?? false;
		this.pendingRemeshMap.set(
			chunk,
			existingPriority || priority || lodPriority,
		);
		this.scheduleRemeshFlush();
	}

	private scheduleRemeshFlush(): void {
		if (this.remeshFlushScheduled) return;
		this.remeshFlushScheduled = true;
		this._scheduleCentralWork(ChunkWorkerPool.WORK_REMESH_FLUSH);
	}

	// -------------------------------------------------------------------------
	// Deferred neighbor-heal remeshes (P2 load-burst coalescing).
	//
	// Every generated chunk schedules remeshes for its 6 face-neighbors. In a
	// load burst, chunk C therefore got one FULL heal remesh per late-arriving
	// neighbor (up to 6 extra mesh builds per chunk) even though only the
	// last one matters. Heals requested within HEAL_REMESH_DEBOUNCE_MS of
	// each other now collapse into a single scheduleRemesh call per chunk.
	// One pooled timer total — no per-chunk timers.
	// -------------------------------------------------------------------------
	// 300ms covers the observed terrain-generation wave cadence (~230-450ms
	// between bursts) so heals from consecutive waves coalesce into one
	// rebuild instead of landing as a second full mesh per chunk.
	private static readonly HEAL_REMESH_DEBOUNCE_MS = 300;
	private deferredHealRemesh = new Map<Chunk, boolean>();
	private healFlushTimer: ReturnType<typeof setTimeout> | null = null;

	private scheduleDeferredNeighborHeal(chunk: Chunk, priority: boolean): void {
		const existing = this.deferredHealRemesh.get(chunk);
		this.deferredHealRemesh.set(chunk, (existing ?? false) || priority);

		if (this.healFlushTimer !== null) return;
		this.healFlushTimer = setTimeout(() => {
			this.healFlushTimer = null;
			if (this.deferredHealRemesh.size === 0) return;
			for (const [c, p] of this.deferredHealRemesh) {
				// scheduleRemesh re-validates liveness/emptiness/in-flight state;
				// the isLoaded check here just skips dead entries cheaply.
				if (c.isLoaded) this._boundScheduleRemesh(c, p);
			}
			this.deferredHealRemesh.clear();
		}, ChunkWorkerPool.HEAL_REMESH_DEBOUNCE_MS);
	}

	private flushPendingRemeshQueue(): void {
		if (this.pendingRemeshMap.size === 0) return;

		const pending = ChunkWorkerPool._flushPendingScratch;
		pending.length = 0;
		for (const entry of this.pendingRemeshMap) {
			pending.push(entry);
		}
		this.pendingRemeshMap.clear();

		// No pre-sort needed: insertChunkIntoRemeshQueue pushes into the heap,
		// which maintains order on its own regardless of insertion order.
		for (let i = 0; i < pending.length; i++) {
			const [chunk, priority] = pending[i];
			if (!chunk.isLoaded) continue;
			if (
				this.isCompletelyEmptyChunk(chunk) ||
				this.isUniformSolidMeshSkippable(chunk)
			) {
				this.clearChunkMeshIfPresent(chunk);
				continue;
			}
			this.insertChunkIntoRemeshQueue(chunk, priority);
		}

		this.processQueue();
	}

	// -------------------------------------------------------------------------
	// Distant terrain
	// -------------------------------------------------------------------------

	public scheduleDistantTerrain(
		centerChunkX: number,
		centerChunkZ: number,
		radius: number,
		renderDistance: number,
		gridStep: number,
	): void {
		const requestId = this.nextDistantTerrainRequestId++;
		const task = {
			requestId,
			centerChunkX,
			centerChunkZ,
			radius,
			renderDistance,
			gridStep,
		};
		if (this.distantTerrainInFlight) {
			this.distantTerrainTaskQueue.length = this.distantTerrainTaskQueueReadIdx;
			this.distantTerrainTaskQueue.push(task);
		} else {
			this.distantTerrainTaskQueue.length = 1;
			this.distantTerrainTaskQueueReadIdx = 0;
			this.distantTerrainTaskQueue[0] = task;
		}
		this.processQueue();
	}

	// -------------------------------------------------------------------------
	// Far tiles (LOD6+)
	// -------------------------------------------------------------------------

	private farTileQueue: {
		requestId: number;
		levelIndex: number;
		tileX: number;
		tileZ: number;
	}[] = [];
	private farTileQueueReadIdx = 0;
	private farTilesInFlightCount = 0;
	private nextFarTileRequestId = 1;
	private readonly maxFarTilesInFlight = 3;

	/** Callback fired on the main thread when a worker finishes a far tile. */
	public onFarTileGenerated: ((data: FarTileGeneratedMessage) => void) | null =
		null;

	public scheduleFarTile(
		levelIndex: number,
		tileX: number,
		tileZ: number,
	): number {
		const requestId = this.nextFarTileRequestId++;
		this.farTileQueue.push({ requestId, levelIndex, tileX, tileZ });
		this.processQueue();
		return requestId;
	}

	// -------------------------------------------------------------------------
	// Cached LOD mesh
	// -------------------------------------------------------------------------

	private tryApplyCachedLODMesh(
		chunk: Chunk,
		allowDirtyReuse = false,
	): boolean {
		if (!allowDirtyReuse && chunk.isDirty) return false;

		if (chunk.hasVoxelData && !hasStableVoxelNeighborsForCachedMesh(chunk)) {
			return false;
		}

		const cached = chunk.getCachedLODMesh(chunk.lodLevel);
		if (!cached?.opaque && !cached?.water && !cached?.cutout) return false;

		createMeshFromData(chunk, cached.opaque, cached.water, cached.cutout);
		chunk.isDirty = false;
		return true;
	}

	// -------------------------------------------------------------------------
	// Worker message handlers
	// -------------------------------------------------------------------------

	private makeTerrainMessageHandler(
		workerIndex: number,
		getWorker: () => ChunkWorker | undefined,
	) {
		return (event: MessageEvent<WorkerMessageData>) => {
			let failed = false;

			try {
				failed = this.handleTerrainMessageBody(workerIndex, event.data);
			} catch (messageError) {
				failed = true;
				console.error(
					`Chunk worker ${workerIndex} onmessage failed; respawning`,
					messageError,
				);
				this.handleWorkerFailure(workerIndex, messageError);
				return;
			}

			if (failed) return;
			if (this.workers[workerIndex] !== getWorker()) return;

			this.setWorkerTaskContext(workerIndex, null);
			this._markWorkerIdle(workerIndex);
			this.scheduleProcessQueuePump();
		};
	}

	private handleTerrainMessageBody(
		workerIndex: number,
		data: WorkerMessageData,
	): boolean {
		const failed = false;
		const type = data.type;

		if (type === WorkerTaskType.WorkerReady) {
			this.scheduleProcessQueuePump();
			return false;
		}

		if (type === WorkerTaskType.InitDistantTerrainShared) {
			this.distantTerrainReadyWorkers.add(workerIndex);
			this.processQueue();
			return false;
		}

		if (type === WorkerTaskType.LightDirty) {
			const dirty = data as LightDirtyMessage;
			this.lightDirtyQueue.push(
				ChunkWorkerPool.allocLightDirtyEntry(dirty.seq, dirty.dirtySlots),
			);
			this.scheduleLightDirtyPump();
			return false;
		}

		if (type === WorkerTaskType.GenerateFullMesh) {
			const meshData = data as FullMeshMessage;
			this.clearInflightRemeshByMessage(meshData.chunkId, meshData.lod);
			this.enqueueMeshResult(meshData, workerIndex);

			const resolvedChunk = this.resolveChunkByMessageId(meshData.chunkId);
			if (resolvedChunk) {
				this.recordBlockRevisionAtMesh(resolvedChunk, meshData.lod);
			}
			if (resolvedChunk?.rerunRemeshAfterInflight) {
				resolvedChunk.rerunRemeshAfterInflight = false;
				this.scheduleRemesh(
					resolvedChunk,
					(resolvedChunk.lodLevel ?? 0) === 0,
					false,
				);
			}
		} else if (type === WorkerTaskType.GenerateTerrain) {
			const terrainData = data as TerrainGeneratedMessage;
			const {
				chunkId,
				block_array,
				light_array,
				isUniform,
				uniformBlockId,
				palette,
				lightSeedQueue,
				lightSeedLength,
			} = terrainData;

			const chunk = this.resolveChunkByMessageId(chunkId);
			if (chunk) {
				const isStale = !chunk.isTerrainScheduled && !chunk.isLoaded;
				this.debugLightSeedLengths.set(
					chunk.id,
					lightSeedLength !== undefined ? lightSeedLength : -1,
				);
				const blocks: Uint8Array | Uint16Array | null = block_array ?? null;
				const light: Uint8Array = light_array;

				let typedPalette: Uint16Array | null =
					palette instanceof Uint16Array ? palette : null;

				if (
					typedPalette &&
					!(typedPalette.buffer instanceof SharedArrayBuffer)
				) {
					const shared = new SharedArrayBuffer(typedPalette.byteLength);
					new Uint16Array(shared).set(typedPalette);
					typedPalette = new Uint16Array(shared);
				}

				chunk.loadFromStorage(
					blocks,
					typedPalette,
					isUniform,
					uniformBlockId,
					light,
					false,
				);
				chunk.isTerrainScheduled = false;
				chunk.isLoaded = true;
				chunk.isModified = true;

				const needsLightRefinement =
					lightSeedQueue !== undefined &&
					lightSeedLength !== undefined &&
					lightSeedLength > 0;

				if (isStale) {
					this.setWorkerTaskContext(workerIndex, null);
					this._markWorkerIdle(workerIndex);
					if (needsLightRefinement) {
						scheduleChunkAndNeighborsRemesh(
							chunk,
							this._boundScheduleRemesh,
							this._boundScheduleHealRemesh,
						);
						this.enqueueDeferredLightingRefinement(
							chunk,
							lightSeedQueue as Uint16Array,
							lightSeedLength as number,
						);
					} else {
						void WorldStorage.saveChunk(chunk).catch((error) => {
							console.error(
								"Initial generated chunk persistence failed:",
								error,
							);
						});
					}
					this.scheduleProcessQueuePump();
					return false;
				}

				scheduleChunkAndNeighborsRemesh(
					chunk,
					this._boundScheduleRemesh,
					this._boundScheduleHealRemesh,
				);
				maybeRemeshNeighborsNowStable(
					chunk,
					this._boundScheduleRemesh,
					this._boundScheduleHealRemesh,
				);

				if (needsLightRefinement) {
					this.enqueueDeferredLightingRefinement(
						chunk,
						lightSeedQueue as Uint16Array,
						lightSeedLength as number,
					);
				} else {
					void WorldStorage.saveChunk(chunk).catch((error) => {
						console.error("Initial generated chunk persistence failed:", error);
					});
				}
			}
		} else if (type === WorkerTaskType.GenerateDistantTerrain_Generated) {
			this.onDistantTerrainGenerated?.(data as DistantTerrainGeneratedMessage);
			this.distantTerrainInFlight = false;
		} else if (type === WorkerTaskType.GenerateFarTile) {
			this.farTilesInFlightCount = Math.max(0, this.farTilesInFlightCount - 1);
			this.onFarTileGenerated?.(data as FarTileGeneratedMessage);
		}

		return failed;
	}

	private makeMeshMessageHandler(
		workerIndex: number,
		getWorker: () => ChunkWorker | undefined,
	) {
		return (event: MessageEvent<MeshWorkerResponse>) => {
			let failed = false;
			const data = event.data as MeshWorkerResponse & { type?: string };

			try {
				failed = this.handleMeshMessageBody(workerIndex, data);
			} catch (messageError) {
				failed = true;
				console.error(
					`Chunk worker ${workerIndex} mesh onmessage failed; respawning`,
					messageError,
				);
				this.handleWorkerFailure(workerIndex, messageError);
				return;
			}

			if (failed) return;
			if (this.workers[workerIndex] !== getWorker()) return;

			this.setWorkerTaskContext(workerIndex, null);
			this._markWorkerIdle(workerIndex);
			this.scheduleProcessQueuePump();
		};
	}

	private handleMeshMessageBody(
		workerIndex: number,
		data: MeshWorkerResponse & { type?: string },
	): boolean {
		const failed = false;
		const type = data.type as string | undefined;

		if (type === (WorkerTaskType.WorkerReady as unknown as string)) {
			return failed;
		}

		if (type === ("HEARTBEAT" as string)) {
			const seq = (data as unknown as { seq?: number }).seq ?? 0;
			this._lastHeartbeatSeq[workerIndex] = seq;
			return failed;
		}

		if (type === (WorkerTaskType.RelightMesh as unknown as string)) {
			// Relight cache miss in the worker: fall back to a full remesh.
			const miss = data as unknown as RelightMeshMissMessage;
			this.clearInflightRemeshByMessage(miss.chunkId, miss.lod);
			const missChunk = this.resolveChunkByMessageId(miss.chunkId);
			if (missChunk?.isLoaded) {
				this.scheduleRemesh(missChunk, (missChunk.lodLevel ?? 0) === 0, false);
			}
			return failed;
		}

		if (type !== (WorkerTaskType.GenerateFullMesh as unknown as string)) {
			console.warn(
				`Ignoring unexpected mesh worker message from ${workerIndex}:`,
				data,
			);
			return failed;
		}

		this.clearInflightRemeshByMessage(data.chunkId, data.lod);

		const fullMeshMessage = data as unknown as FullMeshMessage;
		this.enqueueMeshResult(fullMeshMessage, workerIndex);

		const resolvedChunk = this.resolveChunkByMessageId(data.chunkId);
		if (resolvedChunk) {
			this.recordBlockRevisionAtMesh(resolvedChunk, data.lod);
		}
		if (resolvedChunk?.rerunRemeshAfterInflight) {
			resolvedChunk.rerunRemeshAfterInflight = false;
			this.scheduleRemesh(
				resolvedChunk,
				(resolvedChunk.lodLevel ?? 0) === 0,
				false,
			);
		}

		return failed;
	}

	// -------------------------------------------------------------------------
	// Priority comparator
	// -------------------------------------------------------------------------

	private compareRemeshPriority(
		aChunk: Chunk,
		aPriority: boolean,
		bChunk: Chunk,
		bPriority: boolean,
	): number {
		if (aPriority !== bPriority) return aPriority ? -1 : 1;
		const aLod = aChunk.lodLevel ?? 0;
		const bLod = bChunk.lodLevel ?? 0;
		if (aLod !== bLod) return aLod - bLod;
		if (aChunk.isModified !== bChunk.isModified)
			return aChunk.isModified ? -1 : 1;
		return 0;
	}

	// -------------------------------------------------------------------------
	// Queue dequeue helpers
	// -------------------------------------------------------------------------

	private dequeueNextTerrainChunk(): Chunk | undefined {
		for (const chunk of this.terrainTaskQueue) {
			this.terrainTaskQueue.delete(chunk);
			return chunk;
		}
		return undefined;
	}

	// -------------------------------------------------------------------------
	// taskHeap: binary min-heap over compareRemeshPriority.
	//
	// Replaces the old "binary-search the insertion point, then splice" queue.
	// The binary search made lookup O(log n), but Array.splice still has to
	// shift every element after the insertion point, so a batch of N inserts
	// (e.g. a large terrain edit dirtying hundreds of chunks in one frame) was
	// still O(n) each / O(n^2) overall. Heap push/pop/remove are all O(log n),
	// so the same batch is O(n log n) worst case.
	//
	// taskHeapPositions mirrors each chunk's current array index so
	// heapRemove (used by priority upgrades and chunk disposal) doesn't need
	// a linear scan to find it.
	// -------------------------------------------------------------------------

	private heapSwap(i: number, j: number): void {
		const a = this.taskHeap[i];
		const b = this.taskHeap[j];
		this.taskHeap[i] = b;
		this.taskHeap[j] = a;
		this.taskHeapPositions.set(b, i);
		this.taskHeapPositions.set(a, j);
	}

	private heapLess(i: number, j: number): boolean {
		const a = this.taskHeap[i];
		const b = this.taskHeap[j];
		const aPriority = this.taskQueuePriority.get(a) ?? false;
		const bPriority = this.taskQueuePriority.get(b) ?? false;
		return this.compareRemeshPriority(a, aPriority, b, bPriority) < 0;
	}

	private heapSiftUp(i: number): void {
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (!this.heapLess(i, parent)) break;
			this.heapSwap(i, parent);
			i = parent;
		}
	}

	private heapSiftDown(i: number): void {
		const n = this.taskHeap.length;
		while (true) {
			const left = i * 2 + 1;
			const right = left + 1;
			let smallest = i;
			if (left < n && this.heapLess(left, smallest)) smallest = left;
			if (right < n && this.heapLess(right, smallest)) smallest = right;
			if (smallest === i) break;
			this.heapSwap(i, smallest);
			i = smallest;
		}
	}

	private heapPush(chunk: Chunk): void {
		const idx = this.taskHeap.length;
		this.taskHeap.push(chunk);
		this.taskHeapPositions.set(chunk, idx);
		this.heapSiftUp(idx);
	}

	private heapPop(): Chunk | undefined {
		const n = this.taskHeap.length;
		if (n === 0) return undefined;
		const top = this.taskHeap[0];
		this.taskHeapPositions.delete(top);
		const last = this.taskHeap.pop()!;
		if (n > 1) {
			this.taskHeap[0] = last;
			this.taskHeapPositions.set(last, 0);
			this.heapSiftDown(0);
		}
		return top;
	}

	// O(log n) removal of an arbitrary chunk (used by chunk disposal so a
	// disposed chunk's reference is dropped immediately instead of lingering
	// as a tombstone until it's naturally dequeued).
	private heapRemove(chunk: Chunk): void {
		const idx = this.taskHeapPositions.get(chunk);
		if (idx === undefined) return;
		this.taskHeapPositions.delete(chunk);
		const last = this.taskHeap.pop()!;
		if (idx < this.taskHeap.length) {
			this.taskHeap[idx] = last;
			this.taskHeapPositions.set(last, idx);
			// The replacement could violate the heap property in either
			// direction relative to its new position, so try both.
			this.heapSiftDown(idx);
			this.heapSiftUp(idx);
		}
	}

	private insertChunkIntoRemeshQueue(chunk: Chunk, priority: boolean): void {
		const existingPriority = this.taskQueuePriority.get(chunk);
		if (existingPriority !== undefined) {
			if (priority && !existingPriority) {
				this.taskQueuePriority.set(chunk, true);
				const idx = this.taskHeapPositions.get(chunk);
				// Priority went false -> true, which can only move the chunk
				// closer to the root, so sift-up alone suffices.
				if (idx !== undefined) this.heapSiftUp(idx);
			}
			return;
		}

		this.taskQueuePriority.set(chunk, priority);
		this.heapPush(chunk);
	}

	// -------------------------------------------------------------------------
	// Terrain scheduling
	// -------------------------------------------------------------------------

	public scheduleTerrainGeneration(chunk: Chunk, deferLighting = true): void {
		if (!chunk) return;
		if (this.remoteGenerationEnabled && this.remoteChunkProvider) {
			this.enqueueRemoteGeneration(chunk, deferLighting);
			return;
		}
		// Multiplayer: the server owns terrain. Until the connection (and thus
		// the remote provider) is live, hold the request instead of generating
		// it locally — local gen here is pure waste that gets discarded anyway.
		if (this.expectingRemoteProvider) {
			this.deferChunkForRemote(chunk);
			return;
		}
		this.queueLocalTerrainGeneration(chunk, deferLighting);
	}

	/**
	 * Queue a chunk for LOCAL terrain generation even while remote mode is
	 * active. Used as a fallback when the server confirms a chunk unchanged
	 * at version 0 (untouched) and the client has no local copy — the
	 * deterministic generator produces identical terrain to the server's
	 * for untouched chunks (the seed is synced on join).
	 */
	private queueLocalTerrainGeneration(
		chunk: Chunk,
		deferLighting = true,
	): void {
		this.terrainTaskQueue.add(chunk);
		const existing = this.terrainTaskDeferLighting.get(chunk.id);
		if (existing === undefined) {
			this.terrainTaskDeferLighting.set(chunk.id, deferLighting);
		} else if (existing && !deferLighting) {
			this.terrainTaskDeferLighting.set(chunk.id, false);
		}
		chunk.isTerrainScheduled = true;
		this.scheduleProcessQueuePump();
	}

	public scheduleTerrainGenerationBatch(
		chunks: readonly Chunk[],
		deferLighting = true,
	): void {
		if (chunks.length > 0) {
			// console.log(`[scheduleTerrainGenerationBatch] ${chunks.length} chunks, remote=${this.remoteGenerationEnabled && !!this.remoteChunkProvider}`);
		}
		if (this.remoteGenerationEnabled && this.remoteChunkProvider) {
			for (let i = 0; i < chunks.length; i++) {
				this.enqueueRemoteGeneration(chunks[i], deferLighting);
			}
			this.pumpRemoteGeneration();
			return;
		}
		// Multiplayer: defer instead of generating locally (see scheduleTerrainGeneration).
		if (this.expectingRemoteProvider) {
			for (let i = 0; i < chunks.length; i++) {
				this.deferChunkForRemote(chunks[i]);
			}
			return;
		}
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			this.terrainTaskQueue.add(chunk);
			const existing = this.terrainTaskDeferLighting.get(chunk.id);
			if (existing === undefined) {
				this.terrainTaskDeferLighting.set(chunk.id, deferLighting);
			} else if (existing && !deferLighting) {
				this.terrainTaskDeferLighting.set(chunk.id, false);
			}
			chunk.isTerrainScheduled = true;
		}
		this.scheduleProcessQueuePump();
	}

	/**
	 * In remote (multiplayer) mode, a chunk's voxel data comes from the server,
	 * NOT from a local terrain worker. Enqueue it for a server request without
	 * touching the worker terrain queue, so server-routed work can never starve
	 * the worker remesh queue (the local mesh workers build meshes normally).
	 */
	private enqueueRemoteGeneration(chunk: Chunk, _deferLighting = true): void {
		if (!chunk || chunk.isBoatChunk) return;

		const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);

		if (
			this.remotePendingChunks.has(key) ||
			this.remoteTaskQueueSet.has(chunk)
		) {
			return;
		}

		this.remoteTaskQueue.push(chunk);
		this.remoteTaskQueueSet.add(chunk);
		chunk.isTerrainScheduled = true;
	}

	/**
	 * Hold a chunk request until the server connection is live. Used in
	 * multiplayer before `remoteChunkProvider` is set, so we never fall back to
	 * local terrain generation for chunks the server will provide.
	 */
	private deferChunkForRemote(chunk: Chunk): void {
		if (!chunk || chunk.isBoatChunk) return;
		this.remoteDeferredChunks.add(chunk);
		chunk.isTerrainScheduled = true;
	}

	/** Enter multiplayer mode: defer chunk requests until the server connects. */
	public enableRemoteMode(): void {
		this.expectingRemoteProvider = true;
	}

	/** Leave multiplayer mode (e.g. join failed): allow local generation again. */
	public disableRemoteMode(): void {
		this.expectingRemoteProvider = false;
		// The scheduler skips chunks already flagged isTerrainScheduled, so
		// clear it here; otherwise deferred chunks would never fall back to
		// local generation after a failed join.
		for (const chunk of this.remoteDeferredChunks) {
			chunk.isTerrainScheduled = false;
		}
		this.remoteDeferredChunks.clear();
	}

	public hasRemoteChunksQueued(): boolean {
		return this.remoteTaskQueue.length > 0;
	}

	public pumpRemoteGeneration(): void {
		if (!this.remoteChunkProvider) return;
		if (this.remotePumpScheduled) return;

		// Backpressure: when too many requests are outstanding, wait for
		// responses instead of firing more batches. This prevents the
		// pending map from growing to 15k+ entries and timing out en masse.
		const outstanding = this.remotePendingChunks.size;
		if (outstanding >= this.MAX_OUTSTANDING_REMOTE) {
			if (!this.remoteBackpressureTimer) {
				this.remoteBackpressureTimer = setTimeout(() => {
					this.remoteBackpressureTimer = null;
					this.remotePumpScheduled = false;
					this.pumpRemoteGeneration();
				}, 100);
			}
			return;
		}

		this.remotePumpScheduled = true;

		const toCheck = this.selectColumnBatch(this.MAX_REMOTE_CONCURRENT);

		if (toCheck.length === 0) {
			this.remotePumpScheduled = false;
			return;
		}

		this.remoteChunkProvider
			.getCachedChunks(toCheck)
			.then((hits) => this.finishRemotePumpCycle(hits, toCheck))
			.catch(() => this.finishRemotePumpCycle(null, toCheck));
	}

	/**
	 * Select up to maxCount chunks from the remote queue, prioritizing chunks
	 * from the same vertical column (same chunkX, chunkZ) as the first chunk.
	 * This aligns client request batches with server generation batching so
	 * workers can reuse column-level noise/state across Y-levels.
	 */
	private selectColumnBatch(maxCount: number): Chunk[] {
		const queue = this.remoteTaskQueue;
		const queueSet = this.remoteTaskQueueSet;
		const pending = this.remotePendingChunks;
		const result: Chunk[] = [];

		const len = queue.length;
		if (len === 0 || maxCount <= 0) return result;

		let anchor: Chunk | null = null;
		let anchorX = 0;
		let anchorZ = 0;

		// Find first valid anchor without shifting the array.
		let firstValidIndex = -1;
		for (let i = 0; i < len; i++) {
			const chunk = queue[i];
			if (chunk.isBoatChunk) continue;

			const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
			if (pending.has(key)) continue;

			anchor = chunk;
			anchorX = chunk.chunkX;
			anchorZ = chunk.chunkZ;
			firstValidIndex = i;
			break;
		}

		if (anchor === null) {
			// Everything currently queued is invalid or already pending.
			for (let i = 0; i < len; i++) {
				queueSet.delete(queue[i]);
			}
			queue.length = 0;
			return result;
		}

		const selected = ChunkWorkerPool._dedupScratch;
		selected.clear();

		result.push(anchor);
		selected.add(anchor.numericId);

		// First pass: same-column chunks.
		for (
			let i = firstValidIndex + 1;
			i < len && result.length < maxCount;
			i++
		) {
			const chunk = queue[i];

			if (
				chunk.isBoatChunk ||
				chunk.chunkX !== anchorX ||
				chunk.chunkZ !== anchorZ
			) {
				continue;
			}

			const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
			if (pending.has(key)) continue;

			result.push(chunk);
			selected.add(chunk.numericId);
		}

		// Second pass: FIFO fill.
		for (let i = 0; i < len && result.length < maxCount; i++) {
			const chunk = queue[i];

			if (selected.has(chunk.numericId) || chunk.isBoatChunk) {
				continue;
			}

			const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
			if (pending.has(key)) continue;

			result.push(chunk);
			selected.add(chunk.numericId);
		}

		// Compact queue in one pass, removing selected chunks, boat chunks, and
		// chunks already pending remotely.
		let write = 0;

		for (let i = 0; i < len; i++) {
			const chunk = queue[i];

			if (selected.has(chunk.numericId) || chunk.isBoatChunk) {
				queueSet.delete(chunk);
				continue;
			}

			const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
			if (pending.has(key)) {
				queueSet.delete(chunk);
				continue;
			}

			queue[write++] = chunk;
		}

		queue.length = write;
		selected.clear();

		return result;
	}

	private finishRemotePumpCycle(
		hits: Map<Chunk, RemoteChunkData | null> | null,
		toCheck: Chunk[],
	): void {
		this.remotePumpScheduled = false;

		const toRequest: Chunk[] = [];

		for (let i = 0, len = toCheck.length; i < len; i++) {
			const chunk = toCheck[i];

			if (chunk.isBoatChunk) {
				chunk.isTerrainScheduled = false;
				continue;
			}

			// Cached and uncached chunks both need a server request:
			// cached chunks validate version, misses fetch full data.
			chunk.isTerrainScheduled = true;
			toRequest.push(chunk);

			// Keep the lookup for side effects and future-proofing if caller
			// changes behavior, but avoid branch duplication.
			if (hits) {
				hits.get(chunk);
			}
		}

		this.dispatchRemoteRequests(toRequest);
		this.scheduleRemotePumpContinuation();
	}

	/**
	 * Defer the next drain to a macrotask via MessageChannel (see
	 * Lib/yieldToEventLoop.ts). This has ~0ms delay (no setTimeout(0) clamp)
	 * BUT, crucially, it re-arms through a macrotask rather than a
	 * microtask. The previous implementation re-armed via `queueMicrotask`
	 * for 31/32 continuations, which let the pump chain spin entirely inside
	 * the microtask queue — `Run microtasks` would dominate a frame and
	 * starve rendering/input. Yielding to a macrotask lets the event loop
	 * breathe once per pump cycle.
	 */
	private scheduleRemotePumpContinuation(): void {
		if (this.remoteTaskQueue.length === 0) return;
		if (this.remotePumpScheduled) return;

		this.remotePumpScheduled = true;

		void yieldToEventLoop().then(() => {
			this.remotePumpScheduled = false;
			this.pumpRemoteGeneration();
		});
	}

	private dispatchRemoteRequests(toRequest: Chunk[]): void {
		const provider = this.remoteChunkProvider;
		const len = toRequest.length;

		if (len === 0 || !provider) return;

		const pending = this.remotePendingChunks;

		if (len === 1) {
			const chunk = toRequest[0];

			if (
				!chunk ||
				chunk.isBoatChunk ||
				getChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ) !== chunk
			) {
				return;
			}

			const key = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
			pending.set(key, chunk);

			void provider
				.requestChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ)
				.then((data) => this.handleRemoteChunkData(data))
				.catch((err) => this.handleRemoteGenError(err, chunk, key));

			return;
		}

		const coords: Array<{ cx: number; cy: number; cz: number }> = [];
		const chunks: Chunk[] = [];
		const keys: bigint[] = [];

		for (let i = 0; i < len; i++) {
			const chunk = toRequest[i];

			if (
				!chunk ||
				chunk.isBoatChunk ||
				getChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ) !== chunk
			) {
				continue;
			}

			const cx = chunk.chunkX;
			const cy = chunk.chunkY;
			const cz = chunk.chunkZ;
			const key = packCoords(cx, cy, cz);

			pending.set(key, chunk);
			chunks.push(chunk);
			keys.push(key);
			coords.push({ cx, cy, cz });
		}

		if (coords.length === 0) return;

		const promises = provider.requestChunkBatch(coords);

		for (let i = 0, count = promises.length; i < count; i++) {
			const chunk = chunks[i];
			const key = keys[i];

			void promises[i]
				.then((data) => this.handleRemoteChunkData(data))
				.catch((err) => this.handleRemoteGenError(err, chunk, key));
		}
	}

	private handleRemoteGenError(err: Error, chunk: Chunk, key: bigint): void {
		this.remotePendingChunks.delete(key);

		const live = getChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ);

		if (live !== chunk || chunk.isBoatChunk) {
			this.remoteRetryCount.delete(key);
			chunk.isTerrainScheduled = false;
			this.pumpRemoteGeneration();
			return;
		}

		chunk.isTerrainScheduled = false;

		const retries = (this.remoteRetryCount.get(key) ?? 0) + 1;
		this.remoteRetryCount.set(key, retries);

		if (retries >= this.MAX_REMOTE_RETRY) {
			console.error(
				`[RemoteGen] GIVING UP on ${key} after ${retries} attempts:`,
				err,
			);
			this.remoteRetryCount.delete(key);
			this.pumpRemoteGeneration();
			return;
		}

		console.warn(
			`[RemoteGen] request FAILED ${key} (attempt ${retries}/${this.MAX_REMOTE_RETRY}):`,
			err,
		);

		if (
			!chunk.isLoaded &&
			!this.remotePendingChunks.has(key) &&
			!this.remoteTaskQueueSet.has(chunk)
		) {
			this.remoteTaskQueue.push(chunk);
			this.remoteTaskQueueSet.add(chunk);
			chunk.isTerrainScheduled = true;
		}

		this.pumpRemoteGeneration();
	}

	private getQueuedTerrainDeferLighting(chunk: Chunk): boolean {
		return this.terrainTaskDeferLighting.get(chunk.id) ?? true;
	}

	private dispatchTerrainTaskToWorker(
		workerIndex: number,
		worker: ChunkWorker,
		chunk: Chunk,
	): boolean {
		if (!chunk) return false;
		const deferLighting = this.getQueuedTerrainDeferLighting(chunk);

		this.terrainTaskQueue.delete(chunk);
		this.terrainTaskDeferLighting.delete(chunk.id);
		this.setWorkerTaskContext(workerIndex, {
			taskType: TaskType.Terrain,
			chunk,
			terrainDeferLighting: deferLighting,
		});
		chunk.isTerrainScheduled = true;
		worker.postTerrainGeneration(chunk, deferLighting);
		return true;
	}

	/**
	 * Re-seed all workers and the local height sampler from a new seed.
	 * Used when the server sends its authoritative seed on join so the
	 * clip map matches server terrain.
	 */
	public setWorldSeed(seed: string): void {
		for (const worker of this.workers) {
			worker.setWorldSeed(seed);
		}
	}

	/**
	 * Enable server-side terrain generation (multiplayer mode).
	 * Any chunks already loaded (generated locally or hydrated from the local
	 * save before multiplayer mode was enabled) are re-enqueued so the server's
	 * authoritative data replaces whatever terrain the client built locally.
	 */
	public setRemoteChunkProvider(provider: RemoteChunkProvider | null): void {
		this.remoteChunkProvider = provider;
		this.remoteGenerationEnabled = provider !== null;
		this.expectingRemoteProvider = provider !== null;

		if (provider) {
			let flushed = 0;

			for (const chunk of this.remoteDeferredChunks) {
				this.enqueueRemoteGeneration(chunk);
				flushed++;
			}

			this.remoteDeferredChunks.clear();

			let requeued = 0;

			for (const chunk of Chunk.chunkInstances.values()) {
				if (chunk.isBoatChunk) continue;
				if (!chunk.isLoaded && !chunk.hasVoxelData) continue;

				this.enqueueRemoteGeneration(chunk);
				requeued++;
			}

			if (flushed > 0 || requeued > 0) {
				this.pumpRemoteGeneration();
			}

			console.log(
				`[RemoteGen] setRemoteChunkProvider enabled=true (requeued ${requeued} loaded chunks, flushed ${flushed} deferred)`,
			);

			return;
		}

		// Remote mode disabled. Drop all remote-only references so old chunks,
		// promises and retry state do not keep memory alive.
		this.remoteDeferredChunks.clear();
		this.remoteTaskQueue.length = 0;
		this.remoteTaskQueueSet.clear();
		this.remotePendingChunks.clear();
		this.remoteRetryCount.clear();
		this.remoteNoBlobRetries.clear();
		this.pendingRemoteChunks.clear();
		this.remotePumpScheduled = false;
		this.pendingRemeshScheduled = false;

		if (this.remoteBackpressureTimer !== null) {
			clearTimeout(this.remoteBackpressureTimer);
			this.remoteBackpressureTimer = null;
		}

		console.log(`[RemoteGen] setRemoteChunkProvider enabled=false`);
	}

	/**
	 * Handle chunk data received from the server. The result is a
	 * discriminated union: "data" carries the voxel payload, "unchanged" is
	 * a pure confirmation stamp (no payload fields).
	 */
	private handleRemoteChunkData(result: RemoteChunkResult): void {
		const key = packCoords(result.chunkX, result.chunkY, result.chunkZ);
		const captured = this.remotePendingChunks.get(key) ?? null;

		this.remotePendingChunks.delete(key);
		this.remoteRetryCount.delete(key);

		// Apply the data to the CURRENT live chunk at these coordinates, not the
		// instance captured when the request was dispatched.
		const liveChunk = getChunk(result.chunkX, result.chunkY, result.chunkZ);
		const target = liveChunk ?? captured;

		if (!target || target.isBoatChunk) {
			this.pumpRemoteGeneration();
			return;
		}

		const chunk = target;

		switch (result.kind) {
			case ChunkResultKind.Data: {
				this.remoteNoBlobRetries.delete(key);

				// Pass raw encoded blocks directly to loadFromStorage.
				// loadFromStorage handles uniform, palette, dense u8 and dense u16.
				chunk.loadFromStorage(
					result.blocks,
					result.palette ?? null,
					result.isUniform,
					result.uniformBlockId,
					result.light,
					false,
				);

				chunk.isModified = true;

				this.queueRemoteChunkRemesh(chunk);
				this.pumpRemoteGeneration();
				return;
			}

			case ChunkResultKind.Unchanged: {
				if (chunk.hasVoxelData) {
					chunk.isLoaded = true;
					chunk.isModified = true;

					this.broadcastLightRegister(chunk);
					this.broadcastVoxelRegister(chunk);
					this.queueRemoteChunkRemesh(chunk);
					this.pumpRemoteGeneration();
					return;
				}

				const provider = this.remoteChunkProvider;

				if (!provider) {
					this.pumpRemoteGeneration();
					return;
				}

				void provider
					.getCachedChunk(chunk.chunkX, chunk.chunkY, chunk.chunkZ)
					.then((cached) => {
						if (cached) {
							chunk.loadFromStorage(
								cached.blocks,
								cached.palette ?? null,
								cached.isUniform,
								cached.uniformBlockId,
								cached.light,
								false,
							);

							chunk.isModified = true;
							this.remoteNoBlobRetries.delete(key);

							this.queueRemoteChunkRemesh(chunk);
							return;
						}

						const retries = this.remoteNoBlobRetries.get(key) ?? 0;

						if (result.version === 0) {
							this.remoteNoBlobRetries.delete(key);
							this.queueLocalTerrainGeneration(chunk);
							return;
						}

						if (retries < 1) {
							this.remoteNoBlobRetries.set(key, retries + 1);

							if (
								!this.remotePendingChunks.has(key) &&
								!this.remoteTaskQueueSet.has(chunk)
							) {
								this.remoteTaskQueue.unshift(chunk);
								this.remoteTaskQueueSet.add(chunk);
								chunk.isTerrainScheduled = true;
							}

							return;
						}

						this.remoteNoBlobRetries.delete(key);
						this.queueLocalTerrainGeneration(chunk);
					})
					.catch(() => {
						chunk.isLoaded = true;
					})
					.finally(() => {
						this.pumpRemoteGeneration();
					});

				return;
			}

			default:
				assertNever(result);
		}
	}

	/**
	 * Flush all pending remote chunks: schedule remesh for each chunk + deduped
	 * neighbors in a single pass. Called once per frame via requestAnimationFrame
	 * instead of per-chunk, reducing O(7N) remesh calls to O(N) unique chunks.
	 */
	private flushPendingRemoteChunkRemesh(): void {
		this.pendingRemeshScheduled = false;

		const pending = this.pendingRemoteChunks;
		if (pending.size === 0) return;

		const chunks = ChunkWorkerPool._queryScratch;
		const seen = ChunkWorkerPool._dedupScratch;

		chunks.length = 0;
		seen.clear();

		for (const chunk of pending) {
			chunks.push(chunk);
		}

		pending.clear();

		for (let i = 0, len = chunks.length; i < len; i++) {
			const chunk = chunks[i];

			if (!chunk.isLoaded && !chunk.hasVoxelData) {
				continue;
			}

			if (!seen.has(chunk.numericId)) {
				seen.add(chunk.numericId);
				chunk.scheduleRemesh(true, true);
			}

			let n = chunk.getNeighbor(-1, 0, 0);
			if (n && !seen.has(n.numericId)) {
				seen.add(n.numericId);
				n.scheduleRemesh(true, n.lodLevel === 0);
			}

			n = chunk.getNeighbor(0, 0, -1);
			if (n && !seen.has(n.numericId)) {
				seen.add(n.numericId);
				n.scheduleRemesh(true, n.lodLevel === 0);
			}

			n = chunk.getNeighbor(0, -1, 0);
			if (n && !seen.has(n.numericId)) {
				seen.add(n.numericId);
				n.scheduleRemesh(true, n.lodLevel === 0);
			}

			n = chunk.getNeighbor(1, 0, 0);
			if (n && !seen.has(n.numericId)) {
				seen.add(n.numericId);
				n.scheduleRemesh(true, n.lodLevel === 0);
			}

			n = chunk.getNeighbor(0, 0, 1);
			if (n && !seen.has(n.numericId)) {
				seen.add(n.numericId);
				n.scheduleRemesh(true, n.lodLevel === 0);
			}

			n = chunk.getNeighbor(0, 1, 0);
			if (n && !seen.has(n.numericId)) {
				seen.add(n.numericId);
				n.scheduleRemesh(true, n.lodLevel === 0);
			}
		}

		chunks.length = 0;
		seen.clear();

		this.scheduleProcessQueuePump();
	}

	/**
	 * Add a remote chunk to the pending remesh batch. If this is the first
	 * chunk added this frame, schedule a single flush via requestAnimationFrame.
	 */
	private queueRemoteChunkRemesh(chunk: Chunk): void {
		this.pendingRemoteChunks.add(chunk);
		if (!this.pendingRemeshScheduled) {
			this.pendingRemeshScheduled = true;
			requestAnimationFrame(() => this.flushPendingRemoteChunkRemesh());
		}
	}

	// -------------------------------------------------------------------------
	// Background LOD precompute scheduling
	// -------------------------------------------------------------------------

	public scheduleBackgroundLodPrecompute(
		centerChunkX: number,
		centerChunkY: number,
		centerChunkZ: number,
	): void {
		const now = performance.now();
		const throttleMs = Math.max(
			0,
			SETTING_PARAMS.LOD_PRECOMPUTE_SCHEDULE_THROTTLE_MS | 0,
		);

		if (throttleMs > 0 && now - this.lastPrecomputeScheduleTs < throttleMs) {
			return;
		}

		this.lastPrecomputeScheduleTs = now;

		const horizontalRadius =
			SETTING_PARAMS.RENDER_DISTANCE +
			SETTING_PARAMS.LOD_PRECOMPUTE_HORIZONTAL_OFFSET;
		const verticalRadius =
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE +
			SETTING_PARAMS.LOD_PRECOMPUTE_VERTICAL_OFFSET;

		const candidateChunks = ChunkWorkerPool._lodCandidateChunks;
		const candidateLods = ChunkWorkerPool._lodCandidateLods;
		const candidateScores = ChunkWorkerPool._lodCandidateScores;
		const candidateIndices = ChunkWorkerPool._lodCandidateIndices;

		candidateChunks.length = 0;
		candidateLods.length = 0;
		candidateScores.length = 0;

		const queryScratch = ChunkWorkerPool._queryScratch;
		queryScratch.length = 0;

		Chunk.loadedChunkIndex.queryCollect(
			centerChunkX,
			centerChunkY,
			centerChunkZ,
			horizontalRadius + 1,
			verticalRadius + 1,
			queryScratch,
		);

		for (let i = 0, len = queryScratch.length; i < len; i++) {
			const chunk = queryScratch[i];

			if (
				!chunk.hasVoxelData ||
				chunk.isDirty ||
				!chunk.isModified ||
				chunk.chunkY < 0
			) {
				continue;
			}

			const hDist = Math.max(
				Math.abs(chunk.chunkX - centerChunkX),
				Math.abs(chunk.chunkZ - centerChunkZ),
			);
			const vDist = Math.abs(chunk.chunkY - centerChunkY);

			if (hDist > horizontalRadius || vDist > verticalRadius) {
				continue;
			}

			let lod = 2;
			let key = packInflightKey(chunk.numericId, lod);

			if (
				!chunk.hasCachedLODMesh(lod) &&
				!this.pendingLodPrecomputeKeys.has(key)
			) {
				candidateChunks.push(chunk);
				candidateLods.push(lod);
				candidateScores.push(hDist * 100 + vDist * 10 + lod);
			}

			lod = 3;
			key = packInflightKey(chunk.numericId, lod);

			if (
				!chunk.hasCachedLODMesh(lod) &&
				!this.pendingLodPrecomputeKeys.has(key)
			) {
				candidateChunks.push(chunk);
				candidateLods.push(lod);
				candidateScores.push(hDist * 100 + vDist * 10 + lod);
			}
		}

		const candidateCount = candidateChunks.length;
		if (candidateCount === 0) return;

		for (let i = 0; i < candidateCount; i++) {
			candidateIndices[i] = i;
		}

		candidateIndices.length = candidateCount;
		candidateIndices.sort(compareLodCandidateScores);

		const maxEnqueue = Math.max(
			1,
			SETTING_PARAMS.LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE | 0,
		);

		let added = 0;

		for (let i = 0; i < candidateCount && added < maxEnqueue; i++) {
			const idx = candidateIndices[i];
			const chunk = candidateChunks[idx];
			const lod = candidateLods[idx];
			const key = packInflightKey(chunk.numericId, lod);

			if (this.pendingLodPrecomputeKeys.has(key)) {
				continue;
			}

			this.pendingLodPrecomputeKeys.add(key);
			this.lodPrecomputeQueue.push({ chunk, lod });
			added++;
		}

		if (added > 0) {
			this.updateQueueDebugStats();
			this.processQueue();
		}
	}

	// -------------------------------------------------------------------------
	// Distant terrain shared init
	// -------------------------------------------------------------------------

	public initDistantTerrainShared(
		positionsBuffer: SharedArrayBuffer,
		normalsBuffer: SharedArrayBuffer,
		surfaceTilesBuffer: SharedArrayBuffer,
		radius: number,
		gridStep: number,
	): void {
		this.distantTerrainSharedInit = {
			positionsBuffer,
			normalsBuffer,
			surfaceTilesBuffer,
			radius,
			gridStep,
		};

		for (let i = 0; i < this.workers.length; i++) {
			this.distantTerrainReadyWorkers.delete(i);
			this.workers[i].initDistantTerrainShared(
				positionsBuffer,
				normalsBuffer,
				surfaceTilesBuffer,
				radius,
				gridStep,
			);
		}
	}

	// -------------------------------------------------------------------------
	// Core dispatch loop
	// -------------------------------------------------------------------------

	private processQueue(): void {
		this.updateQueueDebugStats();

		const dispatchBudget = this.getDispatchBudgetPerTick();
		let dispatchedThisTick = 0;

		while (
			this.getEffectiveIdleWorkerCount() > 0 &&
			dispatchedThisTick < dispatchBudget
		) {
			let taskChunk: Chunk | undefined;
			let distantTask: DistantTerrainTask | undefined;
			let farTask:
				| {
						requestId: number;
						levelIndex: number;
						tileX: number;
						tileZ: number;
				  }
				| undefined;
			let precomputeLod: number | undefined;
			let taskType: TaskType;

			if (this.terrainTaskQueue.size > 0) {
				taskChunk = this.dequeueNextTerrainChunk();
				if (!taskChunk) continue;
				taskType = TaskType.Terrain;
			} else if (this.taskHeap.length > 0) {
				taskChunk = this.heapPop();
				if (!taskChunk) continue;
				taskType = TaskType.Remesh;
			} else if (
				this.distantTerrainTaskQueueReadIdx <
					this.distantTerrainTaskQueue.length &&
				!this.distantTerrainInFlight &&
				this.distantTerrainReadyWorkers.size > 0
			) {
				distantTask =
					this.distantTerrainTaskQueue[this.distantTerrainTaskQueueReadIdx++];

				if (!distantTask) continue;

				taskType = TaskType.DistantTerrain;
			} else if (
				this.lodPrecomputeQueueReadIdx < this.lodPrecomputeQueue.length
			) {
				const task = this.lodPrecomputeQueue[this.lodPrecomputeQueueReadIdx++];

				const maybeChunk = task.chunk as Chunk | null | undefined;
				if (!maybeChunk) {
					continue;
				}

				taskChunk = maybeChunk;
				precomputeLod = task.lod;

				this.pendingLodPrecomputeKeys.delete(
					packInflightKey(taskChunk.numericId, precomputeLod),
				);

				taskType = TaskType.LodPrecompute;
			} else if (this.relightQueueReadIdx < this.relightQueue.length) {
				const maybeChunk = this.relightQueue[this.relightQueueReadIdx++] as
					| Chunk
					| null
					| undefined;

				if (!maybeChunk) {
					continue;
				}

				taskChunk = maybeChunk;

				this.pendingRelightKeys.delete(
					packInflightKey(taskChunk.numericId, taskChunk.lodLevel ?? 0),
				);

				taskType = TaskType.Relight;
			} else if (
				this.farTileQueueReadIdx < this.farTileQueue.length &&
				this.farTilesInFlightCount < this.maxFarTilesInFlight
			) {
				farTask = this.farTileQueue[this.farTileQueueReadIdx++];

				if (!farTask) continue;

				taskType = TaskType.FarTile;
			} else if (
				// Periodic compaction: drop consumed queue prefix.
				this.farTileQueueReadIdx > 64 &&
				this.farTileQueueReadIdx * 2 >= this.farTileQueue.length
			) {
				this.farTileQueue.copyWithin(0, this.farTileQueueReadIdx);
				this.farTileQueue.length -= this.farTileQueueReadIdx;
				this.farTileQueueReadIdx = 0;
				break;
			} else {
				break;
			}

			if (!taskChunk && !distantTask && !farTask) break;

			if (taskType === TaskType.Remesh) {
				if (!taskChunk!.isLoaded) {
					this.taskQueuePriority.delete(taskChunk!);
					continue;
				}

				if (
					this.isCompletelyEmptyChunk(taskChunk!) ||
					this.isUniformSolidMeshSkippable(taskChunk!)
				) {
					this.clearChunkMeshIfPresent(taskChunk!);
					this.pendingRemeshMap.delete(taskChunk!);
					this.taskQueuePriority.delete(taskChunk!);
					continue;
				}
			}

			if (taskType === TaskType.LodPrecompute && taskChunk) {
				if (
					!taskChunk.isLoaded ||
					!taskChunk.hasVoxelData ||
					precomputeLod === undefined ||
					shouldSkipLodForChunk(taskChunk, precomputeLod) ||
					taskChunk.hasCachedLODMesh(precomputeLod)
				) {
					continue;
				}
			}

			if (taskType === TaskType.Relight && taskChunk) {
				const lod = taskChunk.lodLevel ?? 0;

				if (!taskChunk.isLoaded) {
					continue;
				}

				if (this.pendingRemeshMap.has(taskChunk)) {
					continue;
				}

				const baseline = this.blockRevisionAtMesh.get(taskChunk.id);

				if (
					!baseline ||
					baseline.lod !== lod ||
					baseline.blockRevision !== taskChunk.blockRevision
				) {
					this.scheduleRemesh(taskChunk, lod === 0, false);
					continue;
				}
			}

			if (taskType === TaskType.DistantTerrain) {
				let readyIdleIndex = -1;

				for (
					let i = this._idleReadIdx;
					i < this.idleWorkerIndices.length;
					i++
				) {
					if (this.distantTerrainReadyWorkers.has(this.idleWorkerIndices[i])) {
						readyIdleIndex = i;
						break;
					}
				}

				if (readyIdleIndex === -1) {
					this.distantTerrainTaskQueueReadIdx--;
					break;
				}

				if (readyIdleIndex !== this._idleReadIdx) {
					const frontIdx = this._idleReadIdx;
					const frontWorker = this.idleWorkerIndices[frontIdx];
					const readyWorker = this.idleWorkerIndices[readyIdleIndex];

					this.idleWorkerIndices[frontIdx] = readyWorker;
					this.idleWorkerIndices[readyIdleIndex] = frontWorker;

					this.idleWorkerIndexPositions.set(readyWorker, frontIdx);
					this.idleWorkerIndexPositions.set(frontWorker, readyIdleIndex);
				}
			}

			if (taskType === TaskType.Terrain && taskChunk) {
				this._swapPreferredIdleWorkerToFront(
					this.terrainWorkerForColumn(taskChunk.chunkX, taskChunk.chunkZ),
				);
			}

			const workerIndex = this._consumeNextIdleWorker();
			if (workerIndex === -1) break;

			const worker = this.workers[workerIndex];

			if (taskType === TaskType.Terrain) {
				if (!taskChunk) {
					this._markWorkerIdle(workerIndex);
					continue;
				}

				if (
					workerIndex === ChunkWorkerPool.LIGHT_WORKER_INDEX &&
					this.workers.length > 1
				) {
					this.terrainTaskQueue.add(taskChunk);
					this._markWorkerIdle(workerIndex);

					if (this.idleWorkerIndices.length - this._idleReadIdx <= 1) {
						break;
					}

					continue;
				}

				this.dispatchTerrainTaskToWorker(workerIndex, worker, taskChunk);
				this.recordWorkerDispatch(workerIndex);
				this.debugStats.totalTerrainDispatches++;
				dispatchedThisTick++;
			} else if (taskType === TaskType.Remesh) {
				normalizeChunkLod(taskChunk!);

				const lod = taskChunk!.lodLevel ?? 0;

				this.setWorkerTaskContext(workerIndex, {
					taskType,
					chunk: taskChunk,
					lod,
				});

				this.pendingRemeshMap.delete(taskChunk!);
				this.taskQueuePriority.delete(taskChunk!);
				this.inFlightRemeshKeys.add(packInflightKey(taskChunk!.numericId, lod));

				worker.postFullRemesh(taskChunk!);

				this.recordWorkerDispatch(workerIndex);
				this.debugStats.totalRemeshDispatches++;
				dispatchedThisTick++;
			} else if (taskType === TaskType.LodPrecompute) {
				const lod = precomputeLod!;

				this.setWorkerTaskContext(workerIndex, {
					taskType,
					chunk: taskChunk,
					lod,
				});

				this.inFlightRemeshKeys.add(packInflightKey(taskChunk!.numericId, lod));

				worker.postFullRemesh(taskChunk!, lod);

				this.recordWorkerDispatch(workerIndex);
				this.debugStats.totalLodPrecomputeDispatches++;
				dispatchedThisTick++;
			} else if (taskType === TaskType.Relight) {
				normalizeChunkLod(taskChunk!);

				const lod = taskChunk!.lodLevel ?? 0;

				this.setWorkerTaskContext(workerIndex, {
					taskType,
					chunk: taskChunk,
					lod,
				});

				this.inFlightRemeshKeys.add(packInflightKey(taskChunk!.numericId, lod));

				worker.postRelightMesh(taskChunk!);

				this.recordWorkerDispatch(workerIndex);
				this.debugStats.totalRelightDispatches++;
				dispatchedThisTick++;
			} else if (taskType === TaskType.FarTile && farTask) {
				this.setWorkerTaskContext(workerIndex, { taskType });
				this.farTilesInFlightCount++;

				worker.postGenerateFarTile(
					farTask.requestId,
					farTask.levelIndex,
					farTask.tileX,
					farTask.tileZ,
				);

				this.recordWorkerDispatch(workerIndex);
				dispatchedThisTick++;
			} else {
				this.setWorkerTaskContext(workerIndex, { taskType, distantTask });
				this.distantTerrainInFlight = true;

				worker.postGenerateDistantTerrain(
					distantTask!.requestId,
					distantTask!.centerChunkX,
					distantTask!.centerChunkZ,
					distantTask!.radius,
					distantTask!.gridStep,
					distantTask!.renderDistance,
				);

				this.recordWorkerDispatch(workerIndex);
				this.debugStats.totalDistantDispatches++;
				dispatchedThisTick++;
			}
		}

		this.debugStats.lastDispatchCount = dispatchedThisTick;
		this.debugStats.totalDispatchCount += dispatchedThisTick;

		if (
			this.lodPrecomputeQueueReadIdx > 64 &&
			this.lodPrecomputeQueueReadIdx * 2 > this.lodPrecomputeQueue.length
		) {
			this.lodPrecomputeQueue.copyWithin(0, this.lodPrecomputeQueueReadIdx);
			this.lodPrecomputeQueue.length -= this.lodPrecomputeQueueReadIdx;
			this.lodPrecomputeQueueReadIdx = 0;
		}

		if (
			this.relightQueueReadIdx > 64 &&
			this.relightQueueReadIdx * 2 > this.relightQueue.length
		) {
			this.relightQueue.copyWithin(0, this.relightQueueReadIdx);
			this.relightQueue.length -= this.relightQueueReadIdx;
			this.relightQueueReadIdx = 0;
		}

		if (
			this._idleReadIdx > 8 &&
			this._idleReadIdx * 2 >= this.idleWorkerIndices.length
		) {
			this._compactIdleWorkers();
		}

		this.updateQueueDebugStats();

		if (this.getEffectiveIdleWorkerCount() > 0 && this.hasPendingTasks()) {
			this.scheduleProcessQueuePump();
		}
	}

	// -------------------------------------------------------------------------
	// Chunk disposal
	//
	// Called by Chunk.dispose() via the addChunkDisposeHook registered below.
	// Releases every strong reference the pool holds to the disposed chunk
	// so the chunk (and its voxel/light/palette SharedArrayBuffers) can be
	// reclaimed by the GC. Persistent chunks (boat chunks) are intentionally
	// skipped — they live as long as the boat does.
	// -------------------------------------------------------------------------
	public onChunkDisposed(chunk: Chunk): void {
		if (chunk.isBoatChunk) return;

		const remoteKey = packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ);

		// Remote-generation cleanup. These structures can otherwise retain
		// disposed Chunk objects and their voxel/light SharedArrayBuffers.
		this.remoteDeferredChunks.delete(chunk);
		this.remoteTaskQueueSet.delete(chunk);
		this.remotePendingChunks.delete(remoteKey);
		this.remoteRetryCount.delete(remoteKey);
		this.remoteNoBlobRetries.delete(remoteKey);
		this.pendingRemoteChunks.delete(chunk);

		// If this chunk was queued for remote remesh, allow the scheduled flush
		// to run normally but do not keep this chunk referenced by the Set.
		if (this.pendingRemoteChunks.size === 0) {
			this.pendingRemeshScheduled = false;
		}

		// Map cleanups.
		this.pendingRemeshMap.delete(chunk);
		this.taskQueuePriority.delete(chunk);
		this.terrainTaskDeferLighting.delete(chunk.id);
		this.deferredLightingQueuedIds.delete(chunk.id);
		this.deferredLightingSeedStates.delete(chunk.id);
		this.blockRevisionAtMesh.delete(chunk.id);
		this.debugLightSeedLengths.delete(chunk.id);

		// O(log n) removal from remesh heap.
		this.heapRemove(chunk);

		// Set cleanup.
		this.terrainTaskQueue.delete(chunk);

		// Lazy tombstone cleanup for arrays. Do not splice here, because unload
		// storms would become O(n²). Queue drains validate live chunks and compact.
		for (let lod = 0; lod < 16; lod++) {
			const key = packInflightKey(chunk.numericId, lod);
			this.pendingLodPrecomputeKeys.delete(key);
			this.pendingRelightKeys.delete(key);
			this.inFlightRemeshKeys.delete(key);
		}

		for (let i = 0; i < this.workerTaskContext.length; i++) {
			const ctx = this.workerTaskContext[i];

			if (
				ctx &&
				(ctx.taskType === TaskType.Remesh ||
					ctx.taskType === TaskType.LodPrecompute ||
					ctx.taskType === TaskType.Relight) &&
				ctx.chunk === chunk &&
				typeof ctx.lod === "number"
			) {
				this.inFlightRemeshKeys.delete(
					packInflightKey(chunk.numericId, ctx.lod),
				);
			}
		}

		const dq = this.deferredLightingQueue;
		for (let i = this.deferredLightingQueueReadIdx; i < dq.length; i++) {
			if (dq[i] === chunk) {
				dq[i] = null as unknown as Chunk;
				break;
			}
		}

		const lq = this.lodPrecomputeQueue;
		for (let i = this.lodPrecomputeQueueReadIdx; i < lq.length; i++) {
			if (lq[i].chunk === chunk) {
				lq[i].chunk = null as unknown as Chunk;
			}
		}

		const rq = this.relightQueue;
		for (let i = this.relightQueueReadIdx; i < rq.length; i++) {
			if (rq[i] === chunk) {
				rq[i] = null as unknown as Chunk;
				break;
			}
		}
	}
	public static async teardownForHmr(): Promise<void> {
		const instance = ChunkWorkerPool.instance;
		if (!instance) return;
		ChunkWorkerPool.instance = undefined;
	}
}

// ---------------------------------------------------------------------------
// Register a chunk-dispose hook so the pool can drop its strong references
// to the chunk the moment Chunk.dispose() runs.
// ---------------------------------------------------------------------------
addChunkDisposeHook((chunk) => {
	ChunkWorkerPool.getInstance().onChunkDisposed(chunk);
});
if (import.meta.hot) {
	import.meta.hot.dispose(() => ChunkWorkerPool.teardownForHmr());
}
