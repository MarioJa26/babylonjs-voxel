import { DistantTerrain } from "@/code/Generation/DistantTerrain/DistantTerrain";
import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import { createMeshFromData } from "../ChunckMesher";
import { Chunk } from "../Chunk";
import { ChunkLoadingSystem } from "../ChunkLoadingSystem";
import { ChunkWorkerPool } from "../ChunkWorkerPool";
import { ChunkLodRuleSet } from "../LOD/ChunkLodRules";

export type QueuedChunkRequest = {
	chunk: Chunk;
	desiredLod: number;
	revision: number;
	includeVoxelData: boolean;
	priority: number;
};

type DesiredChunkState = {
	desiredLod: number;
	revision: number;
};

export interface ChunkStreamingControllerAdapter {
	getLoadQueue(): QueuedChunkRequest[];
	getUnloadQueueSet(): Set<Chunk>;
	onQueueSnapshotChanged?(): void;
}

export class ChunkStreamingController {
	private distantTerrain: DistantTerrain | null = null;
	private static readonly DESIRED_STATE_REVISION_RETENTION = 8;
	private streamRevision = 0;
	private desiredStates = new Map<bigint, DesiredChunkState>();
	// Map from chunkId -> queued request object for O(1) updates without relying
	// on unstable queue indices (the scheduler dequeues from the head).
	private loadQueueRequestMap: Map<bigint, QueuedChunkRequest> = new Map();
	private loadedRefreshQueue: Chunk[] = [];
	private loadedRefreshQueueSet: Set<bigint> = new Set();
	private loadedRefreshQueueHead = 0;

	public constructor(
		private readonly adapter: ChunkStreamingControllerAdapter,
	) {}

	public getDesiredState(chunkId: bigint): DesiredChunkState | undefined {
		return this.desiredStates.get(chunkId);
	}

