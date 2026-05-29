import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import type { SavedChunkData, SavedChunkEntityData } from "../WorldStorage";
import { createMeshFromData } from "./ChunckMesher";
import { Chunk, getChunk, packCoords } from "./Chunk";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import type { MeshData } from "./DataStructures/MeshData";
import { getCurrentLodCacheVersion } from "./LOD/LodCacheVersion";
import { ChunkEntityRegistry } from "./Loading/ChunkEntityRegistry";
import {
	ChunkHydration,
	type SelectedSavedMesh,
} from "./Loading/ChunkHydration";
import { ChunkLoadingDebug } from "./Loading/ChunkLoadingDebug";
import { ChunkPersistenceCoordinator } from "./Loading/ChunkPersistenceCoordinator";
import { ChunkProcessScheduler } from "./Loading/ChunkProcessScheduler";
import { ChunkReadiness } from "./Loading/ChunkReadinessAdapter";
import {
	ChunkStreamingController,
	type QueuedChunkRequest,
} from "./Loading/ChunkStreamingController";
import type {
	ChunkBoundEntity,
	ChunkLoadingDebugStats,
	InFlightProcessState,
} from "./Loading/ChunkTypes";
// After
import {
	ChunkWorldMutations,
	getBlockStateByWorldCoords as getBlockStateFromMutations,
} from "./Loading/ChunkWorldMutations";

type ResolvedSavedMeshSelection = {
	selectedMesh: SelectedSavedMesh | null;
	exactMesh: SelectedSavedMesh | null;
	hasDesiredMesh: boolean;
	hasExactDesiredMesh: boolean;
};

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

type DynamicBlockQueryOptions = {
	ignoredDynamicBlockProviders?: ReadonlySet<symbol>;
};

const loadQueue: QueuedChunkRequest[] = [];
const unloadQueueSet: Set<Chunk> = new Set();
const dynamicBlockProviders: Map<symbol, DynamicBlockProviderEntry> = new Map();

const pendingRemeshChunks: Chunk[] = [];
const pendingRemeshChunkIds: Set<bigint> = new Set();

const hydrationScratchSelectedMesh: SelectedSavedMesh = {
	opaque: null,
	transparent: null,
	lod: 0,
};

const hydrationScratchExactMesh: SelectedSavedMesh = {
	opaque: null,
	transparent: null,
	lod: 0,
};

const debug = new ChunkLoadingDebug();

const hydrationAvailableLodsCache = new WeakMap<
	SavedChunkData,
	readonly number[]
>();

const _neighborBuffer: (Chunk | undefined)[] = new Array(6);

const _queuedIdSet: Set<bigint> = new Set();

const _meshData: {
	opaque: MeshData | null;
	transparent: MeshData | null;
} = { opaque: null, transparent: null };

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
	lastLodCacheVersionMismatches: 0,
	totalLodCacheVersionMismatches: 0,
};

