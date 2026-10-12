import type { SceneContext } from "@babylonjs/lite";
import { onBeforeRender } from "@babylonjs/lite";
import { getFinalTerrainHeight } from "../Generation/TerrainHeightMap";
import { worldToChunkCoord } from "../Lib/VoxelMath";
import { updateChunksAround } from "../World/Chunk/ChunkLoadingSystem";
import { areChunksLoadedAround } from "../World/Chunk/Loading/ChunkReadiness";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";
import {
	getSpawnPosition,
	isSpawnPrepared,
	setSpawnPosition,
} from "../World/SpawnPoint";
import type { Player } from "./Player";

const PREFIX = "[PlayerLoadingGate]";

/**
 * Holds player movement until a valid spawn has been selected and nearby
 * collision chunks are available.
 *
 * Streaming is requested only when the target chunk changes. Repeated frames at
 * the same locked position perform only the inexpensive readiness check.
 */
export class PlayerLoadingGate {
	private static readonly SPAWN_CHUNK_RADIUS = 1;
	private static readonly SPAWN_READY_FRAME_THRESHOLD = 10;

	/**
	 * Maximum time to protect the player after reaching the spawn position.
	 *
	 * This starts after the player is teleported or a saved position is
	 * restored, not when the gate object is constructed.
	 */
	private static readonly SPAWN_PROTECTION_TIMEOUT_MS = 5_000;

	/**
	 * Maximum time to wait for authoritative spawn preparation before creating
	 * the single-player terrain fallback.
	 */
	private static readonly GATE_FALLBACK_TIMEOUT_MS = 30_000;

	private isActive = true;
	private spawnReadyFrames = 0;

	private readonly gateStartedMs: number;
	private spawnProtectionStartedMs = -1;

	private teleported = false;
	private fallbackForced = false;

	/**
	 * A streaming update may be asynchronous. While one is outstanding, retain
	 * only the latest requested coordinate rather than starting overlapping
	 * updates for intermediate positions.
	 */
	private streamUpdatePending = false;
	private queuedStreamUpdate = false;

	private queuedChunkX = 0;
	private queuedChunkY = 0;
	private queuedChunkZ = 0;
	private queuedWorldX = 0;
	private queuedWorldZ = 0;

	/** Last coordinates submitted to updateChunksAround. */
	private hasStreamedCoordinates = false;
	private lastStreamedCx = 0;
	private lastStreamedCy = 0;
	private lastStreamedCz = 0;

	constructor(
		private readonly scene: SceneContext,
		private readonly player: Player,
	) {
		this.gateStartedMs = performance.now();

		this.player.playerVehicle.lockMovementAtCurrentPosition();

		onBeforeRender(this.scene, () => {
			try {
				this.update();
			} catch (error) {
				console.error(PREFIX, "update threw:", error);
			}
		});
	}

	public dispose(): void {
		if (!this.isActive) {
			return;
		}

		this.isActive = false;
		this.queuedStreamUpdate = false;

		const vehicle = this.player.playerVehicle;

		if (vehicle.isMovementLocked) {
			vehicle.unlockMovement();
		}
	}

	private update(): void {
		if (!this.isActive) {
			return;
		}

		const nowMs = performance.now();

		/*
		 * Wait for the authoritative spawn. In single-player or after a failed
		 * spawn preparation, install a deterministic terrain-surface fallback.
		 */
		if (!isSpawnPrepared()) {
			if (
				!this.fallbackForced &&
				nowMs - this.gateStartedMs > PlayerLoadingGate.GATE_FALLBACK_TIMEOUT_MS
			) {
				console.warn(PREFIX, "spawn preparation stalled -> surface fallback");

				setSpawnPosition({
					x: 0,
					y: getFinalTerrainHeight(0, 0) + 2.9,
					z: 0,
				});

				this.fallbackForced = true;
			} else {
				return;
			}
		}

		const vehicle = this.player.playerVehicle;

		if (!this.teleported) {
			if (!vehicle.hasRestoredSavedPosition()) {
				const spawn = getSpawnPosition();

				console.log(PREFIX, "teleporting player to spawn", spawn);

				vehicle.teleportTo(spawn.x, spawn.y, spawn.z);
			}

			/*
			 * A restored position is just as valid as an explicit spawn
			 * teleport. Mark initialization complete in either case so this
			 * branch is never reconsidered on later frames.
			 */
			this.teleported = true;
			this.spawnProtectionStartedMs = nowMs;
		}

		const position = this.player.position;

		const chunkX = worldToChunkCoord(position.x);
		const chunkY = worldToChunkCoord(position.y);
		const chunkZ = worldToChunkCoord(position.z);

		if (
			!this.hasStreamedCoordinates ||
			chunkX !== this.lastStreamedCx ||
			chunkY !== this.lastStreamedCy ||
			chunkZ !== this.lastStreamedCz
		) {
			this.requestStreamingUpdate(
				chunkX,
				chunkY,
				chunkZ,
				position.x,
				position.z,
			);
		}

		const radius = PlayerLoadingGate.SPAWN_CHUNK_RADIUS;

		const chunksReady = areChunksLoadedAround(
			chunkX,
			chunkY,
			chunkZ,
			radius,
			radius,
		);

		const protectionStartedMs = this.spawnProtectionStartedMs;

		const timedOut =
			protectionStartedMs >= 0 &&
			nowMs - protectionStartedMs >
				PlayerLoadingGate.SPAWN_PROTECTION_TIMEOUT_MS;

		if (!chunksReady && !timedOut) {
			this.spawnReadyFrames = 0;
			return;
		}

		this.spawnReadyFrames++;

		if (this.spawnReadyFrames < PlayerLoadingGate.SPAWN_READY_FRAME_THRESHOLD) {
			return;
		}

		this.dispose();
	}

	/**
	 * Queue the latest streaming coordinate.
	 *
	 * At most one updateChunksAround call is active for this gate. If the target
	 * changes while it is running, intermediate coordinates are collapsed into
	 * one follow-up request for the newest position.
	 */
	private requestStreamingUpdate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		worldX: number,
		worldZ: number,
	): void {
		this.lastStreamedCx = chunkX;
		this.lastStreamedCy = chunkY;
		this.lastStreamedCz = chunkZ;
		this.hasStreamedCoordinates = true;

		if (this.streamUpdatePending) {
			this.queuedChunkX = chunkX;
			this.queuedChunkY = chunkY;
			this.queuedChunkZ = chunkZ;
			this.queuedWorldX = worldX;
			this.queuedWorldZ = worldZ;
			this.queuedStreamUpdate = true;
			return;
		}

		this.startStreamingUpdate(chunkX, chunkY, chunkZ, worldX, worldZ);
	}

	private startStreamingUpdate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		worldX: number,
		worldZ: number,
	): void {
		this.streamUpdatePending = true;

		void updateChunksAround(
			chunkX,
			chunkY,
			chunkZ,
			SETTING_PARAMS.RENDER_DISTANCE,
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
			undefined,
			undefined,
			undefined,
			worldX,
			worldZ,
		)
			.catch((error: unknown) => {
				console.error(PREFIX, "updateChunksAround failed:", error);
			})
			.finally(() => {
				this.streamUpdatePending = false;

				if (!this.isActive || !this.queuedStreamUpdate) {
					return;
				}

				this.queuedStreamUpdate = false;

				this.startStreamingUpdate(
					this.queuedChunkX,
					this.queuedChunkY,
					this.queuedChunkZ,
					this.queuedWorldX,
					this.queuedWorldZ,
				);
			});
	}
}
