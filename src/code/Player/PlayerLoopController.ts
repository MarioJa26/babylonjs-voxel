// Add these module-level reusable scratch buffers near _indexedScratch.

import { onBeforeRender, type SceneContext, type Vec3 } from "@babylonjs/lite";
import { CustomBoat } from "../Entities/CustomBoat";
import { update as updateDistantTerrain } from "../Generation/DistantTerrain/DistantTerrain";
import {
	getBiome,
	getFinalTerrainHeight,
	getTerrainNoiseDebug,
} from "../Generation/TerrainHeightMap";
import type { IControls } from "../Interface/IControls";
import { isUiOpen, setInCave } from "../Lib/GameRuntimeState";
import { worldToChunkCoord } from "../Lib/VoxelMath";
import { playSprint } from "../Maps/BlockBreakParticles";
import { Map1 } from "../Maps/Map1";
import { MobTypeId } from "../Network/protocol/messages";
import { Chunk } from "../World/Chunk/Chunk";
import {
	getDebugStats,
	processFrameBudgetedStreamingWork,
	updateChunksAround,
} from "../World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "../World/Chunk/ChunkWorkerPool";
import { getMergedMeshFlushStats } from "../World/Chunk/MergedMeshManager";
import { BlockTickScheduler } from "../World/Chunk/Worker/BlockTickScheduler";
import { processWaterUpdate } from "../World/Chunk/Worker/WaterSimulation";
import { OcclusionCuller } from "../World/Occlusion/OcclusionCuller";
import { onSpawnPrepared } from "../World/SpawnPoint";
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
	static readonly DEBUG_HUD_INTERVAL_MS = 250;

	// ---- captured static callback for restore-on-dispose ----
	#previousOnChunkLoaded: typeof Chunk.onChunkLoaded | null = null;

	// Cache singleton instead of resolving it multiple times in hot paths.
	#blockTickScheduler = BlockTickScheduler.getInstance();

	private readonly scene: SceneContext;

	constructor(
		scene: SceneContext,
		private readonly playerVehicle: {
			isSprinting: boolean;
			isClimbing: boolean;
			isFlying: boolean;
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
	}

	public tick(deltaMs: number): void {
		const frameStart = performance.now();
		const dtSec = deltaMs * 0.001;

		this.#blockTickScheduler.processFrame();

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

		const uiOpen = isUiOpen();
		const playerPos = this.getPlayerPosition();
		const pickHit = uiOpen ? null : this.#pickTargetGated(playerPos);

		this.playerHud.crossHair.setTargetHit(pickHit);

		CustomBoat.tickAllActiveBoats(this.scene, playerPos);

		vehicle.update(deltaMs);

		this.#updateSprintParticles(uiOpen, playerPos);

		stats.update(
			dtSec,
			vehicle.isSprinting,
			vehicle.isClimbing ? stats.climbingStaminaRegenMultiplier : 1,
		);

		vehicle.updateCameraAndVisuals(deltaMs);
		this.#updateControls(uiOpen, pickHit);

		if (this.#updateCaveState(playerPos.y)) {
			this.#loadLastCx = -99999;
		}

		const cx = worldToChunkCoord(playerPos.x);
		const cy = worldToChunkCoord(playerPos.y);
		const cz = worldToChunkCoord(playerPos.z);

		// Chunk streaming / distant terrain run in #streamTick (installed when
		// the spawn is prepared) — see #installStreaming.

		this.#updateActiveMeshSelection(cx, cy, cz);

		this.#occlusionCuller.update(this.#lastOcclusionStats);

		const frameMs = performance.now() - frameStart;
		this.#mainThreadMs = this.#mainThreadMs * 0.9 + frameMs * 0.1;

		this.#updateDebugHud(deltaMs, cx, cy, cz);
		this.#freezeActiveMeshes();
	}

	public dispose(): void {
		if (this.#offSpawnPrepared) {
			this.#offSpawnPrepared();
			this.#offSpawnPrepared = null;
		}
		if (this.#previousOnChunkLoaded !== null) {
			Chunk.onChunkLoaded = this.#previousOnChunkLoaded;
			this.#previousOnChunkLoaded = null;
		}
	}

	#pickTargetGated(playerPos: {
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

	#updateControls(uiOpen: boolean, hit?: BlockRaycastHit | null): void {
		const controls = this.getKeyboardControls();
		const type = controls.controlType;

		if (type !== "walking" && type !== "customBoat" && type !== "paddleBoat") {
			return;
		}

		if (uiOpen) {
			(
				controls as unknown as { stopBlockBreaking?: () => void }
			).stopBlockBreaking?.();
			return;
		}

		(
			controls as unknown as { update(hit?: BlockRaycastHit | null): void }
		).update(hit);
	}

	#updateSprintParticles(
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
			this.scene,
			playerPos.x,
			playerPos.y - 0.85,
			playerPos.z,
			vel.x,
			vel.z,
		);
	}

	#updateCaveState(playerY: number): boolean {
		const inCave = playerY <= -16;

		if (inCave === this.#lastCaveState) {
			return false;
		}

		this.#lastCaveState = inCave;
		setInCave(inCave);
		return true;
	}

	#updateChunksAroundPlayer(
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
			this.#streamTick();
		});
	}

	#streamTick(): void {
		const pos = this.getPlayerPosition();
		updateDistantTerrain(pos.x, pos.z);
		const cx = worldToChunkCoord(pos.x);
		const cy = worldToChunkCoord(pos.y);
		const cz = worldToChunkCoord(pos.z);
		this.#updateChunksAroundPlayer(cx, cy, cz, pos);
		try {
			void processFrameBudgetedStreamingWork(cx, cy, cz);
		} catch (err) {
			console.error("[T0-ERR] processFrameBudgetedStreamingWork threw:", err);
		}
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

	#updateDebugHud(
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
			PlayerHud.updateDebugInfo(
				"Mobs",
				`${localStats.total}/${localStats.cap}`,
				"mobs",
			);

			let breakdown = "";
			for (let i = 0; i < localStats.perType.length; i++) {
				const t = localStats.perType[i];
				if (i > 0) breakdown += "  ";
				breakdown += `${t.type}:${t.count}/${t.max}`;
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