const chunkEntityRegistry = new ChunkEntityRegistry<ChunkBoundEntity>({
	getChunkId: (entity) => getEntityChunkId(entity),
	serialize: (entity) => serializeEntityForReload(entity),
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

	getSavedMeshForLod: (savedData, lod) => {
		if (lod === 0) {
			const hasBaseMesh =
				!!savedData.opaqueMesh ||
				!!savedData.transparentMesh ||
				!!savedData.lodMeshes?.[0]?.opaque ||
				!!savedData.lodMeshes?.[0]?.transparent;

			if (!hasBaseMesh) {
				return null;
			}

			if (savedData.opaqueMesh || savedData.transparentMesh) {
				return {
					opaque: savedData.opaqueMesh ?? null,
					transparent: savedData.transparentMesh ?? null,
				};
			}

			const lod0 = savedData.lodMeshes?.[0];
			if (!lod0) {
				return null;
			}

			return {
				opaque: lod0.opaque ?? null,
				transparent: lod0.transparent ?? null,
			};
		}

		const entry = savedData.lodMeshes?.[lod];
		if (!entry) {
			return null;
		}

		return {
			opaque: entry.opaque ?? null,
			transparent: entry.transparent ?? null,
		};
	},

	getAvailableMeshLods: (savedData) => {
		const cached = hydrationAvailableLodsCache.get(savedData);
		if (cached) {
			return cached;
		}

		const lods: number[] = [];

		const hasBaseMesh =
			!!savedData.opaqueMesh ||
			!!savedData.transparentMesh ||
			!!savedData.lodMeshes?.[0]?.opaque ||
			!!savedData.lodMeshes?.[0]?.transparent;

		if (hasBaseMesh) {
			lods.push(0);
		}

		if (savedData.lodMeshes) {
			for (const key of Object.keys(savedData.lodMeshes)) {
				const lod = Number(key);
				if (!Number.isInteger(lod) || lod === 0) continue;

				const entry = savedData.lodMeshes[lod];
				if (entry?.opaque || entry?.transparent) {
					lods.push(lod);
				}
			}
		}

		lods.sort((a, b) => a - b);
		hydrationAvailableLodsCache.set(savedData, lods);
		return lods;
	},

	getSerializedLodCache: (savedData) => savedData.lodMeshes,
});

const streamingController = new ChunkStreamingController({
	getLoadQueue: () => loadQueue,
	getUnloadQueueSet: () => unloadQueueSet,
	onQueueSnapshotChanged: () => refreshQueueDebugSnapshot(),
});

const worldMutations = new ChunkWorldMutations({
	onBoundaryMutation: ({ chunk }) => {
		if (chunk) {
			scheduleChunkAndNeighborsRemesh(chunk);
		}
	},
});

const readiness = new ChunkReadiness({
	isChunkLoaded: (chunk: Chunk) => chunk.isLoaded,
	isChunkLod0Ready: (chunk: Chunk) => {
		if (chunk.lodLevel === undefined || chunk.lodLevel === null) {
			return false;
		}
		return chunk.isLoaded && chunk.hasVoxelData && chunk.lodLevel === 0;
	},
});

const persistenceCoordinator = new ChunkPersistenceCoordinator({
	getModifiedChunks: () => Chunk.chunkInstances.values(),
	getChunkEntityPayloads: () => collectChunkEntityPayloads(),
	getChunkSaveBatchSize: () => getUnloadBatchSize(),
	getChunkEntitySaveBatchSize: () => getUnloadBatchSize(),
});

const processScheduler = new ChunkProcessScheduler({
	getLoadQueue: () => loadQueue,
	getUnloadQueueSet: () => unloadQueueSet,

	getLoadBatchSize: () => getLoadBatchSize(),
	getUnloadBatchSize: () => getUnloadBatchSize(),
	getProcessFrameBudgetMs: () => getProcessFrameBudgetMs(),

	getDesiredState: (chunkId) => streamingController.getDesiredState(chunkId),

	unloadChunkBoundEntitiesForChunk: (chunk) =>
		unloadChunkBoundEntitiesForChunkImpl(chunk),

	applyLoadedChunkFromSavedData: (state, request, savedData) =>
		applyLoadedChunkFromSavedData(state, request, savedData),

	applyHydratedChunkFromSavedData: (chunk, savedData) =>
		applyHydratedChunkFromSavedData(chunk, savedData),

	scheduleTerrainGenerationBatch: (chunks) =>
		ChunkWorkerPool.getInstance().scheduleTerrainGenerationBatch(chunks),

	updateSliceDebugStats: (state) => updateSliceDebugStats(state),

	finalizeProcessState: (state) => finalizeProcessState(state),

	onQueueSnapshotChanged: () => refreshQueueDebugSnapshot(),

	onLoadRequestsDequeued: (requests) =>
		streamingController.onLoadRequestsDequeued(requests),
});

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

	return packCoords(chunkX, chunkY, chunkZ);
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

