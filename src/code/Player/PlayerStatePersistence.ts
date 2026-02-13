import { Observer, Scene } from "@babylonjs/core";
import type { SavedInventoryState } from "./Inventory/PlayerInventory";
import type { SavedPlayerPosition } from "./PlayerVehicle";
import { Player } from "./Player";

type SavedPlayerState = {
  position: SavedPlayerPosition;
  inventory: SavedInventoryState;
  savedAt: number;
};

export class PlayerStatePersistence {
  private static readonly PLAYER_STATE_STORAGE_KEY = "b102.playerState.v1";
  private static readonly PLAYER_STATE_SAVE_INTERVAL_MS = 2000;

  private lastPlayerStateSaveMs = 0;
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
      now - this.lastPlayerStateSaveMs <
      PlayerStatePersistence.PLAYER_STATE_SAVE_INTERVAL_MS
    ) {
      return;
    }
    this.saveNow();
  }

  public saveNow(): void {
    if (this.isDisposed || typeof window === "undefined") return;
    if (this.player.playerVehicle.isMovementLocked) return;

    try {
      const state: SavedPlayerState = {
        position: this.player.playerVehicle.getSavedPosition(),
        inventory: this.player.playerInventory.getSavedInventoryState(),
        savedAt: Date.now(),
      };
      window.localStorage.setItem(
        PlayerStatePersistence.PLAYER_STATE_STORAGE_KEY,
        JSON.stringify(state),
      );
      this.lastPlayerStateSaveMs = state.savedAt;
    } catch (error) {
      console.warn("Failed to save player state to localStorage.", error);
    }
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

    this.inventoryObserver = this.player.playerInventory.onInventoryChangedObservable.add(
      () => {
        this.saveNow();
      },
    );

    window.addEventListener("beforeunload", this.onBeforeUnload);
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    this.sceneDisposeObserver = this.scene.onDisposeObservable.add(() => {
      this.dispose();
    });
  }

  private restoreFromLocalStorage(): void {
    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(
        PlayerStatePersistence.PLAYER_STATE_STORAGE_KEY,
      );
      if (!raw) return;

      const savedState = JSON.parse(raw) as Partial<SavedPlayerState>;
      const restoredPosition = this.player.playerVehicle.restoreSavedPosition(
        savedState.position,
      );
      const restoredInventory =
        this.player.playerInventory.restoreSavedInventoryState(
          savedState.inventory,
        );

      if (restoredPosition) {
        this.player.playerVehicle.updateCameraAndVisuals();
      }

      if (!restoredPosition && !restoredInventory) {
        console.warn("Saved player data was invalid. Defaults were kept.");
      }
    } catch (error) {
      console.warn("Failed to restore player state from localStorage.", error);
    }
  }
}
