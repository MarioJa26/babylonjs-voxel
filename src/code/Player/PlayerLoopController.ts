import { type SceneContext, type Vec3, vec3 } from "@babylonjs/lite";
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
import { Map1 } from "../Maps/Map1";
import { Chunk } from "../World/Chunk/Chunk";
import {
	getDebugStats,
	processFrameBudgetedStreamingWork,
	refreshOpfsDebugStats,
	updateChunksAround,
} from "../World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "../World/Chunk/ChunkWorkerPool";
import { getMergedMeshFlushStats } from "../World/Chunk/MergedMeshManager";
import { BlockTickScheduler } from "../World/Chunk/Worker/BlockTickScheduler";
import { processWaterUpdate } from "../World/Chunk/Worker/WaterSimulation";
import { OcclusionCuller } from "../World/Occlusion/OcclusionCuller";
import {
	type BlockRaycastHit,
	pickTarget,
} from "./Hud/BlockHighlight/BlockRaycaster";
import { PlayerHud } from "./Hud/PlayerHud";
import type { PlayerCamera } from "./PlayerCamera";
import { Gamemodes, type PlayerStats } from "./PlayerStats";

// PERF: Reusable scratch for debug HUD dispatch histogram — avoids per-tick allocation.
const _indexedScratch: { count: number; index: number }[] = [];

// Lite port: the classic-Babylon scene/engine accessors (onBeforeRenderObservable,
// freezeActiveMeshes, getFps, getDeltaTime, getActiveIndices, ...) are not on
// SceneContext/EngineContext. The frame loop is driven by the host (Player.tick
// via onBeforeRender), and the debug HUD derives timings from the frame delta.

export class PlayerLoopController {
	// ---- chunk-loading position tracking ----
	#loadLastCx = 0;
	#loadLastCy = 0;
	#loadLastCz = 0;

	// ---- active-mesh selection position tracking (separate from loading) ----
	#amLastCx = 0;
	#amLastCy = 0;
	#amLastCz = 0;
	#prevCameraYaw = 0;
	#prevCameraPitch = 0;
	#rebuildActiveMeshes = false;

	// ---- cave state ----
	#lastCaveState = false;

	// ---- occlusion culling ----
	#occlusionCuller = new OcclusionCuller();
	#lastOcclusionStats = { total: 0, occluded: 0, timeMs: 0 };

	// ---- debug HUD throttle ----
	#lastDebugHudUpdateMs = 0;
	// EMA-smoothed main-thread time spent inside onBeforeRender (game logic +
	// chunk streaming + occlusion). Excludes GPU render time — pair with
	// "Frame Ms" (engine.getDeltaTime) to see render-vs-logic split.
	#mainThreadMs = 0;
	static readonly DEBUG_HUD_INTERVAL_MS = 250;

	// ---- captured static callback for restore-on-dispose ----
	#previousOnChunkLoaded: typeof Chunk.onChunkLoaded | null = null;

	private readonly scene: SceneContext;