function getReusableMeshData(
	opaque: MeshData | null,
	transparent: MeshData | null,
): { opaque: MeshData | null; transparent: MeshData | null } {
	const meshData = _meshData;
	meshData.opaque = opaque;
	meshData.transparent = transparent;
	return meshData;
}

function resolveSavedMeshSelection(
	savedData: SavedChunkData,
	targetLod: number,
): ResolvedSavedMeshSelection {
	const hasSelectedMesh = chunkHydration.tryPickBestSavedMesh(
		savedData,
		targetLod,
		hydrationScratchSelectedMesh,
	);

	const hasExactSavedMesh = chunkHydration.tryGetSavedMeshForLod(
		savedData,
		targetLod,
		hydrationScratchExactMesh,
	);

	const selectedMesh = hasSelectedMesh ? hydrationScratchSelectedMesh : null;

	const exactMesh = hasExactSavedMesh ? hydrationScratchExactMesh : null;

	return {
		selectedMesh,
		exactMesh,
		hasDesiredMesh:
			!!selectedMesh && (!!selectedMesh.opaque || !!selectedMesh.transparent),
		hasExactDesiredMesh:
			!!exactMesh && (!!exactMesh.opaque || !!exactMesh.transparent),
	};
}

function applyMeshToChunk(chunk: Chunk, mesh: SelectedSavedMesh | null): void {
	if (!mesh || (!mesh.opaque && !mesh.transparent)) {
		return;
	}

	createMeshFromData(chunk, getReusableMeshData(mesh.opaque, mesh.transparent));
}

function restoreChunkLodCache(chunk: Chunk, savedData: SavedChunkData): void {
	chunk.restoreLODMeshCache(savedData.lodMeshes);

	if (savedData.opaqueMesh || savedData.transparentMesh) {
		chunk.setCachedLODMesh(0, {
			opaque: savedData.opaqueMesh ?? null,
			transparent: savedData.transparentMesh ?? null,
		});
		chunk.isLODMeshCacheDirty = false;
	}
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

	for (
		let y = Math.max(minChunkY, centerChunkY - verticalRadius);
		y <= Math.min(maxChunkY, centerChunkY + verticalRadius);
		y++
	) {
		for (
			let x = centerChunkX - horizontalRadius;
			x <= centerChunkX + horizontalRadius;
			x++
		) {
			for (
				let z = centerChunkZ - horizontalRadius;
				z <= centerChunkZ + horizontalRadius;
				z++
			) {
				const chunk = getChunk(x, y, z);
				const chunkId = packCoords(x, y, z);

				const isLoaded = !!chunk?.isLoaded;
				const isQueued = queuedIds.has(chunkId);
				const isUnloading = !!chunk && unloadQueueSet.has(chunk);
				const hasDesiredState =
					streamingController.getDesiredState(chunkId) !== undefined;

				if (hasDesiredState && !isLoaded && !isQueued && !isUnloading) {
					missing.push({
						chunkX: x,
						chunkY: y,
						chunkZ: z,
						chunkId,
						isLoaded,
						isQueued,
						isUnloading,
						hasDesiredState,
					});
				}
			}
		}
	}

	if (missing.length > 0) {
		console.warn("[ChunkLoadingSystem] Missing desired chunks:", missing);
	}
}

export function enqueueChunkRemesh(chunk: Chunk): void {
	if (pendingRemeshChunkIds.has(chunk.id)) {
		return;
	}

	pendingRemeshChunkIds.add(chunk.id);
	pendingRemeshChunks.push(chunk);
}

let pendingRemeshReadIndex = 0;

