import { worldToChunkCoord } from "@/code/Lib/VoxelMath";
import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import {
	type SavedChunkData,
	type SavedChunkEntityData,
	WorldStorage,
} from "../WorldStorage";
import { addChunkDisposeHook, Chunk, getChunk, getChunkFast } from "./Chunk";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { packCoords } from "./DataStructures/ChunkCoords";
import { ChunkEntityRegistry } from "./Loading/ChunkEntityRegistry";
import { ChunkHydration } from "./Loading/ChunkHydration";
import { ChunkLoadingDebug } from "./Loading/ChunkLoadingDebug";
import { ChunkPersistenceCoordinator } from "./Loading/ChunkPersistenceCoordinator";
import { ChunkProcessScheduler } from "./Loading/ChunkProcessScheduler";
import {
	ChunkStreamingController,
	type QueuedChunkRequest,
} from "./Loading/ChunkStreamingController";
import type {
	ChunkBoundEntity,
	ChunkLoadingDebugStats,
	InFlightProcessState,
} from "./Loading/ChunkTypes";
import {
	ChunkWorldMutations,
	getBlockStateByWorldCoords as getBlockStateFromMutations,
} from "./Loading/ChunkWorldMutations";
import {
	checkNewInfiniteSource,
	scheduleBlockBreakWaterUpdates,
	scheduleBlockPlaceWaterUpdates,
} from "./Worker/WaterSimulation";

export type DynamicBlockSample = {
	blockId: number;
	blockState: number;
	lightLevel: number;
	context?: unknown;
};

type DynamicBlockProvider = (
	worldX: number,
	worldY: number,
	worldZ: number,
) => DynamicBlockSample | null;

type DynamicBlockMutator = (
	worldX: number,
	worldY: number,
	worldZ: number,
	blockId: number,
	blockState: number,
) => boolean;

type DynamicBlockProviderEntry = {
	provider: DynamicBlockProvider;
	mutator?: DynamicBlockMutator;
};

export type DynamicBlockQueryOptions = {
	ignoredDynamicBlockProviders?: ReadonlySet<symbol>;
};

const loadQueue: QueuedChunkRequest[] = [];
const unloadQueueSet: Set<Chunk> = new Set();
const dynamicBlockProviders: Map<symbol, DynamicBlockProviderEntry> = new Map();

const debug = new ChunkLoadingDebug();

const _neighborBuffer: (Chunk | undefined)[] = new Array(6);

const _queuedIdSet: Set<bigint> = new Set();

const _entityPayloadMap = new Map<bigint, SavedChunkEntityData[]>();

const debugStats: ChunkLoadingDebugStats = {
	loadQueueLength: 0,
	unloadQueueLength: 0,
	loadBatchLimit: Math.max(
		1,
		Math.floor(SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT),
	),
	unloadBatchLimit: Math.max(
		1,
		Math.floor(SETTING_PARAMS.CHUNK_UNLOAD_BATCH_LIMIT),
	),
	frameBudgetMs: Math.max(0.5, SETTING_PARAMS.CHUNK_LOADING_FRAME_BUDGET_MS),
	lastProcessMs: 0,
	totalProcessLoops: 0,
	lastLoadedFromStorage: 0,
	lastGenerated: 0,
	lastHydrated: 0,
	lastUnloaded: 0,
	lastSaved: 0,
	totalLoadedFromStorage: 0,
	totalGenerated: 0,
	totalHydrated: 0,
	totalUnloaded: 0,
	totalSaved: 0,
};

const chunkEntityRegistry = new ChunkEntityRegistry<ChunkBoundEntity>({
	getChunkId: getEntityChunkId,
	serialize: serializeEntityForReload,
	dispose: (entity) => {
		entity.unload();
	},
});

const chunkHydration = new ChunkHydration({
	getStoragePayload: (savedData) => ({
		// IMPORTANT: zero-copy handoff
		blocks: savedData.blocks,
		palette: savedData.palette,
		isUniform: savedData.isUniform,
		uniformBlockId: savedData.uniformBlockId,
		lightArray: savedData.lightArray,
	}),
});

