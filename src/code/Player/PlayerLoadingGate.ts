import type { Observer, Scene } from "@babylonjs/core";
import { DistantTerrain } from "../Generation/DistantTerrain/DistantTerrain";
import { getChunk } from "../World/Chunk/Chunk";
import {
	areChunksLod0ReadyAround,
	updateChunksAround,
	worldToChunkCoord,
} from "../World/Chunk/ChunkLoadingSystem";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";
import type { Player } from "./Player";

export class PlayerLoadingGate {
	private static readonly SPAWN_CHUNK_RADIUS = 2;
	private static readonly SPAWN_READY_FRAME_THRESHOLD = 17;
	private static readonly SPAWN_PROTECTION_TIMEOUT_MS = 16000;

	private spawnReadyFrames = 0;
	private isActive = true;
	private readonly startMs: number;
	private beforeRenderObserver: Observer<Scene> | null = null;

	constructor(
		private readonly scene: Scene,
		private readonly player: Player,
	) {
		this.startMs = performance.now();
		this.player.playerVehicle.lockMovementAtCurrentPosition();
		this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(() => {
			this.update();
		});
	}

	public dispose(): void {
		if (!this.isActive) return;
		this.isActive = false;

		if (this.beforeRenderObserver) {
			this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
			this.beforeRenderObserver = null;
		}

		if (this.player.playerVehicle.isMovementLocked) {
			this.player.playerVehicle.unlockMovement();
		}
	}

	private update(): void {
		if (!this.isActive) {
			return;
		}
		const playerPos = this.player.position;
		const chunkX = worldToChunkCoord(playerPos.x);
		const chunkY = worldToChunkCoord(playerPos.y);
		const chunkZ = worldToChunkCoord(playerPos.z);
		updateChunksAround(
			chunkX,
			chunkY,
			chunkZ,
			SETTING_PARAMS.RENDER_DISTANCE * 2,
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
			undefined,
			undefined,
			undefined,
			playerPos.x,
			playerPos.z,
		);

		const chunksReady = areChunksLod0ReadyAround(
			chunkX,
			chunkY,
			chunkZ,
			PlayerLoadingGate.SPAWN_CHUNK_RADIUS,
			2,
		);
		const colliderReady = this.isSpawnColliderReady(chunkX, chunkY, chunkZ);
		const timedOut =
			performance.now() - this.startMs >
			PlayerLoadingGate.SPAWN_PROTECTION_TIMEOUT_MS;

		if ((!chunksReady || !colliderReady) && !timedOut) {
			this.spawnReadyFrames = 0;
			return;
		}

		this.spawnReadyFrames++;
		if (this.spawnReadyFrames < PlayerLoadingGate.SPAWN_READY_FRAME_THRESHOLD) {
			return;
		}

		this.dispose();
	}

	private isSpawnColliderReady(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): boolean {
		for (let dy = 0; dy <= 2; dy++) {
			const chunk = getChunk(chunkX, chunkY - dy, chunkZ);
			if (!chunk?.isLoaded) {
				continue;
			}

			if (chunk.mesh || chunk.transparentMesh) {
				return true;
			}
		}
		return false;
	}
}
