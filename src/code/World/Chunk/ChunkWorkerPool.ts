import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import { WorldStorage } from "../WorldStorage";
import { createMeshFromData } from "./ChunckMesher";
import { Chunk } from "./Chunk";
import { ChunkWorker } from "./chunkWorker";
import type { MeshData } from "./DataStructures/MeshData";
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

export class ChunkWorkerPool {
	private static instance: ChunkWorkerPool;
	private static readonly WORKER_ERROR_COOLDOWN_MS = 120;
	private static readonly MIN_AUTO_POOL_SIZE = 2;
	private static readonly MAX_AUTO_POOL_SIZE = 12;
	private workers: ChunkWorker[] = [];

	private workerTaskContext: Array<{
		taskType: "terrain" | "remesh" | "lodPrecompute" | "distantTerrain";
		chunk?: Chunk;
		lod?: number;
		distantTask?: DistantTerrainTask;
		terrainDeferLighting?: boolean;
	} | null> = [];

	private distantTerrainSharedInit: {
		positionsBuffer: SharedArrayBuffer;
		normalsBuffer: SharedArrayBuffer;
		surfaceTilesBuffer: SharedArrayBuffer;
		radius: number;
		gridStep: number;
	} | null = null;

	private workerRestartAtMs: number[] = [];
	private taskQueue: Chunk[] = [];
	private workerDispatchCounts: number[] = [];
	private lastDispatchWorkerIndices: number[] = [];
	private pendingRemeshQueue: Map<Chunk, boolean> = new Map();
	private pendingRemeshSet: Set<Chunk> = new Set();
	private terrainTaskDeferLighting = new Map<bigint, boolean>();
	private terrainTaskQueue: Set<Chunk> = new Set();
	private deferredLightingQueue: Chunk[] = [];
	private deferredLightingQueuedIds = new Set<bigint>();
	private deferredLightingSeedStates = new Map<
		bigint,
		{ queue: Uint16Array; length: number }
	>();
	private deferredLightingPumpScheduled = false;

	// Tracks which worker indices have ACKed their InitDistantTerrainShared message
	private distantTerrainReadyWorkers = new Set<number>();

	private distantTerrainTaskQueue: DistantTerrainTask[] = [];
	private lodPrecomputeQueue: Array<{ chunk: Chunk; lod: number }> = [];
	private pendingLodPrecomputeKeys = new Set<string>();
	private lastPrecomputeScheduleTs = 0;
	private idleWorkerIndices: number[] = [];
	private meshResultQueue: FullMeshMessage[] = [];
	private remeshFlushScheduled = false;
	private processQueuePumpScheduled = false;
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
	private inFlightRemeshKeys = new Set<string>();
	private rerunRemeshAfterInflight = new Map<Chunk, boolean>();
	private static readonly DEFERRED_LIGHTING_BUDGET_MS = 2.5;
	private static readonly DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME = 1;

	private distantTerrainInFlight = false;
	private nextDistantTerrainRequestId = 1;

	private getDispatchBudgetPerTick(): number {
		const configured = Math.floor(
			SETTING_PARAMS.CHUNK_WORKER_DISPATCH_BUDGET_PER_TICK,
		);
		return configured <= 0 ? Number.POSITIVE_INFINITY : configured;
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
		if (this.processQueuePumpScheduled) {
			return;
		}
		this.processQueuePumpScheduled = true;
		requestAnimationFrame(() => {
			this.processQueuePumpScheduled = false;
			this.processQueue();
		});
	}

	private updateQueueDebugStats(): void {
		this.debugStats.workerCount = this.workers.length;
		this.debugStats.idleWorkers = this.idleWorkerIndices.length;
		this.debugStats.busyWorkers = Math.max(
			0,
			this.debugStats.workerCount - this.debugStats.idleWorkers,
		);
		if (this.debugStats.busyWorkers > this.debugStats.peakBusyWorkers) {
			this.debugStats.peakBusyWorkers = this.debugStats.busyWorkers;
		}
		this.debugStats.remeshQueueLength = this.taskQueue.length;
		this.debugStats.terrainQueueLength = this.terrainTaskQueue.size;
		this.debugStats.lodPrecomputeQueueLength = this.lodPrecomputeQueue.length;
		this.debugStats.distantTerrainQueueLength =
			this.distantTerrainTaskQueue.length;
		this.debugStats.meshResultQueueLength = this.meshResultQueue.length;
		this.debugStats.deferredLightingQueueLength =
			this.deferredLightingQueue.length;
		this.debugStats.deferredLightingSeedStateCount =
			this.deferredLightingSeedStates.size;
		this.debugStats.deferredLightingPumpScheduled =
			this.deferredLightingPumpScheduled;
		const dispatchBudget = this.getDispatchBudgetPerTick();
		this.debugStats.dispatchBudgetPerTick = Number.isFinite(dispatchBudget)
			? dispatchBudget
			: 0;
	}

