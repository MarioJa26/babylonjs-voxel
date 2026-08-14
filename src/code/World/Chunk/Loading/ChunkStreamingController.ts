import {
	isInitialized as isDistantTerrainReady,
	update as updateDistantTerrain,
} from "@/code/Generation/DistantTerrain/DistantTerrain";
import { isInCave } from "@/code/Lib/GameRuntimeState";
import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import { Chunk, getChunk } from "../Chunk";
import { createMeshFromData } from "../ChunkMesher";
import { ChunkWorkerPool } from "../ChunkWorkerPool";
import {
	ChunkLodRuleSet,
	DistantOnlyChunkCreationRule,
	Lod0ChunkCreationRule,
} from "../LOD/ChunkLodRules";

export type QueuedChunkRequest = {
	chunk: Chunk;
	desiredLod: number;
	revision: number;
	includeVoxelData: boolean;
	priority: number;
};

function compareQueuedChunkRequestPriority(
	a: QueuedChunkRequest,
	b: QueuedChunkRequest,
): number {
	return a.priority - b.priority;
}

// Scratch target for chunkDist to avoid per-call object allocation in hot
// enqueue loops. Callers must consume hDist/vDist before the next call.
const _chunkDistScratch: { hDist: number; vDist: number } = {
	hDist: 0,
	vDist: 0,
};
function chunkDistScratch(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	centerX: number,
	centerY: number,
	centerZ: number,
): { hDist: number; vDist: number } {
	_chunkDistScratch.hDist = Math.max(
		Math.abs(chunkX - centerX),
		Math.abs(chunkZ - centerZ),
	);
	_chunkDistScratch.vDist = Math.abs(chunkY - centerY);
	return _chunkDistScratch;
}

// PERF: relative-offset key for the refresh decision cache. The LOD decision
// is a pure function of (chunk - player) offset + the chunk's previous LOD,
// so keying by offset (not by absolute chunk id) keeps cache entries valid
// across player-chunk moves — eliminating the per-pass resolveWithHysteresis
// storm that used to fire on every 1-chunk crossing. Bounds are generous
// (offset +/-128, lod 0..7) so there is no overflow in the packed integer.
const _OFFSET_BIAS = 128;
function packOffsetKey(
	rx: number,
	ry: number,
	rz: number,
	chunkLod: number,
): number {
	return (
		(rx + _OFFSET_BIAS) |
		((ry + _OFFSET_BIAS) << 8) |
		((rz + _OFFSET_BIAS) << 16) |
		(chunkLod << 24)
	);
}

export interface ChunkStreamingControllerAdapter {
	getLoadQueue(): QueuedChunkRequest[];
	getUnloadQueueSet(): Set<Chunk>;
	onQueueSnapshotChanged?(): void;
}

// Scratch array for LoadedChunkIndex.queryCollect — avoids generator overhead.
const _queryScratch: Chunk[] = [];

export class ChunkStreamingController {
	private static readonly DESIRED_STATE_REVISION_RETENTION = 8;
	private streamRevision = 0;
	// PERF: desired state packed into a single number (desiredLod | revision<<3)
	// to avoid a per-chunk object allocation on the hot streaming path.
	// Keyed by chunk.numericId (number) — BigInt keys hash slower and the
	// BigInt box churn showed up at the top of the allocation profile.
	private desiredStates = new Map<number, number>();
	// H1: Lazy prune — only scan desiredStates when stale entries have accumulated
	private _needsDesiredStatePrune = false;
	// Map from numericId -> queued request object for O(1) updates without
	// relying on unstable queue indices (the scheduler dequeues from the head).
	// Keyed by numericId (number) — BigInt keys hash slower and the BigInt
	// box churn showed up at the top of the allocation profile.
	private loadQueueRequestMap: Map<number, QueuedChunkRequest> = new Map();
	private loadedRefreshQueue: Chunk[] = [];
	private loadedRefreshQueueSet: Set<number> = new Set();
	private loadedRefreshQueueHead = 0;