export function processPendingRemeshes(maxChunks = 12): void {
	const pool = ChunkWorkerPool.getInstance();
	let processed = 0;

	while (
		processed < maxChunks &&
		pendingRemeshReadIndex < pendingRemeshChunks.length
	) {
		const chunk = pendingRemeshChunks[pendingRemeshReadIndex];

		// If chunk isn't ready for remesh yet, skip it. It will be
		// retried on the next processPendingRemeshes call.
		if (!chunk.isLoaded || !chunk.hasVoxelData) {
			pendingRemeshReadIndex++;
			processed++;
			continue;
		}

		pendingRemeshReadIndex++;
		pendingRemeshChunkIds.delete(chunk.id);
		pool.scheduleRemesh(chunk, true);
		processed++;
	}

	// PERF: Use copyWithin + length truncation instead of slice() to avoid allocating a new array.
	if (
		pendingRemeshReadIndex > 64 &&
		pendingRemeshReadIndex * 2 > pendingRemeshChunks.length
	) {
		pendingRemeshChunks.copyWithin(0, pendingRemeshReadIndex);
		pendingRemeshChunks.length -= pendingRemeshReadIndex;
		pendingRemeshReadIndex = 0;
	}
}

export function processFrameBudgetedStreamingWork(
	playerChunkX: number,
	playerChunkY: number,
	playerChunkZ: number,
): void {
	streamingController.processLoadedRefreshQueue(
		playerChunkX,
		playerChunkY,
		playerChunkZ,
		SETTING_PARAMS.RENDER_DISTANCE,
		SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
		32,
	);

	processPendingRemeshes(32);
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

async function unloadChunkBoundEntitiesForChunkImpl(
	chunk: Chunk,
): Promise<void> {
	await chunkEntityRegistry.unloadEntitiesForChunk(chunk);
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
	debugStats.lastLodCacheVersionMismatches = state.lodCacheVersionMismatchCount;

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
	debugStats.totalLodCacheVersionMismatches +=
		state.lodCacheVersionMismatchCount;
}

function applyHydratedChunkFromSavedData(
	chunk: Chunk,
	savedData: SavedChunkData,
): void {
	const currentLod = chunk.lodLevel ?? 0;

	const { selectedMesh, hasDesiredMesh, hasExactDesiredMesh } =
		resolveSavedMeshSelection(savedData, currentLod);

	chunkHydration.applyHydratedChunkFromSavedData(
		chunk,
		savedData,
		!hasExactDesiredMesh,
	);

	if (hasDesiredMesh) {
		applyMeshToChunk(chunk, selectedMesh);
	}
}

function loadFarLodChunk(
	state: InFlightProcessState,
	chunk: Chunk,
	selectedMesh: SelectedSavedMesh | null,
	hasDesiredMesh: boolean,
): void {
	if (hasDesiredMesh) {
		chunk.loadLodOnlyFromStorage(false);
		applyMeshToChunk(chunk, selectedMesh);
		return;
	}

	chunk.loadLodOnlyFromStorage(false);

	if (!state.chunksNeedingFullHydration.has(chunk.id)) {
		state.chunksNeedingFullHydration.add(chunk.id);
		state.hydrateIds.push(chunk.id);
		state.hydrateChunks.push(chunk);
	}
}

function loadNearLodChunk(
	chunk: Chunk,
	savedData: SavedChunkData,
	selectedMesh: SelectedSavedMesh | null,
	hasDesiredMesh: boolean,
	hasExactDesiredMesh: boolean,
	targetLod: number,
): void {
	chunk.loadFromStorage(
		savedData.blocks,
		savedData.palette,
		savedData.isUniform,
		savedData.uniformBlockId,
		savedData.lightArray,
		!hasExactDesiredMesh,
	);

	if (!hasDesiredMesh) {
		return;
	}

	applyMeshToChunk(chunk, selectedMesh);

	if (targetLod <= 1) {
		scheduleChunkAndNeighborsRemesh(chunk);
	}
}

function applyLoadedChunkFromSavedData(
	state: InFlightProcessState,
	request: QueuedChunkRequest,
	savedData: SavedChunkData,
): void {
	const chunk = request.chunk;
	const targetLod = request.desiredLod;

	if (savedData.lodCacheVersion !== getCurrentLodCacheVersion()) {
		state.lodCacheVersionMismatchCount++;
	}

	state.loadedFromStorageCount++;
	chunk.lodLevel = targetLod;

	restoreChunkLodCache(chunk, savedData);

	const { selectedMesh, hasDesiredMesh, hasExactDesiredMesh } =
		resolveSavedMeshSelection(savedData, targetLod);

	if (targetLod >= 2) {
		loadFarLodChunk(state, chunk, selectedMesh, hasDesiredMesh);
		return;
	}

	loadNearLodChunk(
		chunk,
		savedData,
		selectedMesh,
		hasDesiredMesh,
		hasExactDesiredMesh,
		targetLod,
	);
}

export function deleteBlock(worldX: number, worldY: number, worldZ: number) {
	if (tryMutateDynamicBlock(worldX, worldY, worldZ, 0, 0)) {
		return;
	}

	worldMutations.deleteBlock(worldX, worldY, worldZ);
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
}

function withDynamicBlock<T>(
	worldX: number,
	worldY: number,
	worldZ: number,
	options: DynamicBlockQueryOptions | undefined,
	extract: (sample: DynamicBlockSample) => T,
	fallback: () => T,
): T {
	const sample = sampleDynamicBlock(worldX, worldY, worldZ, options);
	return sample ? extract(sample) : fallback();
}

export function getBlockByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
	options?: DynamicBlockQueryOptions,
): number {
	return withDynamicBlock(
		worldX,
		worldY,
		worldZ,
		options,
		(s) => s.blockId,
		() => worldMutations.getBlockByWorldCoords(worldX, worldY, worldZ),
	);
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
	return withDynamicBlock(
		worldX,
		worldY,
		worldZ,
		options,
		(s) => s.blockState,
		() => getBlockStateFromMutations(worldX, worldY, worldZ),
	);
}

