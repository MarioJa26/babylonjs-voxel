import {
	FRAME_WORK_BUDGET,
	FrameWorkKind,
} from "@/code/Lib/FrameWorkBudget";
import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { type SavedChunkData, WorldStorage } from "../../WorldStorage";
import { Chunk } from "../Chunk";
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
	 * Reject if `promise` has not settled within IO_TIMEOUT_MS. Never rejects
	 * before the underlying promise settles on its own.
	 */
	private async withIoTimeout<T>(
		label: string,
		promise: Promise<T>,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				this._ioTimedOut.count++;
				console.error(
					`[ChunkProcessScheduler] ${label} did not settle within ` +
						`${ChunkProcessScheduler.IO_TIMEOUT_MS}ms — abandoning it ` +
						`and continuing (occurrence ${this._ioTimedOut.count}). ` +
						`The streaming pipeline would otherwise stay parked forever.`,
				);
				reject(new Error(`${label} timed out`));
			}, ChunkProcessScheduler.IO_TIMEOUT_MS);
		});

		try {
			return await Promise.race([promise, timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
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

	private preferLoadNext = false;
	private unloadRetryAfterMs = 0;

	public onContinuationSlice: (() => void) | null = null;

	public constructor(private readonly adapter: ChunkProcessSchedulerAdapter) {}

	public get processing(): boolean {
		return this.isProcessing;
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
		// P1-6: recycle QueuedChunkRequest objects to pool to avoid per-batch GC.
		if (state.loadBatch.length > 0) {
			const toRecycle = state.loadBatch.slice();
			// Clear references before offloading to pool; state arrays will be cleared below.
			this.adapter.recycleQueuedRequests?.(toRecycle);
		}
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
							try {
								await this.withIoTimeout(
									"WorldStorage.saveChunks (unload batch)",
									WorldStorage.saveChunks(this._saveScratch),
								);

								this.beginSlice(state);

								for (const id of state.savedChunkRevisions.keys()) {
									state.savedChunkIds.add(id);
								}

								state.savedCount += state.savedChunkRevisions.size;
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
								unloadQueueSet.add(chunk);
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
						const takeCount = Math.min(batchSize, loadQueue.length);

						this.clearLoadState(state);

						if (takeCount > 0) {
							for (let i = 0; i < takeCount; i++) {
								state.loadBatch.push(loadQueue[i]);
							}

							if (this.adapter.onLoadRequestsDequeued) {
								this.adapter.onLoadRequestsDequeued(state.loadBatch.slice());
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

						if (!this.isStillDesired(request)) {
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
			FRAME_WORK_BUDGET.record(
				FrameWorkKind.Streaming,
				performance.now() - state.sliceStartMs - offFrameMs,
			);

			this.isProcessing = false;

			if (shouldContinue) {
				this.scheduleProcessContinuation();
			}
		}
	}

	private recoverProcessState(state: InFlightProcessState): void {
		const unloadQueue = this.adapter.getUnloadQueueSet();

		for (
			let i = state.unloadBatchIndex, length = state.unloadBatch.length;
			i < length;
			i++
		) {
			const chunk = state.unloadBatch[i];

			if (chunk.isLoaded && !chunk.isBoatChunk) {
				unloadQueue.add(chunk);
			}
		}

		const loadQueue = this.adapter.getLoadQueue();
		const queuedIds = state.queuedLoadIdsScratch;

		queuedIds.clear();

		for (let i = 0, length = loadQueue.length; i < length; i++) {
			const request = loadQueue[i];
			if (request.chunk) queuedIds.add(request.chunk.id);
		}

		const recovered = this._recoveredRequests;
		recovered.length = 0;

		for (let i = 0, length = state.loadBatch.length; i < length; i++) {
			const request = state.loadBatch[i];
			const chunk = request.chunk;

			if (
				chunk &&
				chunk.isTerrainScheduled &&
				!chunk.isLoaded &&
				!queuedIds.has(chunk.id)
			) {
				queuedIds.add(chunk.id);
				loadQueue.push(request);
				recovered.push(request);
			}
		}

		/*
		 * STALLFIX: drop the batch references now that they are live in
		 * `loadQueue` again. Leaving them in place meant the next
		 * resetState -> clearLoadState recycled them into the free pool while
		 * they were still queued, so ensureChunkQueuedForLoad could hand the
		 * very same object out a second time and push a duplicate entry.
		 */
		state.loadBatch.length = 0;

		/*
		 * The scratch set is no longer needed after the synchronous loops above.
		 * Clearing it avoids retaining IDs until the next process operation.
		 */
		queuedIds.clear();

		/*
		 * These requests went back into `loadQueue` but were removed from the
		 * controller's request map when they were originally dequeued. Without
		 * re-registering them, a later ensureChunkQueuedForLoad for the same
		 * chunk would allocate a SECOND request object for it and the chunk
		 * would be loaded twice per pass.
		 */
		if (recovered.length > 0) {
			this.adapter.onLoadRequestsRecovered?.(recovered);
		}
		recovered.length = 0;

		this.adapter.onQueueSnapshotChanged?.();
	}

	/**
	 * Whether an in-flight request is still wanted, re-syncing it against the
	 * newest desired state first.
	 *
	 * STALLFIX: this used to be a pure "revision must match exactly" predicate,
	 * so a request whose desired state advanced while `LoadFromStorage` was
	 * awaiting was silently skipped — leaving its chunk loaded-but-unhydrated (or
	 * absent) with no request anywhere. Re-syncing means a revision bump is
	 * absorbed instead of discarded, and matches what PrepareLoadBatch now does.
	 */
	private isStillDesired(request: QueuedChunkRequest): boolean {
		const chunk = request.chunk;

		if (!chunk) return false;
		if (!chunk.isTerrainScheduled) return false;

		const desired = this.adapter.getDesiredState(chunk.numericId);

		if (desired === undefined) {
			// Nothing records this chunk as wanted. Leave the request dropped;
			// sweepOrphanedChunks will re-queue it with a fresh desired state if
			// it is still wanted.
			return false;
		}

		const desiredLod = desired & 0b111;
		const desiredRevision = desired >>> 3;

		if (desiredRevision !== request.revision) {
			request.revision = desiredRevision;
		}

		if (desiredLod !== request.desiredLod) {
			// Near/far routing was decided in PrepareLoadBatch from the old LOD;
			// a chunk that crossed the LOD1 boundary mid-flight must go back
			// through the queue rather than being hydrated from the wrong read.
			const wantVoxels = desiredLod <= 1;
			if (wantVoxels !== request.includeVoxelData) {
				return false;
			}
			request.desiredLod = desiredLod;
		}

		return true;
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
		// The slice deadline is the MINIMUM of this subsystem's own ceiling and
		// what the frame-wide pool still has. Both draw on the same frame, and
		// the loaded-refresh drain, orphan sweep and mesh ingest are all competing
		// for it — capping only locally is what let their sum overrun the frame.
		state.sliceDeadlineMs =
			now +
			Math.min(budget, FRAME_WORK_BUDGET.remainingMs() || budget);
	}

	public hasBudget(state: InFlightProcessState): boolean {
		// Both conditions: the slice's own deadline, and the aggregate frame
		// pool. A slice that started while the pool had room can still be cut
		// short by work another subsystem did after it began.
		return (
			performance.now() < state.sliceDeadlineMs &&
			FRAME_WORK_BUDGET.canContinue(FrameWorkKind.Streaming)
		);
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
}