	constructor(
		scene: SceneContext,
		private readonly playerVehicle: {
			isSprinting: boolean;
			isClimbing: boolean;
			update(dt: number): void;
			updateCameraAndVisuals(): void;
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
		// Initialize water tick scheduler
		BlockTickScheduler.getInstance().setProcessCallback(processWaterUpdate);

		// Wire incremental occlusion culling for individual chunk loads
		this.#previousOnChunkLoaded = Chunk.onChunkLoaded;
		Chunk.onChunkLoaded = (chunk: Chunk) => {
			this.#previousOnChunkLoaded?.(chunk);
			this.#occlusionCuller.incrementalAdd(chunk);
		};
	}

	/**
	 * Per-frame update. Driven by the host loop (Player.tick → onBeforeRender),
	 * since Lite's SceneContext has no onBeforeRenderObservable to self-register.
	 */
	public tick(deltaMs: number): void {
		const dt = deltaMs;
		// Stats are tuned per-second; the frame delta arrives in milliseconds
		// (the motor converts internally). Normalize once for the stats path.
		const dtSec = deltaMs / 1000;
		const _frameStart = performance.now();

		BlockTickScheduler.getInstance().processFrame();

		if (this.playerVehicle.isSprinting) {
			if (
				!this.playerStats.consumeStamina(4 * dtSec) &&
				this.playerStats.gamemode !== Gamemodes.Creative
			) {
				this.playerVehicle.isSprinting = false;
			}
		}

		// Raycast once per frame — shared by crosshair highlight and block breaking.
		const pickHit = pickTarget(this.playerHud.player);
		this.playerHud.crossHair.setTargetHit(pickHit);

		// L1: Cache position once — reused by all sub-systems this frame.
		const playerPos = this.getPlayerPosition();

		updateDistantTerrain(playerPos.x, playerPos.z);

		// C3: tick all active boats (buoyancy + controls). Uses the player
		// position only for distance culling of out-of-range boats.
		CustomBoat.tickAllActiveBoats(
			this.scene,
			vec3(playerPos.x, playerPos.y, playerPos.z),
		);
		this.playerVehicle.update(dt);
		this.playerStats.update(
			dtSec,
			this.playerVehicle.isSprinting,
			this.playerVehicle.isClimbing
				? this.playerStats.climbingStaminaRegenMultiplier
				: 1,
		);
		this.playerVehicle.updateCameraAndVisuals();
		this.#updateControls(pickHit);
		if (this.#updateCaveState(playerPos.y)) {
			this.#loadLastCx = -99999;
		}
		const cx = worldToChunkCoord(playerPos.x);
		const cy = worldToChunkCoord(playerPos.y);
		const cz = worldToChunkCoord(playerPos.z);

		this.#updateChunksAroundPlayer(cx, cy, cz, playerPos);
		processFrameBudgetedStreamingWork(cx, cy, cz);

		this.#updateActiveMeshSelection(cx, cy, cz);

		// Occlusion culling – must run after chunk loading and before Lite evaluates the scene.
		this.#occlusionCuller.update(this.#lastOcclusionStats);

		// Main-thread work time for this frame (EMA-smoothed).
		const _frameMs = performance.now() - _frameStart;
		this.#mainThreadMs = this.#mainThreadMs * 0.9 + _frameMs * 0.1;

		this.#updateDebugHud(deltaMs);
		this.#freezeActiveMeshes();
	}

	public dispose(): void {
		if (this.#previousOnChunkLoaded !== null) {
			Chunk.onChunkLoaded = this.#previousOnChunkLoaded;
			this.#previousOnChunkLoaded = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Controls
	// ---------------------------------------------------------------------------

	#updateControls(hit?: BlockRaycastHit | null): void {
		const controls = this.getKeyboardControls();
		const type = controls.controlType;
		if (type === "walking" || type === "customBoat" || type === "paddleBoat") {
			// While a UI overlay (inventory / mason table) is open, suppress block
			// breaking progress and cancel any in-progress break so a held mouse
			// button doesn't keep mining behind the menu.
			if (isUiOpen()) {
				const maybe = controls as unknown as {
					stopBlockBreaking?: () => void;
				};
				maybe.stopBlockBreaking?.();
				return;
			}
			(
				controls as unknown as { update(hit?: BlockRaycastHit | null): void }
			).update(hit);
		}
	}

	// ---------------------------------------------------------------------------
	// Cave state
	// ---------------------------------------------------------------------------

	#updateCaveState(playerY: number): boolean {
		const inCave = playerY <= -16;
		if (inCave !== this.#lastCaveState) {
			this.#lastCaveState = inCave;
			setInCave(inCave);
			return true;
		}
		return false;
	}

	// ---------------------------------------------------------------------------
	// Chunk loading
	// ---------------------------------------------------------------------------

	#updateChunksAroundPlayer(
		cx: number,
		cy: number,
		cz: number,
		playerPos: { x: number; z: number },
	): void {
		if (
			cx !== this.#loadLastCx ||
			cy !== this.#loadLastCy ||
			cz !== this.#loadLastCz
		) {
			void updateChunksAround(
				cx,
				cy,
				cz,
				undefined,
				undefined,
				this.#loadLastCx,
				this.#loadLastCy,
				this.#loadLastCz,
				playerPos.x,
				playerPos.z,
			);
			this.#loadLastCx = cx;
			this.#loadLastCy = cy;
			this.#loadLastCz = cz;
		}
	}

	// ---------------------------------------------------------------------------
	// Active mesh selection
	// Uses its own #amLastCx/Y/Z — never touches chunk-loading state.
	// ---------------------------------------------------------------------------

