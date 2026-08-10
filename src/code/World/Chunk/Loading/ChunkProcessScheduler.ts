import { type SavedChunkData, WorldStorage } from "../../WorldStorage";
import type { Chunk } from "../Chunk";
import type { QueuedChunkRequest } from "./ChunkStreamingController";
import { type InFlightProcessState, ProcessStage } from "./ChunkTypes";

export interface ChunkProcessSchedulerAdapter {
	getLoadQueue(): QueuedChunkRequest[];
	getUnloadQueueSet(): Set<Chunk>;

	getLoadBatchSize(): number;
	getUnloadBatchSize(): number;
	getProcessFrameBudgetMs(): number;

	getDesiredState(numericId: number): number | undefined;

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

	scheduleTerrainGenerationBatch(chunks: readonly Chunk[]): void;

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

	private _saveScratch: Chunk[] = [];
	private _nearIdScratch: bigint[] = [];
	private _farIdScratch: bigint[] = [];

	private preferLoadNext = false;
	private unloadRetryAfterMs = 0;

	public constructor(private readonly adapter: ChunkProcessSchedulerAdapter) {}

	public get processing(): boolean {
		return this.isProcessing;
	}

	private createReusableProcessState(): InFlightProcessState {
		return {
			stage: ProcessStage.Start,

			sliceStartMs: 0,
			sliceDeadlineMs: 0,

			loadedFromStorageCount: 0,
			generatedCount: 0,
			hydratedCount: 0,
			unloadedCount: 0,
			savedCount: 0,

			unloadBatch: [],
			unloadBatchIndex: 0,
			savedChunkIds: new Set(),
			savedChunkRevisions: new Map(),

			loadBatch: [],
			validLoadBatch: [],
			nearRequests: [],
			farRequests: [],
			nearLoadedDataMap: new Map(),
			farLoadedDataMap: new Map(),
			applyLoadedIndex: 0,
			chunksToGenerate: [],
			chunksToGenerateIds: new Set(),
			chunksNeedingFullHydration: new Set(),

			hydrateIds: [],
			hydrateChunks: [],
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

		state.unloadBatch.length = 0;
		state.unloadBatchIndex = 0;
		state.savedChunkIds.clear();
		state.savedChunkRevisions.clear();

		state.loadBatch.length = 0;
		state.validLoadBatch.length = 0;
		state.nearRequests.length = 0;
		state.farRequests.length = 0;

		state.nearLoadedDataMap.clear();
		state.farLoadedDataMap.clear();

		state.applyLoadedIndex = 0;
		state.chunksToGenerate.length = 0;
		state.chunksToGenerateIds.clear();
		state.chunksNeedingFullHydration.clear();

		state.hydrateIds.length = 0;
		state.hydrateChunks.length = 0;
		state.hydrateMap.clear();
		state.hydrateIndex = 0;
	}

	public async processQueues(): Promise<void> {
		if (this.isProcessing) return;

		let shouldContinue = false;

		this.isProcessing = true;

		if (!this.inFlightProcessState) {
			this.inFlightProcessState = this._state;
			this.resetState(this.inFlightProcessState);
		}

		const state = this.inFlightProcessState;
		this.beginSlice(state);

		try {
			let loopCount = 0;
			while (this.hasBudget(state)) {
				if (++loopCount > 1_000) {
					throw new Error("Chunk scheduler stage-transition limit exceeded");
				}
				switch (state.stage) {
					case ProcessStage.Start: {
						const hasLoads = this.adapter.getLoadQueue().length > 0;
						const hasUnloads = this.adapter.getUnloadQueueSet().size > 0;
						const canProcessUnloads =
							performance.now() >= this.unloadRetryAfterMs;

						if (hasLoads && hasUnloads) {
							state.stage = this.preferLoadNext
								? ProcessStage.PrepareLoadBatch
								: ProcessStage.PrepareUnloadBatch;
							this.preferLoadNext = !this.preferLoadNext;
						} else if (hasUnloads && canProcessUnloads) {
							state.stage = ProcessStage.PrepareUnloadBatch;
						} else if (hasLoads) {
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
						state.savedChunkRevisions.clear();

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
						this._saveScratch.length = 0;

						for (let i = 0; i < state.unloadBatch.length; i++) {
							const chunk = state.unloadBatch[i];
							if (
								chunk.isLoaded &&
								!chunk.isBoatChunk &&
								(chunk.isModified || chunk.isLightDirty)
							) {
								this._saveScratch.push(chunk);
							}
						}

						state.savedChunkIds.clear();
						state.savedChunkRevisions.clear();

						if (this._saveScratch.length > 0) {
							try {
								const saveRevisions = new Map<bigint, number>();
								for (let i = 0; i < this._saveScratch.length; i++) {
									const chunk = this._saveScratch[i];
									saveRevisions.set(chunk.id, chunk.persistenceRevision);
								}

								await WorldStorage.saveChunks(this._saveScratch);

								this.beginSlice(state);

								for (const [id, revision] of saveRevisions) {
									state.savedChunkIds.add(id);
									state.savedChunkRevisions.set(id, revision);
								}
								state.savedCount += saveRevisions.size;
							} catch (error) {
								console.error("Background save failed:", error);
								state.savedChunkIds.clear();
								state.savedChunkRevisions.clear();
								this.unloadRetryAfterMs = performance.now() + 250;
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
							const chunk = state.unloadBatch[state.unloadBatchIndex];

							if (!chunk.isLoaded || chunk.isBoatChunk) {
								state.unloadBatchIndex++;
								continue;
							}

							const isDirty = chunk.isModified || chunk.isLightDirty;
							const savedRevision = state.savedChunkRevisions.get(chunk.id);
							const canUnload =
								!isDirty || savedRevision === chunk.persistenceRevision;

							if (!canUnload) {
								this.adapter.getUnloadQueueSet().add(chunk);
								state.unloadBatchIndex++;
								continue;
							}

							try {
								await this.adapter.unloadChunkBoundEntitiesForChunk(chunk);
							} catch (error) {
								console.warn("Failed to unload chunk entities", error);
								this.adapter.getUnloadQueueSet().add(chunk);
								state.unloadBatchIndex++;
								continue;
							}

							this.beginSlice(state);

							if (!chunk.isLoaded || chunk.isBoatChunk) {
								state.unloadBatchIndex++;
								continue;
							}

							const dirtyAfterAwait = chunk.isModified || chunk.isLightDirty;
							const currentSavedRevision = state.savedChunkRevisions.get(
								chunk.id,
							);

							if (
								dirtyAfterAwait &&
								currentSavedRevision !== chunk.persistenceRevision
							) {
								this.adapter.getUnloadQueueSet().add(chunk);
								state.unloadBatchIndex++;
								continue;
							}

							chunk.dispose();

							state.unloadBatchIndex++;
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
						state.chunksToGenerateIds.clear();
						state.chunksNeedingFullHydration.clear();

						state.hydrateIds.length = 0;
						state.hydrateChunks.length = 0;
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
							if (!request.chunk.isTerrainScheduled) {
								continue;
							}
							const desired = this.adapter.getDesiredState(
								request.chunk.numericId,
							);

							if (
								desired === undefined ||
								desired >>> 3 !== request.revision ||
								(desired & 0b111) !== request.desiredLod
							) {
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
						state.nearLoadedDataMap.clear();
						state.farLoadedDataMap.clear();

						this._nearIdScratch.length = 0;
						this._farIdScratch.length = 0;

						for (let i = 0; i < state.nearRequests.length; i++) {
							this._nearIdScratch.push(state.nearRequests[i].chunk.id);
						}

						for (let i = 0; i < state.farRequests.length; i++) {
							this._farIdScratch.push(state.farRequests[i].chunk.id);
						}

						try {
							await Promise.all([
								this._nearIdScratch.length > 0
									? WorldStorage.loadChunks(
											this._nearIdScratch,
											{ includeVoxelData: true },
											state.nearLoadedDataMap,
										)
									: Promise.resolve(),

								this._farIdScratch.length > 0
									? WorldStorage.loadChunks(
											this._farIdScratch,
											{ includeVoxelData: false },
											state.farLoadedDataMap,
										)
									: Promise.resolve(),
							]);

							this.beginSlice(state);
							state.stage = ProcessStage.ApplyLoadedChunks;
						} catch (error) {
							console.warn("Failed to load chunks from storage", error);
							state.nearLoadedDataMap.clear();
							state.farLoadedDataMap.clear();
							this.beginSlice(state);
							state.stage = ProcessStage.ApplyLoadedChunks;
						}
						break;
					}

					case ProcessStage.ApplyLoadedChunks: {
						while (
							state.applyLoadedIndex < state.validLoadBatch.length &&
							this.hasBudget(state)
						) {
							const request = state.validLoadBatch[state.applyLoadedIndex++];

							if (!this.isStillDesired(request)) {
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
							} else if (!request.chunk.isLoaded) {
								this.queueGeneration(state, request.chunk);
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
						try {
							state.hydrateMap.clear();

							await WorldStorage.loadChunks(
								state.hydrateIds,
								{ includeVoxelData: true },
								state.hydrateMap,
							);

							this.beginSlice(state);
						} catch (error) {
							console.warn("Failed to hydrate chunks from storage", error);
							state.hydrateMap.clear();
							this.beginSlice(state);
						}

						state.stage = ProcessStage.ApplyHydration;
						break;
					}

					case ProcessStage.ApplyHydration: {
						while (
							state.hydrateIndex < state.hydrateChunks.length &&
							this.hasBudget(state)
						) {
							const chunk = state.hydrateChunks[state.hydrateIndex++];

							if (!chunk.isTerrainScheduled) {
								if (!chunk.isLoaded) {
									this.queueGeneration(state, chunk);
								}
								continue;
							}

							const savedData = state.hydrateMap.get(chunk.id);
							if (!savedData) {
								this.queueGeneration(state, chunk);
								continue;
							}

							this.adapter.applyHydratedChunkFromSavedData(chunk, savedData);
							state.hydratedCount++;
						}
						if (state.hydrateIndex >= state.hydrateChunks.length) {
							state.stage = ProcessStage.ScheduleGeneration;
						}
						break;
					}

					case ProcessStage.ScheduleGeneration: {
						let writeIndex = 0;
						for (let i = 0; i < state.chunksToGenerate.length; i++) {
							const chunk = state.chunksToGenerate[i];
							if (!chunk.isTerrainScheduled || chunk.isLoaded) {
								continue;
							}
							state.chunksToGenerate[writeIndex++] = chunk;
						}
						state.chunksToGenerate.length = writeIndex;

						if (writeIndex > 0) {
							state.generatedCount += writeIndex;
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

						shouldContinue =
							this.adapter.getLoadQueue().length > 0 ||
							this.adapter.getUnloadQueueSet().size > 0;

						return;
					}
				}
			}
			this.adapter.updateSliceDebugStats(state);
			shouldContinue = true;
		} catch (error) {
			console.error("ChunkProcessScheduler process loop failed:", error);
			this.recoverProcessState(state);
			this.inFlightProcessState = null;
			this.adapter.onProcessError?.(error);
			shouldContinue =
				this.adapter.getLoadQueue().length > 0 ||
				this.adapter.getUnloadQueueSet().size > 0;
		} finally {
			this.isProcessing = false;

			if (shouldContinue) {
				this.scheduleProcessContinuation();
			}
		}
	}

	private recoverProcessState(state: InFlightProcessState): void {
		const unloadQueue = this.adapter.getUnloadQueueSet();

		for (let i = state.unloadBatchIndex; i < state.unloadBatch.length; i++) {
			const chunk = state.unloadBatch[i];
			if (chunk.isLoaded && !chunk.isBoatChunk) {
				unloadQueue.add(chunk);
			}
		}

		const loadQueue = this.adapter.getLoadQueue();
		const queuedIds = new Set<bigint>();

		for (let i = 0; i < loadQueue.length; i++) {
			queuedIds.add(loadQueue[i].chunk.id);
		}

		for (let i = 0; i < state.loadBatch.length; i++) {
			const request = state.loadBatch[i];

			if (
				request.chunk.isTerrainScheduled &&
				!request.chunk.isLoaded &&
				!queuedIds.has(request.chunk.id)
			) {
				queuedIds.add(request.chunk.id);
				loadQueue.push(request);
			}
		}

		this.adapter.onQueueSnapshotChanged?.();
	}

	private isStillDesired(request: QueuedChunkRequest): boolean {
		if (!request.chunk.isTerrainScheduled) return false;
		const desired = this.adapter.getDesiredState(request.chunk.numericId);
		return (
			desired !== undefined &&
			desired >>> 3 === request.revision &&
			(desired & 0b111) === request.desiredLod
		);
	}

	private queueGeneration(state: InFlightProcessState, chunk: Chunk): void {
		if (chunk.isLoaded || state.chunksToGenerateIds.has(chunk.id)) return;
		state.chunksToGenerateIds.add(chunk.id);
		state.chunksToGenerate.push(chunk);
	}

	public beginSlice(state: InFlightProcessState): void {
		const budget = Math.max(0.5, this.adapter.getProcessFrameBudgetMs());
		const now = performance.now();
		state.sliceStartMs = now;
		state.sliceDeadlineMs = now + budget;
	}

	public hasBudget(state: InFlightProcessState): boolean {
		return performance.now() < state.sliceDeadlineMs;
	}

	public scheduleProcessContinuation(): void {
		if (this.processContinuationScheduled) return;

		this.processContinuationScheduled = true;
		requestAnimationFrame(() => {
			this.processContinuationScheduled = false;
			void this.processQueues()
				.then(() => this.onContinuationSlice?.())
				.catch((error) => this.adapter.onProcessError?.(error));
		});
	}

	public onContinuationSlice: (() => void) | null = null;
}
