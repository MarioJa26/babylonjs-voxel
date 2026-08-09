import { onSceneDispose, type SceneContext, type Vec3 } from "@babylonjs/lite";
import {
	flushChunkBoundEntities,
	flushModifiedChunks,
} from "../World/Chunk/ChunkLoadingSystem";
import { worldLocalStorageKey } from "../World/WorldContext";
import { WorldStorage } from "../World/WorldStorage";
import type { SavedInventoryState } from "./Inventory/PlayerInventory";
import type { Player } from "./Player";
import { Gamemodes } from "./PlayerStats";

export class PlayerStatePersistence {
	private static readonly PLAYER_POSITION_STORAGE_KEY =
		"b102.playerPosition.v1";
	private static readonly PLAYER_INVENTORY_STORAGE_KEY =
		"b102.playerInventory.v1";
	private static readonly PLAYER_STATE_SAVE_INTERVAL_MS = 15000;
	private static readonly CHUNK_SAVE_BATCH_SIZE = 32;
	private static readonly CHUNK_SAVE_NOW_BATCH_SIZE = 64;

	private lastPositionSaveMs = 0;
	// PERF: update() runs every frame but only saves every 15 s — gate the
	// Date.now() check to ~4 Hz instead of per-frame.
	private lastCheckMs = 0;
	private inventoryObserver: any = null;
	private sceneDisposeObserver: any = null;
	private isDisposed = false;

	private readonly onBeforeUnload = () => {
		this.saveNow();
	};
	private readonly onVisibilityChange = () => {
		if (document.visibilityState === "hidden") {
			void this.saveNow();
		}
	};

	constructor(
		private readonly scene: SceneContext,
		private readonly player: Player,
		private readonly worldName: string,
	) {
		this.restoreFromLocalStorage();
		this.setupPersistence();
	}

	/** Per-world storage key, e.g. `b102.world.My World.playerPosition.v1`. */
	private storageKey(baseKey: string): string {
		return worldLocalStorageKey(this.worldName, baseKey);
	}

	public update(): void {
		if (this.isDisposed) return;

		const now = Date.now();
		if (now - this.lastCheckMs < 250) return;
		this.lastCheckMs = now;

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

	public async saveNow(): Promise<void> {
		if (this.isDisposed || typeof window === "undefined") return;

		this.savePosition();
		this.saveInventory();

		try {
			await flushModifiedChunks(
				PlayerStatePersistence.CHUNK_SAVE_NOW_BATCH_SIZE,
			);
			await flushChunkBoundEntities();
			await WorldStorage.flush();
		} catch (err) {
			console.warn("Failed to persist chunks on save-now.", err);
		}

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
			this.sceneDisposeObserver = null;
		}

		if (typeof window !== "undefined") {
			window.removeEventListener("beforeunload", this.onBeforeUnload);
			document.removeEventListener(
				"visibilitychange",
				this.onVisibilityChange,
				{
					capture: true,
				},
			);
		}
	}

	private setupPersistence(): void {
		if (typeof window === "undefined") return;

		this.inventoryObserver =
			this.player.playerInventory.onInventoryChangedObservable.add(() => {
				this.saveInventory();
			});

		window.addEventListener("beforeunload", this.onBeforeUnload);
		document.addEventListener("visibilitychange", this.onVisibilityChange, {
			capture: true,
		});

		this.sceneDisposeObserver = onSceneDispose(this.scene, () => {
			this.dispose();
		});
	}

	private requestChunkSave(batchSize: number): void {
		void flushModifiedChunks(batchSize).catch((err: unknown) => {
			console.warn("Failed to persist modified chunks.", err);
		});
		void flushChunkBoundEntities().catch((err: unknown) => {
			console.warn("Failed to persist chunk-bound entities.", err);
		});
	}

	private savePosition(): void {
		if (this.isDisposed || typeof window === "undefined") return;
		if (this.player.playerVehicle.isMovementLocked) return;

		try {
			const positionState = this.player.playerVehicle.getSavedPosition();
			window.localStorage.setItem(
				this.storageKey(PlayerStatePersistence.PLAYER_POSITION_STORAGE_KEY),
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
				this.storageKey(PlayerStatePersistence.PLAYER_INVENTORY_STORAGE_KEY),
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
				this.storageKey(PlayerStatePersistence.PLAYER_POSITION_STORAGE_KEY),
			);
			if (!raw) return;

			const savedPosition = JSON.parse(raw) satisfies Vec3;
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
		if (this.player.stats.gamemode === Gamemodes.Creative) return;

		try {
			const raw = window.localStorage.getItem(
				this.storageKey(PlayerStatePersistence.PLAYER_INVENTORY_STORAGE_KEY),
			);
			if (!raw) return;

			const savedInventory = JSON.parse(raw) satisfies SavedInventoryState;
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
