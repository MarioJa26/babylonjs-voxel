// Add these module-level reusable scratch buffers near _indexedScratch.

import { onBeforeRender, type SceneContext, type Vec3 } from "@babylonjs/lite";
import { playFootstep } from "../Audio/SurfaceAudio";
import { CustomBoat } from "../Entities/CustomBoat";
import { MobTypeId } from "../Entities/MobConfig";
import { update as updateDistantTerrain } from "../Generation/DistantTerrain/DistantTerrain";
import {
	getBiome,
	getFinalTerrainHeight,
	getTerrainNoiseDebug,
} from "../Generation/TerrainHeightMap";
import type { IControls } from "../Interface/IControls";
import { frameProfiler } from "../Lib/FrameProfiler";
import { isUiOpen, setInCave } from "../Lib/GameRuntimeState";
import { worldToChunkCoord } from "../Lib/VoxelMath";
import {
	makeSprintEmitterState,
	playSprint,
} from "../Maps/BlockBreakParticles";
import { Map1 } from "../Maps/Map1";
import { isEyeUnderwater } from "../Maps/UnderWaterEffect";
import { Chunk } from "../World/Chunk/Chunk";
import {
	getBlockByWorldCoords,
	getDebugStats,
	processFrameBudgetedStreamingWork,
	updateChunksAround,
} from "../World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "../World/Chunk/ChunkWorkerPool";
import {
	getMergedLayerMemoryStats,
	getMergedMeshFlushStats,
} from "../World/Chunk/MergedMeshManager";
import { getPackedMeshMemoryStats } from "../World/Chunk/PackedChunkMesh";
import { BlockTickScheduler } from "../World/Chunk/Worker/BlockTickScheduler";
import {
	ensureDefaultInstance,
	processWaterUpdate,
} from "../World/Chunk/Worker/WaterSimulation";
import { FarTileManager } from "../World/FarTiles/FarTileManager";
import { onGpuWorkDone } from "../World/Light/liteGpuBuffer";
import { OcclusionCuller } from "../World/Occlusion/OcclusionCuller";
import { onSpawnPrepared } from "../World/SpawnPoint";
import { BlockType, isCollidableBlock } from "../World/Texture/BlockType";
import {
	type BlockRaycastHit,
	pickTarget,
} from "./Hud/BlockHighlight/BlockRaycaster";
import { PlayerHud } from "./Hud/PlayerHud";
import type { PlayerCamera } from "./PlayerCamera";
import { Gamemodes, type PlayerStats } from "./PlayerStats";

// They replace the object-allocation + full-sort path for Worker Dist.
const _topDispatchIndices = [-1, -1, -1, -1];
const _topDispatchCounts = [0, 0, 0, 0];

const MOB_TYPE_NAMES: Record<number, string> = {
	[MobTypeId.Chicken]: "Chicken",
	[MobTypeId.Sheep]: "Sheep",
};

export class PlayerLoopController {
	// ---- chunk-loading position tracking ----
	#loadLastCx = 0;
	#loadLastCy = 0;
	#loadLastCz = 0;
	// World streaming runs in its own per-frame hook that is installed only
	// once the spawn is prepared (see #installStreaming) — the hot tick()
	// path never touches spawn state.
	#offSpawnPrepared: (() => void) | null = null;

	// ---- active-mesh selection position tracking (separate from loading) ----
	#amLastCx = 0;
	#amLastCy = 0;
	#amLastCz = 0;
	#prevCameraYaw = 0;
	#prevCameraPitch = 0;
	#rebuildActiveMeshes = false;

	// ---- pick-target raycast gating (skip the 64-voxel DDA when still) ----
	#pickLastX = NaN;
	#pickLastY = NaN;
	#pickLastZ = NaN;
	#pickLastYaw = NaN;
	#pickLastPitch = NaN;
	#pickCachedHit: BlockRaycastHit | null = null;
	#pickStillFrames = 0;
	static readonly PICK_STILL_REFRESH_FRAMES = 6;

	// ---- cave state ----
	#lastCaveState = false;

	// ---- occlusion culling ----
	#occlusionCuller = new OcclusionCuller();
	#lastOcclusionStats = { total: 0, occluded: 0, timeMs: 0 };

