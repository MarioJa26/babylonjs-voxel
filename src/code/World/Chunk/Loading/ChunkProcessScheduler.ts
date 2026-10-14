import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { FRAME_WORK_BUDGET, FrameWorkKind } from "@/code/Lib/FrameWorkBudget";
import { type SavedChunkData, WorldStorage } from "../../WorldStorage";
import { Chunk } from "../Chunk";
import { ChunkLifecycle, ResidencyState } from "./ChunkLifecycle";
import type { QueuedChunkRequest } from "./ChunkStreamingController";
import { type InFlightProcessState, ProcessStage } from "./ChunkTypes";

/**
 * Debug labels for ProcessStage. The enum is a `const enum` (so it inlines to
 * bare integers and cannot be reverse-mapped at runtime), and stall diagnosis
 * needs to know which stage the scheduler parked on — an index into the
 * switching machinery is useless in a log.
 */
const PROCESS_STAGE_NAMES: readonly string[] = [
	"Start",
	"PrepareUnloadBatch",
	"SaveUnloadBatch",
	"DisposeUnloadBatch",
	"PrepareLoadBatch",
	"LoadFromStorage",
	"ApplyLoadedChunks",
	"LoadHydrationData",
	"ApplyHydration",
	"ScheduleGeneration",
	"Finalize",
];

export interface ChunkProcessSchedulerAdapter {
	getLoadQueue(): QueuedChunkRequest[];
	getUnloadQueueSet(): Set<Chunk>;

	getLoadBatchSize(): number;
	getUnloadBatchSize(): number;
	getProcessFrameBudgetMs(): number;

	getDesiredState(numericId: number): number | undefined;

	/**
	 * Register a chunk whose load request was abandoned without a re-queue.
	 *
	 * The orphan sweep only inspects registered candidates, so every branch that
	 * drops a request for a chunk that still wants loading MUST call this or the
	 * chunk becomes permanently invisible and its world hole never heals.
	 */
	markPotentialOrphan(chunk: Chunk): void;

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
	onLoadRequestsRecovered?(requests: ReadonlyArray<QueuedChunkRequest>): void;
	onLoadRequestsAbandoned?(requests: ReadonlyArray<QueuedChunkRequest>): void;
	recycleQueuedRequests?(requests: ReadonlyArray<QueuedChunkRequest>): void;
	onProcessError?(error: unknown): void;
}

export class ChunkProcessScheduler {
	/**
	 * Hard ceiling on any single storage/IO await inside the stage machine.
	 *
	 * STALLFIX: every storage call below is awaited WITHOUT a timeout. If one
	 * of those promises never settles — an IndexedDB transaction that stalls
	 * under memory pressure, a `LevelDbChunkStore` write pump parked on a
	 * browser-internal lock, a swallowed rejection that leaves the pump promise
	 * dangling — `processQueues()` stays parked on that await forever with
	 * `isProcessing === true`. Every caller then skips the scheduler
	 * (`if (!processScheduler.processing)` in both
	 * processFrameBudgetedStreamingWork and updateChunksAround), no rAF
	 * continuation is armed because we never reach `finally`, and the entire
	 * streaming pipeline is dead SILENTLY: no exception, no console output, no
	 * further chunk ever loads or generates. That matches "spawn is fine, then
	 * after a while nothing new loads" exactly.
	 *
	 * Timing out converts an unrecoverable silent hang into a logged error and
	 * a stage that continues. The pending promise is deliberately not
	 * cancelled — its result is simply ignored (callers already tolerate a
	 * missing/partial result), and the abandoned work resolves into the void.
	 */
	private static readonly IO_TIMEOUT_MS = 8000;

	private readonly _ioTimedOut = { count: 0 };