	public async updateChunksAround(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		renderDistance = SETTING_PARAMS.RENDER_DISTANCE,
		verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
		prevChunkX?: number,
		prevChunkY?: number,
		prevChunkZ?: number,
	): Promise<void> {
		this.streamRevision++;

		if (!this.distantTerrain) {
			this.distantTerrain = new DistantTerrain();
		}

		this.distantTerrain.update(chunkX, chunkZ);

		const lodRuleSet = ChunkLodRuleSet.fromRenderRadii(
			renderDistance,
			verticalRadius,
		);
		const { lod3HorizontalRadius, lod3VerticalRadius } = lodRuleSet.radii;

		const loadQueue = this.adapter.getLoadQueue();
		const unloadQueueSet = this.adapter.getUnloadQueueSet();
		this.loadQueueRequestMap.clear();

		// Retag queued requests in place.
		let writeIndex = 0;

		for (let readIndex = 0; readIndex < loadQueue.length; readIndex++) {
			const request = loadQueue[readIndex];

			const decision = lodRuleSet.resolveWithHysteresis(
				{
					chunkX: request.chunk.chunkX,
					chunkY: request.chunk.chunkY,
					chunkZ: request.chunk.chunkZ,
				},
				{ chunkX, chunkY, chunkZ },
				request.chunk.lodLevel ?? request.desiredLod,
			);

			if (!decision.allowsChunkCreation) {
				request.chunk.isTerrainScheduled = false;
				this.loadQueueRequestMap.delete(request.chunk.id);
				continue;
			}

			request.desiredLod = decision.lodLevel;
			request.revision = this.streamRevision;
			request.includeVoxelData = request.desiredLod <= 1;
			request.priority = this.computePriority(
				request.chunk,
				request.desiredLod,
				chunkX,
				chunkY,
				chunkZ,
			);

			this.desiredStates.set(request.chunk.id, {
				desiredLod: request.desiredLod,
				revision: request.revision,
			});

			this.loadQueueRequestMap.set(request.chunk.id, request);
			loadQueue[writeIndex++] = request;
		}

		loadQueue.length = writeIndex;

		// Cancel pending unloads for chunks that are back in range.
		for (const chunk of unloadQueueSet) {
			const horizontalDist = Math.max(
				Math.abs(chunk.chunkX - chunkX),
				Math.abs(chunk.chunkZ - chunkZ),
			);
			const verticalDist = Math.abs(chunk.chunkY - chunkY);

			if (
				horizontalDist <= lod3HorizontalRadius &&
				verticalDist <= lod3VerticalRadius
			) {
				unloadQueueSet.delete(chunk);
			}
		}

		const canUseDelta =
			typeof prevChunkX === "number" &&
			typeof prevChunkY === "number" &&
			typeof prevChunkZ === "number" &&
			Math.abs(chunkX - prevChunkX) <= 1 &&
			Math.abs(chunkY - prevChunkY) <= 1 &&
			Math.abs(chunkZ - prevChunkZ) <= 1;

		if (canUseDelta) {
			this.processMovementRings(
				chunkX,
				chunkY,
				chunkZ,
				prevChunkX!,
				prevChunkY!,
				prevChunkZ!,
				lodRuleSet,
			);
		} else {
			this.processInitialShell(chunkX, chunkY, chunkZ, lodRuleSet);
		}

		// Enqueue loaded chunks near LOD boundaries for re-evaluation.
		// This is what drives LOD transitions as the player moves closer/further.
		this.enqueueLoadedChunksForRefresh(chunkX, chunkY, chunkZ, lodRuleSet);

		this.sortLoadQueue(chunkX, chunkY, chunkZ);

		this.queueUnloading(
			chunkX,
			chunkY,
			chunkZ,
			lod3HorizontalRadius,
			lod3VerticalRadius,
		);

		ChunkWorkerPool.getInstance().scheduleBackgroundLodPrecompute(
			chunkX,
			chunkY,
			chunkZ,
		);

		const oldestKeptRevision = Math.max(
			0,
			this.streamRevision -
				ChunkStreamingController.DESIRED_STATE_REVISION_RETENTION,
		);

		for (const [id, state] of this.desiredStates) {
			if (state.revision < oldestKeptRevision) {
				this.desiredStates.delete(id);
			}
		}

		this.adapter.onQueueSnapshotChanged?.();
	}
	private enqueueLoadedChunksForRefresh(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const {
			lod0HorizontalRadius,
			lod0VerticalRadius,
			lod1HorizontalRadius,
			lod1VerticalRadius,
			lod2HorizontalRadius,
			lod2VerticalRadius,
		} = lodRuleSet.radii;

		for (const chunk of Chunk.chunkInstances.values()) {
			if (!chunk.isLoaded) continue;
			if (this.loadedRefreshQueueSet.has(chunk.id)) continue;

			const hdist = Math.max(
				Math.abs(chunk.chunkX - chunkX),
				Math.abs(chunk.chunkZ - chunkZ),
			);
			const vdist = Math.abs(chunk.chunkY - chunkY);

			// Only enqueue chunks that sit near a LOD transition boundary
			// (+/- 2 chunks of each boundary). Skip chunks deep in LOD0 or
			// far out in LOD3 — they don't need re-evaluation.
			const nearLod0 =
				hdist <= lod0HorizontalRadius + 2 && vdist <= lod0VerticalRadius + 2;
			const nearLod1 =
				hdist <= lod1HorizontalRadius + 2 && vdist <= lod1VerticalRadius + 2;
			const nearLod2 =
				hdist <= lod2HorizontalRadius + 2 && vdist <= lod2VerticalRadius + 2;

			if (!nearLod0 && !nearLod1 && !nearLod2) continue;

			// Skip chunks already at the correct LOD with no pending work
			const decision = lodRuleSet.resolveWithHysteresis(
				{ chunkX: chunk.chunkX, chunkY: chunk.chunkY, chunkZ: chunk.chunkZ },
				{ chunkX, chunkY, chunkZ },
				chunk.lodLevel ?? 3,
			);

			if (
				chunk.lodLevel === decision.lodLevel &&
				!chunk.isDirty &&
				!(decision.lodLevel <= 1 && !chunk.hasVoxelData)
			) {
				continue;
			}

			this.loadedRefreshQueueSet.add(chunk.id);
			this.loadedRefreshQueue.push(chunk);
		}
	}
	public processLoadedRefreshQueue(
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
		renderDistance = SETTING_PARAMS.RENDER_DISTANCE,
		verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
		maxChunks = 8,
	): void {
		if (this.loadedRefreshQueueHead >= this.loadedRefreshQueue.length) {
			return;
		}

		const lodRuleSet = ChunkLodRuleSet.fromRenderRadii(
			renderDistance,
			verticalRadius,
		);

		let processed = 0;

		while (processed < maxChunks) {
			const chunk = this.dequeueLoadedRefreshChunk();
			if (!chunk) break;

			this.loadedRefreshQueueSet.delete(chunk.id);

			this.processTargetChunkCoordinate(
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ,
				playerChunkX,
				playerChunkY,
				playerChunkZ,
				lodRuleSet,
			);

			processed++;
		}
	}