	// ---- debug HUD throttle ----
	#lastDebugHudUpdateMs = 0;
	#mainThreadMs = 0;
	static readonly DEBUG_HUD_INTERVAL_MS = 1250;

	// ---- captured static callback for restore-on-dispose ----
	#previousOnChunkLoaded: typeof Chunk.onChunkLoaded | null = null;

	// Cache singleton instead of resolving it multiple times in hot paths.
	#blockTickScheduler = BlockTickScheduler.getInstance();

	// Per-emitter throttle state so the local player keeps its own sprint-dust
	// cadence independent of remote players.
	#sprintEmitter = makeSprintEmitterState();

	// Stride accumulator for footstep sounds (meters since the last step).
	#strideDistance = 0;

	private readonly scene: SceneContext;

	constructor(
		scene: SceneContext,
		private readonly playerVehicle: {
			isSprinting: boolean;
			isClimbing: boolean;
			isFlying: boolean;
			isMounted: boolean;
			isGrounded: boolean;
			onAudibleStep: (() => void) | null;
			velocity: Vec3;
			inputDirection: Vec3;
			update(dt: number): void;
			updateCameraAndVisuals(deltaMs?: number): void;
		},
		private readonly playerStats: PlayerStats,
		private readonly playerHud: PlayerHud,
		private readonly playerCamera: PlayerCamera,
		private readonly getKeyboardControls: () => IControls<unknown>,
		private readonly getPlayerPosition: () => Vec3,
	) {
		this.scene = scene;
	}

	public bind(): void {
		// Kick off async init of the shared default instance (dynamic import of
		// ChunkLoadingSystem). The scheduler callback won't fire until the first
		// processFrame() on a later frame, by which point init has resolved.
		void ensureDefaultInstance();
		this.#blockTickScheduler.setProcessCallback(processWaterUpdate);

		// Install world streaming only once the spawn is prepared — a one-shot
		// notification instead of any spawn-state check in the per-frame hot
		// path. Before the teleport the player sits at the origin; loading
		// there would leave residual chunks at 0,0.
		this.#offSpawnPrepared = onSpawnPrepared(() => this.#installStreaming());

		this.#previousOnChunkLoaded = Chunk.onChunkLoaded;
		Chunk.onChunkLoaded = (chunk: Chunk) => {
			this.#previousOnChunkLoaded?.(chunk);
			this.#occlusionCuller.incrementalAdd(chunk);
		};

		// Step-up sounds share the stride cooldown: any audible step-up
		// restarts the walking cadence so the two never overlap.
		this.playerVehicle.onAudibleStep = () => {
			this.#strideDistance = 0;
		};

		// Profiling keys: F5 dumps a frame-section report, F6 toggles far-tile
		// visibility for GPU-side A/B comparison (CPU sections vs rAF delta).
		window.addEventListener("keydown", this.#profilerKeyDown);
	}

	#profilerKeyDown = (e: KeyboardEvent): void => {
		const key = e.key.toLowerCase();
		if (key === "f5") {
			e.preventDefault();
			frameProfiler.logReport();
			PlayerHud.updateDebugInfo(
				"Profiler",
				frameProfiler.summaryLine(),
				"profiler",
			);
		} else if (key === "f6") {
			e.preventDefault();
			const next = !FarTileManager.isFarTilesVisible();
			FarTileManager.setFarTilesVisible(next);
			console.info(`[Profiler] far tiles visible: ${next}`);
		}
	};

	#gpuLagFrameCounter = 0;
	#pendingGpuLagMs = 0;

