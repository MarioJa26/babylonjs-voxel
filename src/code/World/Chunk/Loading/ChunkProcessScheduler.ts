import { type SavedChunkData, WorldStorage } from "../../WorldStorage";
import { Chunk } from "../Chunk";
import type { QueuedChunkRequest } from "./ChunkStreamingController";
import { ProcessStage } from "./ChunkTypes";

export type InFlightProcessState = {
	stage: ProcessStage;
	sliceStartMs: number;

	loadedFromStorageCount: number;
	generatedCount: number;
	hydratedCount: number;
	unloadedCount: number;
	savedCount: number;
	lodCacheVersionMismatchCount: number;

	unloadBatch: Chunk[];
	unloadBatchIndex: number;
	savedChunkIds: Set<bigint>;

	loadBatch: QueuedChunkRequest[];
	validLoadBatch: QueuedChunkRequest[];
	nearRequests: QueuedChunkRequest[];
	farRequests: QueuedChunkRequest[];
	nearLoadedDataMap: Map<bigint, SavedChunkData>;
	farLoadedDataMap: Map<bigint, SavedChunkData>;
	applyLoadedIndex: number;
	chunksToGenerate: Chunk[];
	chunksNeedingFullHydration: Set<bigint>;

	hydrateIds: bigint[];
	hydrateMap: Map<bigint, SavedChunkData>;
	hydrateIndex: number;
};

export interface ChunkProcessSchedulerAdapter {
	getLoadQueue(): QueuedChunkRequest[];
	getUnloadQueueSet(): Set<Chunk>;

	getLoadBatchSize(): number;
	getUnloadBatchSize(): number;
	getProcessFrameBudgetMs(): number;

	getDesiredState(
		chunkId: bigint,
	): { desiredLod: number; revision: number } | undefined;

	unloadChunkBoundEntitiesForChunk(chunk: Chunk): Promise<void>;

	applyLoadedChunkFromSavedData(
		state: InFlightProcessState,
		request: QueuedChunkRequest,
		savedData: SavedChunkData,
	): void;

	applyHydratedChunkFromSavedData(
		chunk: Chunk,
		savedData: SavedChunkData,
	): void;

	scheduleTerrainGenerationBatch(chunks: Chunk[]): void;

	updateSliceDebugStats(state: InFlightProcessState): void;
	finalizeProcessState(state: InFlightProcessState): void;

	onQueueSnapshotChanged?(): void;
	onLoadRequestsDequeued?(requests: ReadonlyArray<QueuedChunkRequest>): void;
	onProcessError?(error: unknown): void;
}

export class ChunkProcessScheduler {
	private isProcessing = false;
	private inFlightProcessState: InFlightProcessState | null = null;
	private _state: InFlightProcessState = this.createReusableProcessState();
	private processContinuationScheduled = false;

	public constructor(private readonly adapter: ChunkProcessSchedulerAdapter) {}

	public get processing(): boolean {
		return this.isProcessing;
	}
	private createReusableProcessState(): InFlightProcessState {
		return {
			stage: ProcessStage.Start,
			sliceStartMs: 0,

			loadedFromStorageCount: 0,
			generatedCount: 0,
			hydratedCount: 0,
			unloadedCount: 0,
			savedCount: 0,
			lodCacheVersionMismatchCount: 0,

			unloadBatch: [],
			unloadBatchIndex: 0,
			savedChunkIds: new Set(),

			loadBatch: [],
			validLoadBatch: [],
			nearRequests: [],
			farRequests: [],
			nearLoadedDataMap: new Map(),
			farLoadedDataMap: new Map(),
			applyLoadedIndex: 0,
			chunksToGenerate: [],
			chunksNeedingFullHydration: new Set(),

			hydrateIds: [],
			hydrateMap: new Map(),
			hydrateIndex: 0,
		};
	}
	private resetState(state: InFlightProcessState): void {
		state.stage = ProcessStage.Start;

		state.loadedFromStorageCount = 0;
		state.generatedCount = 0;
		state.hydratedCount = 0;
		state.unloadedCount = 0;
		state.savedCount = 0;
		state.lodCacheVersionMismatchCount = 0;

		state.unloadBatch.length = 0;
		state.unloadBatchIndex = 0;
		state.savedChunkIds?.clear();

		state.loadBatch.length = 0;
		state.validLoadBatch.length = 0;
		state.nearRequests.length = 0;
		state.farRequests.length = 0;

		state.nearLoadedDataMap.clear();
		state.farLoadedDataMap.clear();

		state.applyLoadedIndex = 0;
		state.chunksToGenerate.length = 0;
		state.chunksNeedingFullHydration.clear();

		state.hydrateIds.length = 0;
		state.hydrateMap.clear();
		state.hydrateIndex = 0;
	}

