import { SETTING_PARAMS } from "../SETTINGS_PARAMS";
import type { SavedChunkData, SavedChunkEntityData } from "../WorldStorage";
import { ChunkMesher } from "./ChunckMesher";
import { Chunk } from "./Chunk";
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
import { ChunkWorldMutations } from "./Loading/ChunkWorldMutations";

type ResolvedSavedMeshSelection = {
	selectedMesh: SelectedSavedMesh | null;
	exactMesh: SelectedSavedMesh | null;
	hasDesiredMesh: boolean;
	hasExactDesiredMesh: boolean;
};

// biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
export class ChunkLoadingSystem {
	private static loadQueue: QueuedChunkRequest[] = [];
	private static unloadQueueSet: Set<Chunk> = new Set();

	private static pendingRemeshChunks: Chunk[] = [];
	private static pendingRemeshChunkIds: Set<bigint> = new Set();

	private static readonly hydrationScratchSelectedMesh: SelectedSavedMesh = {
		opaque: null,
		transparent: null,
		lod: 0,
	};

	private static readonly hydrationScratchExactMesh: SelectedSavedMesh = {
		opaque: null,
		transparent: null,
		lod: 0,
	};

	private static debug = new ChunkLoadingDebug();

	private static readonly hydrationAvailableLodsCache = new WeakMap<
		SavedChunkData,
		readonly number[]
	>();

	private static _neighborBuffer: (Chunk | undefined)[] = new Array(6);

	private static _queuedIdSet: Set<bigint> = new Set();

	private static _meshData: {
		opaque: MeshData | null;
		transparent: MeshData | null;
	} = { opaque: null, transparent: null };