	public getDebugStats(): ChunkWorkerPoolDebugStats {
		this.updateQueueDebugStats();
		return {
			...this.debugStats,
			workerDispatchCounts: [...this.workerDispatchCounts],
			lastDispatchWorkerIndices: [...this.lastDispatchWorkerIndices],
		};
	}

	private recordWorkerDispatch(workerIndex: number): void {
		if (workerIndex < 0) {
			return;
		}
		if (workerIndex >= this.workerDispatchCounts.length) {
			this.workerDispatchCounts.length = workerIndex + 1;
		}
		this.workerDispatchCounts[workerIndex] =
			(this.workerDispatchCounts[workerIndex] ?? 0) + 1;

		this.lastDispatchWorkerIndices.push(workerIndex);
		if (this.lastDispatchWorkerIndices.length > 24) {
			this.lastDispatchWorkerIndices.shift();
		}
	}

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
		if (typeof chunkId === "number" && Number.isInteger(chunkId)) {
			return Chunk.chunkInstances.get(BigInt(chunkId));
		}
		return undefined;
	}
	private normalizeChunkIdToBigInt(chunkId: unknown): bigint | undefined {
		if (typeof chunkId === "bigint") {
			return chunkId;
		}
		if (typeof chunkId === "string") {
			try {
				return BigInt(chunkId);
			} catch {
				return undefined;
			}
		}
		if (typeof chunkId === "number" && Number.isInteger(chunkId)) {
			return BigInt(chunkId);
		}
		return undefined;
	}

	private getRemeshInflightKey(chunkId: bigint, lod: number): string {
		return `${chunkId.toString()}:${lod}`;
	}

	private isSameLodRemeshInflight(chunk: Chunk): boolean {
		const lod = this.getChunkLodLevel(chunk);
		return this.inFlightRemeshKeys.has(
			this.getRemeshInflightKey(chunk.id, lod),
		);
	}

	private clearInflightRemeshByMessage(chunkId: unknown, lod: number): void {
		const normalizedChunkId = this.normalizeChunkIdToBigInt(chunkId);
		if (normalizedChunkId === undefined) {
			return;
		}
		this.inFlightRemeshKeys.delete(
			this.getRemeshInflightKey(normalizedChunkId, lod),
		);
	}
	public onDistantTerrainGenerated:
		| ((data: DistantTerrainGeneratedMessage) => void)
		| null = null;

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
				this.getRemeshInflightKey(context.chunk.id, context.lod),
			);
		}

		if (context?.taskType === "terrain" && context.chunk) {
			context.chunk.isTerrainScheduled = false;
			this.scheduleTerrainGeneration(
				context.chunk,
				context.terrainDeferLighting ?? true,
			);
		} else if (
			context?.taskType === "remesh" &&
			context.chunk &&
			context.chunk.isLoaded
		) {
			this.scheduleRemesh(context.chunk, true);
		} else if (
			context?.taskType === "lodPrecompute" &&
			context.chunk &&
			typeof context.lod === "number"
		) {
			const key = this.getLodPrecomputeKey(context.chunk, context.lod);
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

		const failedWorker = this.workers[workerIndex];
		this.idleWorkerIndices = this.idleWorkerIndices.filter(
			(idx) => idx !== workerIndex,
		);

		// Worker is no longer ready for distant terrain, must re-ack after restart
		this.distantTerrainReadyWorkers.delete(workerIndex);

		try {
			failedWorker?.terminate();
		} catch {
			// Ignore teardown errors.
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
				replacement.initDistantTerrainShared(
					this.distantTerrainSharedInit.positionsBuffer,
					this.distantTerrainSharedInit.normalsBuffer,
					this.distantTerrainSharedInit.surfaceTilesBuffer,
					this.distantTerrainSharedInit.radius,
					this.distantTerrainSharedInit.gridStep,
				);
				// distantTerrainReadyWorkers will be updated when the ACK arrives
			}

			if (!this.idleWorkerIndices.includes(workerIndex)) {
				this.idleWorkerIndices.push(workerIndex);
			}

			this.processQueue();
		};

		if (delay > 0) {
			window.setTimeout(restart, delay);
		} else {
			restart();
		}
	}

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
			this.idleWorkerIndices.push(i);
			this.workerTaskContext.push(null);
			this.workerRestartAtMs.push(0);
			this.workerDispatchCounts.push(0);
		}

		this.updateQueueDebugStats();
		this.processMeshQueueLoop();
	}

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
			createMeshFromData(chunk, {
				opaque: null,
				transparent: null,
			});
		}
	}

	private enqueueDeferredLightingRefinement(
		chunk: Chunk,
		seedQueue: Uint16Array,
		seedLength: number,
	): void {
		if (!chunk || seedLength <= 0) {
			return;
		}

		if (this.deferredLightingSeedStates.has(chunk.id)) {
			this.debugStats.deferredLightingSeedReplacedTotal += 1;
		}

		this.deferredLightingSeedStates.set(chunk.id, {
			queue: seedQueue,
			length: seedLength,
		});

		if (!this.deferredLightingQueuedIds.has(chunk.id)) {
			this.deferredLightingQueuedIds.add(chunk.id);
			this.deferredLightingQueue.push(chunk);
			this.debugStats.deferredLightingEnqueuedTotal += 1;
		}

		this.scheduleDeferredLightingPump();
	}

	private scheduleDeferredLightingPump(): void {
		if (this.deferredLightingPumpScheduled) {
			return;
		}
		this.deferredLightingPumpScheduled = true;
		requestAnimationFrame(() => {
			this.deferredLightingPumpScheduled = false;
			this.processDeferredLightingQueue();
		});
	}

	private processDeferredLightingQueue(): void {
		const start = performance.now();
		let processed = 0;
		let dropped = 0;

		while (
			this.deferredLightingQueue.length > 0 &&
			processed < ChunkWorkerPool.DEFERRED_LIGHTING_MAX_CHUNKS_PER_FRAME &&
			performance.now() - start < ChunkWorkerPool.DEFERRED_LIGHTING_BUDGET_MS
		) {
			const chunk = this.deferredLightingQueue.shift();
			if (!chunk) {
				continue;
			}

			this.deferredLightingQueuedIds.delete(chunk.id);

			const seedState = this.deferredLightingSeedStates.get(chunk.id);
			this.deferredLightingSeedStates.delete(chunk.id);
			if (!seedState) {
				dropped++;
				continue;
			}

			if (!chunk.isLoaded || !chunk.hasVoxelData) {
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
		if (!chunk.isLoaded || !chunk.hasVoxelData) {
			return;
		}

		const size = Chunk.SIZE;
		const last = size - 1;

		const syncFace = (
			neighbor: Chunk | undefined,
			mapCell: (
				u: number,
				v: number,
			) => [number, number, number, number, number, number],
		): void => {
			if (!neighbor || !neighbor.isLoaded || !neighbor.hasVoxelData) {
				return;
			}

			for (let u = 0; u < size; u++) {
				for (let v = 0; v < size; v++) {
					const [x, y, z, nx, ny, nz] = mapCell(u, v);
					const selfSky = chunk.getSkyLight(x, y, z);
					const neighborSky = neighbor.getSkyLight(nx, ny, nz);

					if (selfSky === neighborSky) {
						continue;
					}

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

	private processMeshQueueLoop = () => {
		const start = performance.now();
		let processed = 0;
		while (this.meshResultQueue.length > 0 && performance.now() - start < 5) {
			const data = this.meshResultQueue.shift();
			if (data) {
				processed++;
				const { chunkId, lod, opaque, transparent } = data;
				const chunk = this.resolveChunkByMessageId(chunkId);
				if (chunk) {
					this.storeReturnedLODMesh(
						chunk,
						lod,
						opaque ?? null,
						transparent ?? null,
					);

					if ((chunk.lodLevel ?? 0) === lod) {
						createMeshFromData(chunk, {
							opaque,
							transparent,
						});
						chunk.isDirty = false;
					}
				}
			}
		}
		this.debugStats.lastMeshProcessed = processed;
		this.debugStats.totalMeshProcessed += processed;
		this.debugStats.lastMeshDrainMs = performance.now() - start;
		this.updateQueueDebugStats();
		requestAnimationFrame(this.processMeshQueueLoop);
	};

	private static resolvePoolSize(explicitPoolSize?: number): number {
		const explicit =
			typeof explicitPoolSize === "number"
				? Math.floor(explicitPoolSize)
				: Number.NaN;
		if (Number.isFinite(explicit) && explicit > 0) {
			return explicit;
		}

		const configured = Math.floor(SETTING_PARAMS.CHUNK_WORKER_POOL_SIZE);
		if (Number.isFinite(configured) && configured > 0) {
			return configured;
		}

		const detected = Math.max(
			1,
			Math.floor((navigator.hardwareConcurrency ?? 0) || 0),
		);
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

	public scheduleRemesh(chunk: Chunk | undefined, priority = false) {
		if (!chunk?.isLoaded) {
			return;
		}

		if (!chunk.hasVoxelData) {
			this.tryApplyCachedLODMesh(chunk, true);
			return;
		}

		if (this.isCompletelyEmptyChunk(chunk)) {
			this.pendingRemeshQueue.delete(chunk);
			this.pendingRemeshSet.delete(chunk);
			const queuedIndex = this.taskQueue.indexOf(chunk);
			if (queuedIndex !== -1) {
				this.taskQueue.splice(queuedIndex, 1);
			}
			this.clearChunkMeshIfPresent(chunk);
			return;
		}

		if (this.isSameLodRemeshInflight(chunk)) {
			this.rerunRemeshAfterInflight.set(chunk, true);
			return;
		}

		const lodPriority = this.getChunkLodLevel(chunk) === 0;
		const existingPriority = this.pendingRemeshQueue.get(chunk) ?? false;

		this.pendingRemeshQueue.set(
			chunk,
			existingPriority || priority || lodPriority,
		);
		this.pendingRemeshSet.add(chunk);

		this.scheduleRemeshFlush();
	}

	private scheduleRemeshFlush() {
		if (this.remeshFlushScheduled) {
			return;
		}
		this.remeshFlushScheduled = true;
		requestAnimationFrame(() => {
			this.remeshFlushScheduled = false;
			this.flushPendingRemeshQueue();
		});
	}

	private flushPendingRemeshQueue() {
		if (this.pendingRemeshQueue.size === 0) {
			return;
		}

		const pending = Array.from(this.pendingRemeshQueue.entries());
		this.pendingRemeshQueue.clear();

		pending.sort(([chunkA, priorityA], [chunkB, priorityB]) =>
			this.compareRemeshPriority(chunkA, priorityA, chunkB, priorityB),
		);

		for (const [chunk, priority] of pending) {
			if (!chunk.isLoaded) {
				continue;
			}

			if (this.isCompletelyEmptyChunk(chunk)) {
				this.clearChunkMeshIfPresent(chunk);
				this.pendingRemeshSet.delete(chunk);
				continue;
			}

			this.insertChunkIntoRemeshQueue(chunk, priority);
		}

		this.processQueue();
	}

	private storeReturnedLODMesh(
		chunk: Chunk,
		lod: number,
		opaque: MeshData | null,
		transparent: MeshData | null,
	): void {
		chunk.setCachedLODMesh(lod, {
			opaque: opaque ?? null,
			transparent: transparent ?? null,
		});
	}

	public scheduleDistantTerrain(
		centerChunkX: number,
		centerChunkZ: number,
		radius: number,
		renderDistance: number,
		gridStep: number,
	): void {
		const requestId = this.nextDistantTerrainRequestId++;
		// Only keep the newest request
		this.distantTerrainTaskQueue = [
			{
				requestId,
				centerChunkX,
				centerChunkZ,
				radius,
				renderDistance,
				gridStep,
			},
		];

		this.processQueue();
	}

	private tryApplyCachedLODMesh(
		chunk: Chunk,
		allowDirtyReuse = false,
	): boolean {
		// Never reuse cache for a chunk that was explicitly marked for remesh.
		// Border edits and light changes set isDirty via scheduleRemesh().
		if (!allowDirtyReuse && chunk.isDirty) {
			return false;
		}

		// IMPORTANT:
		// If this chunk has real voxel data, only trust cached border geometry
		// when all 6 direct neighbors are also loaded and voxel-backed.
		//
		// This prevents reusing stale cached meshes that were built while one or
		// more border neighbors were missing, unloaded, or still mesh-only.
		//
		// We intentionally do NOT apply this rule to mesh-only far chunks
		// (!chunk.hasVoxelData), because those rely on cached LOD meshes by design.
		if (
			chunk.hasVoxelData &&
			!this.hasStableVoxelNeighborsForCachedMesh(chunk)
		) {
			return false;
		}

		const cached = chunk.getCachedLODMesh(chunk.lodLevel);
		if (!cached) {
			return false;
		}

		if (!cached.opaque && !cached.transparent) {
			return false;
		}

		createMeshFromData(chunk, {
			opaque: cached.opaque,
			transparent: cached.transparent,
		});

		chunk.isDirty = false;
		return true;
	}

	private makeTerrainMessageHandler(
		workerIndex: number,
		getWorker: () => ChunkWorker | undefined,
	) {
		return (event: MessageEvent<WorkerMessageData>) => {
			let failed = false;

			try {
				const data = event.data;
				const { type } = data;

				if (type === WorkerTaskType.InitDistantTerrainShared) {
					// Worker ACK — shared buffers are now initialized on the worker side.
					// Mark it ready for distant terrain dispatch and trigger queue.
					// Do NOT touch idleWorkerIndices here — the worker was already idle.
					this.distantTerrainReadyWorkers.add(workerIndex);
					this.processQueue();
					return;
				}

				if (type === WorkerTaskType.GenerateFullMesh) {
					const meshData: FullMeshMessage = data;

					this.clearInflightRemeshByMessage(meshData.chunkId, meshData.lod);
					this.meshResultQueue.push(meshData);

					const resolvedChunk = this.resolveChunkByMessageId(meshData.chunkId);
					if (
						resolvedChunk &&
						this.rerunRemeshAfterInflight.get(resolvedChunk)
					) {
						this.rerunRemeshAfterInflight.delete(resolvedChunk);
						this.scheduleRemesh(
							resolvedChunk,
							(resolvedChunk.lodLevel ?? 0) === 0,
						);
					}
				} else if (type === WorkerTaskType.GenerateTerrain) {
					const terrainData: TerrainGeneratedMessage = data;

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
						// Terrain came back for a chunk that's no longer wanted, populate
						// the data so it's available if the chunk is needed again, but skip
						// remesh and mark for unload instead of rendering it.
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

						const needsLightingRefinement =
							lightSeedQueue !== undefined &&
							lightSeedLength !== undefined &&
							lightSeedLength > 0;

						if (isStale) {
							// Don't remesh stale chunks. Also avoid persisting partially-lit
							// deferred chunks; they can regenerate later with full refinement.
							if (!needsLightingRefinement) {
								void WorldStorage.saveChunk(chunk).catch((error) => {
									console.error(
										"Initial generated chunk persistence failed:",
										error,
									);
								});
							}
							return;
						}

						this.scheduleChunkAndNeighborsRemesh(chunk);
						this.maybeRemeshNeighborsNowStable(chunk);

						const shouldQueueLightingRefinement = needsLightingRefinement;

						if (shouldQueueLightingRefinement) {
							const seedState = {
								queue: lightSeedQueue as Uint16Array,
								length: lightSeedLength as number,
							};
							this.enqueueDeferredLightingRefinement(
								chunk,
								seedState.queue,
								seedState.length,
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
					const distantData: DistantTerrainGeneratedMessage = data;
					this.onDistantTerrainGenerated?.(distantData);
					this.distantTerrainInFlight = false;
				}
			} catch (messageError) {
				failed = true;
				console.error(
					`Chunk worker ${workerIndex} onmessage failed; respawning worker`,
					messageError,
				);
				this.handleWorkerFailure(workerIndex, messageError);
				return;
			}

			if (failed) return;
			if (this.workers[workerIndex] !== getWorker()) return;

			this.workerTaskContext[workerIndex] = null;

			if (!this.idleWorkerIndices.includes(workerIndex)) {
				this.idleWorkerIndices.push(workerIndex);
			}

			this.processQueue();
		};
	}

	private makeMeshMessageHandler(
		workerIndex: number,
		getWorker: () => ChunkWorker | undefined,
	) {
		return (event: MessageEvent<MeshWorkerResponse>) => {
			let failed = false;
			try {
				const data = event.data;

				this.clearInflightRemeshByMessage(data.chunkId, data.lod);

				const fullMeshMessage: FullMeshMessage = {
					type: WorkerTaskType.GenerateFullMesh,
					chunkId: data.chunkId as bigint,
					lod: data.lod,
					opaque: data.opaque,
					transparent: data.transparent,
				};

				this.meshResultQueue.push(fullMeshMessage);

				// NEW: if a same-lod remesh request arrived while this one was in flight,
				// schedule exactly one follow-up rerun now.
				const resolvedChunk = this.resolveChunkByMessageId(data.chunkId);
				if (resolvedChunk && this.rerunRemeshAfterInflight.get(resolvedChunk)) {
					this.rerunRemeshAfterInflight.delete(resolvedChunk);
					this.scheduleRemesh(
						resolvedChunk,
						(resolvedChunk.lodLevel ?? 0) === 0,
					);
				}
			} catch (messageError) {
				failed = true;
				console.error(
					`Chunk worker ${workerIndex} mesh onmessage failed; respawning worker`,
					messageError,
				);
				this.handleWorkerFailure(workerIndex, messageError);
				return;
			}

			if (failed) return;
			if (this.workers[workerIndex] !== getWorker()) return;

			this.workerTaskContext[workerIndex] = null;
			if (!this.idleWorkerIndices.includes(workerIndex)) {
				this.idleWorkerIndices.push(workerIndex);
			}
			this.processQueue();
		};
	}

	private getChunkLodLevel(chunk: Chunk | undefined): number {
		return chunk?.lodLevel ?? 0;
	}

	private compareRemeshPriority(
		aChunk: Chunk,
		aPriority: boolean,
		bChunk: Chunk,
		bPriority: boolean,
	): number {
		if (aPriority !== bPriority) {
			return aPriority ? -1 : 1;
		}

		const aLod = this.getChunkLodLevel(aChunk);
		const bLod = this.getChunkLodLevel(bChunk);
		if (aLod !== bLod) {
			return aLod - bLod;
		}

		if (aChunk.isModified !== bChunk.isModified) {
			return aChunk.isModified ? -1 : 1;
		}

		return 0;
	}

	private dequeueNextTerrainChunk(): Chunk | undefined {
		for (const chunk of this.terrainTaskQueue) {
			this.terrainTaskQueue.delete(chunk);
			return chunk;
		}
		return undefined;
	}

	private insertChunkIntoRemeshQueue(chunk: Chunk, priority: boolean): void {
		// Remove if already present so we can reinsert in the right position
		const existingIndex = this.taskQueue.indexOf(chunk);
		if (existingIndex !== -1) {
			this.taskQueue.splice(existingIndex, 1);
		}

		let insertIndex = this.taskQueue.length;

		for (let i = 0; i < this.taskQueue.length; i++) {
			const queuedChunk = this.taskQueue[i];
			const queuedPriority = false; // queued items no longer carry explicit flag
			if (
				this.compareRemeshPriority(
					chunk,
					priority,
					queuedChunk,
					queuedPriority,
				) < 0
			) {
				insertIndex = i;
				break;
			}
		}

		this.taskQueue.splice(insertIndex, 0, chunk);
	}

	public scheduleTerrainGeneration(
		chunk: Chunk,
		deferLighting: boolean = true,
	): void {
		if (!chunk) {
			return;
		}

		this.terrainTaskQueue.add(chunk);

		const existing = this.terrainTaskDeferLighting.get(chunk.id);

		// If already queued:
		// - keep false if any caller requests full lighting
		// - otherwise default to true for fast first pass
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
		deferLighting: boolean = true,
	): void {
		for (const chunk of chunks) {
			if (!chunk) continue;

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

	private getLodPrecomputeKey(chunk: Chunk, lod: number): string {
		return `${chunk.id.toString()}:${lod}`;
	}

	private dispatchTerrainTaskToWorker(
		workerIndex: number,
		worker: ChunkWorker,
		chunk: Chunk,
	): boolean {
		if (!chunk) {
			return false;
		}

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

	public scheduleBackgroundLodPrecompute(
		centerChunkX: number,
		centerChunkY: number,
		centerChunkZ: number,
	): void {
		const now = performance.now();
		const throttleMs = Math.max(
			0,
			Math.floor(SETTING_PARAMS.LOD_PRECOMPUTE_SCHEDULE_THROTTLE_MS),
		);
		// Throttle precompute scheduling to keep traversal overhead low.
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
		const targetLods = [2, 3];
		const candidates: Array<{ chunk: Chunk; lod: number; score: number }> = [];

		for (const chunk of Chunk.chunkInstances.values()) {
			if (!chunk.isLoaded || !chunk.hasVoxelData) continue;
			if (chunk.isDirty) continue;
			// Only precompute coarse LODs for chunks that were created/edited in this
			// session. Persisted chunks should reuse stored LOD meshes without
			// rebuilding simplified arrays during movement.
			if (!chunk.isModified) continue;

			const horizontalDist = Math.max(
				Math.abs(chunk.chunkX - centerChunkX),
				Math.abs(chunk.chunkZ - centerChunkZ),
			);
			const verticalDist = Math.abs(chunk.chunkY - centerChunkY);
			if (horizontalDist > horizontalRadius || verticalDist > verticalRadius) {
				continue;
			}

			for (const lod of targetLods) {
				if (chunk.hasCachedLODMesh(lod)) continue;
				const key = this.getLodPrecomputeKey(chunk, lod);
				if (this.pendingLodPrecomputeKeys.has(key)) continue;

				const score = horizontalDist * 100 + verticalDist * 10 + lod;
				candidates.push({ chunk, lod, score });
			}
		}

		if (candidates.length === 0) {
			return;
		}

		candidates.sort((a, b) => a.score - b.score);

		const maxEnqueue = Math.max(
			1,
			Math.floor(SETTING_PARAMS.LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE),
		);
		let added = 0;
		for (const candidate of candidates) {
			if (added >= maxEnqueue) break;
			const key = this.getLodPrecomputeKey(candidate.chunk, candidate.lod);
			if (this.pendingLodPrecomputeKeys.has(key)) continue;
			this.pendingLodPrecomputeKeys.add(key);
			this.lodPrecomputeQueue.push({
				chunk: candidate.chunk,
				lod: candidate.lod,
			});
			added++;
		}

		if (added > 0) {
			this.updateQueueDebugStats();
			this.processQueue();
		}
	}

	private scheduleChunkAndNeighborsRemesh(chunk: Chunk): void {
		const targets: (Chunk | undefined)[] = [
			chunk,
			chunk.getNeighbor(-1, 0, 0),
			chunk.getNeighbor(0, 0, -1),
			chunk.getNeighbor(0, -1, 0),
			chunk.getNeighbor(1, 0, 0),
			chunk.getNeighbor(0, 0, 1),
			chunk.getNeighbor(0, 1, 0),
		];

		for (const target of targets) {
			if (!target) continue;
			this.scheduleRemesh(target, this.getChunkLodLevel(target) === 0);
		}
	}

	private hasStableVoxelNeighborsForCachedMesh(chunk: Chunk): boolean {
		const neighbors: Array<Chunk | undefined> = [
			chunk.getNeighbor(-1, 0, 0),
			chunk.getNeighbor(1, 0, 0),
			chunk.getNeighbor(0, -1, 0),
			chunk.getNeighbor(0, 1, 0),
			chunk.getNeighbor(0, 0, -1),
			chunk.getNeighbor(0, 0, 1),
		];

		for (const neighbor of neighbors) {
			if (!neighbor) return false;
			if (!neighbor.isLoaded) return false;
			if (!neighbor.hasVoxelData) return false;
		}

		return true;
	}

	private maybeRemeshNeighborsNowStable(chunk: Chunk): void {
		const neighbors: Array<Chunk | undefined> = [
			chunk.getNeighbor(-1, 0, 0),
			chunk.getNeighbor(1, 0, 0),
			chunk.getNeighbor(0, -1, 0),
			chunk.getNeighbor(0, 1, 0),
			chunk.getNeighbor(0, 0, -1),
			chunk.getNeighbor(0, 0, 1),
		];

		for (const neighbor of neighbors) {
			if (!neighbor) continue;
			if (!neighbor.isLoaded || !neighbor.hasVoxelData) continue;

			const cached = neighbor.getCachedLODMesh(neighbor.lodLevel);
			if (!cached) continue;

			if (this.hasStableVoxelNeighborsForCachedMesh(neighbor)) {
				neighbor.isDirty = true;
				this.scheduleRemesh(neighbor, (neighbor.lodLevel ?? 0) === 0);
			}
		}
	}

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

		// Send init to all workers. Each will ACK via InitDistantTerrainShared
		// message, at which point we add them to distantTerrainReadyWorkers.
		for (let i = 0; i < this.workers.length; i++) {
			this.distantTerrainReadyWorkers.delete(i); // clear stale ready state
			this.workers[i].initDistantTerrainShared(
				positionsBuffer,
				normalsBuffer,
				surfaceTilesBuffer,
				radius,
				gridStep,
			);
		}
	}

	private processQueue() {
		this.updateQueueDebugStats();

		if (this.taskQueue.length > 1) {
			this.taskQueue.sort((a, b) =>
				this.compareRemeshPriority(
					a,
					this.getChunkLodLevel(a) === 0,
					b,
					this.getChunkLodLevel(b) === 0,
				),
			);
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

			// 1) Terrain generation first
			if (this.terrainTaskQueue.size > 0) {
				taskChunk = this.dequeueNextTerrainChunk();
				taskType = "terrain";
			}
			// 2) Then remesh
			else if (this.taskQueue.length > 0) {
				taskChunk = this.taskQueue.shift();
				taskType = "remesh";
			}
			// 3) Then distant terrain — only if a ready worker exists
			else if (
				this.distantTerrainTaskQueue.length > 0 &&
				!this.distantTerrainInFlight &&
				this.distantTerrainReadyWorkers.size > 0
			) {
				distantTask = this.distantTerrainTaskQueue.shift();
				taskType = "distantTerrain";
			}
			// 4) Then background LOD precompute
			else if (this.lodPrecomputeQueue.length > 0) {
				const task = this.lodPrecomputeQueue.shift()!;
				taskChunk = task.chunk;
				precomputeLod = task.lod;
				this.pendingLodPrecomputeKeys.delete(
					this.getLodPrecomputeKey(task.chunk, task.lod),
				);
				taskType = "lodPrecompute";
			} else {
				break;
			}

			if (!(taskChunk || distantTask)) {
				break;
			}

			if (
				taskType === "remesh" &&
				taskChunk &&
				this.isCompletelyEmptyChunk(taskChunk)
			) {
				this.clearChunkMeshIfPresent(taskChunk);
				this.pendingRemeshSet.delete(taskChunk);
				continue;
			}

			if (taskType === "remesh" && taskChunk) {
				if (!this.pendingRemeshSet.has(taskChunk)) {
					if (this.tryApplyCachedLODMesh(taskChunk)) {
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

			// For distant terrain, find a worker that has ACKed its shared init.
			// Swap the chosen idle worker for a ready one if needed.
			if (taskType === "distantTerrain") {
				const readyIdleIndex = this.idleWorkerIndices.findIndex((idx) =>
					this.distantTerrainReadyWorkers.has(idx),
				);

				if (readyIdleIndex === -1) {
					// No ready worker is idle right now — re-queue and stop
					this.distantTerrainTaskQueue.unshift(distantTask!);
					break;
				}

				// Swap the ready worker to the front so the shift below picks it
				const tmp = this.idleWorkerIndices[0];
				this.idleWorkerIndices[0] = this.idleWorkerIndices[readyIdleIndex];
				this.idleWorkerIndices[readyIdleIndex] = tmp;
			}

			const workerIndex = this.idleWorkerIndices.shift()!;
			const worker = this.workers[workerIndex];

			try {
				if (taskType === "terrain") {
					if (!taskChunk) {
						if (!this.idleWorkerIndices.includes(workerIndex)) {
							this.idleWorkerIndices.push(workerIndex);
						}
						continue;
					}

					this.dispatchTerrainTaskToWorker(workerIndex, worker, taskChunk);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalTerrainDispatches += 1;
					dispatchedThisTick += 1;
				} else if (taskType === "remesh") {
					const lod = this.getChunkLodLevel(taskChunk);

					this.workerTaskContext[workerIndex] = {
						taskType,
						chunk: taskChunk,
						lod,
					};

					this.pendingRemeshSet.delete(taskChunk!);
					this.inFlightRemeshKeys.add(
						this.getRemeshInflightKey(taskChunk!.id, lod),
					);

					worker.postFullRemesh(taskChunk!);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalRemeshDispatches += 1;
					dispatchedThisTick += 1;
				} else if (taskType === "lodPrecompute") {
					const lod = precomputeLod!;

					this.workerTaskContext[workerIndex] = {
						taskType,
						chunk: taskChunk,
						lod,
					};

					this.inFlightRemeshKeys.add(
						this.getRemeshInflightKey(taskChunk!.id, lod),
					);

					worker.postFullRemesh(taskChunk!, lod);
					this.recordWorkerDispatch(workerIndex);
					this.debugStats.totalLodPrecomputeDispatches += 1;
					dispatchedThisTick += 1;
				} else {
					// distantTerrain — worker is guaranteed ready here
					this.workerTaskContext[workerIndex] = {
						taskType,
						distantTask,
					};

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
					this.debugStats.totalDistantDispatches += 1;
					dispatchedThisTick += 1;
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

		if (this.idleWorkerIndices.length > 0 && this.hasPendingTasks()) {
			this.scheduleProcessQueuePump();
		}
	}
}