	private _chunksToSave: Chunk[] = [];
	public async processQueues(): Promise<void> {
		if (!this.isProcessing) {
			this.isProcessing = true;

			if (!this.inFlightProcessState) {
				this.inFlightProcessState = this._state;
				this.resetState(this.inFlightProcessState);
			}
		} else if (!this.inFlightProcessState) {
			this.inFlightProcessState = this._state;
			this.resetState(this.inFlightProcessState);
		}

		const state = this.inFlightProcessState;
		this.beginSlice(state);

		try {
			while (this.hasBudget(state)) {
				switch (state.stage) {
					case ProcessStage.Start: {
						if (this.adapter.getUnloadQueueSet().size > 0) {
							state.stage = ProcessStage.PrepareUnloadBatch;
						} else if (this.adapter.getLoadQueue().length > 0) {
							state.stage = ProcessStage.PrepareLoadBatch;
						} else {
							state.stage = ProcessStage.Finalize;
						}
						break;
					}

					case ProcessStage.PrepareUnloadBatch: {
						const unloadQueueSet = this.adapter.getUnloadQueueSet();

						state.unloadBatch.length = 0;
						state.unloadBatchIndex = 0;
						state.savedChunkIds.clear();

						const unloadBatchSize = this.adapter.getUnloadBatchSize();
						let count = 0;

						for (const chunk of unloadQueueSet) {
							state.unloadBatch.push(chunk);
							unloadQueueSet.delete(chunk);

							if (++count >= unloadBatchSize) break;
						}

						this.adapter.onQueueSnapshotChanged?.();

						state.stage =
							state.unloadBatch.length === 0
								? this.adapter.getLoadQueue().length > 0
									? ProcessStage.PrepareLoadBatch
									: ProcessStage.Finalize
								: ProcessStage.SaveUnloadBatch;
						break;
					}

					case ProcessStage.SaveUnloadBatch: {
						const chunksToSave = this._chunksToSave;
						chunksToSave.length = 0;

						for (let i = 0; i < state.unloadBatch.length; i++) {
							const chunk = state.unloadBatch[i];
							if (
								chunk.isLoaded &&
								!chunk.isPersistent &&
								(chunk.isModified || chunk.isLODMeshCacheDirty)
							) {
								chunksToSave.push(chunk);
							}
						}

						state.savedChunkIds.clear();

						if (chunksToSave.length > 0) {
							try {
								await WorldStorage.saveChunks(chunksToSave);

								for (let i = 0; i < chunksToSave.length; i++) {
									state.savedChunkIds.add(chunksToSave[i].id);
								}
								state.savedCount += chunksToSave.length;
							} catch (error) {
								console.error("Background save failed:", error);
								state.savedChunkIds.clear();
							}
						}

						state.stage = ProcessStage.DisposeUnloadBatch;
						break;
					}

					case ProcessStage.DisposeUnloadBatch: {
						while (
							state.unloadBatchIndex < state.unloadBatch.length &&
							this.hasBudget(state)
						) {
							const chunk = state.unloadBatch[state.unloadBatchIndex++];

							if (chunk.isPersistent) {
								continue;
							}

							if (!chunk.isLoaded) {
								continue;
							}

							const canUnload =
								(!chunk.isModified && !chunk.isLODMeshCacheDirty) ||
								state.savedChunkIds.has(chunk.id);

							if (!canUnload) {
								continue;
							}

							await this.adapter.unloadChunkBoundEntitiesForChunk(chunk);

							chunk.dispose();
							chunk.isLoaded = false;
							chunk.isTerrainScheduled = false;
							Chunk.chunkInstances.delete(chunk.id);

							state.unloadedCount++;
						}

						if (state.unloadBatchIndex >= state.unloadBatch.length) {
							state.stage =
								this.adapter.getLoadQueue().length > 0
									? ProcessStage.PrepareLoadBatch
									: ProcessStage.Finalize;
						}
						break;
					}

					case ProcessStage.PrepareLoadBatch: {
						const loadQueue = this.adapter.getLoadQueue();
						const batchSize = this.adapter.getLoadBatchSize();

						state.loadBatch.length = 0;
						state.validLoadBatch.length = 0;
						state.nearRequests.length = 0;
						state.farRequests.length = 0;

						state.nearLoadedDataMap.clear();
						state.farLoadedDataMap.clear();

						state.applyLoadedIndex = 0;
						state.chunksToGenerate.length = 0;
						state.chunksNeedingFullHydration.clear();

						state.hydrateIds.length = 0;
						state.hydrateMap.clear();
						state.hydrateIndex = 0;

						const takeCount = Math.min(batchSize, loadQueue.length);
						if (takeCount > 0) {
							const taken = loadQueue.splice(0, takeCount);
							this.adapter.onLoadRequestsDequeued?.(taken);
							for (let i = 0; i < taken.length; i++) {
								state.loadBatch.push(taken[i]);
							}
						}

						for (let i = 0; i < state.loadBatch.length; i++) {
							const request = state.loadBatch[i];
							const desired = this.adapter.getDesiredState(request.chunk.id);

							if (!desired) {
								continue;
							}

							if (desired.revision !== request.revision) {
								continue;
							}

							if (desired.desiredLod !== request.desiredLod) {
								continue;
							}

							if (!request.chunk.isTerrainScheduled) {
								continue;
							}

							state.validLoadBatch.push(request);

							if (request.includeVoxelData) {
								state.nearRequests.push(request);
							} else {
								state.farRequests.push(request);
							}
						}

						this.adapter.onQueueSnapshotChanged?.();

						if (state.validLoadBatch.length === 0) {
							state.stage =
								this.adapter.getUnloadQueueSet().size > 0
									? ProcessStage.PrepareUnloadBatch
									: ProcessStage.Finalize;
							break;
						}

						state.stage = ProcessStage.LoadFromStorage;
						break;
					}

					case ProcessStage.LoadFromStorage: {
						try {
							const [nearLoadedDataMap, farLoadedDataMap] = await Promise.all([
								state.nearRequests.length > 0
									? WorldStorage.loadChunks(
											state.nearRequests.map((r) => r.chunk.id),
											{ includeVoxelData: true },
										)
									: Promise.resolve(new Map<bigint, SavedChunkData>()),

								state.farRequests.length > 0
									? WorldStorage.loadChunks(
											state.farRequests.map((r) => r.chunk.id),
											{ includeVoxelData: false },
										)
									: Promise.resolve(new Map<bigint, SavedChunkData>()),
							]);

							state.nearLoadedDataMap.clear();
							state.farLoadedDataMap.clear();

							for (const [k, v] of nearLoadedDataMap) {
								state.nearLoadedDataMap.set(k, v);
							}

							for (const [k, v] of farLoadedDataMap) {
								state.farLoadedDataMap.set(k, v);
							}

							state.stage = ProcessStage.ApplyLoadedChunks;
						} catch (error) {
							console.warn("Failed to load chunks from storage", error);

							for (const request of state.validLoadBatch) {
								request.chunk.isTerrainScheduled = false;
							}

							state.stage =
								this.adapter.getUnloadQueueSet().size > 0
									? ProcessStage.PrepareUnloadBatch
									: ProcessStage.Finalize;
						}
						break;
					}

					case ProcessStage.ApplyLoadedChunks: {
						while (
							state.applyLoadedIndex < state.validLoadBatch.length &&
							this.hasBudget(state)
						) {
							const request = state.validLoadBatch[state.applyLoadedIndex++];
							const desired = this.adapter.getDesiredState(request.chunk.id);

							if (!desired) {
								continue;
							}

							if (desired.revision !== request.revision) {
								continue;
							}

							if (desired.desiredLod !== request.desiredLod) {
								continue;
							}

							if (!request.chunk.isTerrainScheduled) {
								continue;
							}

							const savedData = request.includeVoxelData
								? state.nearLoadedDataMap.get(request.chunk.id)
								: state.farLoadedDataMap.get(request.chunk.id);

							if (savedData) {
								this.adapter.applyLoadedChunkFromSavedData(
									state,
									request,
									savedData,
								);
							} else {
								state.chunksToGenerate.push(request.chunk);
							}
						}

						if (state.applyLoadedIndex >= state.validLoadBatch.length) {
							state.stage =
								state.chunksNeedingFullHydration.size > 0
									? ProcessStage.LoadHydrationData
									: ProcessStage.ScheduleGeneration;
						}
						break;
					}

					case ProcessStage.LoadHydrationData: {
						state.hydrateIds.length = 0;

						for (const id of state.chunksNeedingFullHydration) {
							state.hydrateIds.push(id);
						}
						state.hydrateIndex = 0;

						try {
							state.hydrateMap = await WorldStorage.loadChunks(
								state.hydrateIds,
								{ includeVoxelData: true },
							);
						} catch (error) {
							console.warn("Failed to hydrate chunks from storage", error);
							state.hydrateMap = new Map();
						}

						state.hydratedCount += state.hydrateIds.length;
						state.stage = ProcessStage.ApplyHydration;
						break;
					}

					case ProcessStage.ApplyHydration: {
						while (
							state.hydrateIndex < state.hydrateIds.length &&
							this.hasBudget(state)
						) {
							const chunkId = state.hydrateIds[state.hydrateIndex++];
							const chunk = Chunk.chunkInstances.get(chunkId);

							if (!chunk) {
								continue;
							}

							if (!chunk.isTerrainScheduled) {
								continue;
							}

							const savedData = state.hydrateMap.get(chunkId);
							if (!savedData) {
								state.chunksToGenerate.push(chunk);
								continue;
							}

							this.adapter.applyHydratedChunkFromSavedData(chunk, savedData);
						}

						if (state.hydrateIndex >= state.hydrateIds.length) {
							state.stage = ProcessStage.ScheduleGeneration;
						}
						break;
					}

					case ProcessStage.ScheduleGeneration: {
						if (state.chunksToGenerate.length > 0) {
							state.generatedCount += state.chunksToGenerate.length;

							this.adapter.scheduleTerrainGenerationBatch(
								state.chunksToGenerate,
							);
						}

						state.stage = ProcessStage.Finalize;
						break;
					}

					case ProcessStage.Finalize: {
						this.adapter.finalizeProcessState(state);
						this.inFlightProcessState = null;

						const hasMoreWork =
							this.adapter.getLoadQueue().length > 0 ||
							this.adapter.getUnloadQueueSet().size > 0;

						this.isProcessing = false;

						if (hasMoreWork) {
							this.scheduleProcessContinuation();
						}
						return;
					}
				}
			}

			this.adapter.updateSliceDebugStats(state);
			this.scheduleProcessContinuation();
		} catch (error) {
			console.error("ChunkProcessScheduler process loop failed:", error);
			this.inFlightProcessState = null;
			this.isProcessing = false;
			this.adapter.onProcessError?.(error);
		}
	}

	public beginSlice(state: InFlightProcessState): void {
		state.sliceStartMs = performance.now();
	}

	public hasBudget(state: InFlightProcessState): boolean {
		return (
			performance.now() - state.sliceStartMs <
			Math.max(0.5, this.adapter.getProcessFrameBudgetMs())
		);
	}

	public scheduleProcessContinuation(): void {
		if (this.processContinuationScheduled) return;

		this.processContinuationScheduled = true;
		requestAnimationFrame(() => {
			this.processContinuationScheduled = false;
			void this.processQueues();
		});
	}
}
