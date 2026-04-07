import { SavedChunkData, SavedChunkEntityData } from "../../WorldStorage";
import { Chunk } from "../Chunk";
import { QueuedChunkRequest } from "./ChunkStreamingController";

export type ChunkBoundEntity = {
  getWorldPosition: () => { x: number; y: number; z: number };
  unload: () => void;
  isAlive?: () => boolean;
  serializeForChunkReload?: () => SavedChunkEntityData | null;
};

export enum ProcessStage {
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

  loadedFromStorageCount: number;
  generatedCount: number;
  hydratedCount: number;
  unloadedCount: number;
  savedCount: number;
  lodCacheVersionMismatchCount: number;

  unloadBatch: Chunk[];
  unloadBatchIndex: number;
  savedChunkIds: Set<bigint> | null;

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
  lastLodCacheVersionMismatches: number;
  totalLodCacheVersionMismatches: number;
};
