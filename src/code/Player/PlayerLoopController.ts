import type { Engine, Scene, Vector3 } from "@babylonjs/core";
import { CustomBoat } from "../Entities/CustomBoat";
import { getBiome } from "../Generation/TerrainHeightMap";
import type { IControls } from "../Interface/IControls";
import { Chunk } from "../World/Chunk/Chunk";
import {
	getDebugStats,
	processFrameBudgetedStreamingWork,
	refreshOpfsDebugStats,
	updateChunksAround,
	worldToChunkCoord,
} from "../World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "../World/Chunk/ChunkWorkerPool";
import { OcclusionCuller } from "../World/Occlusion/OcclusionCuller";
import {
	type BlockRaycastHit,
	pickTarget,
} from "./Hud/BlockHighlight/BlockRaycaster";
import { PlayerHud } from "./Hud/PlayerHud";
import type { IPlayerBody } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import type { PlayerStats } from "./PlayerStats";

export let isInCave = false;

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
	static readonly DEBUG_HUD_INTERVAL_MS = 250;

	constructor(
		private readonly engine: Engine,
		private readonly scene: Scene,
		private readonly playerVehicle: IPlayerBody,
		private readonly playerStats: PlayerStats,
		private readonly playerHud: PlayerHud,
		private readonly playerCamera: PlayerCamera,
		private readonly getKeyboardControls: () => IControls<unknown>,
		private readonly getPlayerPosition: () => Vector3,
	) {}

	public bind(): void {
		// Wire incremental occlusion culling for individual chunk loads
		const previousOnChunkLoaded = Chunk.onChunkLoaded;
		Chunk.onChunkLoaded = (chunk: Chunk) => {
			previousOnChunkLoaded?.(chunk);
			this.#occlusionCuller.incrementalAdd(chunk);
		};

		this.scene.onBeforeRenderObservable.add(() => {
			const dt = (this.scene.deltaTime || 0) / 1000;

			if (this.playerVehicle.isSprinting) {
				if (!this.playerStats.consumeStamina(4 * dt)) {
					this.playerVehicle.isSprinting = false;
				}
			}

			// Raycast once per frame — shared by crosshair highlight and block breaking.
			const pickHit = pickTarget(this.playerHud.player);
			this.playerHud.crossHair.setTargetHit(pickHit);

			// L1: Cache position once — reused by all sub-systems this frame.
			const playerPos = this.getPlayerPosition();

			CustomBoat.tickAllActiveBoats(this.scene, playerPos);
			this.playerVehicle.update(dt);
			this.playerStats.update(dt, this.playerVehicle.isSprinting);
			this.playerVehicle.updateCameraAndVisuals();
			this.#updateControls(pickHit);
			this.#updateCaveState(playerPos.y);
			const cx = worldToChunkCoord(playerPos.x);
			const cy = worldToChunkCoord(playerPos.y);
			const cz = worldToChunkCoord(playerPos.z);

			this.#updateChunksAroundPlayer(cx, cy, cz, playerPos);
			processFrameBudgetedStreamingWork(cx, cy, cz);
			this.#updateActiveMeshSelection(cx, cy, cz);

			// Occlusion culling – must run after chunk loading and before Babylon evaluates the scene.
			this.#lastOcclusionStats = this.#occlusionCuller.update(this.scene);
		});

		this.scene.onAfterRenderObservable.add(() => {
			this.#updateDebugHud();
			this.#freezeActiveMeshes();
		});
	}

	// ---------------------------------------------------------------------------
	// Controls
	// ---------------------------------------------------------------------------

	#updateControls(hit?: BlockRaycastHit | null): void {
		const controls = this.getKeyboardControls();
		const type = controls.controlType;
		if (type === "walking" || type === "customBoat" || type === "paddleBoat") {
			(
				controls as unknown as { update(hit?: BlockRaycastHit | null): void }
			).update(hit);
		}
	}

	// ---------------------------------------------------------------------------
	// Cave state
	// ---------------------------------------------------------------------------

	#updateCaveState(playerY: number): void {
		const inCave = playerY <= -16;
		if (inCave !== this.#lastCaveState) {
			this.#lastCaveState = inCave;
			isInCave = inCave;
		}
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
			// Unfreeze so Babylon rebuilds the active mesh list this frame.
			if ((this.scene as Scene)._activeMeshesFrozen) {
				(this.scene as Scene)._activeMeshesFrozen = false;
				this.#frozenOnce = false;
			}
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
		if (this.#rebuildActiveMeshes && !this.#frozenOnce) {
			this.scene.freezeActiveMeshes(true, undefined, undefined, false);
			this.#frozenOnce = true;
			this.#rebuildActiveMeshes = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Debug HUD
	// ---------------------------------------------------------------------------

	#updateDebugHud(): void {
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
			this.engine.getFps().toFixed(),
			"performance",
		);
		PlayerHud.updateDebugInfo(
			"Faces",
			this.scene.getActiveIndices() / 3,
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
		PlayerHud.updateDebugInfo(
			"Biome",
			getBiome(Math.floor(playerPos.x), Math.floor(playerPos.z)).name,
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
			"Deferred Light",
			`seed:${workerStats.deferredLightingSeedStateCount} pump:${workerStats.deferredLightingPumpScheduled ? "on" : "off"} enq:${workerStats.deferredLightingEnqueuedTotal} repl:${workerStats.deferredLightingSeedReplacedTotal} proc:${workerStats.deferredLightingProcessedLastFrame}/${workerStats.deferredLightingProcessedTotal} drop:${workerStats.deferredLightingDroppedTotal}`,
			"workers",
		);
		PlayerHud.updateDebugInfo(
			"Worker Dispatch",
			`last:${workerStats.lastDispatchCount} total:${workerStats.totalDispatchCount} budget:${workerStats.dispatchBudgetPerTick || "inf"}`,
			"workers",
		);

		const counts = workerStats.workerDispatchCounts;
		const indexed: { count: number; index: number }[] = [];
		for (let i = 0; i < counts.length; i++) {
			if (counts[i] > 0) indexed.push({ count: counts[i], index: i });
		}
		indexed.sort((a, b) => b.count - a.count);
		const limit = indexed.length < 4 ? indexed.length : 4;
		let dispatchHistogram = "";
		for (let i = 0; i < limit; i++) {
			if (i > 0) dispatchHistogram += " ";
			dispatchHistogram += `${indexed[i].index}:${indexed[i].count}`;
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
