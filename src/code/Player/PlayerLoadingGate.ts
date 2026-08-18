import type { SceneContext } from "@babylonjs/lite";
import { onBeforeRender } from "@babylonjs/lite";
import { getFinalTerrainHeight } from "../Generation/TerrainHeightMap";
import { worldToChunkCoord } from "../Lib/VoxelMath";
import {
	areChunksLoadedAround,
	updateChunksAround,
} from "../World/Chunk/ChunkLoadingSystem";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";
import {
	getSpawnPosition,
	isSpawnPrepared,
	setSpawnPosition,
} from "../World/SpawnPoint";
import type { Player } from "./Player";

const PREFIX = "[PlayerLoadingGate]";

/**
 * Lite (native) port of PlayerLoadingGate.
 * Reuses the core-free ChunkLoadingSystem streaming logic.
 *
 * The world spawn point is generated once on the server at world creation
 * (VoxelRoom.ensureWorldSpawn) and delivered to the client via the
 * SpawnPosition message, which sets it via setSpawnPosition(). This gate waits
 * for that spawn, teleports the player to it, and unlocks movement once the
 * spawn-area chunk is loaded (collision present) so the player can't fall
 * through. A surface fallback covers the no-server (singleplayer) case.
 */
export class PlayerLoadingGate {
	private static readonly SPAWN_CHUNK_RADIUS = 1;
	private static readonly SPAWN_READY_FRAME_THRESHOLD = 10;
	// Short safety net: unlock even if the spawn-area chunks are slow to load
	// so the player is never stuck behind a long loading screen.
	private static readonly SPAWN_PROTECTION_TIMEOUT_MS = 5000;
	// If the world-spawn preparation stalls, force a fallback so the player is
	// never permanently stuck at the loading screen.
	private static readonly GATE_FALLBACK_TIMEOUT_MS = 30000;

	private spawnReadyFrames = 0;
	private isActive = true;
	private readonly startMs: number;
	private teleported = false;
	private fallbackForced = false;

	constructor(
		private readonly scene: SceneContext,
		private readonly player: Player,
	) {
		this.startMs = performance.now();
		this.player.playerVehicle.lockMovementAtCurrentPosition();
		onBeforeRender(this.scene, () => {
			try {
				this.update();
			} catch (err) {
				console.error(PREFIX, "update threw:", err);
			}
		});
	}

	public dispose(): void {
		if (!this.isActive) return;
		this.isActive = false;
		if (this.player.playerVehicle.isMovementLocked) {
			this.player.playerVehicle.unlockMovement();
		}
		console.log(PREFIX, "disposed (player unlocked)");
	}

	private update(): void {
		if (!this.isActive) return;

		// Wait until the world spawn has been prepared (and persisted) before
		// moving the player there. If preparation stalls, force a fallback.
		if (!isSpawnPrepared()) {
			const stalled =
				performance.now() - this.startMs >
				PlayerLoadingGate.GATE_FALLBACK_TIMEOUT_MS;
			if (stalled && !this.fallbackForced) {
				// Last-resort fallback for the no-server (singleplayer) case:
				// drop the player onto the terrain surface near the origin.
				// In multiplayer the server's SpawnPosition message sets the
				// spawn well before this timeout, so this path is not taken.
				console.warn(PREFIX, "spawn prep stalled -> surface fallback");
				setSpawnPosition({
					x: 0,
					y: getFinalTerrainHeight(0, 0) + 2 + 0.9,
					z: 0,
				});
				this.fallbackForced = true;
			} else {
				return;
			}
		}

		if (
			!this.teleported &&
			!this.player.playerVehicle.hasRestoredSavedPosition()
		) {
			const p = getSpawnPosition();
			console.log(PREFIX, "teleporting player to spawn", p);
			this.player.playerVehicle.teleportTo(p.x, p.y, p.z);
			this.teleported = true;
		}

		// Only stream chunks once the player is at the real spawn — loading
		// around the pre-teleport (origin) position leaves residual chunks at
		// 0,0. Chunk coords are derived from the post-teleport position.
		const playerPos = this.player.position;
		const chunkX = worldToChunkCoord(playerPos.x);
		const chunkY = worldToChunkCoord(playerPos.y);
		const chunkZ = worldToChunkCoord(playerPos.z);

		updateChunksAround(
			chunkX,
			chunkY,
			chunkZ,
			SETTING_PARAMS.RENDER_DISTANCE,
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
			undefined,
			undefined,
			undefined,
			playerPos.x,
			playerPos.z,
		);

		const chunksReady = areChunksLoadedAround(
			chunkX,
			chunkY,
			chunkZ,
			PlayerLoadingGate.SPAWN_CHUNK_RADIUS,
			PlayerLoadingGate.SPAWN_CHUNK_RADIUS,
		);
		const timedOut =
			performance.now() - this.startMs >
			PlayerLoadingGate.SPAWN_PROTECTION_TIMEOUT_MS;

		// Unlock once the spawn chunk is loaded (collision data present) so the
		// player won't fall through. We intentionally do NOT wait for the visual
		// mesh — that can lag far behind and was keeping the player locked for
		// up to two minutes.
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
}
