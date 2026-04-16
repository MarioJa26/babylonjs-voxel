export interface ChunkQueueDebugSnapshot {
	loadQueueLength: number;
	unloadQueueLength: number;
	pendingChunkEntityReloadCount: number;
	registeredChunkEntityCount: number;
}

export interface ChunkProcessDebugSnapshot {
	isProcessing: boolean;
	currentStage: string | null;
	processedLoadsThisSlice: number;
	processedUnloadsThisSlice: number;
	processedLoadsTotal: number;
	processedUnloadsTotal: number;
	sliceStartedAtMs: number | null;
	sliceElapsedMs: number;
	frameBudgetMs: number;
	continuationScheduled: boolean;
}

export interface ChunkLoadingDebugStats
	extends ChunkQueueDebugSnapshot,
		ChunkProcessDebugSnapshot {}

export interface ChunkLoadingDebugAdapter {
	now?(): number;
}

export class ChunkLoadingDebug {
	private stats: ChunkLoadingDebugStats = {
		loadQueueLength: 0,
		unloadQueueLength: 0,
		pendingChunkEntityReloadCount: 0,
		registeredChunkEntityCount: 0,
		isProcessing: false,
		currentStage: null,
		processedLoadsThisSlice: 0,
		processedUnloadsThisSlice: 0,
		processedLoadsTotal: 0,
		processedUnloadsTotal: 0,
		sliceStartedAtMs: null,
		sliceElapsedMs: 0,
		frameBudgetMs: 0,
		continuationScheduled: false,
	};

	public constructor(private readonly adapter: ChunkLoadingDebugAdapter = {}) {}

	public getStats(): ChunkLoadingDebugStats {
		return { ...this.stats };
	}

	public refreshQueueSnapshot(params: {
		loadQueueLength: number;
		unloadQueueLength: number;
		pendingChunkEntityReloadCount?: number;
		registeredChunkEntityCount?: number;
	}): void {
		this.stats.loadQueueLength = params.loadQueueLength;
		this.stats.unloadQueueLength = params.unloadQueueLength;

		if (params.pendingChunkEntityReloadCount !== undefined) {
			this.stats.pendingChunkEntityReloadCount =
				params.pendingChunkEntityReloadCount;
		}

		if (params.registeredChunkEntityCount !== undefined) {
			this.stats.registeredChunkEntityCount = params.registeredChunkEntityCount;
		}
	}

	public beginProcessing(
		frameBudgetMs: number,
		stage: string | null = null,
	): void {
		this.stats.isProcessing = true;
		this.stats.currentStage = stage;
		this.stats.processedLoadsThisSlice = 0;
		this.stats.processedUnloadsThisSlice = 0;
		this.stats.sliceStartedAtMs = this.now();
		this.stats.sliceElapsedMs = 0;
		this.stats.frameBudgetMs = frameBudgetMs;
	}

	public endProcessing(): void {
		this.updateSliceElapsed();
		this.stats.isProcessing = false;
		this.stats.currentStage = null;
		this.stats.sliceStartedAtMs = null;
		this.stats.continuationScheduled = false;
	}

	public setStage(stage: string | null): void {
		this.stats.currentStage = stage;
	}

	public markContinuationScheduled(value: boolean): void {
		this.stats.continuationScheduled = value;
	}

	public recordLoadProcessed(count: number = 1): void {
		this.stats.processedLoadsThisSlice += count;
		this.stats.processedLoadsTotal += count;
		this.updateSliceElapsed();
	}

	public recordUnloadProcessed(count: number = 1): void {
		this.stats.processedUnloadsThisSlice += count;
		this.stats.processedUnloadsTotal += count;
		this.updateSliceElapsed();
	}

	public updateSlice(frameBudgetMs?: number): void {
		if (frameBudgetMs !== undefined) {
			this.stats.frameBudgetMs = frameBudgetMs;
		}
		this.updateSliceElapsed();
	}

	public resetTotals(): void {
		this.stats.processedLoadsTotal = 0;
		this.stats.processedUnloadsTotal = 0;
	}

	private updateSliceElapsed(): void {
		if (this.stats.sliceStartedAtMs === null) {
			this.stats.sliceElapsedMs = 0;
			return;
		}

		this.stats.sliceElapsedMs = Math.max(
			0,
			this.now() - this.stats.sliceStartedAtMs,
		);
	}

	private now(): number {
		return this.adapter.now?.() ?? performance.now();
	}
}