	/**
	 * Execute one storage operation with a hard timeout.
	 *
	 * The timeout is cleared as soon as either branch settles. The underlying
	 * operation is not cancelled because the storage API does not expose
	 * cancellation.
	 */
	private async withIoTimeout<T>(
		label: string,
		promise: Promise<T>,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				this._ioTimedOut.count++;

				console.error(
					`[ChunkProcessScheduler] ${label} did not settle within ` +
						`${ChunkProcessScheduler.IO_TIMEOUT_MS}ms. The operation ` +
						`was abandoned so chunk streaming can continue ` +
						`(occurrence ${this._ioTimedOut.count}).`,
				);

				reject(new Error(`${label} timed out`));
			}, ChunkProcessScheduler.IO_TIMEOUT_MS);
		});

		try {
			return await Promise.race([promise, timeoutPromise]);
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	/** Number of storage awaits abandoned by the timeout guard (debug/HUD). */
	public getIoTimeoutCount(): number {
		return this._ioTimedOut.count;
	}

	/**
	 * Hydration writes skipped because the Chunk object had been recycled onto
	 * different coordinates mid-read. Zero in normal operation; see
	 * InFlightProcessState.hydrationRecycledDrops.
	 */
	public getHydrationRecycledDropCount(): number {
		return this._totalHydrationRecycledDrops;
	}

	private isProcessing = false;
	private inFlightProcessState: InFlightProcessState | null = null;
	private _totalHydrationRecycledDrops = 0;
	private readonly _state: InFlightProcessState =
		this.createReusableProcessState();
	private processContinuationScheduled = false;

	private readonly _saveScratch: Chunk[] = [];
	private readonly _nearIdScratch: bigint[] = [];
	private readonly _farIdScratch: bigint[] = [];
	private readonly _recoveredRequests: QueuedChunkRequest[] = [];

	/*
	 * Reusable callback batches.
	 *
	 * These arrays are passed only to synchronous adapter notifications and are
	 * cleared immediately afterward, avoiding loadBatch.slice() allocations.
	 */
	private readonly _notificationRequests: QueuedChunkRequest[] = [];

	private preferLoadNext = false;
	private unloadRetryAfterMs = 0;

	public onContinuationSlice: (() => void) | null = null;

	public constructor(private readonly adapter: ChunkProcessSchedulerAdapter) {}

	public get processing(): boolean {
		return this.isProcessing;
	}

	/**
	 * Whether the chunk sits in the unprocessed tail of the current unload
	 * batch. The scheduler dequeues unload entries into its batch (removing
	 * them from the set) while they are still Unloading; the ChunkLifecycle
	 * host queries this so the owner keeps deriving Unloading through dispose.
	 * Processed entries (index < unloadBatchIndex, including disposed chunks)
	 * intentionally answer false — they are Absent, not Unloading.
	 */
	public isChunkInUnloadBatch(chunk: Chunk): boolean {
		const s = this.inFlightProcessState;
		if (s === null) return false;
		for (let i = s.unloadBatchIndex; i < s.unloadBatch.length; i++) {
			if (s.unloadBatch[i] === chunk) return true;
		}
		return false;
	}

	/** Human-readable name of the stage the in-flight batch is parked on. */
	public get currentStageName(): string {
		const stage = this.inFlightProcessState?.stage;
		if (stage === undefined) return "Idle";
		// ProcessStage is a const enum, so it cannot be reverse-mapped at
		// runtime; keep the label table beside the enum's declaration order.
		return PROCESS_STAGE_NAMES[stage] ?? `Stage(${String(stage)})`;
	}

	/** Progress within the current slice, for stall diagnosis. */
	public get inFlightProgress(): string {
		const s = this.inFlightProcessState;
		if (!s) return "-";
		return (
			`batch ${s.loadBatch.length}/${s.validLoadBatch.length}` +
			` applied ${s.applyLoadedIndex}/${s.validLoadBatch.length}` +
			` hydrate ${s.hydrateIndex}/${s.hydrateChunks.length}` +
			` toGen ${s.chunksToGenerate.length}` +
			` unload ${s.unloadBatchIndex}/${s.unloadBatch.length}`
		);
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
			hydrationRecycledDrops: 0,

			queuedLoadIdsScratch: new Set<bigint>(),
		};
	}

	/**
	 * Notify an adapter with a stable temporary snapshot.
	 *
	 * This keeps adapter callbacks isolated from subsequent state-array mutation
	 * without allocating through Array.prototype.slice().
	 */
	private notifyRequests(
		callback:
			| ((requests: ReadonlyArray<QueuedChunkRequest>) => void)
			| undefined,
		requests: ReadonlyArray<QueuedChunkRequest>,
	): void {
		if (callback === undefined || requests.length === 0) {
			return;
		}

		const snapshot = this._notificationRequests;
		snapshot.length = requests.length;

		for (let i = 0; i < requests.length; i++) {
			snapshot[i] = requests[i];
		}

		try {
			callback(snapshot);
		} finally {
			snapshot.length = 0;
		}
	}

	/**
	 * Recycle the active load batch without creating a temporary slice.
	 *
	 * Adapter recycling is required to be synchronous. The state array is cleared
	 * immediately after notification so it cannot retain recycled requests.
	 */
	private recycleLoadBatch(state: InFlightProcessState): void {
		const length = state.loadBatch.length;

		if (length === 0) {
			return;
		}

		const recycle = this.adapter.recycleQueuedRequests;

		if (recycle !== undefined) {
			recycle(state.loadBatch);
		}

		state.loadBatch.length = 0;
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

		state.queuedLoadIdsScratch.clear();

		this.clearLoadState(state);
	}

	private clearLoadState(state: InFlightProcessState): void {
		this.recycleLoadBatch(state);

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
		state.hydrationRecycledDrops = 0;
	}

	public async processQueues(): Promise<void> {
		if (this.isProcessing) return;

		let shouldContinue = false;
		this.isProcessing = true;

		/*
		 * PERF INSTRUMENTATION.
		 *
		 * The stages before the first `await` run synchronously inside the
		 * caller's onBeforeRender callback, so they are already covered by the
		 * `streaming` section. Every stage AFTER an await resumes in a
		 * microtask with no frame in progress — ApplyLoadedChunks,
		 * ApplyHydration, ScheduleGeneration (the actual worker dispatch) and
		 * Finalize. That is the bulk of the scheduler and it was invisible.
		 *
		 * Time it as off-frame work. `markResume` is placed AFTER each await
		 * rather than before, because the main thread is genuinely idle while
		 * the storage read is in flight; counting that wait would overstate
		 * the cost and misdiagnose it as main-thread pressure.
		 */
		let offFrameStart = 0;
		let offFrameMs = 0;
		const markResume = (): void => {
			const now = performance.now();
			if (offFrameStart !== 0) offFrameMs += now - offFrameStart;
			offFrameStart = now;
		};
		const markSuspend = (): void => {
			if (offFrameStart === 0) return;
			offFrameMs += performance.now() - offFrameStart;
			offFrameStart = 0;
		};

		let state = this.inFlightProcessState;
		if (!state) {
			state = this._state;
			this.inFlightProcessState = state;
			this.resetState(state);
		}

		this.beginSlice(state);

		try {
			let loopCount = 0;

			while (this.hasBudget(state)) {
				if (++loopCount > 1_000) {
					throw new Error("Chunk scheduler stage-transition limit exceeded");
				}

				switch (state.stage) {
					case ProcessStage.Start: {
						const loadQueue = this.adapter.getLoadQueue();
						const unloadQueueSet = this.adapter.getUnloadQueueSet();

						const hasLoads = loadQueue.length > 0;
						const hasUnloads = unloadQueueSet.size > 0;
						const canProcessUnloads =
							performance.now() >= this.unloadRetryAfterMs;

						if (hasLoads && hasUnloads && canProcessUnloads) {
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
						state.savedChunkIds.clear();
						state.savedChunkRevisions.clear();

						for (
							let i = 0, length = state.unloadBatch.length;
							i < length;
							i++
						) {
							const chunk = state.unloadBatch[i];

							if (
								chunk.isLoaded &&
								!chunk.isBoatChunk &&
								(chunk.isModified || chunk.isLightDirty)
							) {
								this._saveScratch.push(chunk);
								state.savedChunkRevisions.set(
									chunk.id,
									chunk.persistenceRevision,
								);
							}
						}

						if (this._saveScratch.length > 0) {
							markSuspend();

							try {
								await this.withIoTimeout(
									"WorldStorage.saveChunks (unload batch)",
									WorldStorage.saveChunks(this._saveScratch),
								);

								for (const id of state.savedChunkRevisions.keys()) {
									state.savedChunkIds.add(id);
								}

								state.savedCount += state.savedChunkRevisions.size;
							} catch (error) {
								console.error("Background save failed:", error);
								state.savedChunkIds.clear();
								state.savedChunkRevisions.clear();
								this.unloadRetryAfterMs = performance.now() + 250;
							} finally {
								markResume();
								this.beginSlice(state);
							}
						}

						state.stage = ProcessStage.DisposeUnloadBatch;
						break;
					}

					case ProcessStage.DisposeUnloadBatch: {
						const unloadQueueSet = this.adapter.getUnloadQueueSet();

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
								unloadQueueSet.add(chunk);
								state.unloadBatchIndex++;
								continue;
							}

							markSuspend();

							try {
								await this.withIoTimeout(
									"unloadChunkBoundEntitiesForChunk",
									this.adapter.unloadChunkBoundEntitiesForChunk(chunk),
								);
							} catch (error) {
								console.warn("Failed to unload chunk entities", error);
								unloadQueueSet.add(chunk);
								state.unloadBatchIndex++;
								continue;
							} finally {
								markResume();
								this.beginSlice(state);
							}

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
								unloadQueueSet.add(chunk);
								state.unloadBatchIndex++;
								continue;
							}

							// Route through the owner: Unloading → Absent (dequeues
							// the unload, clears the residency + mesh flags).
							// chunk.dispose() below performs the data teardown
							// (voxel/light reset, registry unregister, pool
							// recycle); its flag writes repeat the owner's
							// idempotently. isChunkInUnloadBatch keeps the owner
							// deriving Unloading while the batch owns this chunk.
							ChunkLifecycle.completeUnload(chunk);
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
						const takeCount = Math.min(batchSize, loadQueue.length);

						this.clearLoadState(state);

						if (takeCount > 0) {
							for (let i = 0; i < takeCount; i++) {
								state.loadBatch.push(loadQueue[i]);
							}

							if (takeCount < loadQueue.length) {
								loadQueue.copyWithin(0, takeCount);
							}
							loadQueue.length -= takeCount;
						}

						for (let i = 0, length = state.loadBatch.length; i < length; i++) {
							const request = state.loadBatch[i];
							const chunk = request.chunk;

							// STALLFIX: a nulled chunk here used to be a guaranteed
							// TypeError (recycleQueuedRequests cleared the field on
							// requests recoverProcessState had just put back into
							// loadQueue). Skip rather than crash.
							if (!chunk) {
								continue;
							}

							if (!chunk.isTerrainScheduled) {
								continue;
							}

							const desired = this.adapter.getDesiredState(chunk.numericId);

							// No recorded desire at all: the chunk is not known to be
							// wanted (its state was pruned or never recorded), so drop
							// the request. `isTerrainScheduled` is intentionally left
							// set — the chunk is registered as an orphan candidate
							// below and sweepOrphanedChunks re-queues it with a fresh
							// desired state. Clearing the flag here would strand it.
							//
							// The registration is what makes that rescue reachable: the
							// sweep only walks its candidate set, so without this line
							// the chunk would be invisible and its world hole permanent.
							if (desired === undefined) {
								this.adapter.markPotentialOrphan(chunk);
								continue;
							}

							const desiredLod = desired & 0b111;
							const desiredRevision = desired >>> 3;

							if (desiredRevision !== request.revision) {
								// STALLFIX: this request lost a race with a newer
								// streaming revision. Previously it was dropped
								// outright, which left `chunk` with
								// isTerrainScheduled=true but no request anywhere
								// — an orphan that nothing in the system revisits
								// (reconcile only walks loadQueue, the movement scan
								// only the leading edge, and the refresh scan only
								// loaded chunks). Adopt the newer desired state
								// rather than discarding the chunk.
								request.revision = desiredRevision;
								request.desiredLod = desiredLod;
								request.includeVoxelData = desiredLod <= 1;
								request.priority = Number.POSITIVE_INFINITY;
							} else if (desiredLod !== request.desiredLod) {
								request.desiredLod = desiredLod;
								request.includeVoxelData = desiredLod <= 1;
							}

							/*
							 * Scheduled -> Loading. The host atomically transfers the request from
							 * the load queue bookkeeping into the in-flight registry.
							 */
							const residency = ChunkLifecycle.dispatchLoad(chunk);

							if (residency !== ResidencyState.Loading) {
								continue;
							}

							state.validLoadBatch.push(request);

							if (request.includeVoxelData) {
								state.nearRequests.push(request);
							} else {
								state.farRequests.push(request);
							}
						}

						this.notifyRequests(
							this.adapter.onLoadRequestsDequeued,
							state.validLoadBatch,
						);

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

						for (
							let i = 0, length = state.nearRequests.length;
							i < length;
							i++
						) {
							this._nearIdScratch.push(state.nearRequests[i].chunk.id);
						}

						for (
							let i = 0, length = state.farRequests.length;
							i < length;
							i++
						) {
							this._farIdScratch.push(state.farRequests[i].chunk.id);
						}

						try {
							const nearPromise =
								this._nearIdScratch.length > 0
									? WorldStorage.loadChunks(
											this._nearIdScratch,
											{ includeVoxelData: true },
											state.nearLoadedDataMap,
										)
									: undefined;

							const farPromise =
								this._farIdScratch.length > 0
									? WorldStorage.loadChunks(
											this._farIdScratch,
											{ includeVoxelData: false },
											state.farLoadedDataMap,
										)
									: undefined;

							if (nearPromise && farPromise) {
								markSuspend();
								await this.withIoTimeout(
									"WorldStorage.loadChunks (near+far)",
									Promise.all([nearPromise, farPromise]),
								);
							} else if (nearPromise) {
								markSuspend();
								await this.withIoTimeout(
									"WorldStorage.loadChunks (near)",
									nearPromise,
								);
							} else if (farPromise) {
								markSuspend();
								await this.withIoTimeout(
									"WorldStorage.loadChunks (far)",
									farPromise,
								);
							}

							markResume();
							this.beginSlice(state);
							state.stage = ProcessStage.ApplyLoadedChunks;
						} catch (error) {
							console.warn("Failed to load chunks from storage", error);
							state.nearLoadedDataMap.clear();
							state.farLoadedDataMap.clear();
							markResume();
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

							if (!this.isStillDesired(state, request)) {
								/*
								 * The chunk stopped being desired while its storage read
								 * was in flight, so isStillDesired sent the request back
								 * around instead of consuming it. That re-queue keeps the
								 * request alive, so the chunk is NOT an orphan yet.
								 *
								 * The dangerous variant is the opposite outcome: a chunk
								 * that still wants loading but whose request is being
								 * dropped without a re-queue. Those are registered by the
								 * branches that actually abandon a request —
								 * onLoadRequestsAbandoned, and the desired-state drop in
								 * PrepareLoadBatch above.
								 */
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

							markSuspend();
							await this.withIoTimeout(
								"WorldStorage.loadChunks (hydration)",
								WorldStorage.loadChunks(
									state.hydrateIds,
									{ includeVoxelData: true },
									state.hydrateMap,
								),
							);

							markResume();
							this.beginSlice(state);
						} catch (error) {
							console.warn("Failed to hydrate chunks from storage", error);
							state.hydrateMap.clear();
							markResume();
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

							/*
							 * `hydrateChunks` holds Chunk OBJECT references captured
							 * before the storage read, and the read is awaited. Chunk
							 * objects are pooled: one disposed during that await is
							 * unlinked from the registry and may be re-registered at
							 * entirely different coordinates. Everything below keys off
							 * `chunk`, so without this fence a recycled object could be
							 * handed another chunk's saved data — installing coordinate
							 * K's voxels into coordinate J's buffers — or queued for
							 * generation as if it were still the chunk that was asked
							 * for.
							 *
							 * The registry lookup answers both halves at once: disposed
							 * objects are unlinked, and a recycled object registers under
							 * its new id, so neither still maps to itself.
							 */
							if (Chunk.chunkInstances.get(chunk.id) !== chunk) {
								state.hydrationRecycledDrops++;
								this._totalHydrationRecycledDrops++;
								continue;
							}

							if (!chunk.isTerrainScheduled) {
								if (!chunk.isLoaded) {
									this.queueGeneration(state, chunk);
								}
								continue;
							}

							const savedData = state.hydrateMap.get(chunk.id);
							if (!savedData) {
								/*
								 * The hydration read came back without this chunk's data
								 * — the request disappeared between being issued and
								 * being answered. queueGeneration below still produces
								 * the voxels, so this is not an orphan yet; it only
								 * becomes one if that generation task is also lost,
								 * which the worker-failure path registers separately.
								 * Registering it here as well would be harmless but
								 * would grow the candidate set on every far-LOD chunk,
								 * which is the common case, not an anomaly.
								 */
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

						for (
							let i = 0, length = state.chunksToGenerate.length;
							i < length;
							i++
						) {
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

			// STALLFIX: decide continuation BEFORE recovering, and never let a
			// throw inside recovery escape. Both used to leave shouldContinue
			// false with the queue still non-empty, which skipped
			// scheduleProcessContinuation and silently killed the rAF pump.
			shouldContinue = true;

			try {
				this.recoverProcessState(state);
			} catch (recoveryError) {
				console.error(
					"ChunkProcessScheduler recovery failed (queues may be stale):",
					recoveryError,
				);
				// Drop the in-flight batch without recycling it: its requests may
				// already be back in loadQueue, and recycling a live request lets
				// ensureChunkQueuedForLoad hand the same object out twice.
				//
				// Tell the controller they are abandoned so it stops treating
				// them as in-flight — otherwise sweepOrphanedChunks would skip
				// these chunks forever, which is the very stall this fixes.
				this.adapter.onLoadRequestsAbandoned?.(state.loadBatch);
				state.loadBatch.length = 0;
			}

			this.inFlightProcessState = null;
			this.adapter.onProcessError?.(error);
		} finally {
			// Covers every exit path, including the `return` in Finalize.
			markSuspend();
			if (offFrameMs > 0) {
				frameProfiler.noteOffFrameValue("streamAsync", offFrameMs);
			}

			// Book the slice's own synchronous cost against the shared frame pool.
			// `offFrameMs` above covers the awaited storage reads, which happen
			// outside any frame and so must NOT be charged here.
			const synchronousSliceMs = Math.max(
				0,
				performance.now() - state.sliceStartMs - offFrameMs,
			);

			FRAME_WORK_BUDGET.record(FrameWorkKind.Streaming, synchronousSliceMs);

			this.isProcessing = false;

			if (shouldContinue) {
				this.scheduleProcessContinuation();
			}
		}
	}

	/**
	 * Move one request back to the load queue if it is still valid.
	 *
	 * This is used when the desired near/far routing changes while an asynchronous
	 * storage read is in flight. Returning false from isStillDesired without
	 * re-queuing would otherwise strand the chunk.
	 *
	 * Routed through the owner (Loading → Scheduled): the host restores the
	 * retained request — the same object, with the adopted LOD already applied
	 * in place — instead of pushing here. The owner no-ops when the chunk is
	 * no longer Loading (culled mid-flight, unload won the race); the request
	 * is then dropped and the sweep/cull owns the outcome.
	 */
	/**
	 * Notify the adapter about one request without allocating a temporary
	 * single-element array.
	 */
	private notifySingleRequest(
		callback:
			| ((requests: ReadonlyArray<QueuedChunkRequest>) => void)
			| undefined,
		request: QueuedChunkRequest,
	): void {
		if (callback === undefined) {
			return;
		}

		const snapshot = this._notificationRequests;
		snapshot[0] = request;

		try {
			callback(snapshot);
		} finally {
			snapshot.length = 0;
		}
	}

	/**
	 * Move one in-flight request back to the load queue if it is still valid.
	 *
	 * ChunkLifecycle owns the Loading -> Scheduled transition. Its host restores
	 * the retained request object to the queue, so this method must not push the
	 * request directly.
	 */
	private requeueLoadRequest(
		state: InFlightProcessState,
		request: QueuedChunkRequest,
	): boolean {
		const chunk = request.chunk;

		if (!chunk || !chunk.isTerrainScheduled || chunk.isLoaded) {
			return false;
		}

		const loadQueue = this.adapter.getLoadQueue();
		const queuedIds = state.queuedLoadIdsScratch;

		queuedIds.clear();

		try {
			for (let i = 0, length = loadQueue.length; i < length; i++) {
				const queuedChunk = loadQueue[i].chunk;

				if (queuedChunk) {
					queuedIds.add(queuedChunk.id);
				}
			}

			if (queuedIds.has(chunk.id)) {
				return false;
			}

			/*
			 * Loading -> Scheduled. The lifecycle host moves the retained request
			 * from the in-flight registry back to the load queue.
			 */
			const result = ChunkLifecycle.abandonLoad(chunk, "requeue");

			/*
			 * If the transition was rejected because unloading or disposal won the
			 * race, the request was not restored and must be treated as dropped.
			 */
			if (result !== ResidencyState.Scheduled) {
				return false;
			}

			this.notifySingleRequest(this.adapter.onLoadRequestsRecovered, request);

			this.adapter.onQueueSnapshotChanged?.();
			return true;
		} finally {
			queuedIds.clear();
		}
	}

	/**
	 * Whether an in-flight request still matches the current desired state.
	 *
	 * Revision-only changes are adopted in place. A near/far boundary change must
	 * go through storage again because the original read used the wrong voxel-data
	 * mode.
	 */
	private isStillDesired(
		state: InFlightProcessState,
		request: QueuedChunkRequest,
	): boolean {
		const chunk = request.chunk;

		if (!chunk || !chunk.isTerrainScheduled) {
			return false;
		}

		const desired = this.adapter.getDesiredState(chunk.numericId);

		if (desired === undefined) {
			this.adapter.markPotentialOrphan(chunk);
			return false;
		}

		const desiredLod = desired & 0b111;
		const desiredRevision = desired >>> 3;
		const wantVoxelData = desiredLod <= 1;

		request.revision = desiredRevision;

		if (wantVoxelData !== request.includeVoxelData) {
			request.desiredLod = desiredLod;
			request.includeVoxelData = wantVoxelData;
			request.priority = Number.POSITIVE_INFINITY;

			this.requeueLoadRequest(state, request);
			return false;
		}

		request.desiredLod = desiredLod;
		return true;
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
		const queuedIds = state.queuedLoadIdsScratch;

		queuedIds.clear();

		for (let i = 0; i < loadQueue.length; i++) {
			const chunk = loadQueue[i].chunk;

			if (chunk) {
				queuedIds.add(chunk.id);
			}
		}

		const recovered = this._recoveredRequests;
		recovered.length = 0;

		for (let i = 0; i < state.loadBatch.length; i++) {
			const request = state.loadBatch[i];
			const chunk = request.chunk;

			if (
				!chunk ||
				!chunk.isTerrainScheduled ||
				chunk.isLoaded ||
				queuedIds.has(chunk.id)
			) {
				continue;
			}

			queuedIds.add(chunk.id);
			// Route through the owner (Loading → Scheduled): the host
			// restores the retained request — the same object — onto the
			// load queue instead of pushing here.
			ChunkLifecycle.abandonLoad(chunk, "requeue");
			recovered.push(request);
		}

		/*
		 * Requests now owned by loadQueue must not be recycled when this state is
		 * reset.
		 */
		state.loadBatch.length = 0;
		queuedIds.clear();

		if (recovered.length > 0) {
			this.adapter.onLoadRequestsRecovered?.(recovered);
		}

		recovered.length = 0;
		this.adapter.onQueueSnapshotChanged?.();
	}

	private queueGeneration(state: InFlightProcessState, chunk: Chunk): void {
		if (
			chunk.isLoaded ||
			!chunk.isTerrainScheduled ||
			state.chunksToGenerateIds.has(chunk.id)
		) {
			return;
		}

		state.chunksToGenerateIds.add(chunk.id);
		state.chunksToGenerate.push(chunk);
	}

	public beginSlice(state: InFlightProcessState): void {
		const configuredBudget = Math.max(
			0.5,
			this.adapter.getProcessFrameBudgetMs(),
		);

		const sharedRemaining = FRAME_WORK_BUDGET.remainingMs();

		/*
		 * A reported zero means the shared frame budget is exhausted, not that the
		 * local budget should be restored. Keep a very small allowance so the
		 * state machine can record its continuation without doing a full batch.
		 */
		const availableBudget =
			sharedRemaining > 0 ? Math.min(configuredBudget, sharedRemaining) : 0.05;

		const now = performance.now();

		state.sliceStartMs = now;
		state.sliceDeadlineMs = now + availableBudget;
	}

	public hasBudget(state: InFlightProcessState): boolean {
		return (
			performance.now() < state.sliceDeadlineMs &&
			FRAME_WORK_BUDGET.canContinue(FrameWorkKind.Streaming)
		);
	}

	public scheduleProcessContinuation(): void {
		if (this.processContinuationScheduled) {
			return;
		}

		this.processContinuationScheduled = true;

		requestAnimationFrame(() => {
			this.processContinuationScheduled = false;

			void this.processQueues()
				.then(() => this.onContinuationSlice?.())
				.catch((error) => this.adapter.onProcessError?.(error));
		});
	}
}