	private static debugStats: ChunkLoadingDebugStats = {
		loadQueueLength: 0,
		unloadQueueLength: 0,
		loadBatchLimit: Math.max(1, Math.floor(SETTING_PARAMS.RENDER_DISTANCE * 4)),
		unloadBatchLimit: Math.max(
			1,
			Math.floor(SETTING_PARAMS.RENDER_DISTANCE * 4),
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

	private static chunkEntityRegistry =
		new ChunkEntityRegistry<ChunkBoundEntity>({
			getChunkId: (entity) => ChunkLoadingSystem.getEntityChunkId(entity),
			serialize: (entity) =>
				ChunkLoadingSystem.serializeEntityForReload(entity),
			dispose: (entity) => {
				entity.unload();
			},
		});

	private static chunkHydration = new ChunkHydration({
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
			const cached =
				ChunkLoadingSystem.hydrationAvailableLodsCache.get(savedData);
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
			ChunkLoadingSystem.hydrationAvailableLodsCache.set(savedData, lods);
			return lods;
		},

		getSerializedLodCache: (savedData) => savedData.lodMeshes,
	});

	private static streamingController = new ChunkStreamingController({
		getLoadQueue: () => ChunkLoadingSystem.loadQueue,
		getUnloadQueueSet: () => ChunkLoadingSystem.unloadQueueSet,
		onQueueSnapshotChanged: () =>
			ChunkLoadingSystem.refreshQueueDebugSnapshot(),
	});

	private static worldMutations = new ChunkWorldMutations({
		onBoundaryMutation: ({ chunk }) => {
			if (chunk) {
				ChunkLoadingSystem.scheduleChunkAndNeighborsRemesh(chunk);
			}
		},
	});

	private static readiness = new ChunkReadiness({
		isChunkLoaded: (chunk: Chunk) => chunk.isLoaded,
		isChunkLod0Ready: (chunk: Chunk) => {
			if (chunk.lodLevel === undefined || chunk.lodLevel === null) {
				return false;
			}
			return chunk.isLoaded && chunk.hasVoxelData && chunk.lodLevel === 0;
		},
	});

	private static persistenceCoordinator = new ChunkPersistenceCoordinator({
		getModifiedChunks: () => Chunk.chunkInstances.values(),
		getChunkEntityPayloads: () =>
			ChunkLoadingSystem.collectChunkEntityPayloads(),
		getChunkSaveBatchSize: () => ChunkLoadingSystem.getUnloadBatchSize(),
		getChunkEntitySaveBatchSize: () => ChunkLoadingSystem.getUnloadBatchSize(),
	});

	private static processScheduler = new ChunkProcessScheduler({
		getLoadQueue: () => ChunkLoadingSystem.loadQueue,
		getUnloadQueueSet: () => ChunkLoadingSystem.unloadQueueSet,

		getLoadBatchSize: () => ChunkLoadingSystem.getLoadBatchSize(),
		getUnloadBatchSize: () => ChunkLoadingSystem.getUnloadBatchSize(),
		getProcessFrameBudgetMs: () => ChunkLoadingSystem.getProcessFrameBudgetMs(),

		getDesiredState: (chunkId) =>
			ChunkLoadingSystem.streamingController.getDesiredState(chunkId),

		unloadChunkBoundEntitiesForChunk: (chunk) =>
			ChunkLoadingSystem.unloadChunkBoundEntitiesForChunk(chunk),

		applyLoadedChunkFromSavedData: (state, request, savedData) =>
			ChunkLoadingSystem.applyLoadedChunkFromSavedData(
				state,
				request,
				savedData,
			),

		applyHydratedChunkFromSavedData: (chunk, savedData) =>
			ChunkLoadingSystem.applyHydratedChunkFromSavedData(chunk, savedData),

		scheduleTerrainGenerationBatch: (chunks) =>
			ChunkWorkerPool.getInstance().scheduleTerrainGenerationBatch(chunks),

		updateSliceDebugStats: (state) =>
			ChunkLoadingSystem.updateSliceDebugStats(state),

		finalizeProcessState: (state) =>
			ChunkLoadingSystem.finalizeProcessState(state),

		onQueueSnapshotChanged: () =>
			ChunkLoadingSystem.refreshQueueDebugSnapshot(),

		onLoadRequestsDequeued: (requests) =>
			ChunkLoadingSystem.streamingController.onLoadRequestsDequeued(requests),
	});

	private static isEntityAlive(entity: ChunkBoundEntity): boolean {
		return !(entity.isAlive && !entity.isAlive());
	}

	private static getEntityChunkId(entity: ChunkBoundEntity): bigint | null {
		if (!ChunkLoadingSystem.isEntityAlive(entity)) {
			return null;
		}

		const worldPos = entity.getWorldPosition();
		const chunkX = ChunkLoadingSystem.worldToChunkCoord(worldPos.x);
		const chunkY = ChunkLoadingSystem.worldToChunkCoord(worldPos.y);
		const chunkZ = ChunkLoadingSystem.worldToChunkCoord(worldPos.z);

		return Chunk.packCoords(chunkX, chunkY, chunkZ);
	}

	private static serializeEntityForReload(
		entity: ChunkBoundEntity,
	): SavedChunkEntityData | null {
		if (!ChunkLoadingSystem.isEntityAlive(entity)) {
			return null;
		}

		return entity.serializeForChunkReload?.() ?? null;
	}

	private static getConfiguredBatchSize(
		configuredValue: number,
		fallbackValue: number,
	): number {
		const configured = Math.floor(configuredValue);
		return configured > 0 ? configured : Math.max(1, Math.floor(fallbackValue));
	}

	private static getLoadBatchSize(): number {
		return ChunkLoadingSystem.getConfiguredBatchSize(
			SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT,
			SETTING_PARAMS.RENDER_DISTANCE * 4,
		);
	}

	private static getUnloadBatchSize(): number {
		return ChunkLoadingSystem.getConfiguredBatchSize(
			SETTING_PARAMS.CHUNK_UNLOAD_BATCH_LIMIT,
			SETTING_PARAMS.RENDER_DISTANCE * 4,
		);
	}

	private static getProcessFrameBudgetMs(): number {
		return Math.max(0.5, SETTING_PARAMS.CHUNK_LOADING_FRAME_BUDGET_MS);
	}

	private static getNeighbors(chunk: Chunk): (Chunk | undefined)[] {
		const n = ChunkLoadingSystem._neighborBuffer;

		n[0] = chunk.getNeighbor(-1, 0, 0);
		n[1] = chunk.getNeighbor(1, 0, 0);
		n[2] = chunk.getNeighbor(0, -1, 0);
		n[3] = chunk.getNeighbor(0, 1, 0);
		n[4] = chunk.getNeighbor(0, 0, -1);
		n[5] = chunk.getNeighbor(0, 0, 1);

		return n;
	}

	private static scheduleRemeshForChunks(chunks: Chunk[]): void {
		const pool = ChunkWorkerPool.getInstance();

		for (const chunk of chunks) {
			pool.scheduleRemesh(chunk, true);
		}
	}

	private static getReusableMeshData(
		opaque: MeshData | null,
		transparent: MeshData | null,
	): { opaque: MeshData | null; transparent: MeshData | null } {
		const meshData = ChunkLoadingSystem._meshData;
		meshData.opaque = opaque;
		meshData.transparent = transparent;
		return meshData;
	}

	private static resolveSavedMeshSelection(
		savedData: SavedChunkData,
		targetLod: number,
	): ResolvedSavedMeshSelection {
		const hasSelectedMesh =
			ChunkLoadingSystem.chunkHydration.tryPickBestSavedMesh(
				savedData,
				targetLod,
				ChunkLoadingSystem.hydrationScratchSelectedMesh,
			);

		const hasExactSavedMesh =
			ChunkLoadingSystem.chunkHydration.tryGetSavedMeshForLod(
				savedData,
				targetLod,
				ChunkLoadingSystem.hydrationScratchExactMesh,
			);

		const selectedMesh = hasSelectedMesh
			? ChunkLoadingSystem.hydrationScratchSelectedMesh
			: null;

		const exactMesh = hasExactSavedMesh
			? ChunkLoadingSystem.hydrationScratchExactMesh
			: null;

		return {
			selectedMesh,
			exactMesh,
			hasDesiredMesh:
				!!selectedMesh && (!!selectedMesh.opaque || !!selectedMesh.transparent),
			hasExactDesiredMesh:
				!!exactMesh && (!!exactMesh.opaque || !!exactMesh.transparent),
		};
	}

	private static applyMeshToChunk(
		chunk: Chunk,
		mesh: SelectedSavedMesh | null,
	): void {
		if (!mesh || (!mesh.opaque && !mesh.transparent)) {
			return;
		}

		ChunkMesher.createMeshFromData(
			chunk,
			ChunkLoadingSystem.getReusableMeshData(mesh.opaque, mesh.transparent),
		);
	}

	private static restoreChunkLodCache(
		chunk: Chunk,
		savedData: SavedChunkData,
	): void {
		chunk.restoreLODMeshCache(savedData.lodMeshes);

		if (savedData.opaqueMesh || savedData.transparentMesh) {
			chunk.setCachedLODMesh(0, {
				opaque: savedData.opaqueMesh ?? null,
				transparent: savedData.transparentMesh ?? null,
			});
			chunk.isLODMeshCacheDirty = false;
		}
	}

	private static refreshQueueDebugSnapshot(): void {
		ChunkLoadingSystem.debug.refreshQueueSnapshot({
			loadQueueLength: ChunkLoadingSystem.loadQueue.length,
			unloadQueueLength: ChunkLoadingSystem.unloadQueueSet.size,
			pendingChunkEntityReloadCount:
				ChunkLoadingSystem.chunkEntityRegistry.getPendingReloadCount(),
			registeredChunkEntityCount:
				ChunkLoadingSystem.chunkEntityRegistry.getRegisteredEntityCount(),
		});

		ChunkLoadingSystem.debugStats.loadQueueLength =
			ChunkLoadingSystem.loadQueue.length;
		ChunkLoadingSystem.debugStats.unloadQueueLength =
			ChunkLoadingSystem.unloadQueueSet.size;
		ChunkLoadingSystem.debugStats.loadBatchLimit =
			ChunkLoadingSystem.getLoadBatchSize();
		ChunkLoadingSystem.debugStats.unloadBatchLimit =
			ChunkLoadingSystem.getUnloadBatchSize();
		ChunkLoadingSystem.debugStats.frameBudgetMs =
			ChunkLoadingSystem.getProcessFrameBudgetMs();
	}

	public static getDebugStats(): ChunkLoadingDebugStats {
		ChunkLoadingSystem.refreshQueueDebugSnapshot();
		return { ...ChunkLoadingSystem.debugStats };
	}

	private static buildQueuedIdSet(): Set<bigint> {
		const set = ChunkLoadingSystem._queuedIdSet;
		set.clear();

		for (let i = 0; i < ChunkLoadingSystem.loadQueue.length; i++) {
			set.add(ChunkLoadingSystem.loadQueue[i].chunk.id);
		}

		return set;
	}

	private static ensureChunkLoadedHook(): void {
		ChunkLoadingSystem.chunkEntityRegistry.ensureChunkLoadedHook();
	}

	public static validateChunksAround(
		centerChunkX: number,
		centerChunkY: number,
		centerChunkZ: number,
		horizontalRadius = SETTING_PARAMS.RENDER_DISTANCE,
		verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
	): void {
		const queuedIds = ChunkLoadingSystem.buildQueuedIdSet();
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

		const minChunkY = 0;
		const maxChunkY = SETTING_PARAMS.MAX_CHUNK_HEIGHT - 1;

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
					const chunk = Chunk.getChunk(x, y, z);
					const chunkId = Chunk.packCoords(x, y, z);

					const isLoaded = !!chunk?.isLoaded;
					const isQueued = queuedIds.has(chunkId);
					const isUnloading =
						!!chunk && ChunkLoadingSystem.unloadQueueSet.has(chunk);
					const hasDesiredState =
						ChunkLoadingSystem.streamingController.getDesiredState(chunkId) !==
						undefined;

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

	private static scheduleChunkBorderRemeshOnLoad(chunk: Chunk): void {
		const readyNeighbors = ChunkLoadingSystem.getNeighbors(chunk).filter(
			(neighbor): neighbor is Chunk =>
				!!neighbor &&
				neighbor.isLoaded &&
				neighbor.hasVoxelData &&
				(neighbor.lodLevel ?? 0) === 0,
		);

		ChunkLoadingSystem.scheduleRemeshForChunks([chunk, ...readyNeighbors]);
	}

	public static enqueueChunkRemesh(chunk: Chunk): void {
		if (ChunkLoadingSystem.pendingRemeshChunkIds.has(chunk.id)) {
			return;
		}

		ChunkLoadingSystem.pendingRemeshChunkIds.add(chunk.id);
		ChunkLoadingSystem.pendingRemeshChunks.push(chunk);
	}

	private static pendingRemeshReadIndex = 0;

	public static processPendingRemeshes(maxChunks = 12): void {
		const pool = ChunkWorkerPool.getInstance();
		let processed = 0;

		while (
			processed < maxChunks &&
			ChunkLoadingSystem.pendingRemeshReadIndex <
				ChunkLoadingSystem.pendingRemeshChunks.length
		) {
			const chunk =
				ChunkLoadingSystem.pendingRemeshChunks[
					ChunkLoadingSystem.pendingRemeshReadIndex++
				];

			ChunkLoadingSystem.pendingRemeshChunkIds.delete(chunk.id);
			pool.scheduleRemesh(chunk, true);
			processed++;
		}

		// compact occasionally
		if (
			ChunkLoadingSystem.pendingRemeshReadIndex > 64 &&
			ChunkLoadingSystem.pendingRemeshReadIndex * 2 >
				ChunkLoadingSystem.pendingRemeshChunks.length
		) {
			ChunkLoadingSystem.pendingRemeshChunks =
				ChunkLoadingSystem.pendingRemeshChunks.slice(
					ChunkLoadingSystem.pendingRemeshReadIndex,
				);
			ChunkLoadingSystem.pendingRemeshReadIndex = 0;
		}
	}

	public static processFrameBudgetedStreamingWork(
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
	): void {
		ChunkLoadingSystem.streamingController.processLoadedRefreshQueue(
			playerChunkX,
			playerChunkY,
			playerChunkZ,
			SETTING_PARAMS.RENDER_DISTANCE,
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
			32,
		);

		ChunkLoadingSystem.processPendingRemeshes(12);
	}

	public static registerChunkEntityLoader(
		type: string,
		loader: (payload: unknown, chunk: Chunk) => void,
	): void {
		ChunkLoadingSystem.ensureChunkLoadedHook();
		ChunkLoadingSystem.chunkEntityRegistry.registerLoader(type, loader);

		for (const chunk of Chunk.chunkInstances.values()) {
			if (chunk.isLoaded) {
				void ChunkLoadingSystem.chunkEntityRegistry.restoreEntitiesForChunk(
					chunk,
				);
			}
		}
	}

	public static registerChunkBoundEntity(entity: ChunkBoundEntity): symbol {
		ChunkLoadingSystem.ensureChunkLoadedHook();
		return ChunkLoadingSystem.chunkEntityRegistry.registerEntity(entity);
	}

	public static unregisterChunkBoundEntity(handle: symbol | undefined): void {
		ChunkLoadingSystem.chunkEntityRegistry.unregisterEntity(handle);
	}

	private static async unloadChunkBoundEntitiesForChunk(
		chunk: Chunk,
	): Promise<void> {
		await ChunkLoadingSystem.chunkEntityRegistry.unloadEntitiesForChunk(chunk);
	}

	public static flushModifiedChunks(
		maxChunks = ChunkLoadingSystem.getUnloadBatchSize(),
	): Promise<void> {
		return ChunkLoadingSystem.persistenceCoordinator.flushModifiedChunks(
			maxChunks,
		);
	}

	public static flushChunkBoundEntities(): Promise<void> {
		return ChunkLoadingSystem.persistenceCoordinator.flushChunkBoundEntities(
			ChunkLoadingSystem.getUnloadBatchSize(),
		);
	}

	private static scheduleChunkAndNeighborsRemesh(chunk: Chunk): void {
		const pool = ChunkWorkerPool.getInstance();

		pool.scheduleRemesh(chunk, true);

		const n = ChunkLoadingSystem._neighborBuffer;

		if (n[0]) pool.scheduleRemesh(n[0], true);
		if (n[1]) pool.scheduleRemesh(n[1], true);
		if (n[2]) pool.scheduleRemesh(n[2], true);
		if (n[3]) pool.scheduleRemesh(n[3], true);
		if (n[4]) pool.scheduleRemesh(n[4], true);
		if (n[5]) pool.scheduleRemesh(n[5], true);
	}

	public static async updateChunksAround(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		renderDistance = SETTING_PARAMS.RENDER_DISTANCE,
		verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
		prevChunkX?: number,
		prevChunkY?: number,
		prevChunkZ?: number,
	): Promise<void> {
		ChunkLoadingSystem.ensureChunkLoadedHook();

		await ChunkLoadingSystem.streamingController.updateChunksAround(
			chunkX,
			chunkY,
			chunkZ,
			renderDistance,
			verticalRadius,
			prevChunkX,
			prevChunkY,
			prevChunkZ,
		);

		if (!ChunkLoadingSystem.processScheduler.processing) {
			void ChunkLoadingSystem.processScheduler.processQueues();
		}
	}

	private static updateSliceDebugStats(state: InFlightProcessState): void {
		ChunkLoadingSystem.debugStats.lastProcessMs =
			performance.now() - state.sliceStartMs;
		ChunkLoadingSystem.debugStats.lastLoadedFromStorage =
			state.loadedFromStorageCount;
		ChunkLoadingSystem.debugStats.lastGenerated = state.generatedCount;
		ChunkLoadingSystem.debugStats.lastHydrated = state.hydratedCount;
		ChunkLoadingSystem.debugStats.lastUnloaded = state.unloadedCount;
		ChunkLoadingSystem.debugStats.lastSaved = state.savedCount;
		ChunkLoadingSystem.debugStats.lastLodCacheVersionMismatches =
			state.lodCacheVersionMismatchCount;

		ChunkLoadingSystem.refreshQueueDebugSnapshot();
	}

	private static finalizeProcessState(state: InFlightProcessState): void {
		ChunkLoadingSystem.updateSliceDebugStats(state);

		ChunkLoadingSystem.debugStats.totalProcessLoops += 1;
		ChunkLoadingSystem.debugStats.totalLoadedFromStorage +=
			state.loadedFromStorageCount;
		ChunkLoadingSystem.debugStats.totalGenerated += state.generatedCount;
		ChunkLoadingSystem.debugStats.totalHydrated += state.hydratedCount;
		ChunkLoadingSystem.debugStats.totalUnloaded += state.unloadedCount;
		ChunkLoadingSystem.debugStats.totalSaved += state.savedCount;
		ChunkLoadingSystem.debugStats.totalLodCacheVersionMismatches +=
			state.lodCacheVersionMismatchCount;
	}

	private static applyHydratedChunkFromSavedData(
		chunk: Chunk,
		savedData: SavedChunkData,
	): void {
		const currentLod = chunk.lodLevel ?? 0;

		const { selectedMesh, hasDesiredMesh, hasExactDesiredMesh } =
			ChunkLoadingSystem.resolveSavedMeshSelection(savedData, currentLod);

		ChunkLoadingSystem.chunkHydration.applyHydratedChunkFromSavedData(
			chunk,
			savedData,
			!hasExactDesiredMesh,
		);

		if (hasDesiredMesh) {
			ChunkLoadingSystem.applyMeshToChunk(chunk, selectedMesh);
		}
	}

	private static loadFarLodChunk(
		state: InFlightProcessState,
		chunk: Chunk,
		selectedMesh: SelectedSavedMesh | null,
		hasDesiredMesh: boolean,
	): void {
		if (hasDesiredMesh) {
			chunk.loadLodOnlyFromStorage(false);
			ChunkLoadingSystem.applyMeshToChunk(chunk, selectedMesh);
			return;
		}

		chunk.loadLodOnlyFromStorage(false);

		if (!state.chunksNeedingFullHydration.has(chunk.id)) {
			state.chunksNeedingFullHydration.add(chunk.id);
			state.hydrateIds.push(chunk.id);
		}
	}

	private static loadNearLodChunk(
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

		ChunkLoadingSystem.applyMeshToChunk(chunk, selectedMesh);

		if (targetLod === 0) {
			ChunkLoadingSystem.scheduleChunkBorderRemeshOnLoad(chunk);
		}
	}

	private static applyLoadedChunkFromSavedData(
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

		ChunkLoadingSystem.restoreChunkLodCache(chunk, savedData);

		const { selectedMesh, hasDesiredMesh, hasExactDesiredMesh } =
			ChunkLoadingSystem.resolveSavedMeshSelection(savedData, targetLod);

		if (targetLod >= 2) {
			ChunkLoadingSystem.loadFarLodChunk(
				state,
				chunk,
				selectedMesh,
				hasDesiredMesh,
			);
			return;
		}

		ChunkLoadingSystem.loadNearLodChunk(
			chunk,
			savedData,
			selectedMesh,
			hasDesiredMesh,
			hasExactDesiredMesh,
			targetLod,
		);
	}

	public static deleteBlock(worldX: number, worldY: number, worldZ: number) {
		ChunkLoadingSystem.worldMutations.deleteBlock(worldX, worldY, worldZ);
	}

	public static setBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
		state = 0,
	) {
		ChunkLoadingSystem.worldMutations.setBlock(
			worldX,
			worldY,
			worldZ,
			blockId,
			state,
		);
	}

	public static getBlockByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		return ChunkLoadingSystem.worldMutations.getBlockByWorldCoords(
			worldX,
			worldY,
			worldZ,
		);
	}

