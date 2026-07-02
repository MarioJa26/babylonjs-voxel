import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import { packChunkKey } from "../Storage/ChunkKey";
import { deserializeMeshPair } from "../Storage/MeshSerializer";
import {
	type SavedChunkData,
	type SavedChunkEntityData,
	WorldStorage,
} from "../WorldStorage";
import { Chunk, getChunk } from "./Chunk";
import { createMeshFromData } from "./ChunkMesher";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import { packCoords } from "./DataStructures/ChunkCoords";
import type { MeshData } from "./DataStructures/MeshData";
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

const debug = new ChunkLoadingDebug();

const _neighborBuffer: (Chunk | undefined)[] = new Array(6);

const _queuedIdSet: Set<bigint> = new Set();

const _meshData: {
	opaque: MeshData | null;
	transparent: MeshData | null;
} = { opaque: null, transparent: null };

// OPFS mesh cache: chunkId (bigint) -> deserialized mesh pair from OPFS.
// Populated by prefetchOpfsMeshes (called by ChunkProcessScheduler in parallel
// with IDB voxel loads) and read by applyLoadedChunkFromSavedData. Cleared at
// the start of each process cycle.
const opfsMeshCache = new Map<bigint, SelectedSavedMesh>();
let opfsCacheHydratedThisCycle = 0;
let opfsCacheMissedThisCycle = 0;

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
	lastOpfsHits: 0,
	lastOpfsMisses: 0,
	totalOpfsHits: 0,
	totalOpfsMisses: 0,
	opfsUsedBytes: 0,
	opfsTotalBytes: 0,
	opfsSlotCount: 0,
	opfsEvictionCount: 0,
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

	// Mesh data now lives in OPFS, not IDB. The OPFS cache is consulted
	// directly by applyLoadedChunkFromSavedData (via opfsMeshCache).
	getSavedMeshForLod: () => null,
	getAvailableMeshLods: () => [],
	getSerializedLodCache: () => undefined,
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

Chunk.onBlockModified = (chunk) => {
	void WorldStorage.saveChunk(chunk).catch(() => {});
};

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

	prefetchOpfsMeshes: (requests) => prefetchOpfsMeshes(requests),

	resetOpfsMeshCache: () => resetCycleOpfsCache(),

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

function applyMeshToChunk(chunk: Chunk, mesh: SelectedSavedMesh | null): void {
	if (!mesh || (!mesh.opaque && !mesh.transparent)) {
		return;
	}

	createMeshFromData(chunk, getReusableMeshData(mesh.opaque, mesh.transparent));
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

	refreshOpfsPrefetchSnapshot();
}

export function getDebugStats(): ChunkLoadingDebugStats {
	refreshQueueDebugSnapshot();
	return debugStats;
}

let lastOpfsHitCount = 0;
let lastOpfsMissCount = 0;
let lastOpfsRefreshMs = 0;
const OPFS_REFRESH_INTERVAL_MS = 250;

export async function refreshOpfsDebugStats(): Promise<void> {
	// Throttle: OPFS stats require a worker round-trip.
	const now = performance.now();
	if (now - lastOpfsRefreshMs < OPFS_REFRESH_INTERVAL_MS) return;
	lastOpfsRefreshMs = now;

	const client = ChunkWorkerPool.getInstance().getOpfsClient();
	if (!client) {
		debugStats.opfsTotalBytes = 0;
		debugStats.opfsUsedBytes = 0;
		debugStats.opfsSlotCount = 0;
		debugStats.opfsEvictionCount = 0;
		return;
	}

	try {
		const stats = await client.getStats();
		debugStats.opfsTotalBytes = stats.totalBytes;
		debugStats.opfsUsedBytes = stats.usedBytes;
		debugStats.opfsSlotCount = stats.slotCount;
		debugStats.opfsEvictionCount = stats.evictionCount;

		// Cumulative deltas (worker tracks totals; we accumulate UI-side).
		const newHits = stats.hitCount - lastOpfsHitCount;
		const newMisses = stats.missCount - lastOpfsMissCount;
		if (newHits > 0) debugStats.totalOpfsHits += newHits;
		if (newMisses > 0) debugStats.totalOpfsMisses += newMisses;

		lastOpfsHitCount = stats.hitCount;
		lastOpfsMissCount = stats.missCount;
	} catch {
		// worker may be transiently unavailable; leave previous values
	}
}

