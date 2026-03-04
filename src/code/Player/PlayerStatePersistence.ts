import { Observer, Scene } from "@babylonjs/core";
import type { SavedInventoryState } from "./Inventory/PlayerInventory";
import type { SavedPlayerPosition } from "./PlayerVehicle";
import { Player } from "./Player";
import { ChunkLoadingSystem } from "../World/Chunk/ChunkLoadingSystem";

export class PlayerStatePersistence {
  private static readonly PLAYER_POSITION_STORAGE_KEY =
    "b102.playerPosition.v1";
  private static readonly PLAYER_INVENTORY_STORAGE_KEY =
    "b102.playerInventory.v1";
  private static readonly PLAYER_STATE_SAVE_INTERVAL_MS = 2000;
  private static readonly CHUNK_SAVE_BATCH_SIZE = 12;
  private static readonly CHUNK_SAVE_NOW_BATCH_SIZE = 64;

  private lastPositionSaveMs = 0;
  private inventoryObserver: Observer<void> | null = null;
  private sceneDisposeObserver: Observer<Scene> | null = null;
  private isDisposed = false;

  private readonly onBeforeUnload = () => this.saveNow();
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      this.saveNow();
    }
  };

  constructor(
    private readonly scene: Scene,
    private readonly player: Player,
  ) {
    this.restoreFromLocalStorage();
    this.setupPersistence();
  }

  public update(): void {
    if (this.isDisposed) return;

    const now = Date.now();
    if (
      now - this.lastPositionSaveMs <
      PlayerStatePersistence.PLAYER_STATE_SAVE_INTERVAL_MS
    ) {
      return;
    }
    this.savePosition();
    this.requestChunkSave(PlayerStatePersistence.CHUNK_SAVE_BATCH_SIZE);
    this.lastPositionSaveMs = now;
  }

  public saveNow(): void {
    if (this.isDisposed || typeof window === "undefined") return;

    this.savePosition();
    this.saveInventory();
    this.requestChunkSave(PlayerStatePersistence.CHUNK_SAVE_NOW_BATCH_SIZE);
    this.lastPositionSaveMs = Date.now();
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.saveNow();

    if (this.inventoryObserver) {
      this.player.playerInventory.onInventoryChangedObservable.remove(
        this.inventoryObserver,
      );
      this.inventoryObserver = null;
    }

    if (this.sceneDisposeObserver) {
      this.scene.onDisposeObservable.remove(this.sceneDisposeObserver);
      this.sceneDisposeObserver = null;
    }

    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.onBeforeUnload);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private setupPersistence(): void {
    if (typeof window === "undefined") return;

    this.inventoryObserver =
      this.player.playerInventory.onInventoryChangedObservable.add(() => {
        this.saveInventory();
      });

    window.addEventListener("beforeunload", this.onBeforeUnload);
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    this.sceneDisposeObserver = this.scene.onDisposeObservable.add(() => {
      this.dispose();
    });
  }

  private requestChunkSave(batchSize: number): void {
    void ChunkLoadingSystem.flushModifiedChunks(batchSize).catch((error) => {
      console.warn("Failed to persist modified chunks.", error);
    });
  }

  private savePosition(): void {
    if (this.isDisposed || typeof window === "undefined") return;
    if (this.player.playerVehicle.isMovementLocked) return;

    try {
      const positionState = this.player.playerVehicle.getSavedPosition();
      window.localStorage.setItem(
        PlayerStatePersistence.PLAYER_POSITION_STORAGE_KEY,
        JSON.stringify(positionState),
      );
    } catch (error) {
      console.warn("Failed to save player position to localStorage.", error);
    }
  }

  private saveInventory(): void {
    if (this.isDisposed || typeof window === "undefined") return;

    try {
      const inventoryState =
        this.player.playerInventory.getSavedInventoryState();
      window.localStorage.setItem(
        PlayerStatePersistence.PLAYER_INVENTORY_STORAGE_KEY,
        JSON.stringify(inventoryState),
      );
    } catch (error) {
      console.warn("Failed to save player inventory to localStorage.", error);
    }
  }

  private restoreFromLocalStorage(): void {
    if (typeof window === "undefined") return;
    this.restorePosition();
    this.restoreInventory();
  }

  private restorePosition(): void {
    try {
      const raw = window.localStorage.getItem(
        PlayerStatePersistence.PLAYER_POSITION_STORAGE_KEY,
      );
      if (!raw) return;

      const savedPosition = JSON.parse(raw) as SavedPlayerPosition;
      if (this.player.playerVehicle.restoreSavedPosition(savedPosition)) {
        this.player.playerVehicle.updateCameraAndVisuals();
      } else {
        console.warn(
          "Saved player position data was invalid. Defaults were kept.",
        );
      }
    } catch (error) {
      console.warn(
        "Failed to restore player position from localStorage.",
        error,
      );
    }
  }

  private restoreInventory(): void {
    return;
    try {
      const raw = window.localStorage.getItem(
        PlayerStatePersistence.PLAYER_INVENTORY_STORAGE_KEY,
      );
      if (!raw) return;

      const savedInventory = JSON.parse(raw) as SavedInventoryState;
      if (
        !this.player.playerInventory.restoreSavedInventoryState(savedInventory)
      ) {
        console.warn(
          "Saved player inventory data was invalid. Defaults were kept.",
        );
      }
    } catch (error) {
      console.warn(
        "Failed to restore player inventory from localStorage.",
        error,
      );
    }
  }
}