	// H2: Cache LOD rule sets — only rebuild when cave state or render distance changes
	private _cachedCaveLodRuleSet: ChunkLodRuleSet | null = null;
	private _cachedOutdoorLodRuleSet: ChunkLodRuleSet | null = null;
	// Bumped every time a LOD rule set is rebuilt; used as the cache key for
	// per-chunk refresh decisions so stale entries are detected.
	private _ruleSetGeneration = 0;
	// Relative-offset refresh decision cache. Keyed by (chunk - player) offset
	// + previous chunk LOD (see packOffsetKey), value packs decisionLod | ruleRev<<3.
	// Because the LOD decision depends only on the relative offset, entries stay
	// valid when the player moves between chunks, so we skip resolveWithHysteresis
	// for the stable majority of boundary chunks. Bounded by the offset space, so
	// no per-chunk pruning is needed.
	private _refreshCache = new Map<number, number>();
	private _lastCaveState: boolean | null = null;
	private _lastRenderDistance = 0;
	private _lastVerticalRadius = 0;

	public constructor(
		private readonly adapter: ChunkStreamingControllerAdapter,
	) {}

	public getDesiredState(numericId: number): number | undefined {
		return this.desiredStates.get(numericId);
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
		playerWorldX?: number,
		playerWorldZ?: number,
	): Promise<void> {
		this.streamRevision++;

		const caveState = isInCave();

		const distantTerrainX =
			playerWorldX !== undefined ? playerWorldX : chunkX * Chunk.SIZE;
		const distantTerrainZ =
			playerWorldZ !== undefined ? playerWorldZ : chunkZ * Chunk.SIZE;

		if (isDistantTerrainReady()) {
			updateDistantTerrain(distantTerrainX, distantTerrainZ);
		}

		let lodRuleSet: ChunkLodRuleSet;

		if (caveState) {
			if (
				!this._cachedCaveLodRuleSet ||
				this._lastCaveState !== true ||
				this._lastRenderDistance !== renderDistance ||
				this._lastVerticalRadius !== verticalRadius
			) {
				this._ruleSetGeneration++;
				this._cachedCaveLodRuleSet = new ChunkLodRuleSet(
					{
						lod0HorizontalRadius: renderDistance + 2,
						lod0VerticalRadius: verticalRadius + 2,
						lod1HorizontalRadius: 0,
						lod1VerticalRadius: 0,
						lod2HorizontalRadius: 0,
						lod2VerticalRadius: 0,
						lod3HorizontalRadius: 0,
						lod3VerticalRadius: 0,
					},
					[
						new Lod0ChunkCreationRule(renderDistance + 2, verticalRadius + 2),
						new DistantOnlyChunkCreationRule(),
					],
					this._ruleSetGeneration,
				);

				this._lastRenderDistance = renderDistance;
				this._lastVerticalRadius = verticalRadius;
			}

			lodRuleSet = this._cachedCaveLodRuleSet;
		} else {
			if (
				!this._cachedOutdoorLodRuleSet ||
				this._lastCaveState !== false ||
				this._lastRenderDistance !== renderDistance ||
				this._lastVerticalRadius !== verticalRadius
			) {
				this._ruleSetGeneration++;
				this._cachedOutdoorLodRuleSet = ChunkLodRuleSet.fromRenderRadii(
					renderDistance,
					verticalRadius,
					this._ruleSetGeneration,
				);

				this._lastRenderDistance = renderDistance;
				this._lastVerticalRadius = verticalRadius;
			}

			lodRuleSet = this._cachedOutdoorLodRuleSet;
		}

		this._lastCaveState = caveState;

		const {
			lod3HorizontalRadius,
			lod3VerticalRadius,
			lod0HorizontalRadius,
			lod0VerticalRadius,
			lod1HorizontalRadius,
			lod1VerticalRadius,
			lod2HorizontalRadius,
			lod2VerticalRadius,
		} = lodRuleSet.radii;

		const operationalRadius = Math.max(
			lod0HorizontalRadius,
			lod1HorizontalRadius,
			lod2HorizontalRadius,
			lod3HorizontalRadius,
		);

		const operationalVerticalRadius = Math.max(
			lod0VerticalRadius,
			lod1VerticalRadius,
			lod2VerticalRadius,
			lod3VerticalRadius,
		);

		const nearZoneRadius =
			Math.max(lod0HorizontalRadius, lod1HorizontalRadius) + 2;
		const nearZoneVertical =
			Math.max(lod0VerticalRadius, lod1VerticalRadius) + 2;
		const lodRuleRevision = lodRuleSet.revision;

		const loadQueue = this.adapter.getLoadQueue();
		const unloadQueueSet = this.adapter.getUnloadQueueSet();

		this.loadQueueRequestMap.clear();

		let writeIndex = 0;

		for (let readIndex = 0; readIndex < loadQueue.length; readIndex++) {
			const request = loadQueue[readIndex];
			const chunk = request.chunk;

			const hDist = Math.max(
				Math.abs(chunk.chunkX - chunkX),
				Math.abs(chunk.chunkZ - chunkZ),
			);
			const vDist = Math.abs(chunk.chunkY - chunkY);

			if (hDist > operationalRadius || vDist > operationalVerticalRadius) {
				chunk.isTerrainScheduled = false;
				continue;
			}

			let desiredLod = request.desiredLod;

			if (
				chunk.isDirty ||
				(hDist <= nearZoneRadius && vDist <= nearZoneVertical)
			) {
				const previousLod = chunk.lodLevel ?? request.desiredLod;
				const key = packOffsetKey(
					chunk.chunkX - chunkX,
					chunk.chunkY - chunkY,
					chunk.chunkZ - chunkZ,
					previousLod,
				);

				const cached = this._refreshCache.get(key);

				if (
					cached !== undefined &&
					cached >> 3 === lodRuleRevision &&
					!chunk.isDirty
				) {
					desiredLod = cached & 0b111;
				} else {
					desiredLod = lodRuleSet.resolveWithHysteresisFromDistance(
						hDist,
						vDist,
						previousLod,
					).lodLevel;

					this._refreshCache.set(key, desiredLod | (lodRuleRevision << 3));
				}
			}

			request.desiredLod = desiredLod;
			request.revision = this.streamRevision;
			request.includeVoxelData = desiredLod <= 1;
			request.priority = this.computePriority(
				chunk,
				desiredLod,
				chunkX,
				chunkY,
				chunkZ,
			);

			this.desiredStates.set(
				chunk.numericId,
				desiredLod | (this.streamRevision << 3),
			);

			this.loadQueueRequestMap.set(chunk.numericId, request);
			loadQueue[writeIndex++] = request;
		}

		loadQueue.length = writeIndex;

		for (const chunk of unloadQueueSet) {
			const hDist = Math.max(
				Math.abs(chunk.chunkX - chunkX),
				Math.abs(chunk.chunkZ - chunkZ),
			);
			const vDist = Math.abs(chunk.chunkY - chunkY);

			const effectiveVerticalAllowance =
				!caveState && chunk.chunkY < 0
					? Math.min(
							lod3VerticalRadius,
							SETTING_PARAMS.CAVE_VERTICAL_RENDER_DISTANCE,
						)
					: lod3VerticalRadius;

			if (
				hDist <= lod3HorizontalRadius &&
				vDist <= effectiveVerticalAllowance
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

		const unloadScanRadius =
			operationalRadius + SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER + 8;
		const unloadScanVertical =
			operationalVerticalRadius +
			SETTING_PARAMS.CHUNK_UNLOAD_DISTANCE_BUFFER +
			8;

		_queryScratch.length = 0;
		Chunk.loadedChunkIndex.queryCollect(
			chunkX,
			chunkY,
			chunkZ,
			unloadScanRadius,
			unloadScanVertical,
			_queryScratch,
		);

		this.enqueueLoadedChunksForRefresh(chunkX, chunkY, chunkZ, lodRuleSet);

		this.sortLoadQueue();

		this.queueUnloading(
			chunkX,
			chunkY,
			chunkZ,
			operationalRadius,
			operationalVerticalRadius,
		);

		if (!caveState) {
			ChunkWorkerPool.getInstance().scheduleBackgroundLodPrecompute(
				chunkX,
				chunkY,
				chunkZ,
			);
		}

		if (
			this.desiredStates.size > 0 &&
			this.streamRevision %
				ChunkStreamingController.DESIRED_STATE_REVISION_RETENTION ===
				0
		) {
			const oldestKeptRevision = Math.max(
				0,
				this.streamRevision -
					ChunkStreamingController.DESIRED_STATE_REVISION_RETENTION,
			);

			for (const [id, packed] of this.desiredStates) {
				if (packed >> 3 < oldestKeptRevision) {
					this.desiredStates.delete(id);
				}
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

		for (let _qi = 0; _qi < _queryScratch.length; _qi++) {
			const chunk = _queryScratch[_qi];
			if (this.loadedRefreshQueueSet.has(chunk.numericId)) continue;

			const { hDist, vDist } = chunkDistScratch(
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ,
				chunkX,
				chunkY,
				chunkZ,
			);

			// Only enqueue chunks that sit near a LOD transition boundary
			// (+/- 2 chunks of each boundary). Skip chunks deep in LOD0 or
			// far out in LOD3 — they don't need re-evaluation.
			const nearLod0 =
				hDist <= lod0HorizontalRadius + 2 && vDist <= lod0VerticalRadius + 2;
			const nearLod1 =
				hDist <= lod1HorizontalRadius + 2 && vDist <= lod1VerticalRadius + 2;
			const nearLod2 =
				hDist <= lod2HorizontalRadius + 2 && vDist <= lod2VerticalRadius + 2;

			if (!nearLod0 && !nearLod1 && !nearLod2) continue;

			const ruleRev = lodRuleSet.revision;
			const chunkLod = chunk.lodLevel ?? 3;
			// Offset-only key: the LOD decision is a pure function of the
			// relative offset + previous LOD, so cache entries survive player
			// moves and we skip resolveWithHysteresis for the stable majority.
			const key = packOffsetKey(
				chunk.chunkX - chunkX,
				chunk.chunkY - chunkY,
				chunk.chunkZ - chunkZ,
				chunkLod,
			);

			let decisionLod: number;
			const cached = this._refreshCache.get(key);
			if (cached !== undefined && cached >> 3 === ruleRev && !chunk.isDirty) {
				decisionLod = cached & 0b111;
			} else {
				decisionLod = lodRuleSet.resolveWithHysteresisFromDistance(
					hDist,
					vDist,
					chunkLod,
				).lodLevel;
				this._refreshCache.set(key, decisionLod | (ruleRev << 3));
			}

			if (
				chunk.lodLevel === decisionLod &&
				!chunk.isDirty &&
				!(decisionLod <= 1 && !chunk.hasVoxelData)
			) {
				continue;
			}

			this.loadedRefreshQueueSet.add(chunk.numericId);
			this.loadedRefreshQueue.push(chunk);
		}
	}
	public processLoadedRefreshQueue(
		playerChunkX: number,
		playerChunkY: number,
		playerChunkZ: number,
		renderDistance = SETTING_PARAMS.RENDER_DISTANCE,
		verticalRadius = SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
		maxChunks = SETTING_PARAMS.CHUNK_LOAD_BATCH_LIMIT,
	): void {
		if (this.loadedRefreshQueueHead >= this.loadedRefreshQueue.length) {
			return;
		}

		const caveState = isInCave();

		let lodRuleSet: ChunkLodRuleSet;

		if (caveState) {
			if (
				this._cachedCaveLodRuleSet === null ||
				this._lastCaveState !== true ||
				this._lastRenderDistance !== renderDistance ||
				this._lastVerticalRadius !== verticalRadius
			) {
				this._ruleSetGeneration++;
				this._cachedCaveLodRuleSet = new ChunkLodRuleSet(
					{
						lod0HorizontalRadius: renderDistance + 2,
						lod0VerticalRadius: verticalRadius + 2,
						lod1HorizontalRadius: 0,
						lod1VerticalRadius: 0,
						lod2HorizontalRadius: 0,
						lod2VerticalRadius: 0,
						lod3HorizontalRadius: 0,
						lod3VerticalRadius: 0,
					},
					[
						new Lod0ChunkCreationRule(renderDistance + 2, verticalRadius + 2),
						new DistantOnlyChunkCreationRule(),
					],
					this._ruleSetGeneration,
				);

				this._lastRenderDistance = renderDistance;
				this._lastVerticalRadius = verticalRadius;
			}

			lodRuleSet = this._cachedCaveLodRuleSet;
		} else {
			if (
				this._cachedOutdoorLodRuleSet === null ||
				this._lastCaveState !== false ||
				this._lastRenderDistance !== renderDistance ||
				this._lastVerticalRadius !== verticalRadius
			) {
				this._ruleSetGeneration++;
				this._cachedOutdoorLodRuleSet = ChunkLodRuleSet.fromRenderRadii(
					renderDistance,
					verticalRadius,
					this._ruleSetGeneration,
				);

				this._lastRenderDistance = renderDistance;
				this._lastVerticalRadius = verticalRadius;
			}

			lodRuleSet = this._cachedOutdoorLodRuleSet;
		}

		this._lastCaveState = caveState;

		let processed = 0;

		while (processed < maxChunks) {
			const chunk = this.dequeueLoadedRefreshChunk();
			if (!chunk) break;

			this.loadedRefreshQueueSet.delete(chunk.numericId);

			if (!chunk.isLoaded) {
				continue;
			}

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
			this.loadedRefreshQueue.copyWithin(0, this.loadedRefreshQueueHead);
			this.loadedRefreshQueue.length -= this.loadedRefreshQueueHead;
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
		let chunk = getChunk(x, y, z);

		const previousLod = chunk?.lodLevel ?? 3;
		const ruleRev = lodRuleSet.revision;

		const relX = x - playerChunkX;
		const relY = y - playerChunkY;
		const relZ = z - playerChunkZ;

		const cacheKey = packOffsetKey(relX, relY, relZ, previousLod);

		let desiredLod: number;

		const cached = this._refreshCache.get(cacheKey);

		if (cached !== undefined && cached >> 3 === ruleRev && !chunk?.isDirty) {
			desiredLod = cached & 0b111;
		} else {
			const hDist = Math.max(Math.abs(relX), Math.abs(relZ));
			const vDist = Math.abs(relY);

			const decision = lodRuleSet.resolveWithHysteresisFromDistance(
				hDist,
				vDist,
				previousLod,
			);

			if (!decision.allowsChunkCreation) return;

			desiredLod = decision.lodLevel;
			this._refreshCache.set(cacheKey, desiredLod | (ruleRev << 3));
		}

		if (!chunk) {
			chunk = new Chunk(x, y, z);
		}

		const revision = this.streamRevision;

		if (chunk.isLoaded && previousLod === desiredLod) {
			if (desiredLod <= 1 && !chunk.hasVoxelData) {
				this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);
				this.tryApplyCachedLodTransitionMesh(chunk, desiredLod);
			} else if (chunk.isDirty && !chunk.hasVoxelData && desiredLod >= 2) {
				if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
					chunk.isDirty = false;
				}
			}

			return;
		}

		const includeVoxelData = desiredLod <= 1;

		this.desiredStates.set(chunk.numericId, desiredLod | (revision << 3));

		if (chunk.isLoaded && previousLod !== desiredLod) {
			const hasTargetCachedMesh = chunk.hasCachedLODMesh(desiredLod);

			if (!chunk.hasVoxelData) {
				if (desiredLod <= 1) {
					chunk.lodLevel = desiredLod;
					this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);

					if (!hasTargetCachedMesh) {
						return;
					}
				}

				if (desiredLod >= 2 && !hasTargetCachedMesh) {
					chunk.lodLevel = desiredLod;

					if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
						return;
					}

					this.ensureChunkQueuedForLoad(chunk, desiredLod, revision, true);
					return;
				}
			}

			chunk.lodLevel = desiredLod;

			if (this.tryApplyCachedLodTransitionMesh(chunk, desiredLod)) {
				return;
			}

			if (
				previousLod <= 1 ||
				desiredLod <= 1 ||
				!hasTargetCachedMesh ||
				chunk.isDirty
			) {
				chunk.scheduleRemesh(true);
			}

			return;
		}

		chunk.lodLevel = desiredLod;

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
		const radii = lodRuleSet.radii;
		const r = Math.max(
			radii.lod0HorizontalRadius,
			radii.lod1HorizontalRadius,
			radii.lod2HorizontalRadius,
			radii.lod3HorizontalRadius,
		);
		const ry = Math.max(
			radii.lod0VerticalRadius,
			radii.lod1VerticalRadius,
			radii.lod2VerticalRadius,
			radii.lod3VerticalRadius,
		);
		const downwardRy = isInCave()
			? ry
			: Math.min(
					ry,
					Math.max(chunkY, 0) + SETTING_PARAMS.CAVE_VERTICAL_RENDER_DISTANCE,
				);
		const minY = SETTING_PARAMS.MIN_CHUNK_Y;
		const maxY = minY + SETTING_PARAMS.MAX_CHUNK_HEIGHT;

		if (dx !== 0) {
			const x = dx > 0 ? chunkX + r : chunkX - r;
			for (let y = chunkY - downwardRy; y <= chunkY + ry; y++) {
				if (y < minY || y >= maxY) continue;
				for (let z = chunkZ - r; z <= chunkZ + r; z++) {
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

		if (dz !== 0) {
			const z = dz > 0 ? chunkZ + r : chunkZ - r;
			for (let y = chunkY - downwardRy; y <= chunkY + ry; y++) {
				if (y < minY || y >= maxY) continue;
				for (let x = chunkX - r; x <= chunkX + r; x++) {
					if (dx !== 0) {
						const skipX = dx > 0 ? chunkX + r : chunkX - r;
						if (x === skipX) continue;
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

		if (dy !== 0) {
			const y = dy > 0 ? chunkY + ry : chunkY - downwardRy;
			if (y >= minY && y < maxY) {
				for (let x = chunkX - r; x <= chunkX + r; x++) {
					if (dx !== 0) {
						const skipX = dx > 0 ? chunkX + r : chunkX - r;
						if (x === skipX) continue;
					}
					for (let z = chunkZ - r; z <= chunkZ + r; z++) {
						if (dz !== 0) {
							const skipZ = dz > 0 ? chunkZ + r : chunkZ - r;
							if (z === skipZ) continue;
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
		const radii = lodRuleSet.radii;

		const r = Math.max(
			radii.lod0HorizontalRadius,
			radii.lod1HorizontalRadius,
			radii.lod2HorizontalRadius,
			radii.lod3HorizontalRadius,
		);

		const ry = Math.max(
			radii.lod0VerticalRadius,
			radii.lod1VerticalRadius,
			radii.lod2VerticalRadius,
			radii.lod3VerticalRadius,
		);

		const caveState = isInCave();

		const downwardRy = caveState
			? ry
			: Math.min(
					ry,
					Math.max(chunkY, 0) + SETTING_PARAMS.CAVE_VERTICAL_RENDER_DISTANCE,
				);

		const minY = SETTING_PARAMS.MIN_CHUNK_Y;
		const maxY = minY + SETTING_PARAMS.MAX_CHUNK_HEIGHT;

		const startX = chunkX - r;
		const endX = chunkX + r;
		const startZ = chunkZ - r;
		const endZ = chunkZ + r;
		const startY = chunkY - downwardRy;
		const endY = chunkY + ry;

		for (let x = startX; x <= endX; x++) {
			const relX = x - chunkX;

			for (let y = startY; y <= endY; y++) {
				if (y < minY || y >= maxY) continue;

				const relY = y - chunkY;
				const vDist = Math.abs(relY);

				for (let z = startZ; z <= endZ; z++) {
					const existing = getChunk(x, y, z);

					if (existing?.isLoaded && !existing.isDirty) {
						const relZ = z - chunkZ;
						const hDist = Math.max(Math.abs(relX), Math.abs(relZ));

						const decision = lodRuleSet.resolveWithHysteresisFromDistance(
							hDist,
							vDist,
							existing.lodLevel ?? 3,
						);

						if (
							existing.lodLevel === decision.lodLevel &&
							!(decision.lodLevel <= 1 && !existing.hasVoxelData)
						) {
							continue;
						}
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

		const caveState = isInCave();
		const hardOutdoorMinY = -SETTING_PARAMS.CAVE_VERTICAL_RENDER_DISTANCE;

		for (let i = 0; i < _queryScratch.length; i++) {
			const chunk = _queryScratch[i];

			if (chunk.isBoatChunk || unloadQueueSet.has(chunk)) {
				continue;
			}

			const hDist = Math.max(
				Math.abs(chunk.chunkX - chunkX),
				Math.abs(chunk.chunkZ - chunkZ),
			);
			const vDist = Math.abs(chunk.chunkY - chunkY);

			if (
				hDist > removeRadius ||
				vDist > verticalRemoveRadius ||
				(!caveState && chunk.chunkY < hardOutdoorMinY)
			) {
				unloadQueueSet.add(chunk);
			}
		}
	}

	public tryApplyCachedLodTransitionMesh(
		chunk: Chunk,
		targetLod: number,
	): boolean {
		const cached = chunk.getCachedLODMesh(targetLod);
		if (!cached) {
			return false;
		}

		if (!cached.opaque && !cached.transparent) {
			return false;
		}

		createMeshFromData(
			chunk,
			cached.opaque ?? null,
			cached.transparent ?? null,
		);

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
		const existingRequest = this.loadQueueRequestMap.get(chunk.numericId);

		if (existingRequest) {
			const request = existingRequest;

			request.desiredLod = desiredLod;
			request.revision = revision;
			request.includeVoxelData = includeVoxelData;
			request.priority = Number.POSITIVE_INFINITY;
			this.loadQueueRequestMap.set(chunk.numericId, request);
		} else {
			const request: QueuedChunkRequest = {
				chunk,
				desiredLod,
				revision,
				includeVoxelData,
				priority: Number.POSITIVE_INFINITY,
			};
			loadQueue.push(request);
			this.loadQueueRequestMap.set(chunk.numericId, request);
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
			this.loadQueueRequestMap.delete(request.chunk.numericId);
		}
	}

	public onChunkDisposed(numericId: number): void {
		this.loadedRefreshQueueSet.delete(numericId);
		// The refresh cache is keyed by relative offset (bounded by the offset
		// space), so no per-chunk eviction is needed; stale entries are simply
		// overwritten when another chunk occupies that offset.
		// The chunk object remains in loadedRefreshQueue as a tombstone,
		// but dequeueLoadedRefreshChunk will skip it because isLoaded=false
		// and processTargetChunkCoordinate guards on that.
	}

	private sortLoadQueue(): void {
		const loadQueue = this.adapter.getLoadQueue();
		if (loadQueue.length <= 64) return;
		loadQueue.sort(compareQueuedChunkRequestPriority);
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
