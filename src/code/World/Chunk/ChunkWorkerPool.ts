import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
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
	// OPFS mesh cache (replaces IDB mesh persistence)
	// ---------------------------------------------------------------------------
	private opfsClient: OpfsClient | null = null;
	private opfsReady = false;
	private opfsInitPromise: Promise<void> | null = null;

	// ---------------------------------------------------------------------------
	// Static scratch buffers — avoids per-call allocation on hot paths
	// ---------------------------------------------------------------------------
	private static readonly _flushPendingScratch: Array<[Chunk, boolean]> = [];
	private static readonly _queryScratch: Chunk[] = [];
	private static readonly _lodCandidateScratch: Array<{
		chunk: Chunk;
		lod: number;
		score: number;
	}> = [];

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

			if (this.lightHeaderBuffer && workerIndex === 0) {
				replacement.initLightShared(this.lightHeaderBuffer);
				for (const [, chunk] of Chunk.chunkInstances) {
					if (chunk.isLoaded) {
						const snap = chunk.getLightStorageSnapshot();
						replacement.postLightRegisterChunk({
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
	 * a pre-computed light_array.  Builds a seed queue and forwards it to
	 * the worker for the BFS pass.
	 */
	public enqueueDeferredLightFromSunlightInit(
		chunk: Chunk,
		seedQueue: Uint16Array,
		seedLength: number,
	): void {
		this.postLightPropagateDeferred({
			chunkId: chunk.id,
			headerSlot: chunk.lightHeaderSlot,
			seedQueue,
			seedLength,
			seq: this.nextLightSeq(),
		});
		this.postLightSkyReconcile({
			chunkId: chunk.id,
			headerSlot: chunk.lightHeaderSlot,
			seq: this.nextLightSeq(),
		});
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

		while (
			this.lightDirtyQueueReadIdx < this.lightDirtyQueue.length &&
			performance.now() - start < budget
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
			this.lightDirtyQueue.splice(0, this.lightDirtyQueueReadIdx);
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
			if (chunk && chunk.isLoaded && !chunk.isTerrainScheduled) {
				this.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
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
			const merged = new Uint16Array(existing.length + seedLength);
			let writeIdx = 0;
			for (let i = 0; i < existing.length; i++) {
				merged[writeIdx++] = existing.queue[i]!;
			}
			for (let i = 0; i < seedLength; i++) {
				const val = seedQueue[i]!;
				let isDup = false;
				for (let j = 0; j < existing.length; j++) {
					if (existing.queue[j] === val) {
						isDup = true;
						break;
					}
				}
				if (!isDup) merged[writeIdx++] = val;
			}
			existing.queue = merged.subarray(0, writeIdx);
			existing.length = writeIdx;
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

			// Forward the deferred-light BFS to a worker.  The light-worker
			// will post a LightDirty reply when done; processLightDirtyQueue
			// schedules the remesh and the persist below runs immediately
			// because the persistence layer reads from the same SAB the
			// worker is writing to — the next persistence sweep will pick
			// up the post-BFS light_array.
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
				// Write mesh to OPFS (fire-and-forget; non-blocking)
				if (this.opfsReady && this.opfsClient) {
					const bytes = serializeMeshPair(opaque, transparent);
					if (bytes) {
						const key = packChunkKey(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
						void this.opfsClient
							.writeMesh(key, lod, bytes)
							.catch((err: any) => {
								console.warn(
									`[ChunkWorkerPool] OPFS write failed for chunk ${chunkId}:`,
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
					chunk.isDirty = true;
					chunk.remeshQueued = false;
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

			const chunksToSave: Chunk[] = [];
			for (const id of this.pendingRemeshSaveIds) {
				const chunk = Chunk.chunkInstances.get(id);
				if (chunk && chunk.isLoaded && chunk.needsPersistence()) {
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

		const detected = Math.max(1, (navigator.hardwareConcurrency ?? 0) | 0);
		return Math.max(
			ChunkWorkerPool.MIN_AUTO_POOL_SIZE,
			Math.min(ChunkWorkerPool.MAX_AUTO_POOL_SIZE, detected),
		);
	}

	public static getInstance(poolSize?: number): ChunkWorkerPool {
		if (!ChunkWorkerPool.instance) {
			const resolvedPoolSize = ChunkWorkerPool.resolvePoolSize(poolSize);
			const instance = new ChunkWorkerPool(resolvedPoolSize);
			ChunkWorkerPool.instance = instance;
			Chunk.onRequestRemesh = (chunk: Chunk, priority: boolean) => {
				instance.scheduleRemesh(chunk, priority);
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
			if (!this.tryApplyCachedLODMesh(chunk, true)) {
				chunk.isDirty = false;
				chunk.remeshQueued = false;
			}
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
								this.scheduleChunkAndNeighborsRemesh(chunk);
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
				candidates.push({
					chunk,
					lod,
					score: hDist * 100 + vDist * 10 + lod,
				});
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

		// Evict OPFS mesh entries for this chunk to prevent unbounded growth.
		if (this.opfsReady && this.opfsClient) {
			const key = packChunkKey(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
			for (const lod of chunk.cachedLODMeshes.keys()) {
				void this.opfsClient.removeMesh(key, lod).catch(() => {});
			}
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
