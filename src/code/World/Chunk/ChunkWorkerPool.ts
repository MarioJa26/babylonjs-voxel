import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import { WorldStorage } from "../WorldStorage";
import { createMeshFromData } from "./ChunckMesher";
import { Chunk } from "./Chunk";
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
// LOD values are expected to be 0-15 so 4 bits is sufficient.
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
	// Priority flag per chunk — stored alongside via parallel Map to avoid
	// repeated indexOf scans
	private taskQueuePriority: Map<Chunk, boolean> = new Map();

	private workerDispatchCounts: number[] = [];
	// Fixed-size ring buffer replaces the shift()-based sliding window
	private lastDispatchRing = new RingBuffer<number>(
		ChunkWorkerPool.LAST_DISPATCH_RING_SIZE,
	);

	// pendingRemeshQueue and pendingRemeshSet merged: Map<Chunk, priority>
	// The Set membership is implicit: chunk is pending iff it's in the Map.
	private pendingRemeshMap: Map<Chunk, boolean> = new Map();

	private terrainTaskDeferLighting = new Map<bigint, boolean>();
	private terrainTaskQueue: Set<Chunk> = new Set();
	private deferredLightingQueue: Chunk[] = [];
	private deferredLightingQueuedIds = new Set<bigint>();
	private deferredLightingSeedStates = new Map<
		bigint,
		{ queue: Uint16Array; length: number }
	>();
	private deferredLightingPumpScheduled = false;

	private distantTerrainReadyWorkers = new Set<number>();
	private distantTerrainTaskQueue: DistantTerrainTask[] = [];
	private lodPrecomputeQueue: Array<{ chunk: Chunk; lod: number }> = [];
	private pendingLodPrecomputeKeys = new Set<bigint>();
	private lastPrecomputeScheduleTs = 0;

	// idleWorkers as a Set for O(1) has/add/delete, plus array for shift access.
	// idleWorkerIndexPositions maps workerIndex -> position in idleWorkerIndices
	// for O(1) swap-remove.
	private idleWorkerSet: Set<number> = new Set();
	private idleWorkerIndices: number[] = [];
	private idleWorkerIndexPositions: Map<number, number> = new Map();

	private meshResultQueue: FullMeshMessage[] = [];
	private remeshFlushScheduled = false;
	private processQueuePumpScheduled = false;

	// In-flight keys: bigint-packed (chunkId << 4 | lod) — no string allocs
	private inFlightRemeshKeys = new Set<bigint>();
	private rerunRemeshAfterInflight = new Map<bigint, boolean>();

	private distantTerrainInFlight = false;
	private nextDistantTerrainRequestId = 1;

	// Debug stats object — mutated in place to avoid allocations
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
		// Ensure budget is at least the number of workers so all workers get
		// dispatched in one batch — avoids starvation when budget < poolSize.
		return Math.max(configured, this.workers.length);
	}
	private hasPendingTasks(): boolean {
		return (
			this.terrainTaskQueue.size > 0 ||
			this.taskQueue.length > 0 ||
			this.lodPrecomputeQueue.length > 0 ||
			this.distantTerrainTaskQueue.length > 0
		);
	}
	private scheduleProcessQueuePump(): void {
		if (this.processQueuePumpScheduled) return;
		this.processQueuePumpScheduled = true;
		requestAnimationFrame(() => {
			this.processQueuePumpScheduled = false;
			this.processQueue();
		});
	}

	/** Update only the fields that callers read; avoid touching cumulative totals. */
	private updateQueueDebugStats(): void {
		const stats = this.debugStats;
		stats.workerCount = this.workers.length;
		stats.idleWorkers = this.idleWorkerIndices.length;
		const busy = Math.max(0, stats.workerCount - stats.idleWorkers);
		stats.busyWorkers = busy;
		if (busy > stats.peakBusyWorkers) stats.peakBusyWorkers = busy;
		stats.remeshQueueLength = this.taskQueue.length;
		stats.terrainQueueLength = this.terrainTaskQueue.size;
		stats.lodPrecomputeQueueLength = this.lodPrecomputeQueue.length;
		stats.distantTerrainQueueLength = this.distantTerrainTaskQueue.length;
		stats.meshResultQueueLength = this.meshResultQueue.length;
		stats.deferredLightingQueueLength = this.deferredLightingQueue.length;
		stats.deferredLightingSeedStateCount = this.deferredLightingSeedStates.size;
		stats.deferredLightingPumpScheduled = this.deferredLightingPumpScheduled;
		const budget = this.getDispatchBudgetPerTick();
		stats.dispatchBudgetPerTick = Number.isFinite(budget) ? budget : 0;
	}

	public getDebugStats(): ChunkWorkerPoolDebugStats {
		this.updateQueueDebugStats();
		// Shallow-clone only the snapshot arrays; everything else is read from
		// the live stats object which is already up-to-date.
		return {
			...this.debugStats,
			workerDispatchCounts: this.workerDispatchCounts.slice(),
			lastDispatchWorkerIndices: this.lastDispatchRing.toArray(),
		};
	}

	private recordWorkerDispatch(workerIndex: number): void {
		if (workerIndex < 0) return;
		if (workerIndex >= this.workerDispatchCounts.length) {
			// Ensure no holes
			while (this.workerDispatchCounts.length <= workerIndex) {
				this.workerDispatchCounts.push(0);
			}
		}
		this.workerDispatchCounts[workerIndex]++;
		this.lastDispatchRing.push(workerIndex);
	}

	// -------------------------------------------------------------------------
	// Chunk / ID resolution — kept as tight as possible; hot path for messages
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
	// In-flight key management (bigint-packed, no string alloc)
	// -------------------------------------------------------------------------

	private isSameLodRemeshInflight(chunk: Chunk): boolean {
		const lod = chunk.lodLevel ?? 0;
		return this.inFlightRemeshKeys.has(packInflightKey(chunk.id, lod));
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
			this.distantTerrainTaskQueue.unshift(context.distantTask);
		}

		// Remove from idle structures — O(1) swap-remove using position map
		this.idleWorkerSet.delete(workerIndex);
		const pos = this.idleWorkerIndexPositions.get(workerIndex);
		if (pos !== undefined) {
			const lastIdx = this.idleWorkerIndices.length - 1;
			if (pos !== lastIdx) {
				const swapped = this.idleWorkerIndices[lastIdx]!;
				this.idleWorkerIndices[pos] = swapped;
				this.idleWorkerIndexPositions.set(swapped, pos);
			}
			this.idleWorkerIndices.length = lastIdx;
			this.idleWorkerIndexPositions.delete(workerIndex);
		}

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
			this.workerTaskContext[workerIndex] = null;

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

			if (!this.idleWorkerSet.has(workerIndex)) {
				this.idleWorkerSet.add(workerIndex);
				this.idleWorkerIndices.push(workerIndex);
				this.idleWorkerIndexPositions.set(
					workerIndex,
					this.idleWorkerIndices.length - 1,
				);
			}

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
			this.idleWorkerSet.add(i);
			this.idleWorkerIndices.push(i);
			this.idleWorkerIndexPositions.set(i, i);
			this.workerTaskContext.push(null);
			this.workerRestartAtMs.push(0);
			this.workerDispatchCounts.push(0);
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
			chunk.transparentMeshData ||
			chunk.colliderDirty
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
		if (
			this.terrainTaskQueue.size > 0 ||
			this.taskQueue.length > 0 ||
			this.lodPrecomputeQueue.length > 0 ||
			this.distantTerrainTaskQueue.length > 0
		) {
			this.scheduleDeferredLightingPump();
			return;
		}

		const start = performance.now();
		let processed = 0;
		let dropped = 0;
		const budget = ChunkWorkerPool.DEFERRED_LIGHTING_BUDGET_MS;
		const maxChunks = ChunkWorkerPool.DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME;

		while (
			this.deferredLightingQueue.length > 0 &&
			processed < maxChunks &&
			performance.now() - start < budget
		) {
			const chunk = this.deferredLightingQueue.shift()!;
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

		if (this.deferredLightingQueue.length > 0) {
			this.scheduleDeferredLightingPump();
		}
	}

	private reconcileSkyLightAcrossLoadedNeighbors(chunk: Chunk): void {
		if (!chunk.isLoaded || !chunk.hasVoxelData) return;

		const size = Chunk.SIZE;
		const last = size - 1;

		// Inline face-sync to avoid closure allocation per call. Each tuple
		// encodes [dx, dy, dz, isAxisX, isAxisY, isAxisZ, selfEdge, neighborEdge].
		// We iterate over the 6 faces directly with a helper to keep code clear.
		const syncFace = (
			neighbor: Chunk | undefined,
			mapCell: (
				u: number,
				v: number,
			) => [number, number, number, number, number, number],
		): void => {
			if (!neighbor?.isLoaded || !neighbor.hasVoxelData) return;

			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					const [x, y, z, nx, ny, nz] = mapCell(u, v);
					const selfSky = chunk.getSkyLight(x, y, z);
					const neighborSky = neighbor.getSkyLight(nx, ny, nz);
					if (selfSky === neighborSky) continue;
					if (selfSky > neighborSky) {
						neighbor.updateLightFromNeighbors(nx, ny, nz, true);
					} else {
						chunk.updateLightFromNeighbors(x, y, z, true);
					}
				}
			}
		};

		syncFace(chunk.getNeighbor(-1, 0, 0), (u, v) => [0, u, v, last, u, v]);
		syncFace(chunk.getNeighbor(1, 0, 0), (u, v) => [last, u, v, 0, u, v]);
		syncFace(chunk.getNeighbor(0, -1, 0), (u, v) => [u, 0, v, u, last, v]);
		syncFace(chunk.getNeighbor(0, 1, 0), (u, v) => [u, last, v, u, 0, v]);
		syncFace(chunk.getNeighbor(0, 0, -1), (u, v) => [u, v, 0, u, v, last]);
		syncFace(chunk.getNeighbor(0, 0, 1), (u, v) => [u, v, last, u, v, 0]);
	}

	// -------------------------------------------------------------------------
	// Mesh result drain loop — runs every rAF
	// -------------------------------------------------------------------------

	private processMeshQueueLoop = () => {
		const start = performance.now();
		let processed = 0;
		while (this.meshResultQueue.length > 0 && performance.now() - start < 5) {
			const data = this.meshResultQueue.shift()!;
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
					if (Chunk.DEBUG_REMESH) console.log(`[Pool] mesh APPLIED chunk=${chunkId} lod=${lod} dirty=false`);
				} else {
					chunk.isDirty = true;
					this.scheduleRemesh(
						chunk,
						(chunk.lodLevel ?? 0) === 0,
					);
					if (Chunk.DEBUG_REMESH) console.log(`[Pool] mesh LOD MISMATCH chunk=${chunkId} msgLod=${lod} curLod=${chunk.lodLevel} dirty=true rescheduled`);
				}
			} else {
				if (Chunk.DEBUG_REMESH) console.log(`[Pool] mesh CHUNK NOT FOUND chunkId=${chunkId} lod=${lod}`);
			}
		}
		this.debugStats.lastMeshProcessed = processed;
		this.debugStats.totalMeshProcessed += processed;
		this.debugStats.lastMeshDrainMs = performance.now() - start;
		this.updateQueueDebugStats();
		requestAnimationFrame(this.processMeshQueueLoop);
	};

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

	public scheduleRemesh(chunk: Chunk | undefined, priority = false) {
		if (!chunk?.isLoaded) {
			if (Chunk.DEBUG_REMESH) console.log(`[Pool] scheduleRemesh REJECTED (not loaded) chunk=${chunk?.id}`);
			return;
		}

		if (!chunk.hasVoxelData) {
			if (Chunk.DEBUG_REMESH) console.log(`[Pool] scheduleRemesh REJECTED (no voxel data) chunk=${chunk.id} lod=${chunk.lodLevel}`);
			this.tryApplyCachedLODMesh(chunk, true);
			return;
		}

		if (this.isCompletelyEmptyChunk(chunk)) {
			if (this.isSameLodRemeshInflight(chunk)) {
				this.rerunRemeshAfterInflight.set(chunk.id, true);
			}
			if (Chunk.DEBUG_REMESH) console.log(`[Pool] scheduleRemesh REJECTED (empty chunk) chunk=${chunk.id}`);
			this.pendingRemeshMap.delete(chunk);
			// Remove from sorted task queue in O(n) — acceptable since this is a
			// cold path (fully-air chunks are uncommon after first pass).
			const qi = this.taskQueue.indexOf(chunk);
			if (qi !== -1) this.taskQueue.splice(qi, 1);
			this.taskQueuePriority.delete(chunk);
			this.clearChunkMeshIfPresent(chunk);
			return;
		}

		if (this.isSameLodRemeshInflight(chunk)) {
			this.rerunRemeshAfterInflight.set(chunk.id, true);
			if (Chunk.DEBUG_REMESH) console.log(`[Pool] scheduleRemesh DEFERRED (in-flight) chunk=${chunk.id} lod=${chunk.lodLevel}`);
			return;
		}

		const lodPriority = (chunk.lodLevel ?? 0) === 0;
		const existingPriority = this.pendingRemeshMap.get(chunk) ?? false;
		const wasNew = !this.pendingRemeshMap.has(chunk);
		this.pendingRemeshMap.set(
			chunk,
			existingPriority || priority || lodPriority,
		);

		this.scheduleRemeshFlush();
		if (Chunk.DEBUG_REMESH && wasNew) {
			console.log(`[Pool] scheduleRemesh ACCEPTED chunk=${chunk.id} lod=${chunk.lodLevel} priority=${priority || lodPriority} mapSize=${this.pendingRemeshMap.size}`);
		}
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

		// Iterate the Map directly — no Array.from allocation needed for sort.
		// Copy entries into a reusable scratch array.
		const pending: Array<[Chunk, boolean]> = [];
		for (const entry of this.pendingRemeshMap) {
			pending.push(entry);
		}
		this.pendingRemeshMap.clear();

		pending.sort(([ca, pa], [cb, pb]) =>
			this.compareRemeshPriority(ca, pa, cb, pb),
		);

		let enqueued = 0;
		let skipped = 0;
		for (let i = 0; i < pending.length; i++) {
			const [chunk, priority] = pending[i]!;
			if (!chunk.isLoaded) { skipped++; continue; }

			if (this.isCompletelyEmptyChunk(chunk)) {
				this.clearChunkMeshIfPresent(chunk);
				skipped++;
				continue;
			}

			this.insertChunkIntoRemeshQueue(chunk, priority);
			enqueued++;
		}
		if (Chunk.DEBUG_REMESH) {
			console.log(`[Pool] flushPendingRemeshQueue enqueued=${enqueued} skipped=${skipped} totalTaskQueue=${this.taskQueue.length}`);
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
		// Only truncate the queue when no task is in-flight; otherwise just
		// replace the pending slot so the in-flight task's completion handler
		// still finds a valid queue entry.
		if (!this.distantTerrainInFlight) {
			this.distantTerrainTaskQueue.length = 1;
		}
		this.distantTerrainTaskQueue[0] = {
			requestId,
			centerChunkX,
			centerChunkZ,
			radius,
			renderDistance,
			gridStep,
		};
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
					console.warn(
						`[WORKER_READY] worker[${workerIndex}] terrain worker initialized`,
					);
					this.processQueue();
					// Keep pump alive while idle workers exist, even if no tasks
					// yet (e.g. tiny render distance). Tasks added later via
					// scheduleTerrainGenerationBatch will dispatch immediately.
					if (this.idleWorkerIndices.length > 0) {
						this.scheduleProcessQueuePump();
					}
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

						let blocks: Uint8Array | Uint16Array | null = block_array ?? null;
						let light: Uint8Array = light_array;

						const typedPalette: Uint16Array | null =
							palette instanceof Uint16Array ? palette : null;

						if (blocks && !(blocks.buffer instanceof SharedArrayBuffer)) {
							const shared = new SharedArrayBuffer(blocks.byteLength);
							if (blocks instanceof Uint16Array) {
								new Uint16Array(shared).set(blocks);
								blocks = new Uint16Array(shared);
							} else {
								new Uint8Array(shared).set(blocks);
								blocks = new Uint8Array(shared);
							}
						}

						if (!(light.buffer instanceof SharedArrayBuffer)) {
							const shared = new SharedArrayBuffer(light.byteLength);
							new Uint8Array(shared).set(light);
							light = new Uint8Array(shared);
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
						chunk.colliderDirty = true;
						chunk.isModified = true;

						const needsLightRefinement =
							lightSeedQueue !== undefined &&
							lightSeedLength !== undefined &&
							lightSeedLength > 0;

						if (isStale) {
							// Fix: clear context so deferred lighting pump isn't permanently blocked
							this.workerTaskContext[workerIndex] = null;
							this._markWorkerIdle(workerIndex);
							if (!needsLightRefinement) {
								void WorldStorage.saveChunk(chunk).catch((error) => {
									console.error(
										"Initial generated chunk persistence failed:",
										error,
									);
								});
							}
							this.processQueue();
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

			// Fix: always clear context regardless of whether the worker reference
			// still matches, so a replaced worker never leaves a stale terrain context.
			this.workerTaskContext[workerIndex] = null;

			if (this.workers[workerIndex] !== getWorker()) return;

			this._markWorkerIdle(workerIndex);
			if (Chunk.DEBUG_REMESH) console.log(`[Pool] WORKER ${workerIndex} IDLE (terrain complete)`);
			this.processQueue();
		};
	}

	private makeMeshMessageHandler(
		workerIndex: number,
		getWorker: () => ChunkWorker | undefined,
	) {
		return (event: MessageEvent<MeshWorkerResponse>) => {
			let failed = false;
			let meshChunkId: unknown = null;
			let meshLod = 0;
			try {
				const data = event.data;
				meshChunkId = data.chunkId;
				meshLod = data.lod;
				this.clearInflightRemeshByMessage(data.chunkId, data.lod);

				const fullMeshMessage: FullMeshMessage = {
					type: WorkerTaskType.GenerateFullMesh,
					chunkId: data.chunkId as bigint,
					lod: data.lod,
					opaque: data.opaque,
					transparent: data.transparent,
				};
				this.meshResultQueue.push(fullMeshMessage);

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

			this.workerTaskContext[workerIndex] = null;
			this._markWorkerIdle(workerIndex);
			if (Chunk.DEBUG_REMESH) console.log(`[Pool] WORKER ${workerIndex} IDLE (mesh complete) chunkId=${meshChunkId} lod=${meshLod}`);
			this.processQueue();
		};
	}

	/** Mark a worker idle in both the Set and the array, idempotent. */
	private _markWorkerIdle(workerIndex: number): void {
		if (!this.idleWorkerSet.has(workerIndex)) {
			this.idleWorkerSet.add(workerIndex);
			this.idleWorkerIndices.push(workerIndex);
			this.idleWorkerIndexPositions.set(
				workerIndex,
				this.idleWorkerIndices.length - 1,
			);
		}
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

	/**
	 * Binary-search insertion into the sorted taskQueue.
	 * If the chunk is already queued, only updates its priority — the safety
	 * sort in processQueue will reposition it if needed. This avoids the
	 * O(n) indexOf + splice that would negate the binary-search benefit.
	 */
	private insertChunkIntoRemeshQueue(chunk: Chunk, priority: boolean): void {
		const existingPriority = this.taskQueuePriority.get(chunk);
		if (existingPriority !== undefined) {
			// Already in queue — only promote if new priority is higher.
			// The sort in processQueue will fix ordering if needed.
			if (priority && !existingPriority) {
				this.taskQueuePriority.set(chunk, true);
			}
			return;
		}

		this.taskQueuePriority.set(chunk, priority);

		// Binary search for insertion point
		let lo = 0;
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
		this.workerTaskContext[workerIndex] = {
			taskType: "terrain",
			chunk,
			terrainDeferLighting: deferLighting,
		};
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
		const candidates: Array<{ chunk: Chunk; lod: number; score: number }> = [];

		for (const chunk of Chunk.loadedChunks) {
			if (!chunk.hasVoxelData || chunk.isDirty || !chunk.isModified) {
				continue;
			}

			const horizontalDist = Math.max(
				Math.abs(chunk.chunkX - centerChunkX),
				Math.abs(chunk.chunkZ - centerChunkZ),
			);
			if (horizontalDist > horizontalRadius) continue;
			const verticalDist = Math.abs(chunk.chunkY - centerChunkY);
			if (verticalDist > verticalRadius) continue;

			for (let li = 0; li < targetLods.length; li++) {
				const lod = targetLods[li]!;
				if (chunk.hasCachedLODMesh(lod)) continue;
				const key = packInflightKey(chunk.id, lod);
				if (this.pendingLodPrecomputeKeys.has(key)) continue;
				candidates.push({
					chunk,
					lod,
					score: horizontalDist * 100 + verticalDist * 10 + lod,
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
		// Unrolled — avoids array allocation
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
		// Unrolled for V8 — avoids array allocation on hot path
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
		this.updateQueueDebugStats();

		if (Chunk.DEBUG_REMESH) {
			console.log(`[Pool] processQueue idle=${this.idleWorkerIndices.length} taskQueue=${this.taskQueue.length} terrain=${this.terrainTaskQueue.size} lodPrecompute=${this.lodPrecomputeQueue.length} distant=${this.distantTerrainTaskQueue.length} pumpScheduled=${this.processQueuePumpScheduled}`);
		}

		// Sort only when there's more than one item. taskQueue is maintained
		// nearly-sorted by insertChunkIntoRemeshQueue (binary-search insertion),
		// so this full sort is a safety net for any unsorted insertions.
		if (this.taskQueue.length > 1) {
			this.taskQueue.sort((a, b) => {
				const pa = (a.lodLevel ?? 0) === 0;
				const pb = (b.lodLevel ?? 0) === 0;
				return this.compareRemeshPriority(a, pa, b, pb);
			});
		}

		const dispatchBudget = this.getDispatchBudgetPerTick();
		let dispatchedThisTick = 0;

		while (
			this.idleWorkerIndices.length > 0 &&
			dispatchedThisTick < dispatchBudget
		) {
			let taskChunk: Chunk | undefined;
			let distantTask: DistantTerrainTask | undefined;
			let precomputeLod: number | undefined;
			let taskType: "terrain" | "remesh" | "lodPrecompute" | "distantTerrain";

			if (this.terrainTaskQueue.size > 0) {
				taskChunk = this.dequeueNextTerrainChunk();
				taskType = "terrain";
			} else if (this.taskQueue.length > 0) {
				taskChunk = this.taskQueue.shift()!;
				taskType = "remesh";
			} else if (
				this.distantTerrainTaskQueue.length > 0 &&
				!this.distantTerrainInFlight &&
				this.distantTerrainReadyWorkers.size > 0
			) {
				distantTask = this.distantTerrainTaskQueue.shift();
				taskType = "distantTerrain";
			} else if (this.lodPrecomputeQueue.length > 0) {
				const task = this.lodPrecomputeQueue.shift()!;
				taskChunk = task.chunk;
				precomputeLod = task.lod;
				this.pendingLodPrecomputeKeys.delete(
					packInflightKey(task.chunk.id, task.lod),
				);
				taskType = "lodPrecompute";
			} else {
				break;
			}

			if (!(taskChunk || distantTask)) break;

			if (taskType === "remesh" && taskChunk) {
				if (this.isCompletelyEmptyChunk(taskChunk)) {
					this.clearChunkMeshIfPresent(taskChunk);
					this.pendingRemeshMap.delete(taskChunk);
					this.taskQueuePriority.delete(taskChunk);
					if (Chunk.DEBUG_REMESH) console.log(`[Pool] processQueue SKIPPED empty chunk=${taskChunk.id}`);
					continue;
				}
				// Only try cache if the chunk wasn't explicitly dirtied via scheduleRemesh
				if (!this.pendingRemeshMap.has(taskChunk)) {
					if (this.tryApplyCachedLODMesh(taskChunk)) {
						this.taskQueuePriority.delete(taskChunk);
						if (Chunk.DEBUG_REMESH) console.log(`[Pool] processQueue SKIPPED cached mesh chunk=${taskChunk.id}`);
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

			// For distantTerrain, find a ready idle worker
			if (taskType === "distantTerrain") {
				const readyIdleIndex = this.idleWorkerIndices.findIndex((idx) =>
					this.distantTerrainReadyWorkers.has(idx),
				);
				if (readyIdleIndex === -1) {
					this.distantTerrainTaskQueue.unshift(distantTask!);
					break;
				}
				// Swap to front for shift()
				const tmp = this.idleWorkerIndices[0];
				this.idleWorkerIndices[0] = this.idleWorkerIndices[readyIdleIndex]!;
				this.idleWorkerIndices[readyIdleIndex] = tmp!;
			}

			const workerIndex = this.idleWorkerIndices.shift()!;
			this.idleWorkerSet.delete(workerIndex);
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
					this.workerTaskContext[workerIndex] = {
						taskType,
						chunk: taskChunk,
						lod,
					};
					this.pendingRemeshMap.delete(taskChunk!);
					this.taskQueuePriority.delete(taskChunk!);
					this.inFlightRemeshKeys.add(packInflightKey(taskChunk!.id, lod));
					worker.postFullRemesh(taskChunk!);
					if (Chunk.DEBUG_REMESH) console.log(`[Pool] DISPATCHED remesh chunk=${taskChunk!.id} lod=${lod} worker=${workerIndex} queueLen=${this.taskQueue.length} inFlight=${this.inFlightRemeshKeys.size}`);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalRemeshDispatches++;
					dispatchedThisTick++;
				} else if (taskType === "lodPrecompute") {
					const lod = precomputeLod!;
					this.workerTaskContext[workerIndex] = {
						taskType,
						chunk: taskChunk,
						lod,
					};
					this.inFlightRemeshKeys.add(packInflightKey(taskChunk!.id, lod));
					worker.postFullRemesh(taskChunk!, lod);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalLodPrecomputeDispatches++;
					dispatchedThisTick++;
				} else {
					// distantTerrain
					this.workerTaskContext[workerIndex] = { taskType, distantTask };
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
		this.updateQueueDebugStats();

		if (Chunk.DEBUG_REMESH && dispatchedThisTick > 0) {
			console.log(`[Pool] processQueue dispatched=${dispatchedThisTick} remaining idle=${this.idleWorkerIndices.length} taskQueue=${this.taskQueue.length} terrain=${this.terrainTaskQueue.size}`);
		}

		if (this.idleWorkerIndices.length > 0 && this.hasPendingTasks()) {
			this.scheduleProcessQueuePump();
		}
	}
}
