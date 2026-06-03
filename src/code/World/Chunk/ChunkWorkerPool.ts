import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import { WorldStorage } from "../WorldStorage";
import { createMeshFromData } from "./ChunckMesher";
import { addChunkDisposeHook, Chunk } from "./Chunk";
import { ChunkWorker } from "./chunkWorker";
import { RingBuffer } from "./DataStructures/RingBuffer";
import {
	type DistantTerrainGeneratedMessage,
	type DistantTerrainTask,
	type FullMeshMessage,
	type MeshWorkerResponse,
	type TerrainGeneratedMessage,
	type WorkerResponseData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

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
	workerDispatchCounts: number[];
	lastDispatchWorkerIndices: number[];
};

// ---------------------------------------------------------------------------
// Packed in-flight key: (chunkId << 4n | BigInt(lod)) avoids string alloc.
// LOD values are expected to be 0–15 so 4 bits is sufficient.
// ---------------------------------------------------------------------------
function packInflightKey(chunkId: bigint, lod: number): bigint {
	return (chunkId << 4n) | BigInt(lod & 0xf);
}

type WorkerTaskContext = {
	taskType: "terrain" | "remesh" | "lodPrecompute" | "distantTerrain";
	chunk?: Chunk;
	lod?: number;
	distantTask?: DistantTerrainTask;
	terrainDeferLighting?: boolean;
} | null;

function chunkDist(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	centerX: number,
	centerY: number,
	centerZ: number,
): { hDist: number; vDist: number } {
	return {
		hDist: Math.max(Math.abs(chunkX - centerX), Math.abs(chunkZ - centerZ)),
		vDist: Math.abs(chunkY - centerY),
	};
}

export class ChunkWorkerPool {
	private static instance: ChunkWorkerPool;
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
	private _heartbeatLogCount = 0;
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
	private _processQueueCallCount = 0;

	private meshResultQueue: FullMeshMessage[] = [];
	private meshResultQueueReadIdx = 0;
	private remeshFlushScheduled = false;
	private processQueuePumpScheduled = false;

	private pendingRemeshSaveIds = new Set<bigint>();
	private pendingRemeshSaveTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly REMESH_SAVE_DEBOUNCE_MS = 500;

	private inFlightRemeshKeys = new Set<bigint>();
	private rerunRemeshAfterInflight = new Map<bigint, boolean>();

	private distantTerrainInFlight = false;
	private nextDistantTerrainRequestId = 1;

	// ---------------------------------------------------------------------------
	// Static scratch buffers — avoids per-call allocation on hot paths
	// ---------------------------------------------------------------------------
	private static readonly _reconcileSeedChunks: Chunk[] = [];
	private static readonly _reconcileSeedCoords = new Int32Array(6144 * 3);
	private static readonly _reconcileSeedLevels = new Uint8Array(6144);
	private static readonly _flushPendingScratch: Array<[Chunk, boolean]> = [];
	private static readonly _queryScratch: Chunk[] = [];
	private static readonly _lodCandidateScratch: Array<{
		chunk: Chunk;
		lod: number;
		score: number;
	}> = [];

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
		requestAnimationFrame(() => {
			this.processQueuePumpScheduled = false;
			this.processQueue();
		});
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

	private resolveChunkByMessageId(chunkId: unknown): Chunk | undefined {
		if (typeof chunkId === "bigint") {
			return Chunk.chunkInstances.get(chunkId);
		}
		if (typeof chunkId === "string") {
			try {
				return Chunk.chunkInstances.get(BigInt(chunkId));
			} catch {
				return undefined;
			}
		}
		if (typeof chunkId === "number" && (chunkId | 0) === chunkId) {
			return Chunk.chunkInstances.get(BigInt(chunkId));
		}
		return undefined;
	}

	private normalizeChunkIdToBigInt(chunkId: unknown): bigint | undefined {
		if (typeof chunkId === "bigint") return chunkId;
		if (typeof chunkId === "string") {
			try {
				return BigInt(chunkId);
			} catch {
				return undefined;
			}
		}
		if (typeof chunkId === "number" && (chunkId | 0) === chunkId) {
			return BigInt(chunkId);
		}
		return undefined;
	}