const streamingController = new ChunkStreamingController({
	getLoadQueue: () => loadQueue,
	getUnloadQueueSet: () => unloadQueueSet,
	onQueueSnapshotChanged: refreshQueueDebugSnapshot,
});

addChunkDisposeHook((chunk) => {
	streamingController.onChunkDisposed(chunk.numericId);
});

const worldMutations = new ChunkWorldMutations({
	onBoundaryMutation: ({ chunk }) => {
		if (chunk) {
			scheduleChunkAndNeighborsRemesh(chunk);
		}
	},
});

const persistenceCoordinator = new ChunkPersistenceCoordinator({
	getModifiedChunks: () => Chunk.chunkInstances.values(),
	getChunkEntityPayloads: collectChunkEntityPayloads,
	getChunkSaveBatchSize: getUnloadBatchSize,
	getChunkEntitySaveBatchSize: getUnloadBatchSize,
});

// PERF: Debounce block-edit saves into a single batched save per 500 ms;
// unloads and the periodic flush (PlayerStatePersistence) still persist chunks.
const BLOCK_EDIT_SAVE_DEBOUNCE_MS = 500;
const pendingBlockEditSaveIds = new Set<bigint>();
let blockEditSaveTimer: ReturnType<typeof setTimeout> | null = null;

function queueBlockEditSave(chunk: Chunk): void {
	pendingBlockEditSaveIds.add(chunk.id);
	if (blockEditSaveTimer !== null) return;

	blockEditSaveTimer = setTimeout(() => {
		blockEditSaveTimer = null;
		const chunksToSave: Chunk[] = [];
		for (const id of pendingBlockEditSaveIds) {
			const pendingChunk = Chunk.chunkInstances.get(id);
			if (pendingChunk?.isLoaded && pendingChunk.needsPersistence()) {
				chunksToSave.push(pendingChunk);
			}
		}
		pendingBlockEditSaveIds.clear();
		if (chunksToSave.length > 0) {
			void WorldStorage.saveChunks(chunksToSave).catch((error) => {
				console.error("Block-edit chunk save failed:", error);
			});
		}
	}, BLOCK_EDIT_SAVE_DEBOUNCE_MS);
}

Chunk.onBlockModified = (chunk) => {
	queueBlockEditSave(chunk);
};

const processScheduler = new ChunkProcessScheduler({
	getLoadQueue: () => loadQueue,
	getUnloadQueueSet: () => unloadQueueSet,

	getLoadBatchSize: () => getLoadBatchSize(),
	getUnloadBatchSize: () => getUnloadBatchSize(),
	getProcessFrameBudgetMs: () => getProcessFrameBudgetMs(),

	getDesiredState: (chunkId) => streamingController.getDesiredState(chunkId),

	unloadChunkBoundEntitiesForChunk: (chunk) =>
		chunkEntityRegistry.unloadEntitiesForChunk(chunk),

	applyLoadedChunkFromSavedData,
	applyHydratedChunkFromSavedData,

	scheduleTerrainGenerationBatch: (chunks) =>
		ChunkWorkerPool.getInstance().scheduleTerrainGenerationBatch(chunks),

	updateSliceDebugStats,
	finalizeProcessState,

	onQueueSnapshotChanged: refreshQueueDebugSnapshot,

	onLoadRequestsDequeued: (requests) =>
		streamingController.onLoadRequestsDequeued(requests),
});

// After each processQueues continuation slice, pump remote generation.
processScheduler.onContinuationSlice = () => {
	ChunkWorkerPool.getInstance().pumpRemoteGeneration();
};

function isEntityAlive(entity: ChunkBoundEntity): boolean {
	return !(entity.isAlive && !entity.isAlive());
}

