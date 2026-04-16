import { DistantTerrain } from "@/code/Generation/DistantTerrain/DistantTerrain";
import { SettingParams } from "../../SettingParams";
import { ChunkMesher } from "../ChunckMesher";
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
	private static readonly DESIRED_STATE_REVISION_RETENTION = 2;
	private streamRevision = 0;
	private desiredStates = new Map<bigint, DesiredChunkState>();
	// Map from chunkId -> queued request object for O(1) updates without relying
	// on unstable queue indices (the scheduler dequeues from the head).
	private loadQueueRequestMap: Map<bigint, QueuedChunkRequest> = new Map();
	private loadedRefreshQueue: Chunk[] = [];
	private loadedRefreshQueueSet: Set<bigint> = new Set();

	public constructor(
		private readonly adapter: ChunkStreamingControllerAdapter,
	) {}

	public getDesiredState(chunkId: bigint): DesiredChunkState | undefined {
		const state = this.desiredStates.get(chunkId);

		if (!state) {
			ChunkLoadingSystem.traceChunk(chunkId, "desired-state-miss");
			return undefined;
		}

		return state;
	}

	public async updateChunksAround(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		renderDistance = SettingParams.RENDER_DISTANCE,
		verticalRadius = SettingParams.VERTICAL_RENDER_DISTANCE,
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

				ChunkLoadingSystem.traceChunk(
					request.chunk.id,
					"queued-request-pruned",
					{
						previousDesiredLod: request.desiredLod,
						previousRevision: request.revision,
					},
				);

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

			ChunkLoadingSystem.traceChunk(request.chunk.id, "load-request-retagged", {
				desiredLod: request.desiredLod,
				revision: request.revision,
				includeVoxelData: request.includeVoxelData,
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

		const chunkChanged =
			prevChunkX !== chunkX || prevChunkY !== chunkY || prevChunkZ !== chunkZ;

		const canUseDelta =
			typeof prevChunkX === "number" &&
			typeof prevChunkY === "number" &&
			typeof prevChunkZ === "number" &&
			Math.abs(chunkX - prevChunkX) <= 1 &&
			Math.abs(chunkY - prevChunkY) <= 1 &&
			Math.abs(chunkZ - prevChunkZ) <= 1;

		if (canUseDelta) {
			this.processDeltaSlabs(
				chunkX,
				chunkY,
				chunkZ,
				prevChunkX,
				prevChunkY,
				prevChunkZ,
				lodRuleSet,
			);
		} else {
			this.processFullTargetVolume(chunkX, chunkY, chunkZ, lodRuleSet);
		}

		// IMPORTANT:
		// Do NOT synchronously refresh the whole loaded window here.
		// Just enqueue loaded chunks for incremental LOD refresh.
		if (chunkChanged) {
			this.enqueueLoadedChunksForRefresh(chunkX, chunkY, chunkZ, lodRuleSet);
		}

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
		// Refresh only a smaller near-to-mid window, not the whole lod3 window.
		const horizontalRadius = lodRuleSet.radii.lod1HorizontalRadius;
		const verticalRadius = lodRuleSet.radii.lod1VerticalRadius;

		for (
			let y = Math.max(0, chunkY - verticalRadius);
			y <=
			Math.min(SettingParams.MAX_CHUNK_HEIGHT - 1, chunkY + verticalRadius);
			y++
		) {
			for (
				let x = chunkX - horizontalRadius;
				x <= chunkX + horizontalRadius;
				x++
			) {
				for (
					let z = chunkZ - horizontalRadius;
					z <= chunkZ + horizontalRadius;
					z++
				) {
					const chunk = Chunk.getChunk(x, y, z);
					if (!chunk) continue;
					if (!chunk.isLoaded) continue;

					if (!this.loadedRefreshQueueSet.has(chunk.id)) {
						this.loadedRefreshQueueSet.add(chunk.id);
						this.loadedRefreshQueue.push(chunk);
					}
				}
			}
		}
	}

	public processLoadedRefreshQueue(
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
		renderDistance = SettingParams.RENDER_DISTANCE,
		verticalRadius = SettingParams.VERTICAL_RENDER_DISTANCE,
		maxChunks = 8,
	): void {
		if (this.loadedRefreshQueue.length === 0) {
			return;
		}

		const lodRuleSet = ChunkLodRuleSet.fromRenderRadii(
			renderDistance,
			verticalRadius,
		);

		let processed = 0;
		while (processed < maxChunks && this.loadedRefreshQueue.length > 0) {
			const chunk = this.loadedRefreshQueue.shift()!;
			this.loadedRefreshQueueSet.delete(chunk.id);

			// Re-evaluate loaded chunks incrementally instead of scanning the full window in one frame.
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
		if (!chunk) {
			chunk = new Chunk(x, y, z);

			ChunkLoadingSystem.traceChunk(chunk.id, "chunk-created", {
				x,
				y,
				z,
			});
		}

		const previousLod = chunk.lodLevel ?? 0;
		const decision = lodRuleSet.resolveWithHysteresis(
			{ chunkX: x, chunkY: y, chunkZ: z },
			{ chunkX: playerChunkX, chunkY: playerChunkY, chunkZ: playerChunkZ },
			previousLod,
		);

		if (!decision.allowsChunkCreation) {
			ChunkLoadingSystem.traceChunk(chunk.id, "chunk-not-desired", {
				x,
				y,
				z,
				previousLod,
			});
			return;
		}

		const desiredLod = decision.lodLevel;
		const revision = this.streamRevision;

		if (chunk.isLoaded && previousLod === desiredLod) {
			if (desiredLod <= 1 && !chunk.hasVoxelData) {
				ChunkLoadingSystem.traceChunk(chunk.id, "lod-steady-needs-voxel-load", {
					desiredLod,
					revision,
				});

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

		ChunkLoadingSystem.traceChunk(chunk.id, "desired-state", {
			x,
			y,
			z,
			previousLod,
			desiredLod,
			revision,
			includeVoxelData,
			isLoaded: chunk.isLoaded,
			hasVoxelData: chunk.hasVoxelData,
		});

		chunk.lodLevel = desiredLod;

		if (chunk.isLoaded && previousLod !== desiredLod) {
			if (!chunk.hasVoxelData) {
				const hasTargetCachedMesh = chunk.hasCachedLODMesh(desiredLod);

				if (desiredLod <= 1) {
					this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);

					if (!hasTargetCachedMesh) {
						ChunkLoadingSystem.traceChunk(chunk.id, "lod-upgrade-needs-load", {
							previousLod,
							desiredLod,
							revision,
						});
						return;
					}

					ChunkLoadingSystem.traceChunk(
						chunk.id,
						"lod-upgrade-cache-hit-awaiting-voxel-load",
						{
							previousLod,
							desiredLod,
							revision,
						},
					);
				}

				if (desiredLod >= 2 && !hasTargetCachedMesh) {
					ChunkLoadingSystem.traceChunk(
						chunk.id,
						"lod-downgrade-waiting-for-cache",
						{
							previousLod,
							desiredLod,
							revision,
						},
					);
					return;
				}
			}

			if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
				ChunkLoadingSystem.traceChunk(
					chunk.id,
					"cached-lod-transition-applied",
					{
						previousLod,
						desiredLod,
						revision,
					},
				);
				return;
			}

			const requiresImmediateRemesh = previousLod <= 1 || desiredLod <= 1;
			if (requiresImmediateRemesh) {
				ChunkLoadingSystem.traceChunk(chunk.id, "lod-transition-remesh", {
					previousLod,
					desiredLod,
					revision,
				});

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

	public processFullTargetVolume(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		lodRuleSet: ChunkLodRuleSet,
	): void {
		const { lod3HorizontalRadius, lod3VerticalRadius } = lodRuleSet.radii;

		for (
			let y = chunkY - lod3VerticalRadius;
			y <= chunkY + lod3VerticalRadius;
			y++
		) {
			if (y < 0 || y >= SettingParams.MAX_CHUNK_HEIGHT) {
				continue;
			}

			for (
				let x = chunkX - lod3HorizontalRadius;
				x <= chunkX + lod3HorizontalRadius;
				x++
			) {
				for (
					let z = chunkZ - lod3HorizontalRadius;
					z <= chunkZ + lod3HorizontalRadius;
					z++
				) {
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

	public processDeltaSlabs(
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

		const { lod3HorizontalRadius, lod3VerticalRadius } = lodRuleSet.radii;

		if (dx !== 0) {
			const slabX =
				dx > 0 ? chunkX + lod3HorizontalRadius : chunkX - lod3HorizontalRadius;

			for (
				let y = chunkY - lod3VerticalRadius;
				y <= chunkY + lod3VerticalRadius;
				y++
			) {
				if (y < 0 || y >= SettingParams.MAX_CHUNK_HEIGHT) continue;

				for (
					let z = chunkZ - lod3HorizontalRadius;
					z <= chunkZ + lod3HorizontalRadius;
					z++
				) {
					this.processTargetChunkCoordinate(
						slabX,
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

		if (dz !== 0) {
			const slabZ =
				dz > 0 ? chunkZ + lod3HorizontalRadius : chunkZ - lod3HorizontalRadius;

			for (
				let y = chunkY - lod3VerticalRadius;
				y <= chunkY + lod3VerticalRadius;
				y++
			) {
				if (y < 0 || y >= SettingParams.MAX_CHUNK_HEIGHT) continue;

				for (
					let x = chunkX - lod3HorizontalRadius;
					x <= chunkX + lod3HorizontalRadius;
					x++
				) {
					// Skip X/Z overlap column if X slab already handled it
					if (dx !== 0) {
						const enteringX =
							dx > 0
								? chunkX + lod3HorizontalRadius
								: chunkX - lod3HorizontalRadius;

						if (x === enteringX) continue;
					}

					this.processTargetChunkCoordinate(
						x,
						y,
						slabZ,
						chunkX,
						chunkY,
						chunkZ,
						lodRuleSet,
					);
				}
			}
		}

		if (dy !== 0) {
			const slabY =
				dy > 0 ? chunkY + lod3VerticalRadius : chunkY - lod3VerticalRadius;

			if (slabY >= 0 && slabY < SettingParams.MAX_CHUNK_HEIGHT) {
				for (
					let x = chunkX - lod3HorizontalRadius;
					x <= chunkX + lod3HorizontalRadius;
					x++
				) {
					for (
						let z = chunkZ - lod3HorizontalRadius;
						z <= chunkZ + lod3HorizontalRadius;
						z++
					) {
						// Skip X/Y overlap plane already handled by X slab
						if (dx !== 0) {
							const enteringX =
								dx > 0
									? chunkX + lod3HorizontalRadius
									: chunkX - lod3HorizontalRadius;

							if (x === enteringX) continue;
						}

						// Skip Z/Y overlap plane already handled by Z slab
						if (dz !== 0) {
							const enteringZ =
								dz > 0
									? chunkZ + lod3HorizontalRadius
									: chunkZ - lod3HorizontalRadius;

							if (z === enteringZ) continue;
						}

						this.processTargetChunkCoordinate(
							x,
							slabY,
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

	public queueUnloading(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		renderDistance: number,
		verticalRadius: number,
	): void {
		const unloadQueueSet = this.adapter.getUnloadQueueSet();

		const removeRadius =
			renderDistance + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;
		const verticalRemoveRadius =
			verticalRadius + SettingParams.CHUNK_UNLOAD_DISTANCE_BUFFER;

		for (const chunk of Chunk.chunkInstances.values()) {
			if (chunk.isPersistent) continue;
			if (!chunk.isLoaded) continue;
			if (unloadQueueSet.has(chunk)) continue;

			const cx = chunk.chunkX;
			const cy = chunk.chunkY;
			const cz = chunk.chunkZ;

			if (
				Math.abs(cx - chunkX) > removeRadius ||
				Math.abs(cz - chunkZ) > removeRadius ||
				Math.abs(cy - chunkY) > verticalRemoveRadius
			) {
				unloadQueueSet.add(chunk);

				ChunkLoadingSystem.traceChunk(chunk.id, "unload-queued", {
					x: chunk.chunkX,
					y: chunk.chunkY,
					z: chunk.chunkZ,
					dx: Math.abs(cx - chunkX),
					dy: Math.abs(cy - chunkY),
					dz: Math.abs(cz - chunkZ),
					playerChunkX: chunkX,
					playerChunkY: chunkY,
					playerChunkZ: chunkZ,
					removeRadius,
					verticalRemoveRadius,
				});
			}
		}
	}

	public tryApplyCachedLodTransitionMesh(
		chunk: Chunk,
		targetLod: number,
	): boolean {
		if (chunk.isDirty) {
			ChunkLoadingSystem.traceChunk(
				chunk.id,
				"cached-lod-transition-skip-dirty",
				{
					targetLod,
				},
			);
			return false;
		}

		const cached = chunk.getCachedLODMesh(targetLod);
		if (!cached) {
			ChunkLoadingSystem.traceChunk(chunk.id, "cached-lod-transition-miss", {
				targetLod,
			});
			return false;
		}

		if (!cached.opaque && !cached.transparent) {
			ChunkLoadingSystem.traceChunk(
				chunk.id,
				"cached-lod-transition-empty-mesh",
				{
					targetLod,
				},
			);
			return false;
		}

		ChunkMesher.createMeshFromData(chunk, {
			opaque: cached.opaque ?? null,
			transparent: cached.transparent ?? null,
		});
		chunk.isDirty = false;

		ChunkLoadingSystem.traceChunk(chunk.id, "cached-lod-transition-applied", {
			targetLod,
		});

		return true;
	}

	public ensureChunkQueuedForLoad(
		chunk: Chunk,
		desiredLod: number,
		revision: number,
		includeVoxelData = desiredLod <= 1,
	): void {
		if (chunk.isLoaded && (!includeVoxelData || chunk.hasVoxelData)) {
			ChunkLoadingSystem.traceChunk(chunk.id, "load-skip-already-loaded", {
				desiredLod,
				revision,
				includeVoxelData,
				hasVoxelData: chunk.hasVoxelData,
			});
			return;
		}

		const loadQueue = this.adapter.getLoadQueue();
		const existingRequest = this.loadQueueRequestMap.get(chunk.id);

		if (existingRequest) {
			const request = existingRequest;

			const previousDesiredLod = request.desiredLod;
			const previousRevision = request.revision;

			request.desiredLod = desiredLod;
			request.revision = revision;
			request.includeVoxelData = includeVoxelData;
			request.priority = Number.POSITIVE_INFINITY;
			this.loadQueueRequestMap.set(chunk.id, request);

			ChunkLoadingSystem.traceChunk(chunk.id, "load-request-updated", {
				previousDesiredLod,
				previousRevision,
				desiredLod,
				revision,
				includeVoxelData,
			});
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

			ChunkLoadingSystem.traceChunk(chunk.id, "load-queued", {
				desiredLod,
				revision,
				includeVoxelData,
			});
		}

		const unloadSet = this.adapter.getUnloadQueueSet();
		if (unloadSet.has(chunk)) {
			unloadSet.delete(chunk);
			ChunkLoadingSystem.traceChunk(
				chunk.id,
				"unload-cancelled-due-to-load",
				{},
			);
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
