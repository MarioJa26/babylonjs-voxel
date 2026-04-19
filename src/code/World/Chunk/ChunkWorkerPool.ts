import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import { WorldStorage } from "../WorldStorage";
import { ChunkMesher } from "./ChunckMesher";
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
	remeshQueueLength: number;
	terrainQueueLength: number;
	lodPrecomputeQueueLength: number;
	distantTerrainQueueLength: number;
	meshResultQueueLength: number;
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
};

export class ChunkWorkerPool {
	private static instance: ChunkWorkerPool;
	private static readonly WORKER_ERROR_COOLDOWN_MS = 120;
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
	private pendingRemeshQueue: Map<Chunk, boolean> = new Map();
	private terrainTaskDeferLighting = new Map<bigint, boolean>();
	private terrainTaskQueue: Set<Chunk> = new Set();
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
		remeshQueueLength: 0,
		terrainQueueLength: 0,
		lodPrecomputeQueueLength: 0,
		distantTerrainQueueLength: 0,
		meshResultQueueLength: 0,
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
	};
	private inFlightRemeshKeys = new Set<string>();
	private rerunRemeshAfterInflight = new Map<Chunk, boolean>();

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
		this.debugStats.remeshQueueLength = this.taskQueue.length;
		this.debugStats.terrainQueueLength = this.terrainTaskQueue.size;
		this.debugStats.lodPrecomputeQueueLength = this.lodPrecomputeQueue.length;
		this.debugStats.distantTerrainQueueLength =
			this.distantTerrainTaskQueue.length;
		this.debugStats.meshResultQueueLength = this.meshResultQueue.length;
		const dispatchBudget = this.getDispatchBudgetPerTick();
		this.debugStats.dispatchBudgetPerTick = Number.isFinite(dispatchBudget)
			? dispatchBudget
			: 0;
	}

	public getDebugStats(): ChunkWorkerPoolDebugStats {
		this.updateQueueDebugStats();
		return { ...this.debugStats };
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

			const replacement = new ChunkWorker(onMessageTerrain, onMessageMesh);
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

			const workerWrapper = new ChunkWorker(onMessageTerrain, onMessageMesh);
			workerWrapper.setOnError(onError);
			holder.worker = workerWrapper;

			this.workers.push(workerWrapper);
			this.idleWorkerIndices.push(i);
			this.workerTaskContext.push(null);
			this.workerRestartAtMs.push(0);
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
			ChunkMesher.createMeshFromData(chunk, {
				opaque: null,
				transparent: null,
			});
		}
	}

	private processMeshQueueLoop = () => {
		const start = performance.now();
		let processed = 0;
		// Process meshes for up to 4ms per frame to prevent stutter
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

					// Only apply immediately if the chunk is still on the same LOD
					// that produced this worker result.
					if ((chunk.lodLevel ?? 0) === lod) {
						ChunkMesher.createMeshFromData(chunk, {
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

	public static getInstance(
		poolSize = navigator.hardwareConcurrency || 4,
	): ChunkWorkerPool {
		if (!ChunkWorkerPool.instance) {
			ChunkWorkerPool.instance = new ChunkWorkerPool(poolSize);
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

		// Mesh-only far LOD chunks do not carry voxel data, so worker remesh would
		// collapse to empty geometry. Keep cached mesh instead until hydrated.
		if (!chunk.hasVoxelData) {
			this.tryApplyCachedLODMesh(chunk, true);
			return;
		}

		if (this.isCompletelyEmptyChunk(chunk)) {
			this.pendingRemeshQueue.delete(chunk);
			const queuedIndex = this.taskQueue.indexOf(chunk);
			if (queuedIndex !== -1) {
				this.taskQueue.splice(queuedIndex, 1);
			}
			this.clearChunkMeshIfPresent(chunk);
			return;
		}

		// NEW: if the same chunk at the same current LOD is already being meshed,
		// do not queue duplicate work. Remember one follow-up rerun instead.
		if (this.isSameLodRemeshInflight(chunk)) {
			this.rerunRemeshAfterInflight.set(chunk, true);
			return;
		}

		const lodPriority = this.getChunkLodLevel(chunk) === 0;
		const existingPriority = this.pendingRemeshQueue.get(chunk) ?? false;

		// LOD0 chunks automatically get promoted
		this.pendingRemeshQueue.set(
			chunk,
			existingPriority || priority || lodPriority,
		);

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

		// Sort before inserting so LOD0 + explicit priority goes first
		pending.sort(([chunkA, priorityA], [chunkB, priorityB]) =>
			this.compareRemeshPriority(chunkA, priorityA, chunkB, priorityB),
		);

		for (const [chunk, priority] of pending) {
			if (!chunk.isLoaded) {
				continue;
			}

			if (this.isCompletelyEmptyChunk(chunk)) {
				this.clearChunkMeshIfPresent(chunk);
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
	) {
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

		ChunkMesher.createMeshFromData(chunk, {
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

						if (isStale) {
							// Don't remesh, just save and let the unload queue clean it up.
							void WorldStorage.saveChunk(chunk).catch((error) => {
								console.error(
									"Initial generated chunk persistence failed:",
									error,
								);
							});
							return;
						}

						this.scheduleChunkAndNeighborsRemesh(chunk);
						this.maybeRemeshNeighborsNowStable(chunk);

						const needsLightingRefinement =
							lightSeedQueue !== undefined &&
							lightSeedLength !== undefined &&
							lightSeedLength > 0;

						if (needsLightingRefinement) {
							this.scheduleTerrainGeneration(chunk, false);
						}

						void WorldStorage.saveChunk(chunk).catch((error) => {
							console.error(
								"Initial generated chunk persistence failed:",
								error,
							);
						});
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

				// NEW: clear the in-flight remesh key for this exact (chunk, lod)
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
		// Explicit priority always wins first
		if (aPriority !== bPriority) {
			return aPriority ? -1 : 1;
		}

		// Then prefer lower LOD value (LOD0 before LOD1)
		const aLod = this.getChunkLodLevel(aChunk);
		const bLod = this.getChunkLodLevel(bChunk);
		if (aLod !== bLod) {
			return aLod - bLod;
		}

		// Then prefer modified chunks
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

		const horizontalRadius = SETTING_PARAMS.RENDER_DISTANCE + 14;
		const verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE + 4;
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
			if (!neighbor) {
				return false;
			}

			if (!neighbor.isLoaded) {
				return false;
			}

			if (!neighbor.hasVoxelData) {
				return false;
			}
		}

		return true;
	}

	// When a chunk becomes loaded with voxel data, adjacent neighbors that
	// currently have cached LOD meshes may have been built earlier while this
	// chunk was missing. If those neighbors now have all 6 voxel-backed
	// neighbors available, mark them dirty and schedule a remesh so border
	// geometry is generated instead of reusing stale cached meshes.
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
			// Only consider neighbors that are loaded and carry voxel data (not
			// mesh-only far LOD chunks).
			if (!neighbor.isLoaded || !neighbor.hasVoxelData) continue;

			const cached = neighbor.getCachedLODMesh(neighbor.lodLevel);
			if (!cached) continue;

			// If this neighbor now has stable voxel neighbors, force a remesh.
			if (this.hasStableVoxelNeighborsForCachedMesh(neighbor)) {
				// Prevent reusing cached mesh by marking dirty so remesh will rebuild
				// proper border geometry.
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

		for (const worker of this.workers) {
			worker.initDistantTerrainShared(
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

		// Keep remesh queue stable and LOD-aware before dispatching
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
			// 3) Then background LOD precompute
			else if (this.lodPrecomputeQueue.length > 0) {
				const task = this.lodPrecomputeQueue.shift()!;
				taskChunk = task.chunk;
				precomputeLod = task.lod;
				this.pendingLodPrecomputeKeys.delete(
					this.getLodPrecomputeKey(task.chunk, task.lod),
				);
				taskType = "lodPrecompute";
			}
			// 4) Then distant terrain
			else if (
				this.distantTerrainTaskQueue.length > 0 &&
				!this.distantTerrainInFlight
			) {
				distantTask = this.distantTerrainTaskQueue.shift();
				taskType = "distantTerrain";
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
				continue;
			}

			if (taskType === "remesh" && taskChunk) {
				if (this.tryApplyCachedLODMesh(taskChunk)) {
					continue;
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
					this.debugStats.totalTerrainDispatches += 1;
					dispatchedThisTick += 1;
				} else if (taskType === "remesh") {
					const lod = this.getChunkLodLevel(taskChunk);

					this.workerTaskContext[workerIndex] = {
						taskType,
						chunk: taskChunk,
						lod,
					};

					this.inFlightRemeshKeys.add(
						this.getRemeshInflightKey(taskChunk!.id, lod),
					);

					worker.postFullRemesh(taskChunk!);
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
					this.debugStats.totalLodPrecomputeDispatches += 1;
					dispatchedThisTick += 1;
				} else {
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