function getEntityChunkId(entity: ChunkBoundEntity): bigint | null {
	if (!isEntityAlive(entity)) {
		return null;
	}

	const worldPos = entity.getWorldPosition();
	const chunkX = worldToChunkCoord(worldPos.x);
	const chunkY = worldToChunkCoord(worldPos.y);
	const chunkZ = worldToChunkCoord(worldPos.z);

	// PERF: prefer the existing chunk's id over a fresh BigInt packCoords.
	const chunk = getChunk(chunkX, chunkY, chunkZ);
	return chunk ? chunk.id : packCoords(chunkX, chunkY, chunkZ);
}

function serializeEntityForReload(
	entity: ChunkBoundEntity,
): SavedChunkEntityData | null {
	if (!isEntityAlive(entity)) {
		return null;
	}

	return entity.serializeForChunkReload?.() ?? null;
}

function getConfiguredBatchSize(
	configuredValue: number,
	fallbackValue: number,
): number {
	const configured = Math.floor(configuredValue);
	return configured > 0 ? configured : Math.max(1, Math.floor(fallbackValue));
}

function getLoadBatchSize(): number {
	return getConfiguredBatchSize(
		SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT,
		SETTING_PARAMS.RENDER_DISTANCE * 4,
	);
}

function getUnloadBatchSize(): number {
	return getConfiguredBatchSize(
		SETTING_PARAMS.CHUNK_UNLOAD_BATCH_LIMIT,
		SETTING_PARAMS.RENDER_DISTANCE * 4,
	);
}

function getProcessFrameBudgetMs(): number {
	return Math.max(0.5, SETTING_PARAMS.CHUNK_LOADING_FRAME_BUDGET_MS);
}

function getNeighbors(chunk: Chunk): (Chunk | undefined)[] {
	const n = _neighborBuffer;

	n[0] = chunk.getNeighbor(-1, 0, 0);
	n[1] = chunk.getNeighbor(1, 0, 0);
	n[2] = chunk.getNeighbor(0, -1, 0);
	n[3] = chunk.getNeighbor(0, 1, 0);
	n[4] = chunk.getNeighbor(0, 0, -1);
	n[5] = chunk.getNeighbor(0, 0, 1);

	return n;
}

function refreshQueueDebugSnapshot(): void {
	debug.refreshQueueSnapshot({
		loadQueueLength: loadQueue.length,
		unloadQueueLength: unloadQueueSet.size,
		pendingChunkEntityReloadCount: chunkEntityRegistry.getPendingReloadCount(),
		registeredChunkEntityCount: chunkEntityRegistry.getRegisteredEntityCount(),
	});

	debugStats.loadQueueLength = loadQueue.length;
	debugStats.unloadQueueLength = unloadQueueSet.size;
	debugStats.loadBatchLimit = getLoadBatchSize();
	debugStats.unloadBatchLimit = getUnloadBatchSize();
	debugStats.frameBudgetMs = getProcessFrameBudgetMs();
}

export function getDebugStats(): ChunkLoadingDebugStats {
	refreshQueueDebugSnapshot();
	return debugStats;
}

function buildQueuedIdSet(): Set<bigint> {
	const set = _queuedIdSet;
	set.clear();

	for (let i = 0; i < loadQueue.length; i++) {
		set.add(loadQueue[i].chunk.id);
	}

	return set;
}

function ensureChunkLoadedHook(): void {
	chunkEntityRegistry.ensureChunkLoadedHook();
}

