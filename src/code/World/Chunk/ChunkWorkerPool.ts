import { estimatePhysicalCores } from "@/code/Lib/estimatePhysicalCores";
import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { FRAME_WORK_BUDGET, FrameWorkKind } from "@/code/Lib/FrameWorkBudget";
import type { RemoteChunkProvider } from "../../Network/chunk/RemoteChunkProvider";
import { RemoteGenerationPump } from "../../Network/chunk/RemoteGenerationPump";

import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import { shapeInitPromise } from "../Shape/BlockShapes";
import { getWorldNameFromUrl, worldSeedFor } from "../WorldContext";
import { WorldStorage } from "../WorldStorage";
import { addChunkDisposeHook, Chunk, getChunk } from "./Chunk";
import { packCoords } from "./DataStructures/ChunkCoords";
import type { MeshData } from "./DataStructures/MeshData";
import { MeshResultQueue } from "./DataStructures/MeshResultQueue";
import { RemeshHeap } from "./DataStructures/RemeshHeap";
import {
	type DistantTerrainGeneratedMessage,
	type DistantTerrainTask,
	type FarTileGeneratedMessage,
	type FullMeshMessage,
	type LightDirtyMessage,
	type MeshWorkerResponse,
	type RelightMeshMissMessage,
	TaskType,
	type TerrainGeneratedMessage,
	type WorkerResponseData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";
import { BackgroundLodScanner } from "./LOD/BackgroundLodScanner";
import { ChunkLifecycle } from "./Loading/ChunkLifecycle";
import {
	isCompletelyEmptyChunk,
	isUniformSolidMeshSkippable,
} from "./Meshing/ChunkEmptiness";
import { precomputeClosedFaceMasks } from "./Meshing/ChunkFaceMasks";
import { createMeshFromData } from "./Meshing/ChunkMesher";
import {
	flushDirtyMergedGroups,
	setRequestFlush,
} from "./Meshing/MergedMeshManager";
import { DeferredLightStore } from "./Runtime/DeferredLightStore";
import { DispatchAccounting } from "./Runtime/DispatchAccounting";
import { DistantTerrainScheduler } from "./Runtime/DistantTerrainScheduler";
import { FarTileScheduler, type FarTileTask } from "./Runtime/FarTileScheduler";
import { IdleWorkerTracker } from "./Runtime/IdleWorkerTracker";
import { KeyedTaskQueue } from "./Runtime/KeyedTaskQueue";
import { LightDirtyPump } from "./Runtime/LightDirtyPump";
import {
	LightRegistrationDrain,
	UnregisterCoalescer,
} from "./Runtime/LightRegistration";
import { NeighborHealDebouncer } from "./Runtime/NeighborHealDebouncer";
import {
	hasStableVoxelNeighborsForCachedMesh,
	maybeRemeshNeighborsNowStable,
	scheduleChunkAndNeighborsRemesh,
} from "./Runtime/NeighborHelpers";
import {
	packInflightKey,
	RemeshFlightTracker,
} from "./Runtime/RemeshFlightTracker";
import { RemeshSaveDebouncer } from "./Runtime/RemeshSaveDebouncer";
import { RemeshStaging } from "./Runtime/RemeshStaging";
import { TerrainTaskQueue } from "./Runtime/TerrainTaskQueue";
import {
	ChunkWorker,
	NEIGHBOR_OFFSETS_26,
	neighborMaskCache,
} from "./Worker/chunkWorker";

export type WorkerMessageData = WorkerResponseData;

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
	// Overflow discards whose owner was re-queued for a fresh build instead of
	// silently missing its update (backpressure drop policy).
	meshOverflowRequeuedTotal: number;
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

// byteLength > 0 guards against the shared EMPTY_U8 sentinel buffer —
// transferring it would detach a module global. The instanceof check
// excludes SharedArrayBuffer-backed views (never produced by the mesh
// worker, but the static type allows them).
function pushRecyclableBuffer(scratch: ArrayBuffer[], arr: Uint8Array): void {
	const buf = arr.buffer;
	if (buf instanceof ArrayBuffer && buf.byteLength > 0) scratch.push(buf);
}

// PERF: single monomorphic shape for every dispatch context. The old union
// was instantiated as four different literal shapes ({taskType,chunk,...},
// {taskType}, {taskType,distantTask}, ...) — several live V8 hidden classes
// for one logical type, plus one fresh object allocation per worker dispatch.
// Contexts are now allocated once per worker and mutated in place; all fields
// are always assigned on every dispatch so no stale values can leak between
// task types (readers all gate on taskType first anyway).
type WorkerTaskContextShape = {
	taskType: TaskType;
	chunk: Chunk | null;
	lod: number;
	distantTask: DistantTerrainTask | null;
	terrainDeferLighting: boolean;
};
type WorkerTaskContext = WorkerTaskContextShape | null;

export class ChunkWorkerPool {
	private static instance: ChunkWorkerPool | undefined;
	private static readonly WORKER_ERROR_COOLDOWN_MS = 120;
	private static readonly MIN_AUTO_POOL_SIZE = 2;
	private static readonly MAX_AUTO_POOL_SIZE = 12;
	private static readonly DEFERRED_LIGHTING_BUDGET_MS = 2.0;
	private static readonly DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME = 64;

	private static readonly MAX_MESH_QUEUE = 512;

	// T2-11: worker 0's terrainWorker is the dedicated light worker — the
	// only worker whose terrainWorker runs Light* tasks (initLightShared is
	// called on it in the constructor and the HMR replacement path).  Terrain
	// generation is excluded from this worker so light registration, reconcile
	// and propagation never queue behind generation jobs.
	private static readonly LIGHT_WORKER_INDEX = 0;

	private workers: ChunkWorker[] = [];
	private workerTaskContext: WorkerTaskContext[] = [];
	/** Persistent per-worker context objects reused across dispatches —
	 *  never nulled; workerTaskContext points at the active one or null. */
	private persistentTaskCtx: WorkerTaskContextShape[] = [];

	// Remote server-side terrain generation (see Network/chunk/RemoteGenerationPump).
	private remote = new RemoteGenerationPump({
		registerChunk: (chunk) => {
			this.broadcastLightRegister(chunk);
			this.broadcastVoxelRegister(chunk);
		},
		queueLocalTerrain: (chunk) => this.queueLocalTerrainGeneration(chunk),
		schedulePump: () => this.scheduleProcessQueuePump(),
	});

	/** True when chunk voxel data comes from the server (multiplayer mode). */
	public isRemoteGenerationEnabled(): boolean {
		return this.remote.isRemoteGenerationEnabled();
	}

	private distantTerrainSharedInit: {
		positionsBuffer: SharedArrayBuffer;
		normalsBuffer: SharedArrayBuffer;
		surfaceTilesBuffer: SharedArrayBuffer;
		radius: number;
		gridStep: number;
	} | null = null;

	private workerRestartAtMs: number[] = [];

	// --- Remesh queue: staging buffer + binary min-heap (see
	// Runtime/RemeshStaging and DataStructures/RemeshHeap) ---
	private remeshStaging = new RemeshStaging();
	private remeshHeap = new RemeshHeap();

	private dispatchAccounting = new DispatchAccounting();
	private _lastHeartbeatSeq: number[] = [];

	private terrainTasks = new TerrainTaskQueue();
	private deferredLight = new DeferredLightStore();
	private deferredLightingPumpScheduled = false;

	// Debug: deferred-light seed length received at generation time, keyed by
	// chunk id.  Only populated while the in-game LightDebugTool is installed
	// (tracking costs a Map insert/delete per generated chunk otherwise).
	private debugLightSeedTracking = false;
	private debugLightSeedLengths = new Map<bigint, number>();

	public enableDebugLightSeedTracking(): void {
		this.debugLightSeedTracking = true;
	}

	public debugLightSeedLength(chunkId: bigint): number | undefined {
		return this.debugLightSeedLengths.get(chunkId);
	}

	private distantTerrain = new DistantTerrainScheduler();
	private lodPrecomputes = new KeyedTaskQueue<{
		chunk: Chunk | null;
		lod: number;
	}>(true);
	private lodScanner = new BackgroundLodScanner();
	private readonly lodScanHost = {
		queuedCount: (): number => this.lodPrecomputes.pendingCount,
		hasQueued: (key: number): boolean => this.lodPrecomputes.hasKey(key),
		enqueue: (chunk: Chunk, lod: number, key: number): void => {
			this.lodPrecomputes.enqueue({ chunk, lod }, key);
		},
		kick: (): void => {
			this.updateQueueDebugStats();
			this.processQueue();
		},
	};

	// T2-8: light-only remesh queue. Populated by tryScheduleRelightOnly from
	// the light-dirty pump; dispatched with lower priority than block remeshes.
	private relights = new KeyedTaskQueue<Chunk | null>();

	// T2-8: in-flight remesh keys + block content versions each mesh was
	// built from (see Runtime/RemeshFlightTracker). Light-dirty chunks with
	// unchanged blocks take the RelightMesh path instead of a full remesh.
	private remeshFlight = new RemeshFlightTracker();

	// ---------------------------------------------------------------------------
	// Idle-worker tracking (see Runtime/IdleWorkerTracker). All mutations go
	// through the tracker to keep the set/array/position invariants in one
	// place; thin _mark/_remove/_consume/_compact/_swap wrappers below
	// preserve existing call sites in Step 2.
	// ---------------------------------------------------------------------------
	private idleWorkers = new IdleWorkerTracker();

	// Mesh results + originating worker indices (parallel arrays over one
	// consume index) — recycled buffers go back to the sender's voxel worker.
	private meshResults = new MeshResultQueue();
	// Scratch for recycle-message buffer collection (reused, never retained).
	private readonly _recycleScratch: ArrayBuffer[] = [];
	// Since-last-summary accumulators for the burst ingestion log.
	private _summaryApplied = 0;
	private _summaryDropped = 0;
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
	// PERF: Ingestion alone used to be allowed to consume the whole shared
	// budget during bursts, squeezing the merged-group flush to its 0.5ms
	// floor — group memcpys + GPU uploads then spilled across many frames
	// exactly when the CPU was busiest. Cap ingestion below the total so the
	// flush always keeps a guaranteed slice.
	private static readonly MESH_INGEST_BUDGET_MS = 3.5;
	// Floor applied when the GPU queue is saturated. Never zero, so at least
	// one result keeps flowing per drain and the pipeline cannot deadlock.
	private static readonly MESH_FLUSH_MIN_BUDGET_MS = 2.0;
	private static readonly WORK_PROCESS_QUEUE = 1 << 0;
	private static readonly WORK_MESH = 1 << 1;
	private static readonly WORK_DEFERRED_LIGHT = 1 << 2;
	private static readonly WORK_LIGHT_REG = 1 << 3;
	private static readonly WORK_REMESH_FLUSH = 1 << 4;
	private static readonly WORK_LIGHT_DIRTY = 1 << 5;
	private _pendingWorkFlags = 0;
	private _centralSchedulerScheduled = false;

	private remeshSaver = new RemeshSaveDebouncer();
	private neighborHeals = new NeighborHealDebouncer((chunk, priority) =>
		this.scheduleRemesh(chunk, priority),
	);

	// ---------------------------------------------------------------------------
	// LevelDB chunk storage (replaces OPFS)
	// ---------------------------------------------------------------------------

	// ---------------------------------------------------------------------------
	// Static scratch buffers — avoids per-call allocation on hot paths
	// ---------------------------------------------------------------------------
	private static readonly _flushPendingScratch: Array<[Chunk, boolean]> = [];

	// Pre-bound methods — avoids per-call .bind(this) allocation
	private readonly _boundScheduleRemesh = this.scheduleRemesh.bind(this);
	private readonly _boundScheduleHealRemesh =
		this.scheduleDeferredNeighborHeal.bind(this);

	// ---------------------------------------------------------------------------
	// Light-worker integration state
	// ---------------------------------------------------------------------------

	private nextLightSeqCounter = 1;
	private lightDirty = new LightDirtyPump();
	private lightDirtyPumpScheduled = false;
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
		meshOverflowRequeuedTotal: 0,
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
			this.terrainTasks.size > 0 ||
			this.remeshHeap.length > 0 ||
			this.lodPrecomputes.hasPending ||
			this.relights.hasPending ||
			this.distantTerrain.hasPending ||
			// Far tiles were missing here, so a far-tile result landing as the
			// only pending work never re-entered the immediate result-driven pump
			// and had to wait for the next central tick — adding a full tick of
			// latency to every far-tile refill.
			this.farTiles.hasPending
		);
	}

	private getEffectiveIdleWorkerCount(): number {
		return this.idleWorkers.effectiveCount;
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
		stats.remeshQueueLength = this.remeshHeap.length;
		stats.terrainQueueLength = this.terrainTasks.size;
		stats.lodPrecomputeQueueLength = this.lodPrecomputes.pendingCount;
		stats.relightQueueLength = this.relights.pendingCount;
		stats.distantTerrainQueueLength = this.distantTerrain.pendingCount;
		stats.meshResultQueueLength = this.meshResults.pendingCount;
		stats.deferredLightingQueueLength = this.deferredLight.pendingCount;
		stats.deferredLightingSeedStateCount = this.deferredLight.seedStateCount;
		stats.deferredLightingPumpScheduled = this.deferredLightingPumpScheduled;
		const budget = this.getDispatchBudgetPerTick();
		stats.dispatchBudgetPerTick = Number.isFinite(budget) ? budget : 0;
	}

	public getDebugStats(): ChunkWorkerPoolDebugStats {
		this.updateQueueDebugStats();
		const stats = this.debugStats;
		stats.lastDispatchCount = this.dispatchAccounting.lastDispatchCount;
		stats.totalDispatchCount = this.dispatchAccounting.totalDispatchCount;
		this.dispatchAccounting.copyCountsInto(stats.workerDispatchCounts);
		this.dispatchAccounting.copyRecentInto(stats.lastDispatchWorkerIndices);
		return stats;
	}

	private recordWorkerDispatch(workerIndex: number): void {
		this.dispatchAccounting.record(workerIndex);
	}

	private setWorkerTaskContext(
		workerIndex: number,
		taskType: TaskType,
		chunk: Chunk | null = null,
		lod = -1,
		distantTask: DistantTerrainTask | null = null,
		terrainDeferLighting = true,
	): void {
		let ctx = this.persistentTaskCtx[workerIndex];
		if (ctx === undefined) {
			ctx = { taskType, chunk, lod, distantTask, terrainDeferLighting };
			this.persistentTaskCtx[workerIndex] = ctx;
		} else {
			ctx.taskType = taskType;
			ctx.chunk = chunk;
			ctx.lod = lod;
			ctx.distantTask = distantTask;
			ctx.terrainDeferLighting = terrainDeferLighting;
		}
		this.workerTaskContext[workerIndex] = ctx;
	}

	private clearWorkerTaskContext(workerIndex: number): void {
		this.workerTaskContext[workerIndex] = null;
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
		return this.remeshFlight.isSameLodInflight(chunk);
	}

	// -------------------------------------------------------------------------
	// Public callback
	// -------------------------------------------------------------------------

	public onDistantTerrainGenerated:
		| ((data: DistantTerrainGeneratedMessage) => void)
		| null = null;

	public invalidateDistantTerrain(): void {
		this.distantTerrain.invalidate();
	}

	private isDistantTerrainWorkerReadyAndIdle(): boolean {
		const workerIndex = this.distantTerrain.assignedWorker;
		return (
			this.distantTerrain.isWorkerReady(workerIndex) &&
			this.idleWorkers.has(workerIndex)
		);
	}

	// -------------------------------------------------------------------------
	// Idle-worker management — delegates to IdleWorkerTracker (see
	// Runtime/IdleWorkerTracker for invariants). Kept as thin wrappers so
	// existing call sites stay untouched in Step 2.
	// -------------------------------------------------------------------------

	private _markWorkerIdle(workerIndex: number): void {
		this.idleWorkers.markIdle(workerIndex);
	}

	private _removeWorkerFromIdle(workerIndex: number): void {
		this.idleWorkers.remove(workerIndex);
	}

	private _consumeNextIdleWorker(): number {
		return this.idleWorkers.consumeNext();
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

	/** Swap `preferred` to the front of the idle queue if idle. */
	private _swapPreferredIdleWorkerToFront(preferred: number): boolean {
		return this.idleWorkers.swapPreferredToFront(preferred);
	}

	// -------------------------------------------------------------------------
	// Worker failure / restart
	// -------------------------------------------------------------------------

	private handleWorkerFailure(workerIndex: number, reason: unknown): void {
		const context = this.workerTaskContext[workerIndex];
		this.workerTaskContext[workerIndex] = null;

		if (context?.taskType === TaskType.DistantTerrain) {
			this.distantTerrain.clearInFlight();
		}

		if (context?.taskType === TaskType.FarTile) {
			this.farTiles.markCompleted();
		}

		if (
			(context?.taskType === TaskType.Remesh ||
				context?.taskType === TaskType.LodPrecompute ||
				context?.taskType === TaskType.Relight) &&
			context.chunk
		) {
			this.remeshFlight.clear(context.chunk, context.lod);
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
			context.chunk?.isLoaded
		) {
			// Relight's worker-side block grid was lost with the worker —
			// re-queue as a full remesh so it is rebuilt.
			this.scheduleRemesh(context.chunk, true);
		} else if (context?.taskType === TaskType.LodPrecompute && context.chunk) {
			const key = packInflightKey(context.chunk.numericId, context.lod);
			this.lodPrecomputes.enqueue(
				{ chunk: context.chunk, lod: context.lod },
				key,
			);
		} else if (
			context?.taskType === TaskType.DistantTerrain &&
			context.distantTask
		) {
			this.distantTerrain.pushBack(context.distantTask);
		} else if (context?.taskType === TaskType.FarTile) {
			// Far-tile results are derived data; the manager's request simply
			// times out and re-requests. Nothing to restore here.
		}

		/*
		 * A worker dying mid-task is the "cancelled worker task" anomaly. Every
		 * branch above re-queues, so the chunk normally recovers on its own — but
		 * those re-queues are best-effort: the task queue can be compacted or the
		 * chunk disposed between the crash and the re-queue.
		 *
		 * Registering here costs one Set insert on a path that already tears down
		 * and restarts a worker (i.e. once per crash, not per task) and makes the
		 * chunk visible to the orphan sweep if the re-queue did not take. Without
		 * it, a lost re-queue after a worker crash is unrecoverable, because the
		 * sweep no longer walks the whole registry.
		 *
		 * Registered rather than relied upon: if the re-queue worked, the chunk
		 * re-enters the load/generate path and the sweep prunes it as healthy.
		 */
		if (context?.chunk) {
			Chunk.markOrphanCandidate?.(context.chunk);
		}

		// Remove from idle structures using the safe helper.
		this._removeWorkerFromIdle(workerIndex);
		this.distantTerrain.unmark(workerIndex);

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
			this.clearWorkerTaskContext(workerIndex);

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

	public postLightMutateBatch(req: {
		chunkId: bigint;
		headerSlot: number;
		muts: Uint32Array;
		seq: number;
	}): void {
		this.getLightWorker().postLightMutateBatch(req);
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

	// Pending unregister coalescing (see Runtime/LightRegistration):
	// dispose bursts accumulate here and flush as a single batch message per
	// worker. Ordering is preserved by flushing before ANY register/update
	// broadcast plus a macrotask drain.
	private unregisters = new UnregisterCoalescer({
		postLightBatch: (ids) =>
			this.getLightWorker().postLightUnregisterChunkBatch(ids),
		postVoxelBatch: (coords) => {
			for (let i = 0; i < this.workers.length; i++) {
				this.workers[i].postVoxelUnregisterChunkBatch(coords);
			}
		},
	});

	private broadcastLightUnregister(chunk: Chunk): void {
		this.lightDirty.dropSlot(chunk.lightHeaderSlot);
		this.unregisters.enqueueLight(chunk.id);
	}

	private broadcastVoxelUnregister(chunk: Chunk): void {
		this.unregisters.enqueueVoxel(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
	}

	private flushPendingUnregisters(): void {
		this.unregisters.flush();
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

	private lightRegDrain = new LightRegistrationDrain();
	private _lightRegDrainScheduled = false;

	private onLightChunkLoaded(chunk: Chunk, fromChannel: boolean): void {
		this.invalidateNeighborMasks(chunk);
		this.lightChunkByHeaderSlot.set(chunk.lightHeaderSlot, chunk);
		this.lightRegDrain.stage(chunk, fromChannel);
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
		this.deferredLight.invalidate(chunk);
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

	private readonly lightDirtyHost = {
		resolveChunk: (slot: number): Chunk | undefined =>
			this.lightChunkByHeaderSlot.get(slot),
		tryRelight: (chunk: Chunk): boolean => this.tryScheduleRelightOnly(chunk),
		scheduleRemesh: (chunk: Chunk, priority: boolean): void =>
			this.scheduleRemesh(chunk, priority),
		schedulePump: (): void => this.scheduleLightDirtyPump(),
		reportStats: (processed: number, queueLength: number): void => {
			this.debugStats.lightDirtyProcessedLastFrame = processed;
			this.debugStats.lightDirtyProcessedTotal += processed;
			this.debugStats.lightDirtyQueueLength = queueLength;
		},
	};

	private processLightDirtyQueue(): void {
		this.lightDirtyPumpScheduled = false;
		this.lightDirty.process(this.lightDirtyHost);
	}

	/**
	 * T2-8: schedule a light-only remesh for a chunk whose block content is
	 * unchanged since its current mesh was built. Returns false (caller falls
	 * back to a full scheduleRemesh) when the chunk has no mesh baseline, when
	 * a full remesh is already pending/in-flight, or when the chunk has no
	 * light array.
	 */
	private tryScheduleRelightOnly(chunk: Chunk): boolean {
		// A released chunk's light_array is Chunk.EMPTY_LIGHT_ARRAY — a
		// zero-length Uint8Array, which is still truthy — so a bare null
		// check never rejects it. hasVoxelData is the real precondition, and
		// the length check keeps a genuinely empty array from reaching the
		// worker (which would register a 0-byte light SAB).
		if (!chunk.hasVoxelData) return false;
		if (!chunk.light_array || chunk.light_array.length === 0) return false;

		const baseline = this.remeshFlight.getBaseline(chunk.id);
		const lod = chunk.lodLevel ?? 0;
		if (
			baseline === undefined ||
			baseline !== RemeshFlightTracker.packBaseline(chunk.blockRevision, lod)
		) {
			return false;
		}

		if (this.remeshStaging.has(chunk) || this.isSameLodRemeshInflight(chunk)) {
			return false;
		}

		const key = packInflightKey(chunk.numericId, lod);
		if (this.relights.hasKey(key)) return true;

		this.relights.enqueue(chunk, key);
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
	//
	// PERF NOTE: this macrotask runs BETWEEN animation frames, so none of the
	// work below appears in any onBeforeRender profiler section — it still
	// spends the frame budget, and it is where the chunk-mesh `writeBuffer`
	// uploads happen (processMeshQueueLoop → flushDirtyMergedGroups →
	// rebuildGroupData). Each branch is timed under a distinct off-frame
	// section so the F5 report attributes the cost instead of it reading as
	// unexplained dropped frames.
	// -------------------------------------------------------------------------

	private _centralChannel: MessageChannel | null = null;

	private _scheduleCentralWork(flags: number): void {
		this._pendingWorkFlags |= flags;
		if (this._centralSchedulerScheduled) return;
		this._centralSchedulerScheduled = true;
		// MessageChannel instead of setTimeout(0): browsers clamp nested
		// timers to ~4ms, which fragmented heavy streaming into hundreds of
		// clamped timer callbacks. A posted message is a true macrotask
		// with no clamp and fires before the next frame's timers.
		let channel = this._centralChannel;
		if (!channel) {
			channel = new MessageChannel();
			channel.port1.onmessage = this._centralFlush;
			this._centralChannel = channel;
		}
		channel.port2.postMessage(0);
	}

	private _centralFlush = (): void => {
		this._centralSchedulerScheduled = false;
		const flags = this._pendingWorkFlags;
		this._pendingWorkFlags = 0;

		if (flags & ChunkWorkerPool.WORK_PROCESS_QUEUE) {
			this.processQueuePumpScheduled = false;
			frameProfiler.measureOffFrame("poolQueue", () => this.processQueue());
		}
		if (flags & ChunkWorkerPool.WORK_MESH) {
			this.meshDrainScheduled = false;
			// Includes the merged-group rebuild and its GPU uploads — the
			// single largest off-frame cost in this file.
			frameProfiler.measureOffFrame("poolMeshDrain", () =>
				this.processMeshQueueLoop(),
			);
		}
		if (flags & ChunkWorkerPool.WORK_DEFERRED_LIGHT) {
			this.deferredLightingPumpScheduled = false;
			frameProfiler.measureOffFrame("poolLighting", () =>
				this.processDeferredLightingQueue(),
			);
		}
		if (flags & ChunkWorkerPool.WORK_LIGHT_REG) {
			this._lightRegDrainScheduled = false;
			frameProfiler.measureOffFrame("poolLighting", () =>
				this._drainLightRegistration(),
			);
		}
		if (flags & ChunkWorkerPool.WORK_REMESH_FLUSH) {
			this.remeshFlushScheduled = false;
			frameProfiler.measureOffFrame("poolLighting", () =>
				this.flushPendingRemeshQueue(),
			);
		}
		if (flags & ChunkWorkerPool.WORK_LIGHT_DIRTY) {
			this.lightDirtyPumpScheduled = false;
			frameProfiler.measureOffFrame("poolLighting", () =>
				this.processLightDirtyQueue(),
			);
		}
	};

	private _drainLightRegistration(): void {
		if (this.lightRegDrain.stagedCount === 0) return;
		this.lightRegDrain.drain({
			flushUnregisters: () => this.flushPendingUnregisters(),
			nextSeq: () => this.nextLightSeq(),
			skipSkyReconcile: (chunk) => this.deferredLight.has(chunk),
			postLightBatch: (regs) =>
				this.getLightWorker().postLightRegisterChunkBatch(regs),
			postVoxelBatch: (batch) => {
				for (let i = 0; i < this.workers.length; i++) {
					this.workers[i].postVoxelRegisterChunkBatch(batch);
				}
			},
		});
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
		this.distantTerrain.setWorkerIndex(poolSize > 1 ? 1 : 0);
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
			this.dispatchAccounting.addWorker();
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
		// A chunk re-loaded at far LOD loses its voxel data without ever
		// touching the light-worker path, so its neighbours' presence masks have
		// to be dropped explicitly.
		Chunk.onChunkPresenceChanged = (chunk) =>
			this.invalidateNeighborMasks(chunk);
		Chunk._lightPool = {
			postLightMutate: (req) => this.postLightMutate(req),
			postLightMutateBatch: (req) => this.postLightMutateBatch(req),
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
	// Mesh helpers (emptiness predicates live in Meshing/ChunkEmptiness)
	// -------------------------------------------------------------------------

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

		const { enqueued, merged } = this.deferredLight.enqueue(
			chunk,
			seedQueue,
			seedLength,
		);
		if (merged) this.debugStats.deferredLightingSeedReplacedTotal++;
		if (enqueued) this.debugStats.deferredLightingEnqueuedTotal++;

		this.scheduleDeferredLightingPump();
	}

	private scheduleDeferredLightingPump(): void {
		if (this.deferredLightingPumpScheduled) return;
		this.deferredLightingPumpScheduled = true;
		this._scheduleCentralWork(ChunkWorkerPool.WORK_DEFERRED_LIGHT);
	}

	private processDeferredLightingQueue(): void {
		const terrainBusy = this.terrainTasks.size > 0;

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
			this.deferredLight.hasPending &&
			processed < maxChunks &&
			((iterCount++ & 15) !== 0 || performance.now() - start < budget)
		) {
			const entry = this.deferredLight.takeNext();
			if (!entry) break;
			// Slot may have been nulled by onLightChunkDisposed (the chunk was
			// unloaded before the pump reached it); skip it without counting
			// as a dropped chunk.
			if (entry.chunk === null) continue;
			const { chunk, seed: seedState } = entry;

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

		this.deferredLight.compactIfNeeded();

		if (this.deferredLight.hasPending) {
			this.scheduleDeferredLightingPump();
		}
	}

	// -------------------------------------------------------------------------
	// Mesh result drain loop — runs every rAF
	// -------------------------------------------------------------------------

	private scheduleMeshFlush(): void {
		if (this.meshDrainScheduled || this.insideMeshDrain) return;
		this.meshDrainScheduled = true;
		this._scheduleCentralWork(ChunkWorkerPool.WORK_MESH);
	}

	private processMeshQueueLoop(): void {
		this.insideMeshDrain = true;
		try {
			const start = performance.now();
			let processed = 0;

			/*
			 * PERF: check the clock on EVERY result.
			 *
			 * This loop used to be guarded by
			 *   `((iterCount++ & 15) !== 0 || now - start < MESH_INGEST_BUDGET_MS)`
			 * which is true on 15 of every 16 iterations WITHOUT ever reading
			 * the clock — the 3.5ms budget was only enforced once per 16
			 * results. Each iteration calls createMeshFromData (vertex/index
			 * buffer construction), so during a storm 16 results cost far more
			 * than the whole shared budget, and the drain plus
			 * flushDirtyMergedGroups below landed as one 25-64ms macrotask
			 * against a 5.5ms target. That single overrun is what Chrome's
			 * Frames track records as a dropped frame.
			 *
			 * `processed !== 0` keeps a minimum of one result per drain so the
			 * pipeline can never stall on an empty-but-nonempty queue.
			 *
			 * The shared frame pool is consulted alongside the local ceiling.
			 * This drain, flushDirtyMergedGroups below, the loaded-refresh sweep
			 * and the queue slice all fire on the same frame, and each was
			 * previously free to spend its full local budget.
			 */
			while (this.meshResults.hasPending) {
				if (
					processed !== 0 &&
					(!FRAME_WORK_BUDGET.canContinue(
						FrameWorkKind.Meshing,
						ChunkWorkerPool.MESH_INGEST_BUDGET_MS,
					) ||
						performance.now() - start >= ChunkWorkerPool.MESH_INGEST_BUDGET_MS)
				) {
					break;
				}

				const next = this.meshResults.takeNext();
				if (!next) break;
				const { data, workerIndex: workerIdx } = next;
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
					// Route through the owner: a superseded in-flight result still
					// applies via completeRemesh-then-rerun, so the stale drop is
					// markDirty (latches Superseded when Building) + a fresh queue.
					// completeRemesh is deliberately NOT called here: the stale
					// result was never applied, so there is nothing to mark clean.
					ChunkLifecycle.markDirty(chunk);
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0, false);
					processed++;
					continue;
				}

				const opaqueData = opaque ?? null;
				const waterData = water ?? null;
				const cutoutData = cutout ?? null;
				const canCacheMesh =
					lod === 0 || hasStableVoxelNeighborsForCachedMesh(chunk);
				const isCurrentLod = (chunk.lodLevel ?? 0) === lod;

				if (canCacheMesh || !isCurrentLod) {
					_meshApplyScratch.opaque = opaqueData;
					_meshApplyScratch.water = waterData;
					_meshApplyScratch.cutout = cutoutData;
					chunk.setCachedLODMesh(lod, _meshApplyScratch);
				}

				if (isCurrentLod) {
					createMeshFromData(chunk, opaqueData, waterData, cutoutData);
					// Route through the owner: clears dirty + queued, preserves the
					// rerun latch so a superseded chunk still re-runs after this
					// (previously two manual flag writes with the same outcome).
					ChunkLifecycle.completeRemesh(chunk);
					this.queuePostRemeshSave(chunk);
					this.debugStats.meshAppliedTotal++;
					this._summaryApplied++;
				} else {
					// The current LOD changed while this build was in flight: the
					// re-queue must supersede it with a fresh revision. Clear the
					// queued flag first so the owner's bump guard below advances
					// meshRevision exactly as the legacy manual writes did.
					chunk.remeshQueued = false;
					ChunkLifecycle.markDirty(chunk);
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
			const drainMs = performance.now() - start;
			this.debugStats.lastMeshDrainMs = drainMs;
			// Book the ingest half against the shared frame pool. The flush below
			// books its own cost, so the two are attributed separately but drawn
			// from the same millisecond pool.
			FRAME_WORK_BUDGET.record(FrameWorkKind.Meshing, drainMs);

			this.meshResults.compactIfNeeded();

			// Whatever is left of this drain's own 5.5 ms is offered to the upload
			// flush, capped by what the frame-wide pool still has — otherwise a
			// drain that ran long would hand the flush a fresh budget and the
			// pair would overshoot the frame anyway.
			//
			// The `|| MIN` floor is deliberate: if ingest consumed the whole pool,
			// the flush still gets MESH_FLUSH_MIN_BUDGET_MS rather than a zero
			// budget. A zero budget makes flushDirtyMergedGroups process nothing and
			// re-arm, which under sustained ingest starves GPU upload indefinitely
			// and the merged groups pile up dirty. 2 ms is small enough not to
			// matter and bounded enough to break the starvation.
			flushDirtyMergedGroups(
				Math.min(
					Math.max(
						ChunkWorkerPool.MESH_FLUSH_MIN_BUDGET_MS,
						ChunkWorkerPool.MESH_DRAIN_BUDGET_MS - drainMs,
					),
					FRAME_WORK_BUDGET.remainingMs() ||
						ChunkWorkerPool.MESH_FLUSH_MIN_BUDGET_MS,
				),
			);

			if (this.meshResults.hasPending) {
				this.scheduleMeshFlush();
			} else if (this._summaryApplied + this._summaryDropped >= 256) {
				this._summaryApplied = 0;
				this._summaryDropped = 0;
			}
		} finally {
			this.insideMeshDrain = false;
		}
	}

	// -------------------------------------------------------------------------
	// Mesh result queue enqueue — shared by the terrain-worker and mesh-worker
	// message handlers.
	//
	// Backpressure fix: when the queue is at MAX_MESH_QUEUE, we overwrite the
	// oldest unread slot with the new result (see MeshResultQueue) but do
	// NOT advance the consume index. The previous version incremented the
	// read index after writing into it, which made the entry just written
	// look "already consumed" to the drain loop (which starts reading from
	// the consume index) — so under backpressure the *newest* mesh
	// result was the one silently dropped, and since chunk.remeshQueued had
	// already been cleared before dispatch, that chunk's mesh could go
	// missing with no retry. Leaving the read index alone means the slot we
	// just overwrote holds the newest result and is still unread, so the
	// oldest entry is the one discarded instead.
	// -------------------------------------------------------------------------
	private enqueueMeshResult(data: FullMeshMessage, workerIndex: number): void {
		const pending = this.meshResults.pendingCount;
		if (
			pending >= ChunkWorkerPool.MAX_MESH_QUEUE &&
			this.meshResults.hasPending
		) {
			// Backpressure discard: the oldest unread result is being replaced —
			// its buffers are unreferenced, so recycle them. Its owner must not
			// silently miss the update, though: remeshQueued was already cleared
			// at dispatch, so without intervention nothing would ever re-schedule
			// it. Re-queue a fresh build for non-stale victims; stale ones were
			// superseded by an edit whose own schedule call is still covering
			// them.
			// hasPending was checked above, so the oldest slot is occupied.
			const dropped = this.meshResults.peekOldest()!.data;
			this.recycleMeshBuffers(workerIndex, dropped);
			const droppedChunk = this.resolveChunkByMessageId(dropped.chunkId);
			if (
				droppedChunk?.isLoaded &&
				dropped.meshRevision === droppedChunk.meshRevision
			) {
				// Route through the owner (markDirty owns the isDirty write;
				// scheduleRemesh below owns the re-queue). bumpRevision=false is
				// preserved: the victim's revision is current, so no supersede.
				ChunkLifecycle.markDirty(droppedChunk);
				this.scheduleRemesh(
					droppedChunk,
					(droppedChunk.lodLevel ?? 0) === 0,
					false,
				);
				this.debugStats.meshOverflowRequeuedTotal++;
			}
			this.meshResults.overwriteOldest(data, workerIndex);
		} else {
			this.meshResults.push(data, workerIndex);
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
			pushRecyclableBuffer(scratch, o.faceData);
		}
		if (w) {
			pushRecyclableBuffer(scratch, w.faceData);
		}
		if (c) {
			pushRecyclableBuffer(scratch, c.faceData);
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
		if (this.deferredLight.isQueued(chunk)) return;

		this.remeshSaver.queue(chunk.id);
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

		/*
		 * Size from PHYSICAL cores, not hardwareConcurrency.
		 *
		 * hardwareConcurrency reports logical processors, which is 2x physical
		 * cores on any SMT machine. Sizing from it over-allocates, and
		 * over-allocating a CPU-bound pool is actively slower than sizing it
		 * correctly: once a core saturates, a sibling thread on it contends for
		 * the same execution resources instead of adding throughput.
		 *
		 * One physical core is reserved for the main thread (render, mesh
		 * assembly, occlusion culling, game logic) — the most
		 * latency-sensitive thread in the client.
		 *
		 * Each ChunkWorker costs ONE thread, not two: its terrain worker is
		 * created lazily (see Worker/chunkWorker.ts) because in multiplayer the
		 * server is authoritative and local terrain generation never dispatches,
		 * so that thread would otherwise sit idle for the whole session. This
		 * matters directly for multiplayer throughput — a chunk only becomes
		 * visible once the CLIENT has meshed it, so mesh thread count, not
		 * worker-pair count, is what governs how fast chunks appear.
		 *
		 * Set SETTING_PARAMS.CHUNK_WORKER_POOL_SIZE to override when co-locating
		 * with a server; it is checked above and wins outright.
		 */
		const detected = Math.max(1, (navigator.hardwareConcurrency ?? 0) | 0);
		const physical = estimatePhysicalCores(detected);
		const workerBudget = Math.max(2, physical - 1);
		return Math.max(
			ChunkWorkerPool.MIN_AUTO_POOL_SIZE,
			Math.min(ChunkWorkerPool.MAX_AUTO_POOL_SIZE, workerBudget),
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
		// Same coalescing contract as Chunk.scheduleRemesh: a repeat request
		// while a build is queued/in-flight must not advance meshRevision, or
		// the drain discards the in-flight result and pays a duplicate rebuild.
		if (bumpRevision && !chunk.remeshQueued) chunk.meshRevision++;
		if (!chunk.hasVoxelData) {
			if (this.tryApplyCachedLODMesh(chunk, true)) {
				// Cached mesh stands in: the chunk is clean. Drop any queued
				// state — a heap entry pushed before the voxel data was
				// released would otherwise dispatch later as an illegal
				// beginRemesh from Clean.
				this.remeshStaging.delete(chunk);
				this.remeshHeap.remove(chunk);
				ChunkLifecycle.completeRemesh(chunk);
			} else {
				chunk.isDirty = true;
				chunk.remeshQueued = false;
				this.remeshStaging.delete(chunk);
				this.remeshHeap.remove(chunk);
			}
			return;
		}

		const inflight = this.isSameLodRemeshInflight(chunk);

		if (isCompletelyEmptyChunk(chunk) || isUniformSolidMeshSkippable(chunk)) {
			if (inflight) {
				chunk.rerunRemeshAfterInflight = true;
			}
			this.remeshStaging.delete(chunk);
			this.remeshHeap.remove(chunk);
			this.clearChunkMeshIfPresent(chunk);
			// Nothing is queued anymore — release the flag so a later content
			// change can enqueue a fresh build instead of hitting the
			// remeshQueued early-return forever.
			chunk.remeshQueued = false;
			return;
		}

		if (inflight) {
			// Route through the owner: markDirty owns the isDirty write and
			// latches the rerun exactly when a build is in flight
			// (Building → Superseded). The queued/in-flight build still
			// applies when it lands; the latch re-runs it after.
			ChunkLifecycle.markDirty(chunk);
			return;
		}

		const lodPriority = (chunk.lodLevel ?? 0) === 0;
		this.remeshStaging.add(chunk, priority || lodPriority);
		// Route through the owner: queueRemesh owns the isDirty + remeshQueued
		// writes (idempotent when already Queued, illegal-state-guarded
		// otherwise), so the flags always describe the queued entry above.
		// The revision bump above stays gated on !remeshQueued exactly as
		// before: a repeat request must not advance meshRevision.
		ChunkLifecycle.queueRemesh(chunk);
		this.scheduleRemeshFlush();
	}

	private scheduleRemeshFlush(): void {
		if (this.remeshFlushScheduled) return;
		this.remeshFlushScheduled = true;
		this._scheduleCentralWork(ChunkWorkerPool.WORK_REMESH_FLUSH);
	}

	// Deferred neighbor-heal remeshes (see Runtime/NeighborHealDebouncer).
	private scheduleDeferredNeighborHeal(chunk: Chunk, priority: boolean): void {
		this.neighborHeals.schedule(chunk, priority);
	}

	private flushPendingRemeshQueue(): void {
		if (this.remeshStaging.isEmpty) return;

		const pending = ChunkWorkerPool._flushPendingScratch;
		this.remeshStaging.drainInto(pending);

		// No pre-sort needed: the heap maintains order on its own regardless
		// of insertion order.
		for (let i = 0; i < pending.length; i++) {
			const [chunk, priority] = pending[i];
			if (!chunk.isLoaded) continue;
			if (isCompletelyEmptyChunk(chunk) || isUniformSolidMeshSkippable(chunk)) {
				// Mirror scheduleRemesh's empty path: nothing is queued
				// anymore, so release the flag (and drop any stale heap entry
				// pushed before the chunk became empty) instead of leaving a
				// Queued flag with no heap entry behind.
				if (this.isSameLodRemeshInflight(chunk)) {
					chunk.rerunRemeshAfterInflight = true;
				}
				this.remeshHeap.remove(chunk);
				this.clearChunkMeshIfPresent(chunk);
				chunk.remeshQueued = false;
				continue;
			}
			this.remeshHeap.insert(chunk, priority);
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
		this.distantTerrain.schedule(
			centerChunkX,
			centerChunkZ,
			radius,
			renderDistance,
			gridStep,
		);
		this.processQueue();
	}

	// -------------------------------------------------------------------------
	// Far tiles (LOD6+)
	// -------------------------------------------------------------------------

	private farTiles = new FarTileScheduler();

	/** Callback fired on the main thread when a worker finishes a far tile. */
	public onFarTileGenerated: ((data: FarTileGeneratedMessage) => void) | null =
		null;

	public resetFarTileRequests(): void {
		this.farTiles.reset();
	}

	public scheduleFarTile(
		levelIndex: number,
		tileX: number,
		tileZ: number,
	): number {
		const requestId = this.farTiles.schedule(levelIndex, tileX, tileZ);
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

			// A worker message handler is a plain task, not an onBeforeRender
			// callback, so its cost never shows up in a frame section. Time it
			// as off-frame work.
			const startedAt = performance.now();
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
			} finally {
				frameProfiler.noteOffFrameValue(
					"workerMsg",
					performance.now() - startedAt,
				);
			}

			if (failed) return;
			if (this.workers[workerIndex] !== getWorker()) return;

			this.clearWorkerTaskContext(workerIndex);
			this._markWorkerIdle(workerIndex);
			this.scheduleProcessQueuePump();
		};
	}

	// Engine perf: cold worker-message path (mesh-rate, not per-voxel).
	// Shared GenerateFullMesh ingest tail for terrain + mesh handlers:
	// resolve once, clear in-flight key, record baseline, enqueue, rerun.
	private ingestFullMeshResult(
		meshData: FullMeshMessage,
		workerIndex: number,
	): void {
		// PERF: resolve the chunk ONCE — the in-flight key clear, baseline
		// record and rerun check all need the same object, and each
		// BigInt-keyed map lookup hashes the full 3×21-bit id.
		const resolvedChunk = this.resolveChunkByMessageId(meshData.chunkId);
		if (resolvedChunk) {
			this.remeshFlight.clear(resolvedChunk, meshData.lod);
			this.remeshFlight.recordBaseline(resolvedChunk, meshData.lod);
		}
		this.enqueueMeshResult(meshData, workerIndex);

		if (resolvedChunk?.rerunRemeshAfterInflight) {
			// Route through the owner: rerunAfterInflight clears the latch and
			// re-queues (Superseded → Queued); the pool call below refreshes
			// the pending entry without advancing the revision (same as the
			// legacy manual clear + scheduleRemesh(false)).
			ChunkLifecycle.rerunAfterInflight(resolvedChunk);
			this.scheduleRemesh(
				resolvedChunk,
				(resolvedChunk.lodLevel ?? 0) === 0,
				false,
			);
		}
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
			this.distantTerrain.markReady(workerIndex);
			this.processQueue();
			return false;
		}

		if (type === WorkerTaskType.LightDirty) {
			const dirty = data as LightDirtyMessage;
			this.lightDirty.reportDirty(dirty.seq, dirty.dirtySlots);
			this.scheduleLightDirtyPump();
			return false;
		}

		if (type === WorkerTaskType.GenerateFullMesh) {
			const meshData = data as FullMeshMessage;
			this.ingestFullMeshResult(meshData, workerIndex);
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
				if (this.debugLightSeedTracking) {
					this.debugLightSeedLengths.set(
						chunk.id,
						lightSeedLength !== undefined ? lightSeedLength : -1,
					);
				}
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
					this.clearWorkerTaskContext(workerIndex);
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
			const generated = data as DistantTerrainGeneratedMessage;
			this.distantTerrain.clearInFlight();
			if (
				!generated.failed &&
				generated.requestId === this.distantTerrain.latestId
			) {
				this.onDistantTerrainGenerated?.(generated);
			}
		} else if (type === WorkerTaskType.GenerateFarTile) {
			this.farTiles.markCompleted();
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

			// Off-frame task — see makeTerrainMessageHandler.
			const startedAt = performance.now();
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
			} finally {
				frameProfiler.noteOffFrameValue(
					"workerMsg",
					performance.now() - startedAt,
				);
			}

			if (failed) return;
			if (this.workers[workerIndex] !== getWorker()) return;

			this.clearWorkerTaskContext(workerIndex);
			this._markWorkerIdle(workerIndex);
			this.scheduleProcessQueuePump();
		};
	}

	private handleMeshMessageBody(
		workerIndex: number,
		data: MeshWorkerResponse & { type?: string },
	): boolean {
		const failed = false;
		const type = data.type as WorkerTaskType | "HEARTBEAT" | undefined;

		if (type === WorkerTaskType.WorkerReady) {
			return failed;
		}

		if (type === "HEARTBEAT") {
			const seq = (data as unknown as { seq?: number }).seq ?? 0;
			this._lastHeartbeatSeq[workerIndex] = seq;
			return failed;
		}

		if (type === WorkerTaskType.RelightMesh) {
			// Relight cache miss in the worker: fall back to a full remesh.
			const miss = data as unknown as RelightMeshMissMessage;
			const missChunk = this.resolveChunkByMessageId(miss.chunkId);
			if (missChunk) {
				this.remeshFlight.clear(missChunk, miss.lod);
			}
			if (missChunk?.isLoaded) {
				this.scheduleRemesh(missChunk, (missChunk.lodLevel ?? 0) === 0, false);
			}
			return failed;
		}

		if (type !== WorkerTaskType.GenerateFullMesh) {
			console.warn(
				`Ignoring unexpected mesh worker message from ${workerIndex}:`,
				data,
			);
			return failed;
		}

		const fullMeshMessage = data as unknown as FullMeshMessage;
		this.ingestFullMeshResult(fullMeshMessage, workerIndex);

		return failed;
	}

	// -------------------------------------------------------------------------
	// Queue dequeue helpers
	// -------------------------------------------------------------------------

	private dequeueNextTerrainChunk(): Chunk | undefined {
		return this.terrainTasks.takeFirst();
	}

	/**
	 * Whether this chunk is already sitting in the local terrain-generation
	 * queue awaiting a worker.
	 *
	 * Used by ChunkStreamingController's orphan sweep so it does not re-queue a
	 * chunk that is already scheduled for generation (which would make the chunk
	 * both a storage load and a terrain task).
	 */
	public isTerrainTaskQueued(chunk: Chunk): boolean {
		return this.terrainTasks.has(chunk);
	}

	/**
	 * Whether the chunk's load is accounted for anywhere in the generation
	 * pipeline: the local terrain queue, an actively-executing terrain worker
	 * task, or any leg of the multiplayer remote pipeline (queued, deferred,
	 * parked for retry, or awaiting a server response).
	 *
	 * This is the `isGenerating` leg of the ChunkLifecycle host. It must cover
	 * the whole worker-execution window — not just queue membership — because
	 * the scheduler recycles the controller's in-flight marks while generation
	 * is still running, and the owner derives `Loading` from this query when a
	 * generation result completes. A chunk that answers true here is NOT an
	 * orphan even though it sits in no load queue.
	 */
	public isChunkGenerating(chunk: Chunk): boolean {
		if (this.terrainTasks.has(chunk)) return true;
		for (let i = 0; i < this.workerTaskContext.length; i++) {
			const ctx = this.workerTaskContext[i];
			if (ctx?.taskType === TaskType.Terrain && ctx.chunk === chunk) {
				return true;
			}
		}
		return this.isChunkInRemotePipeline(chunk);
	}

	/**
	 * Whether the chunk has any outstanding multiplayer remote-generation
	 * state. Split out so the ChunkLifecycle host and diagnostics can share
	 * one definition of "accounted for by the remote pipeline".
	 */
	public isChunkInRemotePipeline(chunk: Chunk): boolean {
		return this.remote.isChunkInRemotePipeline(chunk);
	}

	/**
	 * Whether any remesh for this chunk (any LOD) is currently dispatched to a
	 * worker. This is the `isRemeshInFlight` leg of the ChunkLifecycle host:
	 * it lets the owner distinguish `Queued` (waiting) from `Building`
	 * (dispatched) without trusting the `remeshQueued` flag alone.
	 */
	public isRemeshInFlightFor(chunk: Chunk): boolean {
		return this.remeshFlight.isAnyLodInflight(chunk);
	}

	/**
	 * Multiplayer request-pipeline state, for stall diagnosis.
	 *
	 * `pending` is the hard gate on this pump: once it reaches `pendingCap` the
	 * pump backpressures shut and no further chunk can be requested until
	 * entries settle. If pending sits at the cap, the client is connected and
	 * silent but the world has stopped filling in.
	 */
	public getRemotePipelineStats(): {
		enabled: boolean;
		taskQueueLength: number;
		pendingCount: number;
		pendingCap: number;
		parkedCount: number;
	} {
		return this.remote.getRemotePipelineStats();
	}

	// -------------------------------------------------------------------------
	// -------------------------------------------------------------------------
	// Terrain scheduling
	// -------------------------------------------------------------------------

	public scheduleTerrainGeneration(chunk: Chunk, deferLighting = true): void {
		if (!chunk) return;
		if (this.remote.isActive()) {
			this.remote.enqueueRemoteGeneration(chunk, deferLighting);
			return;
		}
		// Multiplayer: the server owns terrain. Until the connection (and thus
		// the remote provider) is live, hold the request instead of generating
		// it locally — local gen here is pure waste that gets discarded anyway.
		if (this.remote.isExpectingProvider()) {
			this.remote.deferChunkForRemote(chunk);
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
		this.terrainTasks.add(chunk, deferLighting);
		chunk.isTerrainScheduled = true;
		this.scheduleProcessQueuePump();
	}

	public scheduleTerrainGenerationBatch(
		chunks: readonly Chunk[],
		deferLighting = true,
	): void {
		if (this.remote.isActive()) {
			for (let i = 0; i < chunks.length; i++) {
				this.remote.enqueueRemoteGeneration(chunks[i], deferLighting);
			}
			this.pumpRemoteGeneration();
			return;
		}
		// Multiplayer: defer instead of generating locally (see scheduleTerrainGeneration).
		if (this.remote.isExpectingProvider()) {
			for (let i = 0; i < chunks.length; i++) {
				this.remote.deferChunkForRemote(chunks[i]);
			}
			return;
		}
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			this.terrainTasks.add(chunk, deferLighting);
			chunk.isTerrainScheduled = true;
		}
		this.scheduleProcessQueuePump();
	}

	/** Enter multiplayer mode: defer chunk requests until the server connects. */
	public enableRemoteMode(): void {
		this.remote.enableRemoteMode();
	}

	/** Leave multiplayer mode (e.g. join failed): allow local generation again. */
	public disableRemoteMode(): void {
		this.remote.disableRemoteMode();
	}

	public hasRemoteChunksQueued(): boolean {
		return this.remote.hasRemoteChunksQueued();
	}

	public pumpRemoteGeneration(): void {
		this.remote.pumpRemoteGeneration();
	}

	private getQueuedTerrainDeferLighting(chunk: Chunk): boolean {
		return this.terrainTasks.getDeferLighting(chunk);
	}

	private dispatchTerrainTaskToWorker(
		workerIndex: number,
		worker: ChunkWorker,
		chunk: Chunk,
	): boolean {
		if (!chunk) return false;
		const deferLighting = this.getQueuedTerrainDeferLighting(chunk);

		this.terrainTasks.remove(chunk);
		this.setWorkerTaskContext(
			workerIndex,
			TaskType.Terrain,
			chunk,
			-1,
			null,
			deferLighting,
		);
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
		this.remote.setRemoteChunkProvider(provider);
	}

	// -------------------------------------------------------------------------
	// Background LOD precompute scheduling
	// -------------------------------------------------------------------------

	public scheduleBackgroundLodPrecompute(
		centerChunkX: number,
		centerChunkY: number,
		centerChunkZ: number,
	): void {
		this.lodScanner.scan(
			this.lodScanHost,
			centerChunkX,
			centerChunkY,
			centerChunkZ,
		);
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

		this.distantTerrain.clearReady();
		for (let i = 0; i < this.workers.length; i++) {
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

	// Engine perf: dispatch-rate helper (a few calls per tick, not per voxel).
	// Stale-entry gates for dequeued Remesh/LodPrecompute/Relight tasks,
	// verbatim from processQueue. Returns false when the entry must be
	// skipped (caller `continue`s to the next queue entry).
	private validateDequeuedChunkTask(
		taskType: TaskType,
		taskChunk: Chunk | undefined,
		precomputeLod: number | undefined,
	): boolean {
		if (taskType === TaskType.Remesh) {
			const chunk = taskChunk;
			if (chunk === undefined) {
				return false;
			}

			if (!chunk.isLoaded) {
				this.remeshHeap.deletePriority(chunk);
				return false;
			}

			// No voxel data: meshing it would build a uniform-air mesh. This
			// MUST be checked before isCompletelyEmptyChunk below, because that
			// predicate is true for a released chunk (isUniform &&
			// uniformBlockId === 0) and would route it into
			// clearChunkMeshIfPresent — replacing a valid mesh with a hole.
			// Delegate to scheduleRemesh's hasVoxelData branch so the flags
			// heal through the single owner (cached mesh standing in, or
			// Dirty + queues dropped) instead of leaving a Queued flag with
			// no queue behind.
			if (!chunk.hasVoxelData) {
				this.remeshStaging.delete(chunk);
				this.remeshHeap.deletePriority(chunk);
				this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0, false);
				return false;
			}

			if (isCompletelyEmptyChunk(chunk) || isUniformSolidMeshSkippable(chunk)) {
				// Delegate to scheduleRemesh's empty path: it owns the rerun
				// latch, the heap removal, and the flag release.
				this.remeshStaging.delete(chunk);
				this.remeshHeap.deletePriority(chunk);
				this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0, false);
				return false;
			}

			// Stale heap entry: the mesh flags were cleared after this entry
			// was pushed (completed, cached, emptied, or pooled). Dispatching
			// would log an illegal beginRemesh from Clean/Superseded and waste
			// a worker build on a chunk whose mesh is already current.
			if (chunk.rerunRemeshAfterInflight) {
				// The in-flight result's ingest re-queues via
				// rerunAfterInflight; the heap entry itself is stale.
				this.remeshStaging.delete(chunk);
				this.remeshHeap.deletePriority(chunk);
				return false;
			}
			if (!chunk.remeshQueued) {
				this.remeshStaging.delete(chunk);
				this.remeshHeap.deletePriority(chunk);
				if (chunk.isDirty) {
					// Dirty still needs a mesh — heal back through the owner
					// instead of dispatching directly, so the flags and the
					// pending entry stay consistent (bumpRevision=false: no
					// new content change, just a flag/heap desync).
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0, false);
				}
				return false;
			}
			// Same-LOD build already in flight: duplicate dispatch while
			// Building. The in-flight result (or its stale-drop re-queue)
			// heals; a second concurrent build for the same LOD is pure waste.
			if (this.isSameLodRemeshInflight(chunk)) {
				this.remeshStaging.delete(chunk);
				this.remeshHeap.deletePriority(chunk);
				return false;
			}
		}

		if (taskType === TaskType.LodPrecompute && taskChunk) {
			if (
				!taskChunk.isLoaded ||
				!taskChunk.hasVoxelData ||
				precomputeLod === undefined ||
				taskChunk.hasCachedLODMesh(precomputeLod)
			) {
				return false;
			}
		}

		if (taskType === TaskType.Relight && taskChunk) {
			const lod = taskChunk.lodLevel ?? 0;

			if (!taskChunk.isLoaded) {
				return false;
			}

			// A relight re-reads the chunk's light grid in the worker, so it
			// requires voxel data exactly like a full remesh. This is the
			// only dispatch arm that had no hasVoxelData gate, which is
			// harmless today only because released chunks are never handed
			// here. Rejecting here (rather than falling through to
			// scheduleRemesh) keeps the voxel-less case from re-entering the
			// queue via that call.
			if (!taskChunk.hasVoxelData) {
				return false;
			}

			if (this.remeshStaging.has(taskChunk)) {
				return false;
			}

			const baseline = this.remeshFlight.getBaseline(taskChunk.id);

			if (
				baseline === undefined ||
				baseline !==
					RemeshFlightTracker.packBaseline(taskChunk.blockRevision, lod)
			) {
				this.scheduleRemesh(taskChunk, lod === 0, false);
				return false;
			}
		}

		return true;
	}

	// Engine perf: dispatch-rate helper (a few calls per tick, not per voxel).
	// Shared body for the Remesh / LodPrecompute / Relight dispatch arms:
	// context + in-flight key + post + record + stats, in the same order.
	// `kind` selects the post method (0 = full remesh, 1 = LOD remesh,
	// 2 = relight) with explicit branches — no per-dispatch closure alloc,
	// no megamorphic call. Callers still bump `dispatchedThisTick`.
	private dispatchRemeshLikeTask(
		workerIndex: number,
		taskType: TaskType,
		taskChunk: Chunk,
		lod: number,
		kind: 0 | 1 | 2,
	): void {
		const worker = this.workers[workerIndex];
		this.setWorkerTaskContext(workerIndex, taskType, taskChunk, lod);
		if (kind === 0) {
			// Route through the owner: Queued → Building. No flag writes (the
			// worker now owns the build); the host's isRemeshInFlight query
			// distinguishes the states from here on. Must run BEFORE the
			// in-flight key is added so the transition reads Queued, not
			// Building (idempotent either way).
			ChunkLifecycle.beginRemesh(taskChunk);
			this.remeshStaging.delete(taskChunk);
			this.remeshHeap.deletePriority(taskChunk);
		}
		this.remeshFlight.add(taskChunk, lod);
		if (kind === 0) {
			worker.postFullRemesh(taskChunk);
		} else if (kind === 1) {
			worker.postFullRemesh(taskChunk, lod);
		} else {
			worker.postRelightMesh(taskChunk);
		}
		this.recordWorkerDispatch(workerIndex);
		if (kind === 0) {
			this.debugStats.totalRemeshDispatches++;
		} else if (kind === 1) {
			this.debugStats.totalLodPrecomputeDispatches++;
		} else {
			this.debugStats.totalRelightDispatches++;
		}
	}

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
			let farTask: FarTileTask | undefined;
			let precomputeLod: number | undefined;
			let taskType: TaskType;

			if (this.terrainTasks.size > 0) {
				taskChunk = this.dequeueNextTerrainChunk();
				if (!taskChunk) continue;
				taskType = TaskType.Terrain;
			} else if (this.remeshHeap.length > 0) {
				taskChunk = this.remeshHeap.pop();
				if (!taskChunk) continue;
				taskType = TaskType.Remesh;
			} else if (
				this.distantTerrain.hasPending &&
				!this.distantTerrain.isInFlight &&
				this.isDistantTerrainWorkerReadyAndIdle()
			) {
				distantTask = this.distantTerrain.takeNext();

				if (!distantTask) continue;

				taskType = TaskType.DistantTerrain;
			} else if (this.lodPrecomputes.hasPending) {
				const task = this.lodPrecomputes.takeNext();
				if (!task) {
					continue;
				}

				const maybeChunk = task.chunk as Chunk | null | undefined;
				if (!maybeChunk) {
					continue;
				}

				taskChunk = maybeChunk;
				precomputeLod = task.lod;

				this.lodPrecomputes.deleteKey(
					packInflightKey(taskChunk.numericId, precomputeLod),
				);

				taskType = TaskType.LodPrecompute;
			} else if (this.relights.hasPending) {
				const maybeChunk = this.relights.takeNext();

				if (!maybeChunk) {
					continue;
				}

				taskChunk = maybeChunk;

				this.relights.deleteKey(
					packInflightKey(taskChunk.numericId, taskChunk.lodLevel ?? 0),
				);

				taskType = TaskType.Relight;
			} else if (this.farTiles.canDispatch) {
				farTask = this.farTiles.tryDequeue();

				if (!farTask) continue;

				taskType = TaskType.FarTile;
			} else {
				// Periodic compaction: drop consumed queue prefix.
				this.farTiles.compactIfNeeded();
				break;
			}

			if (!taskChunk && !distantTask && !farTask) break;

			if (!this.validateDequeuedChunkTask(taskType, taskChunk, precomputeLod)) {
				continue;
			}

			if (taskType === TaskType.DistantTerrain) {
				if (
					!this.isDistantTerrainWorkerReadyAndIdle() ||
					!this._swapPreferredIdleWorkerToFront(
						this.distantTerrain.assignedWorker,
					)
				) {
					this.distantTerrain.releaseBack();
					break;
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
					this.terrainTasks.add(taskChunk);
					this._markWorkerIdle(workerIndex);

					if (this.getEffectiveIdleWorkerCount() <= 1) {
						break;
					}

					continue;
				}

				this.dispatchTerrainTaskToWorker(workerIndex, worker, taskChunk);
				this.recordWorkerDispatch(workerIndex);
				this.debugStats.totalTerrainDispatches++;
				dispatchedThisTick++;
			} else if (taskType === TaskType.Remesh) {
				const lod = taskChunk!.lodLevel ?? 0;
				this.dispatchRemeshLikeTask(workerIndex, taskType, taskChunk!, lod, 0);
				dispatchedThisTick++;
			} else if (taskType === TaskType.LodPrecompute) {
				const lod = precomputeLod!;
				this.dispatchRemeshLikeTask(workerIndex, taskType, taskChunk!, lod, 1);
				dispatchedThisTick++;
			} else if (taskType === TaskType.Relight) {
				const lod = taskChunk!.lodLevel ?? 0;
				this.dispatchRemeshLikeTask(workerIndex, taskType, taskChunk!, lod, 2);
				dispatchedThisTick++;
			} else if (taskType === TaskType.FarTile && farTask) {
				this.setWorkerTaskContext(workerIndex, taskType);
				this.farTiles.markDispatched();

				worker.postGenerateFarTile(
					farTask.requestId,
					farTask.levelIndex,
					farTask.tileX,
					farTask.tileZ,
				);

				this.recordWorkerDispatch(workerIndex);
				dispatchedThisTick++;
			} else {
				this.setWorkerTaskContext(
					workerIndex,
					taskType,
					null,
					-1,
					distantTask ?? null,
				);
				this.distantTerrain.markInFlight();

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

		this.dispatchAccounting.commitTick(dispatchedThisTick);

		this.lodPrecomputes.compactIfNeeded();
		this.relights.compactIfNeeded();

		this.idleWorkers.maybeCompact();

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
		this.remote.onChunkDisposed(chunk, remoteKey);

		// Map cleanups.
		this.remeshStaging.delete(chunk);
		this.remeshHeap.remove(chunk);
		this.terrainTasks.remove(chunk);
		this.deferredLight.invalidate(chunk);
		this.remeshFlight.deleteBaseline(chunk.id);
		this.debugLightSeedLengths.delete(chunk.id);

		// Lazy tombstone cleanup for arrays. Do not splice here, because unload
		// storms would become O(n²). Queue drains validate live chunks and compact.
		for (let lod = 0; lod < 16; lod++) {
			const key = packInflightKey(chunk.numericId, lod);
			this.lodPrecomputes.deleteKey(key);
			this.relights.deleteKey(key);
		}
		this.remeshFlight.clearAll(chunk);

		for (let i = 0; i < this.workerTaskContext.length; i++) {
			const ctx = this.workerTaskContext[i];

			if (
				ctx &&
				(ctx.taskType === TaskType.Remesh ||
					ctx.taskType === TaskType.LodPrecompute ||
					ctx.taskType === TaskType.Relight) &&
				ctx.chunk === chunk
			) {
				this.remeshFlight.clear(chunk, ctx.lod);
			}
		}

		this.lodPrecomputes.invalidate(
			(item) => item.chunk === chunk,
			(item) => ({ chunk: null, lod: item.lod }),
		);

		this.relights.invalidate(
			(item) => item === chunk,
			() => null,
			true,
		);
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