	// -------------------------------------------------------------------------
	// In-flight key management
	// -------------------------------------------------------------------------

	private isSameLodRemeshInflight(chunk: Chunk): boolean {
		return this.inFlightRemeshKeys.has(
			packInflightKey(chunk.id, chunk.lodLevel ?? 0),
		);
	}

	private clearInflightRemeshByMessage(chunkId: unknown, lod: number): void {
		const id = this.normalizeChunkIdToBigInt(chunkId);
		if (id !== undefined) {
			this.inFlightRemeshKeys.delete(packInflightKey(id, lod));
		}
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

		if (context?.taskType === "distantTerrain") {
			this.distantTerrainInFlight = false;
		}

		if (
			(context?.taskType === "remesh" ||
				context?.taskType === "lodPrecompute") &&
			context.chunk &&
			typeof context.lod === "number"
		) {
			this.inFlightRemeshKeys.delete(
				packInflightKey(context.chunk.id, context.lod),
			);
		}

		// Re-queue interrupted tasks.
		if (context?.taskType === "terrain" && context.chunk) {
			context.chunk.isTerrainScheduled = false;
			this.scheduleTerrainGeneration(
				context.chunk,
				context.terrainDeferLighting ?? true,
			);
		} else if (context?.taskType === "remesh" && context.chunk?.isLoaded) {
			this.scheduleRemesh(context.chunk, true);
		} else if (
			context?.taskType === "lodPrecompute" &&
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
		} else if (context?.taskType === "distantTerrain" && context.distantTask) {
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
	// Constructor
	// -------------------------------------------------------------------------

	private constructor(poolSize: number) {
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
		}

		this.updateQueueDebugStats();
		this.processMeshQueueLoop();
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

		if (this.deferredLightingSeedStates.has(chunk.id)) {
			this.debugStats.deferredLightingSeedReplacedTotal++;
		}

		this.deferredLightingSeedStates.set(chunk.id, {
			queue: seedQueue,
			length: seedLength,
		});

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
		if (this.terrainTaskQueue.size > 0) {
			this.scheduleDeferredLightingPump();
			return;
		}

		const start = performance.now();
		let processed = 0;
		let dropped = 0;
		const budget = ChunkWorkerPool.DEFERRED_LIGHTING_BUDGET_MS;
		const maxChunks = ChunkWorkerPool.DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME;

		while (
			this.deferredLightingQueueReadIdx < this.deferredLightingQueue.length &&
			processed < maxChunks &&
			performance.now() - start < budget
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

			chunk.propagateDeferredLight(seedState);
			this.reconcileSkyLightAcrossLoadedNeighbors(chunk);
			void WorldStorage.saveChunk(chunk).catch((error) => {
				console.error("Deferred-light chunk persistence failed:", error);
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

	private reconcileSkyLightAcrossLoadedNeighbors(chunk: Chunk): void {
		if (!chunk.isLoaded || !chunk.hasVoxelData) return;

		const size = Chunk.SIZE;
		const last = size - 1;

		const negX = chunk.getNeighbor(-1, 0, 0);
		const posX = chunk.getNeighbor(1, 0, 0);
		const negY = chunk.getNeighbor(0, -1, 0);
		const posY = chunk.getNeighbor(0, 1, 0);
		const negZ = chunk.getNeighbor(0, 0, -1);
		const posZ = chunk.getNeighbor(0, 0, 1);

		const seedChunks = ChunkWorkerPool._reconcileSeedChunks;
		const seedCoords = ChunkWorkerPool._reconcileSeedCoords;
		const seedLevels = ChunkWorkerPool._reconcileSeedLevels;
		seedChunks.length = 0;
		let seedCount = 0;

		const collectFace = (
			selfChunk: Chunk,
			neighbor: Chunk | undefined,
			selfEdge: number,
			neighborEdge: number,
			axis: 0 | 1 | 2,
		): void => {
			if (!neighbor?.isLoaded || !neighbor.hasVoxelData) return;

			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					let x: number, y: number, z: number;
					let nx: number, ny: number, nz: number;

					if (axis === 0) {
						x = selfEdge;
						y = u;
						z = v;
						nx = neighborEdge;
						ny = u;
						nz = v;
					} else if (axis === 1) {
						x = u;
						y = selfEdge;
						z = v;
						nx = u;
						ny = neighborEdge;
						nz = v;
					} else {
						x = u;
						y = v;
						z = selfEdge;
						nx = u;
						ny = v;
						nz = neighborEdge;
					}

					const selfSky = selfChunk.getSkyLight(x, y, z);
					const neighborSky = neighbor.getSkyLight(nx, ny, nz);
					if (selfSky === neighborSky) continue;
					if (seedCount >= 6144) return;

					if (selfSky > neighborSky) {
						seedChunks[seedCount] = neighbor;
						seedCoords[seedCount * 3] = nx;
						seedCoords[seedCount * 3 + 1] = ny;
						seedCoords[seedCount * 3 + 2] = nz;
						seedLevels[seedCount] = selfSky;
					} else {
						seedChunks[seedCount] = selfChunk;
						seedCoords[seedCount * 3] = x;
						seedCoords[seedCount * 3 + 1] = y;
						seedCoords[seedCount * 3 + 2] = z;
						seedLevels[seedCount] = neighborSky;
					}
					seedCount++;
				}
			}
		};

		collectFace(chunk, negX, 0, last, 0);
		collectFace(chunk, posX, last, 0, 0);
		collectFace(chunk, negY, 0, last, 1);
		collectFace(chunk, posY, last, 0, 1);
		collectFace(chunk, negZ, 0, last, 2);
		collectFace(chunk, posZ, last, 0, 2);

		if (seedCount > 0) {
			chunk.batchPropagateSkyLightFlat(
				seedChunks,
				seedCoords,
				seedCount,
				seedLevels,
			);
		}
	}

	// -------------------------------------------------------------------------
	// Mesh result drain loop — runs every rAF
	// -------------------------------------------------------------------------

	private processMeshQueueLoop = () => {
		const start = performance.now();
		let processed = 0;
		while (
			this.meshResultQueueReadIdx < this.meshResultQueue.length &&
			performance.now() - start < 5
		) {
			const data = this.meshResultQueue[this.meshResultQueueReadIdx++]!;
			processed++;
			const { chunkId, lod, opaque, transparent } = data;
			const chunk = this.resolveChunkByMessageId(chunkId);
			if (chunk) {
				chunk.setCachedLODMesh(lod, {
					opaque: opaque ?? null,
					transparent: transparent ?? null,
				});
				if ((chunk.lodLevel ?? 0) === lod) {
					createMeshFromData(chunk, { opaque, transparent });
					chunk.isDirty = false;
					this.queuePostRemeshSave(chunk);
				} else {
					chunk.isDirty = true;
					this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
				}
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
		if (chunk.isPersistent) return;
		if (this.deferredLightingQueuedIds.has(chunk.id)) return;

		this.pendingRemeshSaveIds.add(chunk.id);
		if (this.pendingRemeshSaveTimer !== null) return;

		this.pendingRemeshSaveTimer = setTimeout(() => {
			this.pendingRemeshSaveTimer = null;
			const ids = Array.from(this.pendingRemeshSaveIds);
			this.pendingRemeshSaveIds.clear();

			const chunksToSave: Chunk[] = [];
			for (let i = 0; i < ids.length; i++) {
				const chunk = Chunk.chunkInstances.get(ids[i]);
				if (chunk && chunk.isLoaded && chunk.needsPersistence()) {
					chunksToSave.push(chunk);
				}
			}

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

		const detected = Math.max(1, (navigator.hardwareConcurrency ?? 0) | 0);
		return Math.max(
			ChunkWorkerPool.MIN_AUTO_POOL_SIZE,
			Math.min(ChunkWorkerPool.MAX_AUTO_POOL_SIZE, detected),
		);
	}

	public static getInstance(poolSize?: number): ChunkWorkerPool {
		if (!ChunkWorkerPool.instance) {
			const resolvedPoolSize = ChunkWorkerPool.resolvePoolSize(poolSize);
			console.log(
				`ChunkWorkerPool initialized with ${resolvedPoolSize} workers (hw=${navigator.hardwareConcurrency ?? "n/a"})`,
			);
			ChunkWorkerPool.instance = new ChunkWorkerPool(resolvedPoolSize);
			Chunk.onRequestRemesh = (chunk: Chunk, priority: boolean) => {
				ChunkWorkerPool.instance.scheduleRemesh(chunk, priority);
			};
		}
		return ChunkWorkerPool.instance;
	}

	// -------------------------------------------------------------------------
	// Remesh scheduling
	// -------------------------------------------------------------------------

	public scheduleRemesh(chunk: Chunk | undefined, priority = false): void {
		if (!chunk?.isLoaded) return;

		if (!chunk.hasVoxelData) {
			this.tryApplyCachedLODMesh(chunk, true);
			return;
		}

		if (this.isCompletelyEmptyChunk(chunk)) {
			if (this.isSameLodRemeshInflight(chunk)) {
				this.rerunRemeshAfterInflight.set(chunk.id, true);
			}
			this.pendingRemeshMap.delete(chunk);
			this.taskQueuePriority.delete(chunk);
			this.clearChunkMeshIfPresent(chunk);
			return;
		}

		if (this.isSameLodRemeshInflight(chunk)) {
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

		pending.sort(([ca, pa], [cb, pb]) =>
			this.compareRemeshPriority(ca, pa, cb, pb),
		);

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

		if (
			chunk.hasVoxelData &&
			!this.hasStableVoxelNeighborsForCachedMesh(chunk)
		) {
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

				if (type === WorkerTaskType.GenerateFullMesh) {
					const meshData = data as FullMeshMessage;
					this.clearInflightRemeshByMessage(meshData.chunkId, meshData.lod);
					this.meshResultQueue.push(meshData);
					requestAnimationFrame(this.processMeshQueueLoop);

					const resolvedChunk = this.resolveChunkByMessageId(meshData.chunkId);
					if (
						resolvedChunk &&
						this.rerunRemeshAfterInflight.get(resolvedChunk.id)
					) {
						this.rerunRemeshAfterInflight.delete(resolvedChunk.id);
						this.scheduleRemesh(
							resolvedChunk,
							(resolvedChunk.lodLevel ?? 0) === 0,
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

						chunk.populate(
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
							if (!needsLightRefinement) {
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

						this.scheduleChunkAndNeighborsRemesh(chunk);
						this.maybeRemeshNeighborsNowStable(chunk);

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

				const fullMeshMessage: FullMeshMessage = {
					type: WorkerTaskType.GenerateFullMesh,
					chunkId: data.chunkId as bigint,
					lod: data.lod,
					opaque: data.opaque,
					transparent: data.transparent,
				};
				this.meshResultQueue.push(fullMeshMessage);
				requestAnimationFrame(this.processMeshQueueLoop);

				const resolvedChunk = this.resolveChunkByMessageId(data.chunkId);
				if (
					resolvedChunk &&
					this.rerunRemeshAfterInflight.get(resolvedChunk.id)
				) {
					this.rerunRemeshAfterInflight.delete(resolvedChunk.id);
					this.scheduleRemesh(
						resolvedChunk,
						(resolvedChunk.lodLevel ?? 0) === 0,
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
			this.taskQueue.splice(0, this.taskQueueReadIdx);
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
			taskType: "terrain",
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

		const candidates = ChunkWorkerPool._lodCandidateScratch;
		candidates.length = 0;

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

			const { hDist, vDist } = chunkDist(
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ,
				centerChunkX,
				centerChunkY,
				centerChunkZ,
			);
			if (hDist > horizontalRadius || vDist > verticalRadius) continue;

			for (let li = 0; li < targetLods.length; li++) {
				const lod = targetLods[li]!;
				if (chunk.hasCachedLODMesh(lod)) continue;
				const key = packInflightKey(chunk.id, lod);
				if (this.pendingLodPrecomputeKeys.has(key)) continue;
				candidates.push({ chunk, lod, score: hDist * 100 + vDist * 10 + lod });
			}
		}

		if (candidates.length === 0) return;
		candidates.sort((a, b) => a.score - b.score);

		const maxEnqueue = Math.max(
			1,
			SETTING_PARAMS.LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE | 0,
		);
		let added = 0;
		for (let i = 0; i < candidates.length && added < maxEnqueue; i++) {
			const { chunk, lod } = candidates[i]!;
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
	// Neighbor remesh helpers
	// -------------------------------------------------------------------------

	private scheduleChunkAndNeighborsRemesh(chunk: Chunk): void {
		this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
		const n0 = chunk.getNeighbor(-1, 0, 0);
		const n1 = chunk.getNeighbor(0, 0, -1);
		const n2 = chunk.getNeighbor(0, -1, 0);
		const n3 = chunk.getNeighbor(1, 0, 0);
		const n4 = chunk.getNeighbor(0, 0, 1);
		const n5 = chunk.getNeighbor(0, 1, 0);
		if (n0) this.scheduleRemesh(n0, (n0.lodLevel ?? 0) === 0);
		if (n1) this.scheduleRemesh(n1, (n1.lodLevel ?? 0) === 0);
		if (n2) this.scheduleRemesh(n2, (n2.lodLevel ?? 0) === 0);
		if (n3) this.scheduleRemesh(n3, (n3.lodLevel ?? 0) === 0);
		if (n4) this.scheduleRemesh(n4, (n4.lodLevel ?? 0) === 0);
		if (n5) this.scheduleRemesh(n5, (n5.lodLevel ?? 0) === 0);
	}

	private hasStableVoxelNeighborsForCachedMesh(chunk: Chunk): boolean {
		const n0 = chunk.getNeighbor(-1, 0, 0);
		if (!n0?.isLoaded || !n0.hasVoxelData) return false;
		const n1 = chunk.getNeighbor(1, 0, 0);
		if (!n1?.isLoaded || !n1.hasVoxelData) return false;
		const n2 = chunk.getNeighbor(0, -1, 0);
		if (!n2?.isLoaded || !n2.hasVoxelData) return false;
		const n3 = chunk.getNeighbor(0, 1, 0);
		if (!n3?.isLoaded || !n3.hasVoxelData) return false;
		const n4 = chunk.getNeighbor(0, 0, -1);
		if (!n4?.isLoaded || !n4.hasVoxelData) return false;
		const n5 = chunk.getNeighbor(0, 0, 1);
		if (!n5?.isLoaded || !n5.hasVoxelData) return false;
		return true;
	}

	private maybeRemeshNeighborsNowStable(chunk: Chunk): void {
		const neighbors = [
			chunk.getNeighbor(-1, 0, 0),
			chunk.getNeighbor(1, 0, 0),
			chunk.getNeighbor(0, -1, 0),
			chunk.getNeighbor(0, 1, 0),
			chunk.getNeighbor(0, 0, -1),
			chunk.getNeighbor(0, 0, 1),
		];
		for (let i = 0; i < neighbors.length; i++) {
			const neighbor = neighbors[i];
			if (!neighbor?.isLoaded || !neighbor.hasVoxelData) continue;
			if (!neighbor.getCachedLODMesh(neighbor.lodLevel)) continue;
			if (this.hasStableVoxelNeighborsForCachedMesh(neighbor)) {
				neighbor.isDirty = true;
				this.scheduleRemesh(neighbor, (neighbor.lodLevel ?? 0) === 0);
			}
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
		this._processQueueCallCount++;
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
			let taskType: "terrain" | "remesh" | "lodPrecompute" | "distantTerrain";

			if (this.terrainTaskQueue.size > 0) {
				taskChunk = this.dequeueNextTerrainChunk();
				taskType = "terrain";
			} else if (this.taskQueueReadIdx < this.taskQueue.length) {
				taskChunk = this.taskQueue[this.taskQueueReadIdx++]!;
				taskType = "remesh";
			} else if (
				this.distantTerrainTaskQueueReadIdx <
					this.distantTerrainTaskQueue.length &&
				!this.distantTerrainInFlight &&
				this.distantTerrainReadyWorkers.size > 0
			) {
				distantTask =
					this.distantTerrainTaskQueue[this.distantTerrainTaskQueueReadIdx++]!;
				taskType = "distantTerrain";
			} else if (
				this.lodPrecomputeQueueReadIdx < this.lodPrecomputeQueue.length
			) {
				const task = this.lodPrecomputeQueue[this.lodPrecomputeQueueReadIdx++]!;
				taskChunk = task.chunk;
				precomputeLod = task.lod;
				this.pendingLodPrecomputeKeys.delete(
					packInflightKey(task.chunk.id, task.lod),
				);
				taskType = "lodPrecompute";
			} else {
				break;
			}

			if (!taskChunk && !distantTask) break;

			// Per-type pre-dispatch validation.
			if (taskType === "remesh" && taskChunk) {
				if (this.isCompletelyEmptyChunk(taskChunk)) {
					this.clearChunkMeshIfPresent(taskChunk);
					this.pendingRemeshMap.delete(taskChunk);
					this.taskQueuePriority.delete(taskChunk);
					continue;
				}
				if (!this.pendingRemeshMap.has(taskChunk)) {
					if (this.tryApplyCachedLODMesh(taskChunk)) {
						this.taskQueuePriority.delete(taskChunk);
						continue;
					}
				}
			}

			if (taskType === "lodPrecompute" && taskChunk) {
				if (
					!taskChunk.isLoaded ||
					!taskChunk.hasVoxelData ||
					precomputeLod === undefined ||
					taskChunk.hasCachedLODMesh(precomputeLod)
				) {
					continue;
				}
			}

			// For distantTerrain, find a ready idle worker within the live portion.
			if (taskType === "distantTerrain") {
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
				if (taskType === "terrain") {
					if (!taskChunk) {
						this._markWorkerIdle(workerIndex);
						continue;
					}
					this.dispatchTerrainTaskToWorker(workerIndex, worker, taskChunk);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalTerrainDispatches++;
					dispatchedThisTick++;
				} else if (taskType === "remesh") {
					const lod = taskChunk!.lodLevel ?? 0;
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
				} else if (taskType === "lodPrecompute") {
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
						distantTask!.renderDistance,
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
		if (chunk.isPersistent) return;

		// Map cleanups (O(1) each).
		this.pendingRemeshMap.delete(chunk);
		this.taskQueuePriority.delete(chunk);
		this.terrainTaskDeferLighting.delete(chunk.id);
		this.deferredLightingQueuedIds.delete(chunk.id);
		this.deferredLightingSeedStates.delete(chunk.id);
		this.rerunRemeshAfterInflight.delete(chunk.id);

		// Set cleanup.
		this.terrainTaskQueue.delete(chunk);

		// Array cleanups — splice any matching entry whose index is at or
		// after the current read pointer. Entries before the read pointer
		// have already been consumed and cannot remain in the array because
		// the dequeue loops always advance past them.
		spliceMatchingFromArray(this.taskQueue, chunk, this.taskQueueReadIdx);
		spliceMatchingFromArray(
			this.deferredLightingQueue,
			chunk,
			this.deferredLightingQueueReadIdx,
		);
		spliceLodPrecomputeMatching(
			this.lodPrecomputeQueue,
			chunk,
			this.lodPrecomputeQueueReadIdx,
		);

		// pendingLodPrecomputeKeys uses packInflightKey(chunkId, lod).
		// LOD values are 0–15, so 16 deletes is cheap.
		for (let lod = 0; lod < 16; lod++) {
			this.pendingLodPrecomputeKeys.delete(packInflightKey(chunk.id, lod));
		}
	}
}

// ---------------------------------------------------------------------------
// Module-level helpers used by onChunkDisposed.
// ---------------------------------------------------------------------------
function spliceMatchingFromArray(
	arr: Chunk[],
	chunk: Chunk,
	startIdx: number,
): void {
	for (let i = arr.length - 1; i >= startIdx; i--) {
		if (arr[i] === chunk) arr.splice(i, 1);
	}
}

function spliceLodPrecomputeMatching(
	arr: Array<{ chunk: Chunk; lod: number }>,
	chunk: Chunk,
	startIdx: number,
): void {
	for (let i = arr.length - 1; i >= startIdx; i--) {
		if (arr[i]!.chunk === chunk) arr.splice(i, 1);
	}
}

// ---------------------------------------------------------------------------
// Register a chunk-dispose hook so the pool can drop its strong references
// to the chunk the moment Chunk.dispose() runs.
// ---------------------------------------------------------------------------
addChunkDisposeHook((chunk) => {
	ChunkWorkerPool.getInstance().onChunkDisposed(chunk);
});