	public static getBlockStateByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		return ChunkLoadingSystem.worldMutations.getBlockStateByWorldCoords(
			worldX,
			worldY,
			worldZ,
		);
	}

	public static getLightByWorldCoords(
		worldX: number,
		worldY: number,
		worldZ: number,
	): number {
		const chunkX = ChunkLoadingSystem.worldToChunkCoord(worldX);
		const chunkY = ChunkLoadingSystem.worldToChunkCoord(worldY);
		const chunkZ = ChunkLoadingSystem.worldToChunkCoord(worldZ);
		const chunk = Chunk.getChunk(chunkX, chunkY, chunkZ);

		if (!chunk?.isLoaded) {
			return 15 << Chunk.SKY_LIGHT_SHIFT;
		}

		return ChunkLoadingSystem.worldMutations.getLightByWorldCoords(
			worldX,
			worldY,
			worldZ,
		);
	}

	/**
	 * Converts world coordinates to chunk coordinates.
	 * @param value The world coordinate value (e.g., player's x position).
	 * @returns The corresponding chunk coordinate.
	 */
	public static worldToChunkCoord(value: number): number {
		return Math.floor(value / Chunk.SIZE);
	}

	/**
	 * Converts world coordinates to local block coordinates within a chunk.
	 * @param value The world coordinate value.
	 * @returns The local block coordinate (0-63).
	 */
	public static worldToBlockCoord(value: number): number {
		return ((Math.floor(value) % Chunk.SIZE) + Chunk.SIZE) % Chunk.SIZE;
	}

	public static areChunksLoadedAround(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		horizontalRadius = 1,
		verticalRadius = 0,
	): boolean {
		return ChunkLoadingSystem.readiness.areChunksLoadedAround(
			chunkX,
			chunkY,
			chunkZ,
			horizontalRadius,
			verticalRadius,
		);
	}

	public static areChunksLod0ReadyAround(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		horizontalRadius = 1,
		verticalRadius = 0,
	): boolean {
		return ChunkLoadingSystem.readiness.areChunksLod0ReadyAround(
			chunkX,
			chunkY,
			chunkZ,
			horizontalRadius,
			verticalRadius,
		);
	}

	private static collectChunkEntityPayloads(): ReadonlyMap<
		bigint,
		SavedChunkEntityData[]
	> {
		const entitiesByChunk = new Map<bigint, SavedChunkEntityData[]>();

		for (const entity of ChunkLoadingSystem.chunkEntityRegistry
			.getRegisteredEntities()
			.values()) {
			const chunkId = ChunkLoadingSystem.getEntityChunkId(entity);
			const serialized = ChunkLoadingSystem.serializeEntityForReload(entity);

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
}
