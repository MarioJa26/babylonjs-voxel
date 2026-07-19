import type {
	EngineContext,
	GpuPicker,
	Mesh,
	SceneContext,
	Vec3,
} from "@babylonjs/lite";
import {
	addToScene,
	createCapsule,
	createGpuPicker,
	createStandardMaterial,
	disposePicker,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { tryCreateBoatFromMarker } from "@/code/World/Boat/BoatCreatorSystem";
import { BlockType } from "@/code/World/Texture/BlockType";
import type { IControls } from "../Interface/IControls";
import { getIsPaused, isUiOpen, setIsPaused } from "../Shared/GameRuntimeState";
import { WalkingControls } from "./Controls/WalkingControls";
import {
	pickDroppedItem,
	pickTarget,
} from "./Hud/BlockHighlight/BlockRaycaster";
import { PauseMenu } from "./Hud/PauseMenu";
import { PlayerHud } from "./Hud/PlayerHud";
import { DroppedItem } from "./Inventory/DroppedItem";
import { PlayerInventory } from "./Inventory/PlayerInventory";
import { PlayerBodyControlState } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import { PlayerFlashLight } from "./PlayerFlashLight";
import { PlayerInputController } from "./PlayerInputController";
import { PlayerLoopController } from "./PlayerLoopController";
import { PlayerStats } from "./PlayerStats";
import { PlayerVehicleMotor } from "./PlayerVehicleMotor";

/**
 * Lite (native) port of the Player — Phase B slice.
 *
 * Wires the existing gameplay clusters (PlayerHud, PlayerInputController,
 * WalkingControls, PlayerInventory, BreakingBlockHandler, ItemUseActions,
 * DroppedItem) into the Babylon Lite runtime:
 *   - movement is owned by `PlayerVehicle` (driven by WalkingControls flags via
 *     the voxel AABB collider)
 *   - per-frame: move, update distant terrain, raycast a target for the
 *     crosshair highlight, tick WalkingControls (block breaking), refresh HUD
 *
 * Phase C (mobs/boats/mounts) and the full PlayerLoopController are deferred.
 */
export class Player {
	#playerCamera: PlayerCamera;
	#stats: PlayerStats;
	#playerVehicle: PlayerVehicleMotor;
	#walkingControls: WalkingControls;
	#flashlight: PlayerFlashLight;
	#playerInventory: PlayerInventory;
	#playerHud!: PlayerHud;
	#pauseMenu!: PauseMenu;
	#inputController: PlayerInputController;
	#picker: GpuPicker | null = null;
	#pickInFlight = false;
	#loopController!: PlayerLoopController;
	#playerBodyMesh: Mesh | null = null;

	// Current keyboard control scheme (WalkingControls, or InventoryControls
	// while the inventory overlay is open).
	keyboardControls: IControls<unknown>;

	constructor(
		private engine: EngineContext,
		private scene: SceneContext,
		playerCam: PlayerCamera,
		private canvas: HTMLCanvasElement,
	) {
		this.#playerCamera = playerCam;
		this.#stats = new PlayerStats();
		this.#playerVehicle = new PlayerVehicleMotor({
			scene,
			engine,
			camera: playerCam,
			controls: new PlayerBodyControlState(),
			playerStats: this.#stats,
		});
		this.#walkingControls = new WalkingControls(this);
		this.keyboardControls = this.#walkingControls;
		this.#flashlight = new PlayerFlashLight(scene, playerCam.playerCamera);
		this.#playerInventory = new PlayerInventory(scene, this, 10, 10);

		this.#inputController = new PlayerInputController(
			canvas,
			playerCam,
			(key, down) => this.onKeyEvent(key, down),
			() => this.keyboardControls,
			() => this.#onPauseRequested(),
		);
		this.#inputController.bind();

		this.#picker = createGpuPicker(scene);
	}

	/**
	 * Build the HUD (crosshair + inventory + stats). Deferred until after
	 * `Map1.initPromise` so the highlight/`BlockBreakingVisuals` meshes can use
	 * `Map1.engine`, which is only ready once the world has initialised.
	 */
	public createHud(scene: SceneContext): void {
		if (this.#playerHud) return;
		this.#playerHud = new PlayerHud(scene, this);
		this.#createPlayerBody(scene);
		this.#loopController = new PlayerLoopController(
			scene,
			this.#playerVehicle,
			this.#stats,
			this.#playerHud,
			this.#playerCamera,
			() => this.keyboardControls,
			() => this.position,
		);
		this.#loopController.bind();
		this.#pauseMenu = new PauseMenu(() => this.#resume(), this);
	}

	/** Visible player capsule (third-person). Lite-native mesh + unlit material. */
	#createPlayerBody(scene: SceneContext): void {
		const body = createCapsule(this.engine, { height: 1.8, radius: 0.3 });
		const mat = createStandardMaterial();
		mat.diffuseColor = [0.2, 0.6, 1.0];
		mat.emissiveColor = [0.0, 0.0, 0.0];
		mat.disableLighting = true;
		body.material = mat;
		body.pickable = false;
		body.visible = false;
		addToScene(scene, body);
		this.#playerBodyMesh = body;
	}

	/** Recompute spawn height against the loaded terrain (call after map init). */
	public respawn(): void {
		this.#playerVehicle.respawn();
	}

	public tick(deltaMs: number): void {
		if (getIsPaused()) return;
		if (!this.#loopController) return;
		this.#loopController.tick(deltaMs);
		this.#updatePlayerBody();
	}

	#updatePlayerBody(): void {
		if (!this.#playerBodyMesh) return;
		const p = this.position;
		this.#playerBodyMesh.position.set(p.x, p.y, p.z);
		this.#playerBodyMesh.visible = this.#playerCamera.isThirdPerson;
	}

	#onPauseRequested(): void {
		// Never open the pause menu while a non-blocking overlay (inventory,
		// mason table) is open — those keep the world running and just free the
		// mouse. Only a genuine pause request (Esc with no menu) reaches here.
		if (getIsPaused() || isUiOpen() || !this.#pauseMenu) return;
		setIsPaused(true);
		Map1.isPaused = true;
		this.#pauseMenu.show();
		if (document.pointerLockElement) document.exitPointerLock();
	}

	#resume(): void {
		setIsPaused(false);
		Map1.isPaused = false;
		this.#pauseMenu.hide();
		this.canvas.requestPointerLock();
	}

	public onKeyEvent(key: string, isKeyDown: boolean): void {
		this.keyboardControls?.handleKeyEvent(key, isKeyDown);
	}

	// ─── public surface consumed by WalkingControls / PlayerHud ─────────────

	public get position(): Vec3 {
		return this.#playerVehicle.position;
	}

	/** Current world-space velocity of the player body (m/s). */
	public get velocity(): Vec3 {
		return this.#playerVehicle.velocity;
	}

	public get playerVehicle(): PlayerVehicleMotor {
		return this.#playerVehicle;
	}

	public get playerHud(): PlayerHud {
		return this.#playerHud;
	}

	public get playerInventory(): PlayerInventory {
		return this.#playerInventory;
	}

	public get playerCamera(): PlayerCamera {
		return this.#playerCamera;
	}

	public get stats(): PlayerStats {
		return this.#stats;
	}

	public get flashlight(): PlayerFlashLight {
		return this.#flashlight;
	}

	public get defaultKeyboardControls(): WalkingControls {
		return this.#walkingControls;
	}

	public get sceneRef(): SceneContext {
		return this.scene;
	}

	/** KEY_USE ('e') — interact with the usable mesh under the crosshair. */
	public use(): void {
		if (this.#pickInFlight || !this.#picker) return;
		this.#pickInFlight = true;

		// Crosshair is screen-centre; pick there in CSS pixels relative to canvas.
		const _x = this.canvas.clientWidth / 2;
		const _y = this.canvas.clientHeight / 2;

		// Pick up the dropped item the player is looking at (within reach).
		// Falls back to the nearest item if none is directly targeted.
		const dropped = pickDroppedItem(this) ?? DroppedItem.nearestTo(this);
		if (dropped) {
			dropped.use(this);
			this.#pickInFlight = false;
			return;
		}

		// No usable mesh hit — fall back to block interaction.
		const blockHit = pickTarget(this);
		const blockId = blockHit?.blockId;
		if (blockId === BlockType.MasonTable) {
			if (this.#playerHud.isMasonTableOpen) {
				this.#playerHud.hideMasonTableUI();
			} else {
				this.#playerHud.showMasonTableUI();
			}
			return;
		}
		if (blockId === BlockType.BoatCreator && blockHit) {
			tryCreateBoatFromMarker(
				this,
				Math.floor(blockHit.x),
				Math.floor(blockHit.y),
				Math.floor(blockHit.z),
			);
			return;
		}

		this.#pickInFlight = false;
	}

	/** Release GPU picker resources. */
	public disposePicker(): void {
		if (this.#picker) {
			disposePicker(this.#picker);
			this.#picker = null;
		}
	}
}