export function validateChunksAround(
	centerChunkX: number,
	centerChunkY: number,
	centerChunkZ: number,
	horizontalRadius = SETTING_PARAMS.RENDER_DISTANCE,
	verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
): void {
	const queuedIds = buildQueuedIdSet();

	const missing: Array<{
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		chunkId: bigint;
		isLoaded: boolean;
		isQueued: boolean;
		isUnloading: boolean;
		hasDesiredState: boolean;
	}> = [];

	const minChunkY = SETTING_PARAMS.MIN_CHUNK_Y;
	const maxChunkY = minChunkY + SETTING_PARAMS.MAX_CHUNK_HEIGHT - 1;

	const startY = Math.max(minChunkY, centerChunkY - verticalRadius);
	const endY = Math.min(maxChunkY, centerChunkY + verticalRadius);
	const startX = centerChunkX - horizontalRadius;
	const endX = centerChunkX + horizontalRadius;
	const startZ = centerChunkZ - horizontalRadius;
	const endZ = centerChunkZ + horizontalRadius;

	for (let y = startY; y <= endY; y++) {
		for (let x = startX; x <= endX; x++) {
			for (let z = startZ; z <= endZ; z++) {
				const chunk = getChunk(x, y, z);

				// A non-existent chunk cannot have desired state because
				// desired state is keyed by chunk.numericId from existing chunks.
				if (!chunk) {
					continue;
				}

				const hasDesiredState =
					streamingController.getDesiredState(chunk.numericId) !== undefined;

				if (!hasDesiredState || chunk.isLoaded || unloadQueueSet.has(chunk)) {
					continue;
				}

				const chunkId = chunk.id;

				if (queuedIds.has(chunkId)) {
					continue;
				}

				missing.push({
					chunkX: x,
					chunkY: y,
					chunkZ: z,
					chunkId,
					isLoaded: false,
					isQueued: false,
					isUnloading: false,
					hasDesiredState: true,
				});
			}
		}
	}

	if (missing.length > 0) {
		console.warn("[ChunkLoadingSystem] Missing desired chunks:", missing);
	}
}

export async function processFrameBudgetedStreamingWork(
	playerChunkX: number,
	playerChunkY: number,
	playerChunkZ: number,
): Promise<void> {
	const sliceStart = performance.now();

	streamingController.processLoadedRefreshQueue(
		playerChunkX,
		playerChunkY,
		playerChunkZ,
		SETTING_PARAMS.RENDER_DISTANCE,
		SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
		255,
	);

	if (!processScheduler.processing) {
		await processScheduler.processQueues();
	}

	// Always pump remote generation every frame. This sends queued chunks
	// to the server. Even if processQueues hasn't reached ScheduleGeneration
	// yet, pumping is a no-op when the queue is empty.
	const pool = ChunkWorkerPool.getInstance();
	if (performance.now() - sliceStart > getProcessFrameBudgetMs() * 4) {
		// The streaming slice already consumed its share of the frame —
		// defer the remote pump to a macrotask so its IndexedDB read + apply
		// work lands outside the render frame instead of stacking into it.
		setTimeout(() => pool.pumpRemoteGeneration(), 0);
	} else {
		pool.pumpRemoteGeneration();
	}
}

export function registerChunkEntityLoader(
	type: string,
	loader: (payload: unknown, chunk: Chunk) => void,
): void {
	ensureChunkLoadedHook();
	chunkEntityRegistry.registerLoader(type, loader);

	for (const chunk of Chunk.chunkInstances.values()) {
		if (chunk.isLoaded) {
			void chunkEntityRegistry.restoreEntitiesForChunk(chunk);
		}
	}
}

export function registerChunkBoundEntity(entity: ChunkBoundEntity): symbol {
	ensureChunkLoadedHook();
	return chunkEntityRegistry.registerEntity(entity);
}

export function unregisterChunkBoundEntity(handle: symbol | undefined): void {
	chunkEntityRegistry.unregisterEntity(handle);
}

export function registerDynamicBlockProvider(
	provider: DynamicBlockProvider,
	mutator?: DynamicBlockMutator,
): symbol {
	const handle = Symbol("dynamicBlockProvider");
	dynamicBlockProviders.set(handle, {
		provider,
		mutator,
	});
	return handle;
}

export function unregisterDynamicBlockProvider(
	handle: symbol | undefined,
): void {
	if (!handle) {
		return;
	}
	dynamicBlockProviders.delete(handle);
}