function refreshOpfsPrefetchSnapshot(): void {
	// lastOpfsHits / lastOpfsMisses are per-process-cycle values captured
	// in prefetchOpfsMeshes(). Snapshot them here so the HUD sees fresh
	// values on each frame.
	debugStats.lastOpfsHits = opfsCacheHydratedThisCycle;
	debugStats.lastOpfsMisses = opfsCacheMissedThisCycle;
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

export async function flushOpfsStorage(): Promise<void> {
	const client = ChunkWorkerPool.getInstance().getOpfsClient();
	if (!client) return;
	try {
		await client.flush();
	} catch {
		// best-effort; ignore errors
	}
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
	// Mesh lookup is purely OPFS-based (see applyLoadedChunkFromSavedData).
	// Hydration re-runs never re-fetch OPFS; the chunk already has whatever
	// mesh it had after applyLoadedChunkFromSavedData, and the worker pool
	// will overwrite/regenerate as needed.
	chunkHydration.applyHydratedChunkFromSavedData(chunk, savedData, true);
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
		chunk.isTerrainScheduled = true;
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
	targetLod: number,
): void {
	chunk.loadFromStorage(
		savedData.blocks,
		savedData.palette,
		savedData.isUniform,
		savedData.uniformBlockId,
		savedData.lightArray,
		!hasDesiredMesh,
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

	state.loadedFromStorageCount++;
	chunk.lodLevel = targetLod;

	// Mesh comes from OPFS, populated by prefetchOpfsMeshes in parallel with
	// the IDB voxel load. If absent, loadNearLodChunk will fall through to
	// remesh, which writes the freshly generated mesh to OPFS for next time.
	const selectedMesh = opfsMeshCache.get(chunk.id) ?? null;
	const hasDesiredMesh = !!selectedMesh;

	if (targetLod >= 2) {
		loadFarLodChunk(state, chunk, selectedMesh, hasDesiredMesh);
		return;
	}

	loadNearLodChunk(chunk, savedData, selectedMesh, hasDesiredMesh, targetLod);
}

async function prefetchOpfsMeshes(
	requests: QueuedChunkRequest[],
): Promise<void> {
	// Reset cycle counters; cache cleared in resetCycleOpfsCache().
	opfsCacheHydratedThisCycle = 0;
	opfsCacheMissedThisCycle = 0;

	const client = await ChunkWorkerPool.getInstance().ensureOpfsReady();
	if (!client) return;

	const promises: Promise<void>[] = [];
	for (const request of requests) {
		const chunk = request.chunk;
		const lod = request.desiredLod;
		const key = packChunkKey(chunk.chunkX, chunk.chunkY, chunk.chunkZ);
		promises.push(
			client
				.readMesh(key, lod)
				.then((bytes) => {
					if (!bytes) {
						opfsCacheMissedThisCycle++;
						return;
					}
					const mesh = deserializeMeshPair(bytes, lod);
					if (mesh) {
						opfsMeshCache.set(chunk.id, mesh);
						opfsCacheHydratedThisCycle++;
					} else {
						opfsCacheMissedThisCycle++;
					}
				})
				.catch((err: any) => {
					console.warn(
						`[ChunkLoadingSystem] OPFS read failed for chunk ${chunk.id}:`,
						err,
					);
				}),
		);
	}
	await Promise.all(promises);
}

function resetCycleOpfsCache(): void {
	if (opfsMeshCache.size > 0) {
		opfsMeshCache.clear();
	}
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
	out.blockId = worldMutations.getBlockByWorldCoords(worldX, worldY, worldZ);
	out.blockState = getBlockStateFromMutations(worldX, worldY, worldZ);
	return out;
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
