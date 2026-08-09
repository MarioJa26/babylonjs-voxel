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

	// M2: Reusable scratch for SaveUnloadBatch — avoids per-stage array allocation
	private _saveScratch: Chunk[] = [];

	// M3: Reusable ID arrays for WorldStorage.loadChunks — avoids .map() allocation
	private _nearIdScratch: bigint[] = [];
	private _farIdScratch: bigint[] = [];

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
		state.hydrateChunks.length = 0;
		state.hydrateMap.clear();
		state.hydrateIndex = 0;
	}

	private _processStartTime = 0;
	private _overallDeadline = 0;
	private static readonly OVERALL_TIMEOUT_MS = 500;

	private checkDeadline(): boolean {
		return performance.now() > this._overallDeadline;
	}

	/** Race a promise against a timeout. Resolves with fallback on timeout. */
	private withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
		return Promise.race([
			promise,
			new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
		]);
	}

	/** Force-reset if processing has been stuck for too long. Called every frame. */
	public ensureNotStuck(): void {
		if (
			this.isProcessing &&
			(!this._processStartTime ||
				performance.now() - this._processStartTime > 2000)
		) {
			this.isProcessing = false;
			this.inFlightProcessState = null;
			this._processStartTime = 0;
		}
	}

	public async processQueues(): Promise<void> {
		if (this.isProcessing) {
			return;
		}

		this.isProcessing = true;
		this._processStartTime = performance.now();
		this._overallDeadline =
			performance.now() + ChunkProcessScheduler.OVERALL_TIMEOUT_MS;

		if (!this.inFlightProcessState) {
			this.inFlightProcessState = this._state;
			this.resetState(this.inFlightProcessState);
		}

		const state = this.inFlightProcessState;
		this.beginSlice(state);

		let timedOut = false;
		try {
			let loopCount = 0;
			while (this.hasBudget(state) && !timedOut) {
				loopCount++;
				if (loopCount > 50) {
					this.isProcessing = false;
					this.adapter.updateSliceDebugStats(state);
					this.scheduleProcessContinuation();
					return;
				}
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
						// M2: Reuse scratch array — avoids per-frame allocation
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

						if (this._saveScratch.length > 0) {
							try {
								await this.withTimeout(
									WorldStorage.saveChunks(this._saveScratch),
									500,
									undefined,
								);
								if (this.checkDeadline()) {
									timedOut = true;
									break;
								}
								this.beginSlice(state);

								for (let i = 0; i < this._saveScratch.length; i++) {
									state.savedChunkIds.add(this._saveScratch[i].id);
								}
								state.savedCount += this._saveScratch.length;
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
							const chunk = state.unloadBatch[state.unloadBatchIndex];

							// Permanent skip — already disposed by another path, or a
							// persistent chunk (boat chunk) that should never be unloaded.
							// Advance the index without re-queueing.
							if (!chunk.isLoaded || chunk.isBoatChunk) {
								state.unloadBatchIndex++;
								continue;
							}

							const canUnload =
								!chunk.isModified || state.savedChunkIds.has(chunk.id);

							if (!canUnload) {
								// The chunk is still dirty AND wasn't saved (e.g. it was
								// modified again between SaveUnloadBatch and now, or the
								// save failed). Put it back into the unload queue set so
								// the next processQueues() invocation re-runs SaveUnloadBatch
								// for it and gets a chance to dispose it.
								this.adapter.getUnloadQueueSet().add(chunk);
								state.unloadBatchIndex++;
								continue;
							}

							await this.adapter.unloadChunkBoundEntitiesForChunk(chunk);
							if (this.checkDeadline()) {
								timedOut = true;
								break;
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
								desired >> 3 !== request.revision ||
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
						const loadStart = performance.now();
						try {
							this._nearIdScratch.length = 0;
							this._farIdScratch.length = 0;
							for (const r of state.nearRequests)
								this._nearIdScratch.push(r.chunk.id);
							for (const r of state.farRequests)
								this._farIdScratch.push(r.chunk.id);

						await this.withTimeout(
							Promise.all([
								state.nearRequests.length > 0
									? WorldStorage.loadChunks(
											this._nearIdScratch,
											{ includeVoxelData: true },
											state.nearLoadedDataMap,
										)
									: Promise.resolve(),

								state.farRequests.length > 0
									? WorldStorage.loadChunks(
											this._farIdScratch,
											{ includeVoxelData: false },
											state.farLoadedDataMap,
										)
									: Promise.resolve(),
							]),
							500,
							undefined,
						);
						if (this.checkDeadline()) {
							timedOut = true;
							break;
						}

							this.beginSlice(state);
							state.stage = ProcessStage.ApplyLoadedChunks;
							break;
						} catch (error) {
							console.warn("Failed to load chunks from storage", error);
							state.stage = ProcessStage.Finalize;
						}
						break;
					}
					case ProcessStage.ApplyLoadedChunks: {
						while (
							state.applyLoadedIndex < state.validLoadBatch.length &&
							this.hasBudget(state)
						) {
							const request = state.validLoadBatch[state.applyLoadedIndex++];
							if (!request.chunk.isTerrainScheduled) {
								continue;
							}

							// Check savedData FIRST — if OPFS has data, always use it
							// regardless of revision mismatch caused by frame-budget
							// splitting between PrepareLoadBatch and ApplyLoadedChunks.
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
						try {
							// PERF: same fix as LoadFromStorage above — write directly
							// into state.hydrateMap instead of copying out of a temp Map.
							state.hydrateMap.clear();
							await this.withTimeout(
								WorldStorage.loadChunks(
									state.hydrateIds,
									{ includeVoxelData: true },
									state.hydrateMap,
								),
								500,
								undefined,
							);
							if (this.checkDeadline()) {
								timedOut = true;
								break;
							}
							this.beginSlice(state);

							// Bug 5 fix — only count on success
							state.hydratedCount += state.hydrateIds.length;
						} catch (error) {
							console.warn("Failed to hydrate chunks from storage", error);
							state.hydrateMap.clear();
							state.hydrateIds.length = 0;
							state.hydrateChunks.length = 0;
							state.chunksNeedingFullHydration.clear();
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
									state.chunksToGenerate.push(chunk);
								}
								continue;
							}

							const savedData = state.hydrateMap.get(chunk.id);
							if (!savedData) {
								state.chunksToGenerate.push(chunk);
								continue;
							}

							this.adapter.applyHydratedChunkFromSavedData(chunk, savedData);
						}
						if (state.hydrateIndex >= state.hydrateChunks.length) {
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
						// isProcessing cleared here too, before the return
						this.isProcessing = false;

						if (
							this.adapter.getLoadQueue().length > 0 ||
							this.adapter.getUnloadQueueSet().size > 0
						) {
							this.scheduleProcessContinuation();
						}
						return;
					}
				}
			}
			this.isProcessing = false;
			if (timedOut) {
				this.inFlightProcessState = null;
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
			void this.processQueues().then(() => this.onContinuationSlice?.());
		});
	}

	/** Hook called after each processQueues continuation slice completes. */
	public onContinuationSlice: (() => void) | null = null;
}