	private dequeueLoadedRefreshChunk(): Chunk | undefined {
		if (this.loadedRefreshQueueHead >= this.loadedRefreshQueue.length) {
			return undefined;
		}

		const chunk = this.loadedRefreshQueue[this.loadedRefreshQueueHead++];

		if (
			this.loadedRefreshQueueHead > 1024 &&
			this.loadedRefreshQueueHead * 2 >= this.loadedRefreshQueue.length
		) {
			this.loadedRefreshQueue = this.loadedRefreshQueue.slice(
				this.loadedRefreshQueueHead,
			);
			this.loadedRefreshQueueHead = 0;
		}

		return chunk;
	}

	public processTargetChunkCoordinate(
		x: number,
		y: number,
		z: number,
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		let chunk = Chunk.getChunk(x, y, z);

		const previousLod = chunk?.lodLevel ?? 3;
		const decision = lodRuleSet.resolveWithHysteresis(
			{ chunkX: x, chunkY: y, chunkZ: z },
			{ chunkX: playerChunkX, chunkY: playerChunkY, chunkZ: playerChunkZ },
			previousLod,
		);

		if (!decision.allowsChunkCreation) return;

		if (!chunk) {
			chunk = new Chunk(x, y, z);
		}

		const desiredLod = decision.lodLevel;
		const revision = this.streamRevision;

		if (chunk.isLoaded && previousLod === desiredLod) {
			if (desiredLod <= 1 && !chunk.hasVoxelData) {
				this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);
				this.tryApplyCachedLodTransitionMesh(chunk, desiredLod);
			}
			return;
		}

		const includeVoxelData = desiredLod <= 1;

		this.desiredStates.set(chunk.id, {
			desiredLod,
			revision,
		});

		chunk.lodLevel = desiredLod;

		if (chunk.isLoaded && previousLod !== desiredLod) {
			if (!chunk.hasVoxelData) {
				const hasTargetCachedMesh = chunk.hasCachedLODMesh(desiredLod);

				if (desiredLod <= 1) {
					this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);
					if (!hasTargetCachedMesh) {
						return;
					}
				}

				if (desiredLod >= 2 && !hasTargetCachedMesh) {
					return;
				}
			}

