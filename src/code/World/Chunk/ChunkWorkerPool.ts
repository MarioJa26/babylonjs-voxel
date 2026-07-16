import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import { shapeInitPromise } from "../Shape/BlockShapes";
import { packChunkKey } from "../Storage/ChunkKey";
import { serializeMeshPair } from "../Storage/MeshSerializer";
import { OpfsClient } from "../Storage/OpfsClient";
import { WorldStorage } from "../WorldStorage";
import { addChunkDisposeHook, Chunk } from "./Chunk";
import { createMeshFromData } from "./ChunkMesher";
import { ChunkWorker } from "./chunkWorker";
import { RingBuffer } from "./DataStructures/RingBuffer";
import {
	type DistantTerrainGeneratedMessage,
	type DistantTerrainTask,
	type FullMeshMessage,
	type LightDirtyMessage,
	type MeshWorkerResponse,
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

export type ChunkWorkerPoolDebugStats = {
	workerCount: number;
	idleWorkers: number;
	busyWorkers: number;
	peakBusyWorkers: number;
	remeshQueueLength: number;
	terrainQueueLength: number;
	lodPrecomputeQueueLength: number;
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
	totalTerrainDispatches: number;
	totalRemeshDispatches: number;
	totalLodPrecomputeDispatches: number;
	totalDistantDispatches: number;
	lightDirtyQueueLength: number;
	lightDirtyProcessedLastFrame: number;
	lightDirtyProcessedTotal: number;
	lightDispatches: number;
	workerDispatchCounts: number[];
	lastDispatchWorkerIndices: number[];
};

// ---------------------------------------------------------------------------
// Packed in-flight key: (chunkId << 4n | BigInt(lod)) avoids string alloc.
// LOD values are expected to be 0–15 so 4 bits is sufficient.
// ---------------------------------------------------------------------------
const _lodBigInts: bigint[] = [];
for (let i = 0; i < 16; i++) _lodBigInts[i] = BigInt(i);

function packInflightKey(chunkId: bigint, lod: number): bigint {
	return (chunkId << 4n) | _lodBigInts[lod & 0xf];
}

type WorkerTaskContext = {
	taskType: TaskType;
	chunk?: Chunk;
	lod?: number;
	distantTask?: DistantTerrainTask;
	terrainDeferLighting?: boolean;
} | null;

export class ChunkWorkerPool {
	private static instance: ChunkWorkerPool | undefined;
	private static readonly WORKER_ERROR_COOLDOWN_MS = 120;
	private static readonly MIN_AUTO_POOL_SIZE = 2;
	private static readonly MAX_AUTO_POOL_SIZE = 12;
	private static readonly DEFERRED_LIGHTING_BUDGET_MS = 2.5;
	private static readonly DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME = 48;
	private static readonly LAST_DISPATCH_RING_SIZE = 24;

	private workers: ChunkWorker[] = [];
	private workerTaskContext: WorkerTaskContext[] = [];

	private distantTerrainSharedInit: {
		positionsBuffer: SharedArrayBuffer;
		normalsBuffer: SharedArrayBuffer;
		surfaceTilesBuffer: SharedArrayBuffer;
		radius: number;
		gridStep: number;
	} | null = null;

	private workerRestartAtMs: number[] = [];

	// --- Remesh queue: sorted array, insertion-sort maintained ---
	private taskQueue: Chunk[] = [];
	private taskQueueReadIdx = 0;
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

	private distantTerrainReadyWorkers = new Set<number>();
	private distantTerrainTaskQueue: DistantTerrainTask[] = [];
	private distantTerrainTaskQueueReadIdx = 0;
	private lodPrecomputeQueue: Array<{ chunk: Chunk; lod: number }> = [];
	private lodPrecomputeQueueReadIdx = 0;
	private pendingLodPrecomputeKeys = new Set<bigint>();
	private lastPrecomputeScheduleTs = 0;

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
	private remeshFlushScheduled = false;
	private processQueuePumpScheduled = false;
	private meshDrainScheduled = false;

	private pendingRemeshSaveIds = new Set<bigint>();
	private pendingRemeshSaveTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly REMESH_SAVE_DEBOUNCE_MS = 500;

	private inFlightRemeshKeys = new Set<bigint>();
	private rerunRemeshAfterInflight = new Map<bigint, boolean>();

	private distantTerrainInFlight = false;
	private nextDistantTerrainRequestId = 1;

	// ---------------------------------------------------------------------------
	// OPFS mesh cache (replaces IDB mesh persistence)
	// ---------------------------------------------------------------------------
	private opfsClient: OpfsClient | null = null;
	private opfsReady = false;
	private opfsInitPromise: Promise<void> | null = null;
	private opfsFlushCounter = 0;

	// ---------------------------------------------------------------------------
	// Static scratch buffers — avoids per-call allocation on hot paths
	// ---------------------------------------------------------------------------
	private static readonly _flushPendingScratch: Array<[Chunk, boolean]> = [];
	private static readonly _queryScratch: Chunk[] = [];
	private static readonly _dedupScratch: Set<number> = new Set();

	// Pre-bound methods — avoids per-call .bind(this) allocation
	private readonly _boundScheduleRemesh = this.scheduleRemesh.bind(this);
	private readonly _compareRemeshPriorityFn = (
		[ca, pa]: [Chunk, boolean],
		[cb, pb]: [Chunk, boolean],
	) => this.compareRemeshPriority(ca, pa, cb, pb);
	// SoA scratch for scheduleBackgroundLodPrecompute — avoids per-candidate
	// object allocation.  Indices are grown via .push() to stay on
	// PACKED_SMI_ELEMENTS (array.length = N followed by fill triggers a
	// one-way HOLEY transition in V8).
	private static readonly _lodCandidateChunks: Chunk[] = [];
	private static readonly _lodCandidateLods: number[] = [];
	private static readonly _lodCandidateScores: number[] = [];
	private static readonly _lodCandidateIndices: number[] = [];

	// ---------------------------------------------------------------------------
	// Light-worker integration state
	// ---------------------------------------------------------------------------

	private nextLightSeqCounter = 1;
	private lightDirtyQueue: { seq: number; dirtySlots: Uint32Array }[] = [];
	private lightDirtyQueueReadIdx = 0;
	private lightDirtyPumpScheduled = false;
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
		totalTerrainDispatches: 0,
		totalRemeshDispatches: 0,
		totalLodPrecomputeDispatches: 0,
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
			this.taskQueueReadIdx < this.taskQueue.length ||
			this.lodPrecomputeQueueReadIdx < this.lodPrecomputeQueue.length ||
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
			requestAnimationFrame(() => {
				this.processQueuePumpScheduled = false;
				this.processQueue();
			});
		}
	}

	private updateQueueDebugStats(): void {
		const stats = this.debugStats;
		stats.workerCount = this.workers.length;
		stats.idleWorkers = this.getEffectiveIdleWorkerCount();
		const busy = Math.max(0, stats.workerCount - stats.idleWorkers);
		stats.busyWorkers = busy;
		if (busy > stats.peakBusyWorkers) stats.peakBusyWorkers = busy;
		stats.remeshQueueLength = this.taskQueue.length - this.taskQueueReadIdx;
		stats.terrainQueueLength = this.terrainTaskQueue.size;
		stats.lodPrecomputeQueueLength =
			this.lodPrecomputeQueue.length - this.lodPrecomputeQueueReadIdx;
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
			packInflightKey(chunk.id, chunk.lodLevel ?? 0),
		);
	}

	private clearInflightRemeshByMessage(chunkId: bigint, lod: number): void {
		this.inFlightRemeshKeys.delete(packInflightKey(chunkId, lod));
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
			const swapped = this.idleWorkerIndices[liveEnd]!;
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
		const workerIndex = this.idleWorkerIndices[this._idleReadIdx]!;
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
			this.idleWorkerIndexPositions.set(this.idleWorkerIndices[i]!, i);
		}
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

		if (
			(context?.taskType === TaskType.Remesh ||
				context?.taskType === TaskType.LodPrecompute) &&
			context.chunk &&
			typeof context.lod === "number"
		) {
			this.inFlightRemeshKeys.delete(
				packInflightKey(context.chunk.id, context.lod),
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
			context?.taskType === TaskType.LodPrecompute &&
			context.chunk &&
			typeof context.lod === "number"
		) {
			const key = packInflightKey(context.chunk.id, context.lod);
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
				this.distantTerrainTaskQueue.unshift(context.distantTask);
			}
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

			this.workers[workerIndex] = replacement;
			this.workerRestartAtMs[workerIndex] = performance.now();
			this.setWorkerTaskContext(workerIndex, null);

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
	 * worker (onLightChunkLoaded posts LightRegisterChunk synchronously
	 * in the same loadFromStorage call, before the next rAF).
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
		return this.workers[0]!;
	}

	private broadcastLightRegister(chunk: Chunk): void {
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

	private broadcastLightUnregister(chunk: Chunk): void {
		this.getLightWorker().postLightUnregisterChunk(chunk.id);
		this.lightSlotPendingSeq.delete(chunk.lightHeaderSlot);
	}

	private onLightChunkLoaded(chunk: Chunk): void {
		this.lightChunkByHeaderSlot.set(chunk.lightHeaderSlot, chunk);
		this.broadcastLightRegister(chunk);
	}

	private onLightChunkLayoutChanged(chunk: Chunk): void {
		this.broadcastLightUpdateBuffers(chunk);
	}

	private onLightChunkDisposed(chunk: Chunk): void {
		this.lightChunkByHeaderSlot.delete(chunk.lightHeaderSlot);
		this.broadcastLightUnregister(chunk);
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
			const entry = this.lightDirtyQueue[this.lightDirtyQueueReadIdx++]!;
			const slots = entry.dirtySlots;
			for (let i = 0; i < slots.length; i++) {
				const slot = slots[i]!;
				const prev = slotMap.get(slot) ?? 0;
				if (entry.seq > prev) slotMap.set(slot, entry.seq);
			}
			processed++;
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
				this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
				slotMap.delete(slot);
			} else if (!chunk) {
				slotMap.delete(slot);
			}
		}
	};

	private scheduleLightDirtyPump(): void {
		if (this.lightDirtyPumpScheduled) return;
		this.lightDirtyPumpScheduled = true;
		requestAnimationFrame(this.processLightDirtyQueue);
	}

	// -------------------------------------------------------------------------
	// Constructor
	// -------------------------------------------------------------------------

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

		Chunk.onLightChunkLoaded = (chunk) => this.onLightChunkLoaded(chunk);
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

		// Fire-and-forget OPFS init; fall back gracefully if unavailable
		this.opfsInitPromise = OpfsClient.create()
			.then((client: OpfsClient) => {
				this.opfsClient = client;
				this.opfsReady = true;
			})
			.catch((err: any) => {
				console.warn("[ChunkWorkerPool] OPFS unavailable:", err);
				this.opfsReady = false;
			});

		// Fire-and-forget: once block shapes finish loading, precompute the
		// per-face closed-mask lookup table and send it to the light worker
		// so it can correctly handle non-full blocks (slabs, stairs, etc.).
		shapeInitPromise
			.then(() => {
				const lut = Chunk.precomputeClosedFaceMasks();
				const sab = new SharedArrayBuffer(lut.byteLength);
				new Uint8Array(sab).set(lut);
				this.closedFaceMaskBuffer = sab;
				this.workers[0]?.postLightSetClosedFaceMask(sab);
			})
			.catch(() => {
				/* shapes failed to load; worker keeps cube fallback */
			});
	}

	public async ensureOpfsReady(): Promise<OpfsClient | null> {
		if (this.opfsReady && this.opfsClient) return this.opfsClient;
		if (this.opfsInitPromise) {
			await this.opfsInitPromise;
		}
		return this.opfsReady ? this.opfsClient : null;
	}

	/** Public accessor for the OPFS client (null if not yet initialised). */
	public getOpfsClient(): OpfsClient | null {
		return this.opfsReady ? this.opfsClient : null;
	}

	// -------------------------------------------------------------------------
	// Mesh helpers
	// -------------------------------------------------------------------------

	private isCompletelyEmptyChunk(chunk: Chunk): boolean {
		return chunk.isUniform && chunk.uniformBlockId === 0;
	}

	private clearChunkMeshIfPresent(chunk: Chunk): void {
		if (
			chunk.mesh ||
			chunk.transparentMesh ||
			chunk.opaqueMeshData ||
			chunk.transparentMeshData
		) {
			createMeshFromData(chunk, { opaque: null, transparent: null });
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
			// Uses a reusable scratch Set to avoid per-merge allocation.
			const existingLen = existing.length;
			const seen = ChunkWorkerPool._dedupScratch;
			seen.clear();
			for (let i = 0; i < existingLen; i++) {
				seen.add(existing.queue[i]!);
			}
			const merged = new Uint16Array(existingLen + seedLength);
			merged.set(existing.queue.subarray(0, existingLen));
			let writeIdx = existingLen;
			for (let i = 0; i < seedLength; i++) {
				const val = seedQueue[i]!;
				if (!seen.has(val)) {
					merged[writeIdx++] = val;
				}
			}
			existing.queue = merged.subarray(0, writeIdx);
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
		requestAnimationFrame(() => {
			this.deferredLightingPumpScheduled = false;
			this.processDeferredLightingQueue();
		});
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
				this.deferredLightingQueue[this.deferredLightingQueueReadIdx++]!;
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
		if (this.meshDrainScheduled) return;
		this.meshDrainScheduled = true;
		requestAnimationFrame(() => {
			this.meshDrainScheduled = false;
			this.processMeshQueueLoop();
		});
	};

	private processMeshQueueLoop = () => {
		const start = performance.now();
		let processed = 0;
		let iterCount = 0;
		while (
			this.meshResultQueueReadIdx < this.meshResultQueue.length &&
			((iterCount++ & 15) !== 0 || performance.now() - start < 5)
		) {
			const data = this.meshResultQueue[this.meshResultQueueReadIdx++]!;
			processed++;
			const { chunkId, lod, opaque, transparent } = data;
			const chunk = this.resolveChunkByMessageId(chunkId);
			if (chunk) {
				if (data.meshRevision !== chunk.meshRevision) {
					// A newer edit/remesh request exists. Never expose this result.
					chunk.isDirty = true;
					chunk.remeshQueued = false;
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0, false);
					continue;
				}
				if (shouldSkipLodForChunk(chunk, lod)) {
					// Drop stale/old underground LOD2+ results.
					normalizeChunkLod(chunk);
					chunk.isDirty = true;
					chunk.remeshQueued = false;
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
					continue;
				}

				const canCacheMesh =
					lod === 0 || hasStableVoxelNeighborsForCachedMesh(chunk);

				if (canCacheMesh) {
					chunk.setCachedLODMesh(lod, {
						opaque: opaque ?? null,
						transparent: transparent ?? null,
					});
				}

				if (this.opfsReady && this.opfsClient && canCacheMesh) {
					const bytes = serializeMeshPair(opaque, transparent);
					if (bytes) {
						const key = packChunkKey(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
						void this.opfsClient
							.writeMesh(key, lod, bytes)
							.catch((err: any) => {
								console.error(
									`[ChunkWorkerPool] OPFS mesh write failed for chunk ${chunkId} (key=${key}, lod=${lod}, bytes=${bytes.length}):`,
									err,
								);
							});
					}
				}
				if ((chunk.lodLevel ?? 0) === lod) {
					createMeshFromData(chunk, { opaque, transparent });
					chunk.isDirty = false;
					chunk.remeshQueued = false;
					this.queuePostRemeshSave(chunk);
				} else {
					if (!canCacheMesh) {
						chunk.setCachedLODMesh(lod, { opaque, transparent });
					}
					chunk.isDirty = true;
					chunk.remeshQueued = false;
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
				}
			}
		}

		flushDirtyMergedGroups();

		if (processed > 0 && this.opfsReady && this.opfsClient) {
			this.opfsFlushCounter++;
			if (this.opfsFlushCounter >= 60) {
				this.opfsFlushCounter = 0;
				void this.opfsClient.flush().catch((err: any) => {
					console.warn("[ChunkWorkerPool] OPFS flush failed:", err);
				});
			}
		}

		if (
			this.meshResultQueueReadIdx > 64 &&
			this.meshResultQueueReadIdx * 2 > this.meshResultQueue.length
		) {
			this.meshResultQueue.copyWithin(0, this.meshResultQueueReadIdx);
			this.meshResultQueue.length -= this.meshResultQueueReadIdx;
			this.meshResultQueueReadIdx = 0;
		}

		this.debugStats.lastMeshProcessed = processed;
		this.debugStats.totalMeshProcessed += processed;
		this.debugStats.lastMeshDrainMs = performance.now() - start;
		this.updateQueueDebugStats();

		if (this.meshResultQueueReadIdx < this.meshResultQueue.length) {
			requestAnimationFrame(this.processMeshQueueLoop);
		}
	};

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

		if (this.isCompletelyEmptyChunk(chunk)) {
			if (inflight) {
				this.rerunRemeshAfterInflight.set(chunk.id, true);
			}
			this.pendingRemeshMap.delete(chunk);
			this.taskQueuePriority.delete(chunk);
			this.clearChunkMeshIfPresent(chunk);
			return;
		}

		if (inflight) {
			this.rerunRemeshAfterInflight.set(chunk.id, true);
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
		requestAnimationFrame(() => {
			this.remeshFlushScheduled = false;
			this.flushPendingRemeshQueue();
		});
	}

	private flushPendingRemeshQueue(): void {
		if (this.pendingRemeshMap.size === 0) return;

		const pending = ChunkWorkerPool._flushPendingScratch;
		pending.length = 0;
		for (const entry of this.pendingRemeshMap) {
			pending.push(entry);
		}
		this.pendingRemeshMap.clear();

		pending.sort(this._compareRemeshPriorityFn);

		for (let i = 0; i < pending.length; i++) {
			const [chunk, priority] = pending[i]!;
			if (!chunk.isLoaded) continue;
			if (this.isCompletelyEmptyChunk(chunk)) {
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
		if (!cached?.opaque && !cached?.transparent) return false;

		createMeshFromData(chunk, {
			opaque: cached.opaque,
			transparent: cached.transparent,
		});
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
				const data = event.data;
				const type = data.type;

				if (type === WorkerTaskType.WorkerReady) {
					this.scheduleProcessQueuePump();
					return;
				}

				if (type === WorkerTaskType.InitDistantTerrainShared) {
					this.distantTerrainReadyWorkers.add(workerIndex);
					this.processQueue();
					return;
				}

				if (type === WorkerTaskType.LightDirty) {
					const dirty = data as LightDirtyMessage;
					this.lightDirtyQueue.push({
						seq: dirty.seq,
						dirtySlots: dirty.dirtySlots,
					});
					this.scheduleLightDirtyPump();
					return;
				}

				if (type === WorkerTaskType.GenerateFullMesh) {
					const meshData = data as FullMeshMessage;
					this.clearInflightRemeshByMessage(meshData.chunkId, meshData.lod);
					const pending =
						this.meshResultQueue.length - this.meshResultQueueReadIdx;
					if (
						pending >= ChunkWorkerPool.MAX_MESH_QUEUE &&
						this.meshResultQueueReadIdx < this.meshResultQueue.length
					) {
						this.meshResultQueue[this.meshResultQueueReadIdx++] = meshData;
					} else {
						this.meshResultQueue.push(meshData);
					}
					if (!this.meshDrainScheduled) {
						this.meshDrainScheduled = true;
						requestAnimationFrame(() => {
							this.meshDrainScheduled = false;
							this.processMeshQueueLoop();
						});
					}

					const resolvedChunk = this.resolveChunkByMessageId(meshData.chunkId);
					if (
						resolvedChunk &&
						this.rerunRemeshAfterInflight.get(resolvedChunk.id)
					) {
						this.rerunRemeshAfterInflight.delete(resolvedChunk.id);
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
							return;
						}

						scheduleChunkAndNeighborsRemesh(chunk, this._boundScheduleRemesh);
						maybeRemeshNeighborsNowStable(chunk, this._boundScheduleRemesh);

						if (needsLightRefinement) {
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
					}
				} else if (type === WorkerTaskType.GenerateDistantTerrain_Generated) {
					this.onDistantTerrainGenerated?.(
						data as DistantTerrainGeneratedMessage,
					);
					this.distantTerrainInFlight = false;
				}
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

	private makeMeshMessageHandler(
		workerIndex: number,
		getWorker: () => ChunkWorker | undefined,
	) {
		return (event: MessageEvent<MeshWorkerResponse>) => {
			let failed = false;
			const data = event.data as MeshWorkerResponse & { type?: string };
			const type = data.type as string | undefined;

			try {
				if (type === (WorkerTaskType.WorkerReady as unknown as string)) {
					return;
				}

				if (type === ("HEARTBEAT" as string)) {
					const seq = (data as unknown as { seq?: number }).seq ?? 0;
					this._lastHeartbeatSeq[workerIndex] = seq;
					return;
				}

				if (type !== (WorkerTaskType.GenerateFullMesh as unknown as string)) {
					console.warn(
						`Ignoring unexpected mesh worker message from ${workerIndex}:`,
						data,
					);
					return;
				}

				this.clearInflightRemeshByMessage(data.chunkId, data.lod);

				const fullMeshMessage = data as unknown as FullMeshMessage;
				const pending2 =
					this.meshResultQueue.length - this.meshResultQueueReadIdx;
				if (
					pending2 >= ChunkWorkerPool.MAX_MESH_QUEUE &&
					this.meshResultQueueReadIdx < this.meshResultQueue.length
				) {
					this.meshResultQueue[this.meshResultQueueReadIdx++] = fullMeshMessage;
				} else {
					this.meshResultQueue.push(fullMeshMessage);
				}
				if (!this.meshDrainScheduled) {
					this.meshDrainScheduled = true;
					requestAnimationFrame(() => {
						this.meshDrainScheduled = false;
						this.processMeshQueueLoop();
					});
				}

				const resolvedChunk = this.resolveChunkByMessageId(data.chunkId);
				if (
					resolvedChunk &&
					this.rerunRemeshAfterInflight.get(resolvedChunk.id)
				) {
					this.rerunRemeshAfterInflight.delete(resolvedChunk.id);
					this.scheduleRemesh(
						resolvedChunk,
						(resolvedChunk.lodLevel ?? 0) === 0,
						false,
					);
				}
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

	private compactTaskQueue(): void {
		if (this.taskQueueReadIdx === 0) return;
		if (this.taskQueueReadIdx > this.taskQueue.length >> 1) {
			this.taskQueue.copyWithin(0, this.taskQueueReadIdx);
			this.taskQueue.length -= this.taskQueueReadIdx;
			this.taskQueueReadIdx = 0;
		}
	}

	private insertChunkIntoRemeshQueue(chunk: Chunk, priority: boolean): void {
		const existingPriority = this.taskQueuePriority.get(chunk);
		if (existingPriority !== undefined) {
			if (priority && !existingPriority) {
				this.taskQueuePriority.set(chunk, true);
			}
			return;
		}

		this.taskQueuePriority.set(chunk, priority);
		this.compactTaskQueue();

		let lo = this.taskQueueReadIdx;
		let hi = this.taskQueue.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const queued = this.taskQueue[mid]!;
			const queuedPriority = this.taskQueuePriority.get(queued) ?? false;
			if (
				this.compareRemeshPriority(chunk, priority, queued, queuedPriority) < 0
			) {
				hi = mid;
			} else {
				lo = mid + 1;
			}
		}
		this.taskQueue.splice(lo, 0, chunk);
	}

	// -------------------------------------------------------------------------
	// Terrain scheduling
	// -------------------------------------------------------------------------

	public scheduleTerrainGeneration(chunk: Chunk, deferLighting = true): void {
		if (!chunk) return;
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
		chunks: Chunk[],
		deferLighting = true,
	): void {
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i]!;
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
		if (throttleMs > 0 && now - this.lastPrecomputeScheduleTs < throttleMs)
			return;
		this.lastPrecomputeScheduleTs = now;

		const horizontalRadius =
			SETTING_PARAMS.RENDER_DISTANCE +
			SETTING_PARAMS.LOD_PRECOMPUTE_HORIZONTAL_OFFSET;
		const verticalRadius =
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE +
			SETTING_PARAMS.LOD_PRECOMPUTE_VERTICAL_OFFSET;
		const targetLods = [2, 3];

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

		for (let _qi = 0; _qi < queryScratch.length; _qi++) {
			const chunk = queryScratch[_qi]!;
			if (!chunk.hasVoxelData || chunk.isDirty || !chunk.isModified) continue;

			// Underground chunks currently only support LOD0/LOD1.
			// Do not precompute LOD2/LOD3 for them.
			if (chunk.chunkY < 0) continue;

			const hDist = Math.max(
				Math.abs(chunk.chunkX - centerChunkX),
				Math.abs(chunk.chunkZ - centerChunkZ),
			);
			const vDist = Math.abs(chunk.chunkY - centerChunkY);
			if (hDist > horizontalRadius || vDist > verticalRadius) continue;

			for (let li = 0; li < targetLods.length; li++) {
				const lod = targetLods[li]!;
				if (chunk.hasCachedLODMesh(lod)) continue;
				const key = packInflightKey(chunk.id, lod);
				if (this.pendingLodPrecomputeKeys.has(key)) continue;
				candidateChunks.push(chunk);
				candidateLods.push(lod);
				candidateScores.push(hDist * 100 + vDist * 10 + lod);
			}
		}

		const candidateCount = candidateChunks.length;
		if (candidateCount === 0) return;

		// Sort via an index array so we never touch the parallel data arrays
		// during the sort — only the lightweight integer indices move.
		for (let i = 0; i < candidateCount; i++) candidateIndices[i] = i;
		candidateIndices.length = candidateCount;
		candidateIndices.sort((a, b) => candidateScores[a] - candidateScores[b]);

		const maxEnqueue = Math.max(
			1,
			SETTING_PARAMS.LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE | 0,
		);
		let added = 0;
		for (let i = 0; i < candidateCount && added < maxEnqueue; i++) {
			const idx = candidateIndices[i]!;
			const chunk = candidateChunks[idx]!;
			const lod = candidateLods[idx]!;
			const key = packInflightKey(chunk.id, lod);
			if (this.pendingLodPrecomputeKeys.has(key)) continue;
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
			let precomputeLod: number | undefined;
			let taskType: TaskType;

			if (this.terrainTaskQueue.size > 0) {
				taskChunk = this.dequeueNextTerrainChunk();
				taskType = TaskType.Terrain;
			} else if (this.taskQueueReadIdx < this.taskQueue.length) {
				taskChunk = this.taskQueue[this.taskQueueReadIdx++]!;
				taskType = TaskType.Remesh;
			} else if (
				this.distantTerrainTaskQueueReadIdx <
					this.distantTerrainTaskQueue.length &&
				!this.distantTerrainInFlight &&
				this.distantTerrainReadyWorkers.size > 0
			) {
				distantTask =
					this.distantTerrainTaskQueue[this.distantTerrainTaskQueueReadIdx++]!;
				taskType = TaskType.DistantTerrain;
			} else if (
				this.lodPrecomputeQueueReadIdx < this.lodPrecomputeQueue.length
			) {
				const task = this.lodPrecomputeQueue[this.lodPrecomputeQueueReadIdx++]!;
				taskChunk = task.chunk;
				precomputeLod = task.lod;
				this.pendingLodPrecomputeKeys.delete(
					packInflightKey(task.chunk.id, task.lod),
				);
				taskType = TaskType.LodPrecompute;
			} else {
				break;
			}

			if (!taskChunk && !distantTask) break;

			// Per-type pre-dispatch validation.
			if (taskType === TaskType.Remesh && taskChunk) {
				// Skip disposed chunks — onChunkDisposed clears pendingRemeshMap and
				// taskQueuePriority but leaves stale entries in taskQueue to avoid
				// the O(n) splice.  The isLoaded check is the tombstone guard.
				if (!taskChunk.isLoaded) {
					this.taskQueuePriority.delete(taskChunk);
					continue;
				}
				if (this.isCompletelyEmptyChunk(taskChunk)) {
					this.clearChunkMeshIfPresent(taskChunk);
					this.pendingRemeshMap.delete(taskChunk);
					this.taskQueuePriority.delete(taskChunk);
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

			// For distantTerrain, find a ready idle worker within the live portion.
			if (taskType === TaskType.DistantTerrain) {
				let readyIdleIndex = -1;
				for (
					let i = this._idleReadIdx;
					i < this.idleWorkerIndices.length;
					i++
				) {
					if (this.distantTerrainReadyWorkers.has(this.idleWorkerIndices[i]!)) {
						readyIdleIndex = i;
						break;
					}
				}
				if (readyIdleIndex === -1) {
					this.distantTerrainTaskQueueReadIdx--;
					break;
				}
				// Swap the ready worker to the front of the live portion so
				// _consumeNextIdleWorker picks it up.
				if (readyIdleIndex !== this._idleReadIdx) {
					const frontIdx = this._idleReadIdx;
					const frontWorker = this.idleWorkerIndices[frontIdx]!;
					const readyWorker = this.idleWorkerIndices[readyIdleIndex]!;
					this.idleWorkerIndices[frontIdx] = readyWorker;
					this.idleWorkerIndices[readyIdleIndex] = frontWorker;
					this.idleWorkerIndexPositions.set(readyWorker, frontIdx);
					this.idleWorkerIndexPositions.set(frontWorker, readyIdleIndex);
				}
			}

			// Consume the next idle worker — this clears it from idleWorkerSet
			// and idleWorkerIndexPositions atomically so swap-remove in
			// handleWorkerFailure can never see a stale consumed entry.
			const workerIndex = this._consumeNextIdleWorker();
			if (workerIndex === -1) break;

			const worker = this.workers[workerIndex]!;

			try {
				if (taskType === TaskType.Terrain) {
					if (!taskChunk) {
						this._markWorkerIdle(workerIndex);
						continue;
					}
					this.dispatchTerrainTaskToWorker(workerIndex, worker, taskChunk);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalTerrainDispatches++;
					dispatchedThisTick++;
				} else if (taskType === TaskType.Remesh) {
					normalizeChunkLod(taskChunk!);

					const lod = taskChunk?.lodLevel ?? 0;
					this.setWorkerTaskContext(workerIndex, {
						taskType,
						chunk: taskChunk,
						lod,
					});
					this.pendingRemeshMap.delete(taskChunk!);
					this.taskQueuePriority.delete(taskChunk!);
					this.inFlightRemeshKeys.add(packInflightKey(taskChunk!.id, lod));
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
					this.inFlightRemeshKeys.add(packInflightKey(taskChunk!.id, lod));
					worker.postFullRemesh(taskChunk!, lod);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalLodPrecomputeDispatches++;
					dispatchedThisTick++;
				} else {
					// distantTerrain
					this.setWorkerTaskContext(workerIndex, { taskType, distantTask });
					this.distantTerrainInFlight = true;
					worker.postGenerateDistantTerrain(
						distantTask!.requestId,
						distantTask!.centerChunkX,
						distantTask!.centerChunkZ,
						distantTask!.radius,
						distantTask!.gridStep,
					);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalDistantDispatches++;
					dispatchedThisTick++;
				}
			} catch (dispatchError) {
				console.error(
					`Failed to dispatch worker task (${taskType}) on worker ${workerIndex}`,
					dispatchError,
				);
				this.handleWorkerFailure(workerIndex, dispatchError);
			}
		}

		this.debugStats.lastDispatchCount = dispatchedThisTick;
		this.debugStats.totalDispatchCount += dispatchedThisTick;

		// Compact lodPrecomputeQueue when read-index exceeds threshold.
		if (
			this.lodPrecomputeQueueReadIdx > 64 &&
			this.lodPrecomputeQueueReadIdx * 2 > this.lodPrecomputeQueue.length
		) {
			this.lodPrecomputeQueue.copyWithin(0, this.lodPrecomputeQueueReadIdx);
			this.lodPrecomputeQueue.length -= this.lodPrecomputeQueueReadIdx;
			this.lodPrecomputeQueueReadIdx = 0;
		}

		// Compact idleWorkerIndices when the consumed prefix is large enough.
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

		// Map cleanups (O(1) each).
		this.pendingRemeshMap.delete(chunk);
		this.taskQueuePriority.delete(chunk);
		this.terrainTaskDeferLighting.delete(chunk.id);
		this.deferredLightingQueuedIds.delete(chunk.id);
		this.deferredLightingSeedStates.delete(chunk.id);
		this.rerunRemeshAfterInflight.delete(chunk.id);

		// Set cleanup.
		this.terrainTaskQueue.delete(chunk);

		// taskQueue, deferredLightingQueue, and lodPrecomputeQueue are intentionally
		// NOT spliced here.  Splicing is O(n) and causes O(n²) behaviour during
		// large unload storms.  Instead, stale entries are skipped at dequeue time
		// in processQueue and processDeferredLightingQueue via isLoaded / seedState
		// guards.  lodPrecomputeQueue entries are also skipped via the isLoaded guard
		// in processQueue, so we only clear the tracking set here.

		// pendingLodPrecomputeKeys uses packInflightKey(chunkId, lod).
		// LOD values are 0–15, so 16 deletes is cheap.
		for (let lod = 0; lod < 16; lod++) {
			this.pendingLodPrecomputeKeys.delete(packInflightKey(chunk.id, lod));
		}
	}
	public static async teardownForHmr(): Promise<void> {
		const instance = ChunkWorkerPool.instance;
		if (!instance) return;
		ChunkWorkerPool.instance = undefined;
		const client = instance.opfsClient;
		if (!client) return;
		try {
			await client.close();
		} catch {
			// terminate() was already called inside close()
		}
	}

	private static readonly MAX_MESH_QUEUE = 512;
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

// Re-export extracted utilities for backward compatibility
export {
	clampLodForChunk,
	normalizeChunkLod,
	shouldSkipLodForChunk,
} from "./Worker/LODUtilities";
export {
	hasStableVoxelNeighborsForCachedMesh,
	maybeRemeshNeighborsNowStable,
	scheduleChunkAndNeighborsRemesh,
} from "./Worker/NeighborHelpers";