	#frozenOnce = false;
	#cameraStillFrames = 0;
	static readonly FREEZE_DELAY_FRAMES = 4; // freeze after N still frames

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
			// Lite has no active-mesh freeze; reset the local freeze latch so a
			// later still-period can re-arm (no-op on the renderer side).
			this.#frozenOnce = false;
		} else {
			this.#cameraStillFrames++;
			// Schedule ONE freeze after the player has been still long enough.
			if (
				this.#cameraStillFrames === PlayerLoopController.FREEZE_DELAY_FRAMES &&
				!this.#frozenOnce
			) {
				this.#rebuildActiveMeshes = true;
			}
		}
	}

	#freezeActiveMeshes(): void {
		// Lite SceneContext exposes no active-mesh freeze API; chunk visibility is
		// already driven directly by the OcclusionCuller each frame. Keep the local
		// latch consistent so a future still-period re-arms cleanly.
		if (this.#rebuildActiveMeshes && !this.#frozenOnce) {
			this.#frozenOnce = true;
			this.#rebuildActiveMeshes = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Debug HUD
	// ---------------------------------------------------------------------------

	#updateDebugHud(deltaMs: number): void {
		this.playerHud.updateStats();
		if (PlayerHud.debugPanelDiv.style.display === "none") return;

		const now = performance.now();
		if (
			now - this.#lastDebugHudUpdateMs <
			PlayerLoopController.DEBUG_HUD_INTERVAL_MS
		)
			return;
		this.#lastDebugHudUpdateMs = now;

		const playerPos = this.getPlayerPosition();
		const chunkX = worldToChunkCoord(playerPos.x);
		const chunkY = worldToChunkCoord(playerPos.y);
		const chunkZ = worldToChunkCoord(playerPos.z);
		const cameraPos = this.playerCamera.position;
		const cameraYaw = this.playerCamera.cameraYaw;
		const cameraPitch = this.playerCamera.cameraPitch;

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
		PlayerHud.updateDebugInfo("Faces", "n/a", "performance");
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
		PlayerHud.updateDebugInfo(
			"Biome",
			getBiome(Math.floor(playerPos.x), Math.floor(playerPos.z)).name,
			"biome",
		);

		const terrainNoise = getTerrainNoiseDebug(
			Math.floor(playerPos.x),
			Math.floor(playerPos.z),
		);
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
			getFinalTerrainHeight(Math.floor(playerPos.x), Math.floor(playerPos.z)),
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
		void refreshOpfsDebugStats();

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
			"OPFS Mesh",
			`hits:${loadStats.lastOpfsHits} miss:${loadStats.lastOpfsMisses} ` +
				`used:${(loadStats.opfsUsedBytes / 1024 / 1024).toFixed(1)}MB / ` +
				`${(loadStats.opfsTotalBytes / 1024 / 1024).toFixed(0)}MB ` +
				`slots:${loadStats.opfsSlotCount} evicts:${loadStats.opfsEvictionCount}`,
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

		const counts = workerStats.workerDispatchCounts;
		// PERF: Reuse scratch array to avoid per-tick allocation.
		_indexedScratch.length = 0;
		for (let i = 0; i < counts.length; i++) {
			if (counts[i] > 0) _indexedScratch.push({ count: counts[i], index: i });
		}
		_indexedScratch.sort((a, b) => b.count - a.count);
		const limit = _indexedScratch.length < 4 ? _indexedScratch.length : 4;
		let dispatchHistogram = "";
		for (let i = 0; i < limit; i++) {
			if (i > 0) dispatchHistogram += " ";
			dispatchHistogram += `${_indexedScratch[i].index}:${_indexedScratch[i].count}`;
		}

		const indices = workerStats.lastDispatchWorkerIndices;
		const len = indices.length;
		const recentStart = len > 8 ? len - 8 : 0;
		let recentWorkers = "";
		for (let i = recentStart; i < len; i++) {
			if (i > recentStart) recentWorkers += ",";
			recentWorkers += String(indices[i]);
		}

		PlayerHud.updateDebugInfo(
			"Worker Dist",
			`peakBusy:${workerStats.peakBusyWorkers} top:[${dispatchHistogram || "-"}] recent:[${recentWorkers || "-"}]`,
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

		const mobStats = Map1.mobRegistry?.getDebugStats();
		if (mobStats) {
			PlayerHud.updateDebugInfo(
				"Mobs",
				`${mobStats.total}/${mobStats.cap}`,
				"mobs",
			);
			const breakdown = mobStats.perType
				.map((t) => `${t.type}:${t.count}/${t.max}`)
				.join("  ");
			PlayerHud.updateDebugInfo("Mob Types", breakdown || "-", "mobs");
		}
	}

	// Lookup table is faster than the original Math.round(degrees/45) path
	// because it avoids floating-point modular arithmetic at call-site.
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
		const normalizedDeg = (degrees + 360) % 360;
		const index = Math.round(normalizedDeg / 45) % 8;
		return PlayerLoopController.#DIRECTION_NAMES[index];
	}
}