			if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
				return;
			}

			const requiresImmediateRemesh = previousLod <= 1 || desiredLod <= 1;
			if (requiresImmediateRemesh) {
				ChunkLoadingSystem.enqueueChunkRemesh(chunk);
			}

			return;
		}

		if (!chunk.isLoaded) {
			this.ensureChunkQueuedForLoad(
				chunk,
				desiredLod,
				revision,
				includeVoxelData,
			);
		}
	}

	private processMovementRings(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		prevChunkX: number,
		prevChunkY: number,
		prevChunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const dx = chunkX - prevChunkX;
		const dy = chunkY - prevChunkY;
		const dz = chunkZ - prevChunkZ;

		const { lod3HorizontalRadius: r, lod3VerticalRadius: ry } =
			lodRuleSet.radii;

		// 👉 X movement
		if (dx !== 0) {
			const x = dx > 0 ? chunkX + r : chunkX - r;

			for (let y = chunkY - ry; y <= chunkY + ry; y++) {
				if (y < 0 || y >= SETTING_PARAMS.MAX_CHUNK_HEIGHT) continue;

				for (let z = chunkZ - r; z <= chunkZ + r; z++) {
					const chunk = Chunk.getChunk(x, y, z);

					if (chunk?.isLoaded) {
						if (!this.loadedRefreshQueueSet.has(chunk.id)) {
							this.loadedRefreshQueueSet.add(chunk.id);
							this.loadedRefreshQueue.push(chunk);
						}
						continue;
					}
					this.processTargetChunkCoordinate(
						x,
						y,
						z,
						chunkX,
						chunkY,
						chunkZ,
						lodRuleSet,
					);
				}
			}
		}

		// 👉 Z movement
		if (dz !== 0) {
			const z = dz > 0 ? chunkZ + r : chunkZ - r;

			for (let y = chunkY - ry; y <= chunkY + ry; y++) {
				if (y < 0 || y >= SETTING_PARAMS.MAX_CHUNK_HEIGHT) continue;

				for (let x = chunkX - r; x <= chunkX + r; x++) {
					// overlap skip (already handled by X)
					if (dx !== 0) {
						const skipX = dx > 0 ? chunkX + r : chunkX - r;
						if (x === skipX) continue;
					}
					const chunk = Chunk.getChunk(x, y, z);

					if (chunk?.isLoaded) {
						if (!this.loadedRefreshQueueSet.has(chunk.id)) {
							this.loadedRefreshQueueSet.add(chunk.id);
							this.loadedRefreshQueue.push(chunk);
						}
						continue;
					}
					this.processTargetChunkCoordinate(
						x,
						y,
						z,
						chunkX,
						chunkY,
						chunkZ,
						lodRuleSet,
					);
				}
			}
		}

		// 👉 Y movement
		if (dy !== 0) {
			const y = dy > 0 ? chunkY + ry : chunkY - ry;

			if (y >= 0 && y < SETTING_PARAMS.MAX_CHUNK_HEIGHT) {
				for (let x = chunkX - r; x <= chunkX + r; x++) {
					for (let z = chunkZ - r; z <= chunkZ + r; z++) {
						if (dx !== 0) {
							const skipX = dx > 0 ? chunkX + r : chunkX - r;
							if (x === skipX) continue;
						}

						if (dz !== 0) {
							const skipZ = dz > 0 ? chunkZ + r : chunkZ - r;
							if (z === skipZ) continue;
						}
						const chunk = Chunk.getChunk(x, y, z);

						if (chunk?.isLoaded) {
							if (!this.loadedRefreshQueueSet.has(chunk.id)) {
								this.loadedRefreshQueueSet.add(chunk.id);
								this.loadedRefreshQueue.push(chunk);
							}
							continue;
						}
						this.processTargetChunkCoordinate(
							x,
							y,
							z,
							chunkX,
							chunkY,
							chunkZ,
							lodRuleSet,
						);
					}
				}
			}
		}
	}
	private processInitialShell(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const { lod3HorizontalRadius: r, lod3VerticalRadius: ry } =
			lodRuleSet.radii;

		for (let x = -r; x <= r; x++) {
			for (let y = -ry; y <= ry; y++) {
				const worldY = chunkY + y;
				if (worldY < 0 || worldY >= SETTING_PARAMS.MAX_CHUNK_HEIGHT) continue;

				for (let z = -r; z <= r; z++) {
					const existing = Chunk.getChunk(chunkX + x, worldY, chunkZ + z);

					// Skip if already loaded at the correct LOD with voxel data if needed
					if (existing?.isLoaded) {
						const decision = lodRuleSet.resolveWithHysteresis(
							{ chunkX: chunkX + x, chunkY: worldY, chunkZ: chunkZ + z },
							{ chunkX, chunkY, chunkZ },
							existing.lodLevel ?? 3,
						);
						const needsVoxelData =
							decision.lodLevel <= 1 && !existing.hasVoxelData;
						if (
							!existing.isDirty &&
							existing.lodLevel === decision.lodLevel &&
							!needsVoxelData
						) {
							continue; // nothing to do
						}
					}

					this.processTargetChunkCoordinate(
						chunkX + x,
						worldY,
						chunkZ + z,
						chunkX,
						chunkY,
						chunkZ,
						lodRuleSet,
					);
				}
			}
		}
	}

	public queueUnloading(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		renderDistance: number,
		verticalRadius: number,
	): void {
		const unloadQueueSet = this.adapter.getUnloadQueueSet();

		const removeRadius =
			renderDistance + SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER;
		const verticalRemoveRadius =
			verticalRadius + SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER;

		for (const chunk of Chunk.chunkInstances.values()) {
			if (!chunk.isLoaded || chunk.isPersistent) continue;
			if (unloadQueueSet.has(chunk)) continue;

			const dx = chunk.chunkX - chunkX;
			const dy = chunk.chunkY - chunkY;
			const dz = chunk.chunkZ - chunkZ;

			if (
				dx > removeRadius ||
				dx < -removeRadius ||
				dz > removeRadius ||
				dz < -removeRadius ||
				dy > verticalRemoveRadius ||
				dy < -verticalRemoveRadius
			) {
				unloadQueueSet.add(chunk);
			}
		}
	}

	public tryApplyCachedLodTransitionMesh(
		chunk: Chunk,
		targetLod: number,
	): boolean {
		if (chunk.isDirty) {
			return false;
		}

		const cached = chunk.getCachedLODMesh(targetLod);
		if (!cached) {
			return false;
		}

		if (!cached.opaque && !cached.transparent) {
			return false;
		}

		createMeshFromData(chunk, {
			opaque: cached.opaque ?? null,
			transparent: cached.transparent ?? null,
		});
		chunk.isDirty = false;

		return true;
	}

	public ensureChunkQueuedForLoad(
		chunk: Chunk,
		desiredLod: number,
		revision: number,
		includeVoxelData = desiredLod <= 1,
	): void {
		if (chunk.isLoaded && (!includeVoxelData || chunk.hasVoxelData)) {
			return;
		}

		const loadQueue = this.adapter.getLoadQueue();
		const existingRequest = this.loadQueueRequestMap.get(chunk.id);

		if (existingRequest) {
			const request = existingRequest;

			request.desiredLod = desiredLod;
			request.revision = revision;
			request.includeVoxelData = includeVoxelData;
			request.priority = Number.POSITIVE_INFINITY;
			this.loadQueueRequestMap.set(chunk.id, request);
		} else {
			const request: QueuedChunkRequest = {
				chunk,
				desiredLod,
				revision,
				includeVoxelData,
				priority: Number.POSITIVE_INFINITY,
			};

			loadQueue.push(request);
			this.loadQueueRequestMap.set(chunk.id, request);
		}

		const unloadSet = this.adapter.getUnloadQueueSet();
		if (unloadSet.has(chunk)) {
			unloadSet.delete(chunk);
		}

		chunk.isTerrainScheduled = true;
	}

	public onLoadRequestsDequeued(
		requests: ReadonlyArray<QueuedChunkRequest>,
	): void {
		for (const request of requests) {
			const queued = this.loadQueueRequestMap.get(request.chunk.id);
			if (queued === request) {
				this.loadQueueRequestMap.delete(request.chunk.id);
			}
		}
	}

	public onChunkDisposed(chunkId: bigint): void {
		this.loadedRefreshQueueSet.delete(chunkId);
		// The chunk object remains in loadedRefreshQueue as a tombstone,
		// but dequeueLoadedRefreshChunk will skip it because isLoaded=false
		// and processTargetChunkCoordinate guards on that.
	}

	private sortLoadQueue(
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
	): void {
		const loadQueue = this.adapter.getLoadQueue();

		for (const request of loadQueue) {
			request.priority = this.computePriority(
				request.chunk,
				request.desiredLod,
				playerChunkX,
				playerChunkY,
				playerChunkZ,
			);
		}

		loadQueue.sort((a, b) => a.priority - b.priority);
	}

	private computePriority(
		chunk: Chunk,
		desiredLod: number,
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
	): number {
		const lodBias = desiredLod * 1_000_000;
		const dist =
			(chunk.chunkX - playerChunkX) ** 2 +
			(chunk.chunkY - playerChunkY) ** 2 +
			(chunk.chunkZ - playerChunkZ) ** 2;

		return lodBias + dist;
	}
}