function sampleDynamicBlock(
	worldX: number,
	worldY: number,
	worldZ: number,
	options?: DynamicBlockQueryOptions,
): DynamicBlockSample | null {
	if (dynamicBlockProviders.size === 0) {
		return null;
	}

	const ignored = options?.ignoredDynamicBlockProviders;

	for (const [handle, entry] of dynamicBlockProviders) {
		if (ignored?.has(handle)) {
			continue;
		}

		const sample = entry.provider(worldX, worldY, worldZ);
		if (sample && sample.blockId !== 0) {
			return sample;
		}
	}

	return null;
}

function tryMutateDynamicBlock(
	worldX: number,
	worldY: number,
	worldZ: number,
	blockId: number,
	blockState: number,
): boolean {
	if (dynamicBlockProviders.size === 0) {
		return false;
	}

	for (const entry of dynamicBlockProviders.values()) {
		const handled =
			entry.mutator?.(worldX, worldY, worldZ, blockId, blockState) ?? false;
		if (handled) {
			return true;
		}
	}

	return false;
}

export function flushModifiedChunks(
	maxChunks = getUnloadBatchSize(),
): Promise<void> {
	return persistenceCoordinator.flushModifiedChunks(maxChunks);
}

export function flushChunkBoundEntities(): Promise<void> {
	return persistenceCoordinator.flushChunkBoundEntities(getUnloadBatchSize());
}

function scheduleChunkAndNeighborsRemesh(chunk: Chunk): void {
	const pool = ChunkWorkerPool.getInstance();

	pool.scheduleRemesh(chunk, true);

	const n = getNeighbors(chunk);

	if (n[0]) pool.scheduleRemesh(n[0], true);
	if (n[1]) pool.scheduleRemesh(n[1], true);
	if (n[2]) pool.scheduleRemesh(n[2], true);
	if (n[3]) pool.scheduleRemesh(n[3], true);
	if (n[4]) pool.scheduleRemesh(n[4], true);
	if (n[5]) pool.scheduleRemesh(n[5], true);
}

export async function updateChunksAround(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	renderDistance = SETTING_PARAMS.RENDER_DISTANCE,
	verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
	prevChunkX?: number,
	prevChunkY?: number,
	prevChunkZ?: number,
	playerWorldX?: number,
	playerWorldZ?: number,
): Promise<void> {
	ensureChunkLoadedHook();

	await streamingController.updateChunksAround(
		chunkX,
		chunkY,
		chunkZ,
		renderDistance,
		verticalRadius,
		prevChunkX,
		prevChunkY,
		prevChunkZ,
		playerWorldX,
		playerWorldZ,
	);

	if (!processScheduler.processing) {
		void processScheduler.processQueues();
	}
}

function updateSliceDebugStats(state: InFlightProcessState): void {
	debugStats.lastProcessMs = performance.now() - state.sliceStartMs;
	debugStats.lastLoadedFromStorage = state.loadedFromStorageCount;
	debugStats.lastGenerated = state.generatedCount;
	debugStats.lastHydrated = state.hydratedCount;
	debugStats.lastUnloaded = state.unloadedCount;
	debugStats.lastSaved = state.savedCount;

	refreshQueueDebugSnapshot();
}

function finalizeProcessState(state: InFlightProcessState): void {
	updateSliceDebugStats(state);

	debugStats.totalProcessLoops += 1;
	debugStats.totalLoadedFromStorage += state.loadedFromStorageCount;
	debugStats.totalGenerated += state.generatedCount;
	debugStats.totalHydrated += state.hydratedCount;
	debugStats.totalUnloaded += state.unloadedCount;
	debugStats.totalSaved += state.savedCount;
}

function applyHydratedChunkFromSavedData(
	chunk: Chunk,
	savedData: SavedChunkData,
): void {
	chunkHydration.applyHydratedChunkFromSavedData(chunk, savedData, true);
}

