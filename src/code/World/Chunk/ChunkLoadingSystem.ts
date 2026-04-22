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

	private static chunkEntityRegistry =
		new ChunkEntityRegistry<ChunkBoundEntity>({
			getChunkId: (entity) => {
				if (entity.isAlive && !entity.isAlive()) {
					return null;
				}

				const worldPos = entity.getWorldPosition();
				const chunkX = ChunkLoadingSystem.worldToChunkCoord(worldPos.x);
				const chunkY = ChunkLoadingSystem.worldToChunkCoord(worldPos.y);
				const chunkZ = ChunkLoadingSystem.worldToChunkCoord(worldPos.z);
				return Chunk.packCoords(chunkX, chunkY, chunkZ);
			},

			serialize: (entity) => {
				if (entity.isAlive && !entity.isAlive()) {
					return null;
				}
				return entity.serializeForChunkReload?.() ?? null;
			},

			dispose: (entity) => {
				entity.unload();
			},
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

	private static _neighborBuffer: (Chunk | undefined)[] = new Array(6);

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
	private static readonly hydrationAvailableLodsCache = new WeakMap<
		SavedChunkData,
		readonly number[]
	>();
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

				// Prefer explicit base mesh fields first
				if (savedData.opaqueMesh || savedData.transparentMesh) {
					return {
						opaque: savedData.opaqueMesh ?? null,
						transparent: savedData.transparentMesh ?? null,
					};
				}

				// Fallback to lodMeshes[0] if present
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
			// If lodLevel is null/undefined, it's definitely not ready yet
			if (chunk.lodLevel === undefined || chunk.lodLevel === null) return false;
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

	private static getLoadBatchSize(): number {
		const configured = Math.floor(SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT);
		if (configured > 0) {
			return configured;
		}
		return Math.max(1, Math.floor(SETTING_PARAMS.RENDER_DISTANCE * 4));
	}

	private static getUnloadBatchSize(): number {
		const configured = Math.floor(SETTING_PARAMS.CHUNK_UNLOAD_BATCH_LIMIT);
		if (configured > 0) {
			return configured;
		}
		return Math.max(1, Math.floor(SETTING_PARAMS.RENDER_DISTANCE * 4));
	}

	private static getProcessFrameBudgetMs(): number {
		return Math.max(0.5, SETTING_PARAMS.CHUNK_LOADING_FRAME_BUDGET_MS);
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

					// Only consider a chunk 'missing' if the streaming controller
					// actually desires it. This avoids false positives for cells
					// outside the streamer window.
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
		const pool = ChunkWorkerPool.getInstance();

		// Always remesh the chunk that just became ready.
		pool.scheduleRemesh(chunk, true);

		// Only reconcile already-loaded detailed neighbors.
		const neighbors = ChunkLoadingSystem.getNeighbors(chunk);

		for (const neighbor of neighbors) {
			if (!neighbor) continue;
			if (!neighbor.isLoaded) continue;
			if (!neighbor.hasVoxelData) continue;
			if ((neighbor.lodLevel ?? 0) !== 0) continue;
			pool.scheduleRemesh(neighbor, true);
		}
	}

	private static _queuedIdSet: Set<bigint> = new Set();

	private static buildQueuedIdSet(): Set<bigint> {
		const set = ChunkLoadingSystem._queuedIdSet;
		set.clear();

		for (let i = 0; i < ChunkLoadingSystem.loadQueue.length; i++) {
			set.add(ChunkLoadingSystem.loadQueue[i].chunk.id);
		}

		return set;
	}

	public static getDebugStats(): ChunkLoadingDebugStats {
		ChunkLoadingSystem.refreshQueueDebugSnapshot();
		return { ...ChunkLoadingSystem.debugStats };
	}

	private static ensureChunkLoadedHook(): void {
		ChunkLoadingSystem.chunkEntityRegistry.ensureChunkLoadedHook();
	}
	public static enqueueChunkRemesh(chunk: Chunk): void {
		if (ChunkLoadingSystem.pendingRemeshChunkIds.has(chunk.id)) {
			return;
		}

		ChunkLoadingSystem.pendingRemeshChunkIds.add(chunk.id);
		ChunkLoadingSystem.pendingRemeshChunks.push(chunk);
	}

	public static processPendingRemeshes(maxChunks = 4): void {
		const pool = ChunkWorkerPool.getInstance();

		let processed = 0;
		while (
			processed < maxChunks &&
			ChunkLoadingSystem.pendingRemeshChunks.length > 0
		) {
			const chunk = ChunkLoadingSystem.pendingRemeshChunks.shift()!;
			ChunkLoadingSystem.pendingRemeshChunkIds.delete(chunk.id);

			pool.scheduleRemesh(chunk, true);

			processed++;
		}
	}

	public static processFrameBudgetedStreamingWork(
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
	): void {
		// Incrementally refresh a few already-loaded chunks whose LOD may need updating.
		ChunkLoadingSystem.streamingController.processLoadedRefreshQueue(
			playerChunkX,
			playerChunkY,
			playerChunkZ,
			SETTING_PARAMS.RENDER_DISTANCE,
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
			32,
		);

		// Incrementally dispatch remesh work instead of submitting a burst in one frame.
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
		const neighbors = [
			chunk,
			chunk.getNeighbor(-1, 0, 0),
			chunk.getNeighbor(1, 0, 0),
			chunk.getNeighbor(0, -1, 0),
			chunk.getNeighbor(0, 1, 0),
			chunk.getNeighbor(0, 0, -1),
			chunk.getNeighbor(0, 0, 1),
		];

		for (const neighbor of neighbors) {
			pool.scheduleRemesh(neighbor, true);
		}
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
	) {
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

	private static _meshData: {
		opaque: MeshData | null;
		transparent: MeshData | null;
	} = { opaque: null, transparent: null };

	private static getReusableMeshData(
		opaque: MeshData | null,
		transparent: MeshData | null,
	) {
		const m = ChunkLoadingSystem._meshData;
		m.opaque = opaque;
		m.transparent = transparent;
		return m;
	}

	private static applyHydratedChunkFromSavedData(
		chunk: Chunk,
		savedData: SavedChunkData,
	): void {
		const currentLod = chunk.lodLevel ?? 0;

		const hasSelectedMesh =
			ChunkLoadingSystem.chunkHydration.tryPickBestSavedMesh(
				savedData,
				currentLod,
				ChunkLoadingSystem.hydrationScratchSelectedMesh,
			);

		const hasExactSavedMesh =
			ChunkLoadingSystem.chunkHydration.tryGetSavedMeshForLod(
				savedData,
				currentLod,
				ChunkLoadingSystem.hydrationScratchExactMesh,
			);

		const selectedMesh = hasSelectedMesh
			? ChunkLoadingSystem.hydrationScratchSelectedMesh
			: null;

		const exactSavedMesh = hasExactSavedMesh
			? ChunkLoadingSystem.hydrationScratchExactMesh
			: null;

		const hasDesiredMesh =
			!!selectedMesh && (!!selectedMesh.opaque || !!selectedMesh.transparent);

		const hasExactDesiredMesh =
			!!exactSavedMesh &&
			(!!exactSavedMesh.opaque || !!exactSavedMesh.transparent);

		ChunkLoadingSystem.chunkHydration.applyHydratedChunkFromSavedData(
			chunk,
			savedData,
			!hasExactDesiredMesh,
		);

		if (hasDesiredMesh) {
			ChunkMesher.createMeshFromData(
				chunk,
				ChunkLoadingSystem.getReusableMeshData(
					selectedMesh!.opaque,
					selectedMesh!.transparent,
				),
			);
		}
	}
	private static applyLoadedChunkFromSavedData(
		state: InFlightProcessState,
		request: QueuedChunkRequest,
		savedData: SavedChunkData,
	): void {
		const chunk = request.chunk;
		const targetLod = request.desiredLod;

		const expectedLodCacheVersion = getCurrentLodCacheVersion();
		if (savedData.lodCacheVersion !== expectedLodCacheVersion) {
			state.lodCacheVersionMismatchCount++;
		}

		state.loadedFromStorageCount++;

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

		const exactSavedMesh = hasExactSavedMesh
			? ChunkLoadingSystem.hydrationScratchExactMesh
			: null;

		const hasDesiredMesh =
			!!selectedMesh && (!!selectedMesh.opaque || !!selectedMesh.transparent);

		const hasExactDesiredMesh =
			!!exactSavedMesh &&
			(!!exactSavedMesh.opaque || !!exactSavedMesh.transparent);

		chunk.lodLevel = targetLod;

		// Restore serialized LOD cache ONCE here.
		chunk.restoreLODMeshCache(savedData.lodMeshes);

		// Keep explicit LOD0 cached if base meshes exist
		if (savedData.opaqueMesh || savedData.transparentMesh) {
			chunk.setCachedLODMesh(0, {
				opaque: savedData.opaqueMesh ?? null,
				transparent: savedData.transparentMesh ?? null,
			});
			chunk.isLODMeshCacheDirty = false;
		}

		if (targetLod >= 2) {
			if (hasDesiredMesh) {
				chunk.loadLodOnlyFromStorage(false);

				ChunkMesher.createMeshFromData(
					chunk,
					ChunkLoadingSystem.getReusableMeshData(
						selectedMesh!.opaque,
						selectedMesh!.transparent,
					),
				);

				return;
			}

			// No saved mesh, mark chunk as loaded so block mutations don't reject it,
			// then queue for full hydration to get voxel data.
			chunk.loadLodOnlyFromStorage(false);

			if (!state.chunksNeedingFullHydration.has(chunk.id)) {
				state.chunksNeedingFullHydration.add(chunk.id);
				state.hydrateIds.push(chunk.id);
			}

			return;
		}

		// Near LOD path:
		chunk.loadFromStorage(
			savedData.blocks,
			savedData.palette,
			savedData.isUniform,
			savedData.uniformBlockId,
			savedData.lightArray,
			!hasExactDesiredMesh,
		);

		if (hasDesiredMesh) {
			ChunkMesher.createMeshFromData(
				chunk,
				ChunkLoadingSystem.getReusableMeshData(
					selectedMesh!.opaque,
					selectedMesh!.transparent,
				),
			);

			if (targetLod === 0) {
				ChunkLoadingSystem.scheduleChunkBorderRemeshOnLoad(chunk);
			}
		}
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

	private static getRuntimeEntityChunkId(
		entity: ChunkBoundEntity,
	): bigint | null {
		if (entity.isAlive && !entity.isAlive()) {
			return null;
		}

		const worldPos = entity.getWorldPosition();
		const chunkX = ChunkLoadingSystem.worldToChunkCoord(worldPos.x);
		const chunkY = ChunkLoadingSystem.worldToChunkCoord(worldPos.y);
		const chunkZ = ChunkLoadingSystem.worldToChunkCoord(worldPos.z);
		return Chunk.packCoords(chunkX, chunkY, chunkZ);
	}

	private static serializeRuntimeEntity(
		entity: ChunkBoundEntity,
	): SavedChunkEntityData | null {
		if (entity.isAlive && !entity.isAlive()) {
			return null;
		}

		return entity.serializeForChunkReload?.() ?? null;
	}

	private static collectChunkEntityPayloads(): ReadonlyMap<
		bigint,
		SavedChunkEntityData[]
	> {
		const entitiesByChunk = new Map<bigint, SavedChunkEntityData[]>();

		for (const entity of ChunkLoadingSystem.chunkEntityRegistry
			.getRegisteredEntities()
			.values()) {
			const chunkId = ChunkLoadingSystem.getRuntimeEntityChunkId(entity);
			const serialized = ChunkLoadingSystem.serializeRuntimeEntity(entity);

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
