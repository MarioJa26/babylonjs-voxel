import type { SavedChunkData, SavedChunkEntityData } from "../../WorldStorage";
import type { Chunk } from "../Chunk";
import type { QueuedChunkRequest } from "./ChunkStreamingController";

export type ChunkBoundEntity = {
	getWorldPosition: () => { x: number; y: number; z: number };
	unload: () => void;
	isAlive?: () => boolean;
	serializeForChunkReload?: () => SavedChunkEntityData | null;
};

export const enum ProcessStage {
	Start,
	PrepareUnloadBatch,
	SaveUnloadBatch,
	DisposeUnloadBatch,
	PrepareLoadBatch,
	LoadFromStorage,
	ApplyLoadedChunks,
	LoadHydrationData,
	ApplyHydration,
	ScheduleGeneration,
	Finalize,
}

export type InFlightProcessState = {
	stage: ProcessStage;
	sliceStartMs: number;
	sliceDeadlineMs: number;

	loadedFromStorageCount: number;
	generatedCount: number;
	hydratedCount: number;
	unloadedCount: number;
	savedCount: number;

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
	hydrateChunks: Chunk[];
	hydrateMap: Map<bigint, SavedChunkData>;
	hydrateIndex: number;
};

export type ChunkLoadingDebugStats = {
	loadQueueLength: number;
	unloadQueueLength: number;
	loadBatchLimit: number;
	unloadBatchLimit: number;
	frameBudgetMs: number;
	lastProcessMs: number;
	totalProcessLoops: number;
	lastLoadedFromStorage: number;
	lastGenerated: number;
	lastHydrated: number;
	lastUnloaded: number;
	lastSaved: number;
	totalLoadedFromStorage: number;
	totalGenerated: number;
	totalHydrated: number;
	totalUnloaded: number;
	totalSaved: number;
	lastOpfsHits: number;
	lastOpfsMisses: number;
	totalOpfsHits: number;
	totalOpfsMisses: number;
	opfsUsedBytes: number;
	opfsTotalBytes: number;
	opfsSlotCount: number;
	opfsEvictionCount: number;
};