function loadFarLodChunk(state: InFlightProcessState, chunk: Chunk): void {
	chunk.loadLodOnlyFromStorage(false);

	if (!state.chunksNeedingFullHydration.has(chunk.id)) {
		chunk.isTerrainScheduled = true;
		state.chunksNeedingFullHydration.add(chunk.id);
		state.hydrateIds.push(chunk.id);
		state.hydrateChunks.push(chunk);
	}
}

function loadNearLodChunk(chunk: Chunk, savedData: SavedChunkData): void {
	chunk.loadFromStorage(
		savedData.blocks,
		savedData.palette,
		savedData.isUniform,
		savedData.uniformBlockId,
		savedData.lightArray,
		true,
		true,
	);
}

function applyLoadedChunkFromSavedData(
	state: InFlightProcessState,
	request: QueuedChunkRequest,
	savedData: SavedChunkData,
): void {
	const chunk = request.chunk;
	const targetLod = request.desiredLod;

	// Multiplayer: a local save is at best a copy of an older server
	// snapshot — another player may have edited this chunk since it was
	// saved (even while it was unloaded). Never apply stored voxel data
	// without the server's confirmation. This covers BOTH loading stages:
	// near chunks (which would skip generation entirely once loaded) and
	// far chunks (which would otherwise feed stale voxel data through the
	// hydration stage — ApplyHydration applies the saved data without any
	// server request). Route to generation instead, which in remote mode
	// sends the chunk's version to the server so it can confirm the local
	// copy (ChunkUnchanged) or return the authoritative data.
	if (ChunkWorkerPool.getInstance().isRemoteGenerationEnabled()) {
		if (!chunk.isLoaded && !state.chunksToGenerateIds.has(chunk.id)) {
			chunk.isTerrainScheduled = true;
			state.chunksToGenerateIds.add(chunk.id);
			state.chunksToGenerate.push(chunk);
		}
		return;
	}

	state.loadedFromStorageCount++;
	chunk.lodLevel = targetLod;

	if (targetLod >= 2) {
		loadFarLodChunk(state, chunk);
		return;
	}

	loadNearLodChunk(chunk, savedData);
}

export function deleteBlock(worldX: number, worldY: number, worldZ: number) {
	if (tryMutateDynamicBlock(worldX, worldY, worldZ, 0, 0)) {
		return;
	}

	worldMutations.deleteBlock(worldX, worldY, worldZ);
	scheduleBlockBreakWaterUpdates(worldX, worldY, worldZ);
	checkNewInfiniteSource(worldX, worldY, worldZ);
}

export function setBlock(
	worldX: number,
	worldY: number,
	worldZ: number,
	blockId: number,
	state = 0,
) {
	if (tryMutateDynamicBlock(worldX, worldY, worldZ, blockId, state)) {
		return;
	}

	worldMutations.setBlock(worldX, worldY, worldZ, blockId, state);
	scheduleBlockPlaceWaterUpdates(worldX, worldY, worldZ, blockId);
}

export function getBlockByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
	options?: DynamicBlockQueryOptions,
): number {
	const sample = sampleDynamicBlock(worldX, worldY, worldZ, options);
	return sample
		? sample.blockId
		: worldMutations.getBlockByWorldCoords(worldX, worldY, worldZ);
}

export function getTerrainBlockByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
): number {
	return worldMutations.getBlockByWorldCoords(worldX, worldY, worldZ);
}

export function getBlockStateByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
	options?: DynamicBlockQueryOptions,
): number {
	const sample = sampleDynamicBlock(worldX, worldY, worldZ, options);
	return sample
		? sample.blockState
		: getBlockStateFromMutations(worldX, worldY, worldZ);
}

// PERF: Allocation-free combined lookup. Writes into a reusable out object
// to avoid per-call object allocation in hot paths (collision, raycasting).
export type BlockAndStateOut = { blockId: number; blockState: number };