	public tick(deltaMs: number): void {
		const frameStart = performance.now();
		const dtSec = deltaMs * 0.001;

		// Batch the whole tick wave: a flood tick can write hundreds of blocks;
		// coalescing turns that into one remesh per touched chunk instead of
		// dozens of intermediate rebuilds.
		frameProfiler.begin("blockTicks");
		Chunk.beginBlockEditBatch();
		try {
			this.#blockTickScheduler.processFrame();
		} finally {
			Chunk.endBlockEditBatch();
		}
		frameProfiler.end("blockTicks");

		const vehicle = this.playerVehicle;
		const stats = this.playerStats;

		if (
			vehicle.isSprinting &&
			(vehicle.inputDirection.x !== 0 || vehicle.inputDirection.z !== 0) &&
			!stats.consumeStamina(4 * dtSec) &&
			stats.gamemode !== Gamemodes.Creative
		) {
			vehicle.isSprinting = false;
		}

		const camPos = this.playerCamera.position;
		const isUnderwater = isEyeUnderwater(camPos.x, camPos.y, camPos.z);

		if (isUnderwater) {
			if (
				!stats.consumeStamina(8 * dtSec) &&
				stats.gamemode !== Gamemodes.Creative
			) {
				stats.takeDamage(10 * dtSec);
			}
		}

		const uiOpen = isUiOpen();
		const playerPos = this.getPlayerPosition();

		frameProfiler.begin("pick");
		const pickHit = uiOpen ? null : this.pickTargetGated(playerPos);
		frameProfiler.end("pick");

		this.playerHud.crossHair.setTargetHit(pickHit);

		frameProfiler.begin("boats");
		CustomBoat.tickAllActiveBoats(this.scene, playerPos);
		frameProfiler.end("boats");

		frameProfiler.begin("physics");
		vehicle.update(deltaMs);

		this.updateSprintParticles(uiOpen, playerPos);
		this.updateFootsteps(uiOpen, playerPos, dtSec);

		stats.update(
			dtSec,
			vehicle.isSprinting,
			isUnderwater
				? 0
				: vehicle.isClimbing
					? stats.climbingStaminaRegenMultiplier
					: 1,
		);

		vehicle.updateCameraAndVisuals(deltaMs);
		frameProfiler.end("physics");

		frameProfiler.begin("controls");
		this.updateControls(uiOpen, pickHit);
		frameProfiler.end("controls");

		if (this.updateCaveState(playerPos.y)) {
			this.#loadLastCx = -99999;
		}

		const cx = worldToChunkCoord(playerPos.x);
		const cy = worldToChunkCoord(playerPos.y);
		const cz = worldToChunkCoord(playerPos.z);

		// Chunk streaming / distant terrain run in #streamTick (installed when
		// the spawn is prepared) — see #installStreaming.

		this.#updateActiveMeshSelection(cx, cy, cz);

		frameProfiler.begin("occlusion");
		this.#occlusionCuller.update(this.#lastOcclusionStats);
		frameProfiler.end("occlusion");

		// Best-effort GPU-lag probe: how long the queue takes to drain all
		// work submitted so far. Sampled every 30th frame — the promise itself
		// is cheap but not free. The async result is buffered and injected
		// into the frame right before endFrame (noteSectionValue drops
		// samples that land inside an open section).
		if (++this.#gpuLagFrameCounter % 30 === 0 && Map1.engine) {
			const submittedAt = performance.now();
			void onGpuWorkDone(Map1.engine).then(() => {
				this.#pendingGpuLagMs = performance.now() - submittedAt;
			});
		}

		const frameMs = performance.now() - frameStart;
		this.#mainThreadMs = this.#mainThreadMs * 0.9 + frameMs * 0.1;

		frameProfiler.begin("hud");
		this.updateDebugHud(deltaMs, cx, cy, cz);
		frameProfiler.end("hud");

		this.#freezeActiveMeshes();

		if (this.#pendingGpuLagMs > 0) {
			frameProfiler.noteSectionValue("gpuLag", this.#pendingGpuLagMs);
			this.#pendingGpuLagMs = 0;
		}

		frameProfiler.endFrame(deltaMs);
	}

	public dispose(): void {
		window.removeEventListener("keydown", this.#profilerKeyDown);
		if (this.#offSpawnPrepared) {
			this.#offSpawnPrepared();
			this.#offSpawnPrepared = null;
		}
		if (this.#previousOnChunkLoaded !== null) {
			Chunk.onChunkLoaded = this.#previousOnChunkLoaded;
			this.#previousOnChunkLoaded = null;
		}
	}

	pickTargetGated(playerPos: {
		x: number;
		y: number;
		z: number;
	}): BlockRaycastHit | null {
		const yaw = this.playerCamera.cameraYaw;
		const pitch = this.playerCamera.cameraPitch;

		const still =
			Math.abs(playerPos.x - this.#pickLastX) < 0.001 &&
			Math.abs(playerPos.y - this.#pickLastY) < 0.001 &&
			Math.abs(playerPos.z - this.#pickLastZ) < 0.001 &&
			Math.abs(yaw - this.#pickLastYaw) < 0.001 &&
			Math.abs(pitch - this.#pickLastPitch) < 0.001;

		if (
			still &&
			this.#pickStillFrames < PlayerLoopController.PICK_STILL_REFRESH_FRAMES
		) {
			this.#pickStillFrames++;
			return this.#pickCachedHit;
		}

		this.#pickLastX = playerPos.x;
		this.#pickLastY = playerPos.y;
		this.#pickLastZ = playerPos.z;
		this.#pickLastYaw = yaw;
		this.#pickLastPitch = pitch;
		this.#pickStillFrames = 0;
		this.#pickCachedHit = pickTarget(this.playerHud.player);

		return this.#pickCachedHit;
	}

	updateControls(uiOpen: boolean, hit?: BlockRaycastHit | null): void {
		const controls = this.getKeyboardControls();
		const type = controls.controlType;

		if (type !== "walking" && type !== "customBoat" && type !== "paddleBoat") {
			return;
		}

		if (uiOpen) {
			const c = controls as unknown as {
				stopBlockBreaking?: () => void;
				cancelDraw?: () => void;
			};
			c.stopBlockBreaking?.();
			c.cancelDraw?.();
			return;
		}

		(
			controls as unknown as { update(hit?: BlockRaycastHit | null): void }
		).update(hit);
	}

	updateSprintParticles(
		uiOpen: boolean,
		playerPos: { x: number; y: number; z: number },
	): void {
		const vehicle = this.playerVehicle;

		if (uiOpen || !vehicle.isSprinting || vehicle.isFlying) {
			return;
		}

		const vel = vehicle.velocity;
		if (vel.x * vel.x + vel.z * vel.z < 4) {
			return;
		}

		playSprint(
			this.#sprintEmitter,
			playerPos.x,
			playerPos.y - 0.85,
			playerPos.z,
			vel.x,
			vel.z,
		);
	}

	/**
	 * Footstep sounds from stride distance. Plays the ground material's
	 * footstep (or a splash when wading) every ~2m walked / ~2.6m sprinted.
	 * Riding, flying, climbing, and UI-open states stay silent.
	 */
	updateFootsteps(
		uiOpen: boolean,
		playerPos: { x: number; y: number; z: number },
		dtSec: number,
	): void {
		const vehicle = this.playerVehicle;

		if (
			uiOpen ||
			vehicle.isMounted ||
			vehicle.isFlying ||
			vehicle.isClimbing ||
			!vehicle.isGrounded
		) {
			this.#strideDistance = 0;
			return;
		}

		const vel = vehicle.velocity;
		const horizontalSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

		if (horizontalSpeed < 1.2 || dtSec <= 0) {
			this.#strideDistance = 0;
			return;
		}

		this.#strideDistance += horizontalSpeed * dtSec;

		const stride = vehicle.isSprinting ? 2.6 : 2.0;
		if (this.#strideDistance < stride) {
			return;
		}
		// Hold at threshold while the shared cooldown suppresses us so at
		// most one step stays pending — it fires as soon as the gate opens
		// instead of bursting afterwards.
		this.#strideDistance = stride;

		const intensity = Math.min(1, Math.max(0.4, horizontalSpeed / 6));

		// Feet sit ~0.85 below the body origin (cf. sprint dust); scan down
		// for the first solid block so slabs and half-steps resolve.
		const blockX = Math.floor(playerPos.x);
		const blockZ = Math.floor(playerPos.z);
		const feetBlockY = Math.floor(playerPos.y - 0.85);

		for (let d = 0; d <= 2; d++) {
			const blockId = getBlockByWorldCoords(blockX, feetBlockY - d, blockZ);

			if (blockId === BlockType.Water) {
				if (playFootstep(blockId, intensity)) this.#strideDistance = 0;
				return;
			}

			if (isCollidableBlock(blockId)) {
				if (playFootstep(blockId, intensity)) this.#strideDistance = 0;
				return;
			}
		}

		// No ground found (world edge): drop the pending step.
		this.#strideDistance = 0;
	}

	updateCaveState(playerY: number): boolean {
		const inCave = playerY <= -16;

		if (inCave === this.#lastCaveState) {
			return false;
		}

		this.#lastCaveState = inCave;
		setInCave(inCave);
		return true;
	}

	updateChunksAroundPlayer(
		cx: number,
		cy: number,
		cz: number,
		playerPos: { x: number; z: number },
	): void {
		if (
			cx === this.#loadLastCx &&
			cy === this.#loadLastCy &&
			cz === this.#loadLastCz
		) {
			return;
		}

		const prevCx = this.#loadLastCx;
		const prevCy = this.#loadLastCy;
		const prevCz = this.#loadLastCz;

		this.#loadLastCx = cx;
		this.#loadLastCy = cy;
		this.#loadLastCz = cz;

		void updateChunksAround(
			cx,
			cy,
			cz,
			undefined,
			undefined,
			prevCx,
			prevCy,
			prevCz,
			playerPos.x,
			playerPos.z,
		);
	}

	/**
	 * Installed exactly once, when the world spawn is prepared (server
	 * SpawnPosition or the singleplayer fallback). Registers its own per-frame
	 * scene hook — onBeforeRender prepends, so it runs first each frame — and
	 * tick() stays free of any spawn-state gating. #loadLast* is pre-absorbed
	 * at the still-current pre-teleport position so the teleport performed by
	 * PlayerLoadingGate later that same frame is what triggers the first real
	 * chunk update, never the origin.
	 */
	#installStreaming(): void {
		const pos = this.getPlayerPosition();
		this.#loadLastCx = worldToChunkCoord(pos.x);
		this.#loadLastCy = worldToChunkCoord(pos.y);
		this.#loadLastCz = worldToChunkCoord(pos.z);
		onBeforeRender(this.scene, () => {
			this.streamTick();
		});
	}

	streamTick(): void {
		frameProfiler.begin("streaming");
		const pos = this.getPlayerPosition();
		updateDistantTerrain(pos.x, pos.z);
		const cx = worldToChunkCoord(pos.x);
		const cy = worldToChunkCoord(pos.y);
		const cz = worldToChunkCoord(pos.z);
		this.updateChunksAroundPlayer(cx, cy, cz, pos);
		try {
			void processFrameBudgetedStreamingWork(cx, cy, cz);
		} catch (err) {
			console.error("[T0-ERR] processFrameBudgetedStreamingWork threw:", err);
		}
		frameProfiler.end("streaming");
	}

	#frozenOnce = false;
	#cameraStillFrames = 0;
	static readonly FREEZE_DELAY_FRAMES = 4;

	#updateActiveMeshSelection(cx: number, cy: number, cz: number): void {
		const yaw = this.playerCamera.cameraYaw;
		const pitch = this.playerCamera.cameraPitch;

		const chunkChanged =
			cx !== this.#amLastCx || cy !== this.#amLastCy || cz !== this.#amLastCz;
		const cameraMoved =
			yaw !== this.#prevCameraYaw || pitch !== this.#prevCameraPitch;

		if (chunkChanged) {
			this.#amLastCx = cx;
			this.#amLastCy = cy;
			this.#amLastCz = cz;
		}

		if (cameraMoved) {
			this.#prevCameraYaw = yaw;
			this.#prevCameraPitch = pitch;
		}

		if (chunkChanged || cameraMoved) {
			this.#cameraStillFrames = 0;
			this.#rebuildActiveMeshes = false;
			this.#frozenOnce = false;
			return;
		}

		this.#cameraStillFrames++;

		if (
			this.#cameraStillFrames === PlayerLoopController.FREEZE_DELAY_FRAMES &&
			!this.#frozenOnce
		) {
			this.#rebuildActiveMeshes = true;
		}
	}

	#freezeActiveMeshes(): void {
		if (!this.#rebuildActiveMeshes || this.#frozenOnce) {
			return;
		}

		this.#frozenOnce = true;
		this.#rebuildActiveMeshes = false;
	}

	updateDebugHud(
		deltaMs: number,
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): void {
		this.playerHud.updateStats();

		if (!PlayerHud.debugPanelVisible) {
			return;
		}

		const now = performance.now();
		if (
			now - this.#lastDebugHudUpdateMs <
			PlayerLoopController.DEBUG_HUD_INTERVAL_MS
		) {
			return;
		}

		this.#lastDebugHudUpdateMs = now;

		const playerPos = this.getPlayerPosition();
		const cam = this.playerCamera;
		const cameraPos = cam.position;
		const cameraYaw = cam.cameraYaw;
		const cameraPitch = cam.cameraPitch;
		const floorX = Math.floor(playerPos.x);
		const floorZ = Math.floor(playerPos.z);

		PlayerHud.updateDebugInfo(
			"FPS",
			deltaMs > 0 ? (1000 / deltaMs).toFixed() : "0",
			"performance",
		);
		PlayerHud.updateDebugInfo("Frame Ms", deltaMs.toFixed(1), "performance");
		PlayerHud.updateDebugInfo(
			"Main Thread Ms",
			this.#mainThreadMs.toFixed(1),
			"performance",
		);

		PlayerHud.updateDebugInfo(
			"Player Pos",
			`${playerPos.x.toFixed(2)}, ${playerPos.y.toFixed(2)}, ${playerPos.z.toFixed(2)}`,
			"position",
		);
		PlayerHud.updateDebugInfo(
			"Chunk Pos",
			`${chunkX}, ${chunkY}, ${chunkZ}`,
			"position",
		);
		PlayerHud.updateDebugInfo(
			"Camera Pos",
			`${cameraPos.x.toFixed(2)}, ${cameraPos.y.toFixed(2)}, ${cameraPos.z.toFixed(2)}`,
			"position",
		);
		PlayerHud.updateDebugInfo(
			"Camera Angle",
			`Yaw: ${cameraYaw.toFixed(2)}, Pitch: ${cameraPitch.toFixed(2)}`,
			"position",
		);
		PlayerHud.updateDebugInfo(
			"Facing",
			this.#directionFromYaw(cameraYaw),
			"position",
		);

		PlayerHud.updateDebugInfo("Biome", getBiome(floorX, floorZ).name, "biome");

		const terrainNoise = getTerrainNoiseDebug(floorX, floorZ);

		PlayerHud.updateDebugInfo(
			"Continent",
			terrainNoise.continent.toFixed(3),
			"biome",
		);
		PlayerHud.updateDebugInfo(
			"Temperature",
			terrainNoise.temperature.toFixed(3),
			"biome",
		);
		PlayerHud.updateDebugInfo(
			"Humidity",
			terrainNoise.humidity.toFixed(3),
			"biome",
		);
		PlayerHud.updateDebugInfo(
			"Erosion",
			terrainNoise.erosion.toFixed(3),
			"biome",
		);
		PlayerHud.updateDebugInfo("P&V", terrainNoise.pv.toFixed(3), "biome");
		PlayerHud.updateDebugInfo(
			"River Noise",
			terrainNoise.river.toFixed(3),
			"biome",
		);
		PlayerHud.updateDebugInfo(
			"Height",
			getFinalTerrainHeight(floorX, floorZ),
			"biome",
		);

		PlayerHud.updateDebugInfo(
			"Loaded Chunks",
			Chunk.loadedChunks.size,
			"chunks",
		);

		const occ = this.#lastOcclusionStats;
		PlayerHud.updateDebugInfo(
			"Occlusion",
			`${occ.occluded}/${occ.total} culled (${occ.timeMs.toFixed(1)}ms)`,
			"chunks",
		);

		const loadStats = getDebugStats();
		const workerStats = ChunkWorkerPool.getInstance().getDebugStats();

		PlayerHud.updateDebugInfo(
			"Chunk Queues",
			`L:${loadStats.loadQueueLength} U:${loadStats.unloadQueueLength} B:${loadStats.loadBatchLimit}/${loadStats.unloadBatchLimit}`,
			"chunks",
		);
		PlayerHud.updateDebugInfo(
			"Chunk Loop",
			`${loadStats.lastProcessMs.toFixed(2)}ms (budget ${loadStats.frameBudgetMs.toFixed(1)}ms)`,
			"chunks",
		);
		PlayerHud.updateDebugInfo(
			"Chunk I/O",
			`load:${loadStats.lastLoadedFromStorage} gen:${loadStats.lastGenerated} hyd:${loadStats.lastHydrated} unload:${loadStats.lastUnloaded} save:${loadStats.lastSaved}`,
			"chunks",
		);
		PlayerHud.updateDebugInfo(
			"Worker Queues",
			`T:${workerStats.terrainQueueLength} R:${workerStats.remeshQueueLength} P:${workerStats.lodPrecomputeQueueLength} D:${workerStats.distantTerrainQueueLength} DL:${workerStats.deferredLightingQueueLength} busy:${workerStats.busyWorkers}/${workerStats.workerCount} idle:${workerStats.idleWorkers}`,
			"workers",
		);
		PlayerHud.updateDebugInfo(
			"Worker Idle %",
			workerStats.workerCount > 0
				? ((workerStats.idleWorkers / workerStats.workerCount) * 100).toFixed(0)
				: "0",
			"workers",
		);
		PlayerHud.updateDebugInfo(
			"Deferred Light",
			`seed:${workerStats.deferredLightingSeedStateCount} pump:${workerStats.deferredLightingPumpScheduled ? "on" : "off"} enq:${workerStats.deferredLightingEnqueuedTotal} repl:${workerStats.deferredLightingSeedReplacedTotal} proc:${workerStats.deferredLightingProcessedLastFrame}/${workerStats.deferredLightingProcessedTotal} drop:${workerStats.deferredLightingDroppedTotal}`,
			"workers",
		);
		PlayerHud.updateDebugInfo(
			"Worker Dispatch",
			`last:${workerStats.lastDispatchCount} total:${workerStats.totalDispatchCount} budget:${workerStats.dispatchBudgetPerTick || "inf"}`,
			"workers",
		);

		const meshStats = getMergedMeshFlushStats();
		PlayerHud.updateDebugInfo(
			"Mesh Build",
			`${meshStats.lastMs.toFixed(1)}ms (avg ${meshStats.avgMs.toFixed(1)}ms)`,
			"workers",
		);

		const mem = getPackedMeshMemoryStats();
		const layers = getMergedLayerMemoryStats();
		const mib = (b: number) => `${(b / 1048576).toFixed(1)}`;
		PlayerHud.updateDebugInfo(
			"Mesh Memory",
			`inst:${mib(mem.instanceBytes)} arenas:${mib(mem.arenaBytes)} ` +
				`(${mem.arenaUsedFaces}/${mem.arenaCapacityFaces}f) ` +
				`off:${mib(mem.offsetBytes)} grp:${layers.groups}/${mib(layers.layerBytes)}MiB`,
			"workers",
		);

		const census = Chunk.getCensus();
		PlayerHud.updateDebugInfo(
			"Chunk Census",
			`total:${census.total} vox:${census.withVoxels} ` +
				`lod<=1:${census.lodLow} lod2-3:${census.lodMid} lod4+:${census.lodHigh} ` +
				`meshes:${census.cachedMeshEntries}/${mib(census.cachedMeshBytes)}MiB`,
			"workers",
		);

		const dispatchHistogram = this.#formatTopDispatchWorkers(
			workerStats.workerDispatchCounts,
		);
		const recentWorkers = this.#formatRecentWorkers(
			workerStats.lastDispatchWorkerIndices,
		);

		PlayerHud.updateDebugInfo(
			"Worker Dist",
			`peakBusy:${workerStats.peakBusyWorkers} top:[${dispatchHistogram}] recent:[${recentWorkers}]`,
			"workers",
		);
		PlayerHud.updateDebugInfo(
			"Mesh Drain",
			`${workerStats.lastMeshProcessed} in ${workerStats.lastMeshDrainMs.toFixed(2)}ms`,
			"workers",
		);

		const farStats = FarTileManager.getDebugStats();
		if (farStats) {
			const kib = (b: number) => `${(b / 1024).toFixed(0)}KiB`;
			const levelSummary = farStats.levels
				.map(
					(l, i) =>
						`L${i}:${l.faces}/${l.capacity}f(${l.straight}+${l.reversed})`,
				)
				.join(" ");
			PlayerHud.updateDebugInfo(
				"Far Tiles",
				`tiles:${farStats.tiles} pend:${farStats.pending} water:${farStats.water.faces}f origins:${farStats.origins.used}/${farStats.origins.capacity}`,
				"far",
			);
			PlayerHud.updateDebugInfo(
				"Far Detail",
				`${levelSummary} up:${kib(farStats.uploadBytes)}/f`,
				"far",
			);
		}

		PlayerHud.updateDebugInfo(
			"Profiler",
			frameProfiler.summaryLine(),
			"profiler",
		);

		PlayerHud.updateDebugInfo(
			"Health",
			Math.ceil(this.playerStats.health),
			"stats",
		);
		PlayerHud.updateDebugInfo(
			"Hunger",
			Math.ceil(this.playerStats.hunger),
			"stats",
		);
		PlayerHud.updateDebugInfo(
			"Stamina",
			Math.ceil(this.playerStats.stamina),
			"stats",
		);
		PlayerHud.updateDebugInfo(
			"Mana",
			Math.ceil(this.playerStats.mana),
			"stats",
		);

		const localStats = Map1.mobRegistry?.getDebugStats();
		const remoteStats = Map1.remoteMobManager?.getDebugStats();
		if (!localStats && !remoteStats) {
			return;
		}

		if (localStats) {
			// Cap accounting covers only naturally spawned mobs; spawn-egg
			// mobs are cap-exempt and shown as a "+N" suffix when present.
			const eggCount = localStats.total - localStats.naturalTotal;
			const mobLabel =
				eggCount > 0
					? `${localStats.naturalTotal}/${localStats.cap} (+${eggCount})`
					: `${localStats.naturalTotal}/${localStats.cap}`;

			PlayerHud.updateDebugInfo("Mobs", mobLabel, "mobs");

			let breakdown = "";
			for (let i = 0; i < localStats.perType.length; i++) {
				const t = localStats.perType[i];
				if (i > 0) breakdown += "  ";
				breakdown += `${t.type}:${t.natural}/${t.max}`;
			}

			PlayerHud.updateDebugInfo("Mob Types", breakdown || "-", "mobs");
		}

		if (remoteStats) {
			PlayerHud.updateDebugInfo("Mobs", `${remoteStats.total}`, "mobs");

			let breakdown = "";
			for (let i = 0; i < remoteStats.perType.length; i++) {
				const t = remoteStats.perType[i];
				if (i > 0) breakdown += "  ";
				breakdown += `${MOB_TYPE_NAMES[t.typeId] ?? `type${t.typeId}`}:${t.count}`;
			}

			PlayerHud.updateDebugInfo("Mob Types", breakdown || "-", "mobs");
		}
	}

	#formatTopDispatchWorkers(counts: readonly number[]): string {
		_topDispatchIndices[0] = -1;
		_topDispatchIndices[1] = -1;
		_topDispatchIndices[2] = -1;
		_topDispatchIndices[3] = -1;

		_topDispatchCounts[0] = 0;
		_topDispatchCounts[1] = 0;
		_topDispatchCounts[2] = 0;
		_topDispatchCounts[3] = 0;

		for (let index = 0; index < counts.length; index++) {
			const count = counts[index];
			if (count <= 0 || count <= _topDispatchCounts[3]) {
				continue;
			}

			let slot = 3;
			while (slot > 0 && count > _topDispatchCounts[slot - 1]) {
				_topDispatchCounts[slot] = _topDispatchCounts[slot - 1];
				_topDispatchIndices[slot] = _topDispatchIndices[slot - 1];
				slot--;
			}

			_topDispatchCounts[slot] = count;
			_topDispatchIndices[slot] = index;
		}

		let out = "";
		for (let i = 0; i < 4; i++) {
			const index = _topDispatchIndices[i];
			if (index < 0) {
				break;
			}

			if (out.length > 0) {
				out += " ";
			}

			out += `${index}:${_topDispatchCounts[i]}`;
		}

		return out || "-";
	}

	#formatRecentWorkers(indices: readonly number[]): string {
		const len = indices.length;
		const start = len > 8 ? len - 8 : 0;

		let out = "";
		for (let i = start; i < len; i++) {
			if (i > start) {
				out += ",";
			}

			out += String(indices[i]);
		}

		return out || "-";
	}

	static readonly #DIRECTION_NAMES = [
		"West",
		"North-West",
		"North",
		"North-East",
		"East",
		"South-East",
		"South",
		"South-West",
	] as const;

	#directionFromYaw(yaw: number): string {
		const degrees = (yaw * (180 / Math.PI)) % 360;
		const normalizedDeg = degrees + (degrees < 0 ? 360 : 0);
		const index = Math.round(normalizedDeg / 45) & 7;

		return PlayerLoopController.#DIRECTION_NAMES[index];
	}
}
