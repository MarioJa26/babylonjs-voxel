import type { Engine, Scene, Vector3 } from "@babylonjs/core";
import { CustomBoat } from "../Entities/CustomBoat";
import { getBiome } from "../Generation/TerrainHeightMap";
import type { IControls } from "../Inferface/IControls";
import { Chunk } from "../World/Chunk/Chunk";
import {
	getDebugStats,
	processFrameBudgetedStreamingWork,
	updateChunksAround,
	worldToChunkCoord,
} from "../World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "../World/Chunk/ChunkWorkerPool";
import { PlayerHud } from "./Hud/PlayerHud";
import type { IPlayerBody } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import type { PlayerStats } from "./PlayerStats";

export class PlayerLoopController {
	#lastChunkX = 0;
	#lastChunkY = 0;
	#lastChunkZ = 0;

	#prevCameraYaw = 0;
	#prevCameraPitch = 0;
	#frameCount = 0;
	#rebuildActiveMeshes = false;

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
		this.scene.onBeforeRenderObservable.add(() => {
			const dt = (this.scene.deltaTime || 0) / 1000;

			if (this.playerVehicle.isSprinting) {
				if (!this.playerStats.consumeStamina(4 * dt)) {
					this.playerVehicle.isSprinting = false;
				}
			}

			CustomBoat.tickAllActiveBoats(this.scene);
			this.playerVehicle.update(dt);
			this.playerStats.update(dt, this.playerVehicle.isSprinting);
			this.playerVehicle.updateCameraAndVisuals();
			this.updateControls();

			this.updateChunksAroundPlayer();

			// Always drain a small amount of streaming work every frame.
			// This is what smooths out chunk-boundary spikes.
			const playerPos = this.getPlayerPosition();
			const currentChunkX = worldToChunkCoord(playerPos.x);
			const currentChunkY = worldToChunkCoord(playerPos.y);
			const currentChunkZ = worldToChunkCoord(playerPos.z);

			processFrameBudgetedStreamingWork(
				currentChunkX,
				currentChunkY,
				currentChunkZ,
			);

			this.#updateActiveMeshSelection();
		});

		this.scene.onAfterRenderObservable.add(() => {
			this.updateDebugHud();
			this.#freezeActiveMeshes();
		});
	}

	private updateControls(): void {
		const controls = this.getKeyboardControls();
		const type = controls.controlType;
		if (type === "walking" || type === "customBoat" || type === "paddleBoat") {
			(controls as unknown as { update(): void }).update();
		}
	}

	private updateChunksAroundPlayer(): void {
		const playerPos = this.getPlayerPosition();
		const currentChunkX = worldToChunkCoord(playerPos.x);
		const currentChunkY = worldToChunkCoord(playerPos.y);
		const currentChunkZ = worldToChunkCoord(playerPos.z);

		if (
			currentChunkX !== this.#lastChunkX ||
			currentChunkY !== this.#lastChunkY ||
			currentChunkZ !== this.#lastChunkZ
		) {
			void updateChunksAround(
				currentChunkX,
				currentChunkY,
				currentChunkZ,
				undefined,
				undefined,
				this.#lastChunkX,
				this.#lastChunkY,
				this.#lastChunkZ,
				playerPos.x,
				playerPos.z,
			);

			this.#lastChunkX = currentChunkX;
			this.#lastChunkY = currentChunkY;
			this.#lastChunkZ = currentChunkZ;
		}
	}

	#updateActiveMeshSelection(): void {
		const pos = this.getPlayerPosition();
		const cx = worldToChunkCoord(pos.x);
		const cy = worldToChunkCoord(pos.y);
		const cz = worldToChunkCoord(pos.z);
		const yaw = this.playerCamera.cameraYaw;
		const pitch = this.playerCamera.cameraPitch;

		const chunkChanged =
			cx !== this.#lastChunkX ||
			cy !== this.#lastChunkY ||
			cz !== this.#lastChunkZ;
		const cameraMoved =
			yaw !== this.#prevCameraYaw || pitch !== this.#prevCameraPitch;

		if (chunkChanged) {
			this.#lastChunkX = cx;
			this.#lastChunkY = cy;
			this.#lastChunkZ = cz;
		}
		if (cameraMoved) {
			this.#prevCameraYaw = yaw;
			this.#prevCameraPitch = pitch;
		}

		this.#rebuildActiveMeshes = false;

		if (chunkChanged || cameraMoved) {
			this.#frameCount++;
			if (this.#frameCount % 2 === 0) {
				this.#rebuildActiveMeshes = true;
			}
		}

		if (
			this.#rebuildActiveMeshes &&
			(this.scene as Scene)._activeMeshesFrozen
		) {
			this.scene.unfreezeActiveMeshes();
		}
	}

	#freezeActiveMeshes(): void {
		if (this.#rebuildActiveMeshes) {
			this.scene.freezeActiveMeshes();
			this.#rebuildActiveMeshes = false;
		} else if (!(this.scene as Scene)._activeMeshesFrozen) {
			this.scene.freezeActiveMeshes();
		}
	}

	private updateDebugHud(): void {
		this.playerHud.updateStats();
		if (PlayerHud.debugPanelDiv.style.display === "none") return;

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
			this.getDirectionFromYaw(cameraYaw),
			"position",
		);
		const biome = getBiome(Math.floor(playerPos.x), Math.floor(playerPos.z));
		PlayerHud.updateDebugInfo("Biome", biome.name, "biome");
		PlayerHud.updateDebugInfo(
			"Loaded Chunks",
			Chunk.loadedChunks.size,
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
			"LOD Cache Ver",
			`mismatch:${loadStats.lastLodCacheVersionMismatches}`,
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
		const top4: string[] = [];
		const indexed: { count: number; index: number }[] = [];
		for (let i = 0; i < counts.length; i++) {
			if (counts[i] > 0) indexed.push({ count: counts[i], index: i });
		}
		indexed.sort((a, b) => b.count - a.count);
		const limit = indexed.length < 4 ? indexed.length : 4;
		for (let i = 0; i < limit; i++) {
			top4.push(`${indexed[i].index}:${indexed[i].count}`);
		}
		const dispatchHistogram = top4.join(" ");
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

	private getDirectionFromYaw(yaw: number): string {
		const degrees = (yaw * (180 / Math.PI)) % 360;
		const normalizedDegrees = (degrees + 360) % 360;

		const directions = [
			"West",
			"North-West",
			"North",
			"North-East",
			"East",
			"South-East",
			"South",
			"South-West",
		];
		const index = Math.round(normalizedDegrees / 45) % 8;
		return directions[index];
	}
}