// PERF: Combined lookup avoids calling sampleDynamicBlock + worldMutations twice
// when both blockId and blockState are needed (e.g. voxel collision queries).
export function getBlockAndStateByWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
	options?: DynamicBlockQueryOptions,
): { blockId: number; blockState: number } {
	return withDynamicBlock(
		worldX,
		worldY,
		worldZ,
		options,
		(s) => ({ blockId: s.blockId, blockState: s.blockState }),
		() => ({
			blockId: worldMutations.getBlockByWorldCoords(worldX, worldY, worldZ),
			blockState: getBlockStateFromMutations(worldX, worldY, worldZ),
		}),
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
	const chunk = getChunk(chunkX, chunkY, chunkZ);

	if (!chunk?.isLoaded) {
		return 15 << Chunk.SKY_LIGHT_SHIFT;
	}

	return worldMutations.getLightByWorldCoords(worldX, worldY, worldZ);
}

export function areChunksLoadedAround(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	horizontalRadius = 1,
	verticalRadius = 0,
): boolean {
	return readiness.areChunksLoadedAround(
		chunkX,
		chunkY,
		chunkZ,
		horizontalRadius,
		verticalRadius,
	);
}

export function areChunksLod0ReadyAround(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	horizontalRadius = 1,
	verticalRadius = 0,
): boolean {
	return readiness.areChunksLod0ReadyAround(
		chunkX,
		chunkY,
		chunkZ,
		horizontalRadius,
		verticalRadius,
	);
}

function collectChunkEntityPayloads(): ReadonlyMap<
	bigint,
	SavedChunkEntityData[]
> {
	const entitiesByChunk = new Map<bigint, SavedChunkEntityData[]>();

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

/**
 * Converts world coordinates to chunk coordinates.
 * @param value The world coordinate value (e.g., player's x position).
 * @returns The corresponding chunk coordinate.
 */
export function worldToChunkCoord(value: number): number {
	return Math.floor(value / Chunk.SIZE);
}
/**
 * Converts world coordinates to local block coordinates within a chunk.
 * @param value The world coordinate value.
 * @returns The local block coordinate (0-63).
 */
export function worldToBlockCoord(value: number): number {
	return ((Math.floor(value) % Chunk.SIZE) + Chunk.SIZE) % Chunk.SIZE;
}
