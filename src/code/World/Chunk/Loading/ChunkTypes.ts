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
	savedChunkRevisions: Map<bigint, number>;

	loadBatch: QueuedChunkRequest[];
	validLoadBatch: QueuedChunkRequest[];
	nearRequests: QueuedChunkRequest[];
	farRequests: QueuedChunkRequest[];
	nearLoadedDataMap: Map<bigint, SavedChunkData>;
	farLoadedDataMap: Map<bigint, SavedChunkData>;
	applyLoadedIndex: number;
	chunksToGenerate: Chunk[];
	chunksToGenerateIds: Set<bigint>;
	chunksNeedingFullHydration: Set<bigint>;

	hydrateIds: bigint[];
	hydrateChunks: Chunk[];
	hydrateMap: Map<bigint, SavedChunkData>;
	hydrateIndex: number;

	/**
	 * Hydration targets skipped because the Chunk object they referenced had
	 * been disposed and recycled onto different coordinates while the storage
	 * read was in flight.
	 *
	 * Should be zero in normal operation. A rising count means chunks are being
	 * unloaded faster than hydration resolves, which is the same pressure that
	 * produces orphan chunks — worth surfacing rather than silently dropping.
	 */
	hydrationRecycledDrops: number;

	/**
	 * Caller-owned scratch set used while rebuilding the load queue after
	 * processing fails. It is reused instead of allocating a new Set for
	 * every recovery.
	 *
	 * This belongs to the process state because the state is exclusively
	 * owned by one active processQueues() operation.
	 */
	queuedLoadIdsScratch: Set<bigint>;
};

export type ChunkLoadingDebugStats = {
	loadQueueLength: number;
	unloadQueueLength: number;
	loadBatchLimit: number;
	unloadBatchLimit: number;
	frameBudgetMs: number;
	lastProcessMs: number;
	totalProcessLoops: number;
	// Orphan sweep (ChunkStreamingController.sweepOrphanedChunks): chunks that
	// wanted to load but had lost their request, re-queued by the safety net.
	// A non-zero "last" while the player is not moving means the streaming
	// controller is dropping requests; "total" climbing steadily is the stall.
	lastOrphanRescued: number;
	totalOrphanRescued: number;
	// Size of the orphan candidate set, which is now exactly what the sweep
	// inspects. Should hover near zero; its cost replaces an O(all chunks) walk.
	orphanCandidates: number;
	totalOrphanCandidatesInspected: number;
	// Hydration writes skipped because the Chunk object was recycled onto
	// different coordinates mid-read. Zero in normal operation; a climbing total
	// means unloads are outrunning hydration.
	hydrationRecycledDrops: number;
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
};