export function getBlockAndStateByWorldCoordsInto(
	worldX: number,
	worldY: number,
	worldZ: number,
	out: BlockAndStateOut,
	options?: DynamicBlockQueryOptions,
): BlockAndStateOut {
	const sample = sampleDynamicBlock(worldX, worldY, worldZ, options);
	if (sample) {
		out.blockId = sample.blockId;
		out.blockState = sample.blockState;
		return out;
	}
	// PERF: single resolveCoords for both fields (was two: one for the block
	// id, one for the state), avoiding a redundant BigInt packCoords getChunk
	// on every chunk-boundary crossing.
	worldMutations.getBlockAndStateAtWorldCoordsInto(worldX, worldY, worldZ, out);
	return out;
}

export type ResolvedBlock = {
	blockId: number;
	blockState: number;
	loaded: boolean;
	unloaded: boolean;
};

const _resolvedBlockScratch: ResolvedBlock = {
	blockId: 0,
	blockState: 0,
	loaded: false,
	unloaded: false,
};

// PERF: single-resolve collidable-block lookup for the player collision
// sampler.  Resolves the chunk once (cached) and reports whether it is
// unloaded so the caller can treat it as solid terrain — replacing the old
// isChunkLoadedAtWorldCoords() + getBlockAndStateByWorldCoords() pair, which
// resolved the chunk twice per voxel.
export function resolveBlockAtWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
	options?: DynamicBlockQueryOptions,
): ResolvedBlock {
	const sample = sampleDynamicBlock(worldX, worldY, worldZ, options);
	if (sample) {
		_resolvedBlockScratch.blockId = sample.blockId;
		_resolvedBlockScratch.blockState = sample.blockState;
		_resolvedBlockScratch.loaded = true;
		_resolvedBlockScratch.unloaded = false;
		return _resolvedBlockScratch;
	}
	worldMutations.getBlockAndStateAtWorldCoordsInto(
		worldX,
		worldY,
		worldZ,
		_resolvedBlockScratch,
	);
	_resolvedBlockScratch.unloaded = !_resolvedBlockScratch.loaded;
	return _resolvedBlockScratch;
}

const _blockAndStateScratch: BlockAndStateOut = { blockId: 0, blockState: 0 };

export function getBlockAndStateByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
	options?: DynamicBlockQueryOptions,
): BlockAndStateOut {
	return getBlockAndStateByWorldCoordsInto(
		worldX,
		worldY,
		worldZ,
		_blockAndStateScratch,
		options,
	);
}

export function getLightByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
	options?: DynamicBlockQueryOptions,
): number {
	const dynamicSample = sampleDynamicBlock(worldX, worldY, worldZ, options);
	if (dynamicSample) {
		return dynamicSample.lightLevel;
	}

	const chunkX = worldToChunkCoord(worldX);
	const chunkY = worldToChunkCoord(worldY);
	const chunkZ = worldToChunkCoord(worldZ);
	// PERF: cached chunk lookup avoids the BigInt packCoords getChunk on the
	// common (same/recent chunk) case.
	const chunk = getChunkFast(chunkX, chunkY, chunkZ);

	if (!chunk?.isLoaded) {
		return 15 << Chunk.SKY_LIGHT_SHIFT;
	}

	return worldMutations.getLightByWorldCoords(worldX, worldY, worldZ);
}

function collectChunkEntityPayloads(): ReadonlyMap<
	bigint,
	SavedChunkEntityData[]
> {
	_entityPayloadMap.clear();
	const entitiesByChunk = _entityPayloadMap;

	for (const entity of chunkEntityRegistry.getRegisteredEntities().values()) {
		const chunkId = getEntityChunkId(entity);
		const serialized = serializeEntityForReload(entity);

		if (chunkId === null || !serialized) {
			continue;
		}

		const list = entitiesByChunk.get(chunkId);
		if (list) {
			list.push(serialized);
		} else {
			entitiesByChunk.set(chunkId, [serialized]);
		}
	}

	return entitiesByChunk;
}

export {
	areChunksLoadedAround,
	areChunksLod0ReadyAround,
} from "./Loading/ChunkReadiness";
