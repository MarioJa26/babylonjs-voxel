import { Engine, Scene, Vector3 } from "@babylonjs/core";

import { IControls } from "../Inferface/IControls";
import { Chunk } from "../World/Chunk/Chunk";
import { ChunkLoadingSystem } from "../World/Chunk/ChunkLoadingSystem";
import { PaddleBoatControls } from "./Controls/PaddleBoatControls";
import { WalkingControls } from "./Controls/WalkingControls";
import { PlayerHud } from "./Hud/PlayerHud";
import { IPlayerBody } from "./IPlayerBody";
import { PlayerCamera } from "./PlayerCamera";
import { PlayerStats } from "./PlayerStats";

export class PlayerLoopController {
  #lastChunkX = 0;
  #lastChunkY = 0;
  #lastChunkZ = 0;

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
      this.playerVehicle.update(dt);
      this.playerStats.update(dt, this.playerVehicle.isSprinting);
      this.playerVehicle.updateCameraAndVisuals();
      this.updateControls();
      this.updateChunksAroundPlayer();
    });

    this.scene.onAfterRenderObservable.add(() => {
      this.updateDebugHud();
    });
  }

  private updateControls(): void {
    const controls = this.getKeyboardControls();
    if (controls instanceof PaddleBoatControls) {
      controls.update();
    } else if (controls instanceof WalkingControls) {
      controls.update();
    }
  }

  private updateChunksAroundPlayer(): void {
    const playerPos = this.getPlayerPosition();
    const currentChunkX = ChunkLoadingSystem.worldToChunkCoord(playerPos.x);
    const currentChunkY = ChunkLoadingSystem.worldToChunkCoord(playerPos.y);
    const currentChunkZ = ChunkLoadingSystem.worldToChunkCoord(playerPos.z);

    if (
      currentChunkX !== this.#lastChunkX ||
      currentChunkY !== this.#lastChunkY ||
      currentChunkZ !== this.#lastChunkZ
    ) {
      ChunkLoadingSystem.updateChunksAround(
        currentChunkX,
        currentChunkY,
        currentChunkZ,
      );
      this.#lastChunkX = currentChunkX;
      this.#lastChunkY = currentChunkY;
      this.#lastChunkZ = currentChunkZ;
    }
  }

  private updateDebugHud(): void {
    this.playerHud.updateStats();
    if (PlayerHud.debugPanelDiv.style.display === "none") return;

    const playerPos = this.getPlayerPosition();
    const chunkX = ChunkLoadingSystem.worldToChunkCoord(playerPos.x);
    const chunkY = ChunkLoadingSystem.worldToChunkCoord(playerPos.y);
    const chunkZ = ChunkLoadingSystem.worldToChunkCoord(playerPos.z);
    const cameraPos = this.playerCamera.position;
    const cameraYaw = this.playerCamera.cameraYaw;
    const cameraPitch = this.playerCamera.cameraPitch;

    PlayerHud.updateDebugInfo("FPS", this.engine.getFps().toFixed());
    PlayerHud.updateDebugInfo("Faces", this.scene.getActiveIndices() / 3);
    PlayerHud.updateDebugInfo(
      "Player Pos",
      `${playerPos.x.toFixed(2)}, ${playerPos.y.toFixed(2)}, ${playerPos.z.toFixed(2)}`,
    );
    PlayerHud.updateDebugInfo("Chunk Pos", `${chunkX}, ${chunkY}, ${chunkZ}`);
    PlayerHud.updateDebugInfo(
      "Camera Pos",
      `${cameraPos.x.toFixed(2)}, ${cameraPos.y.toFixed(2)}, ${cameraPos.z.toFixed(2)}`,
    );
    PlayerHud.updateDebugInfo(
      "Camera Angle",
      `Yaw: ${cameraYaw.toFixed(2)}, Pitch: ${cameraPitch.toFixed(2)}`,
    );
    PlayerHud.updateDebugInfo("Facing", this.getDirectionFromYaw(cameraYaw));
    PlayerHud.updateDebugInfo(
      "Loaded Chunks",
      Array.from(Chunk.chunkInstances.values()).filter((c) => c.isLoaded)
        .length,
    );
    PlayerHud.updateDebugInfo("Health", Math.ceil(this.playerStats.health));
    PlayerHud.updateDebugInfo("Hunger", Math.ceil(this.playerStats.hunger));
    PlayerHud.updateDebugInfo("Stamina", Math.ceil(this.playerStats.stamina));
    PlayerHud.updateDebugInfo("Mana", Math.ceil(this.playerStats.mana));
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
