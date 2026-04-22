import type { Engine, Scene, Vector3 } from "@babylonjs/core";

import { MetadataContainer } from "../Entities/MetaDataContainer";
import type { IControls } from "../Inferface/IControls";
import type { IUsable } from "../Inferface/IUsable";
import { Map1 } from "../Maps/Map1";
import { WalkingControls } from "../Player/Controls/WalkingControls";
import { CrossHair } from "./Hud/Crosshair/CrossHair";
import { PauseMenu } from "./Hud/PauseMenu";
import { PlayerHud } from "./Hud/PlayerHud";
import { PlayerInventory } from "./Inventory/PlayerInventory";
import type { IPlayerBody } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import { PlayerFlashLight } from "./PlayerFlashLight";
import { PlayerInputController } from "./PlayerInputController";
import { PlayerLoopController } from "./PlayerLoopController";
import { PlayerStats } from "./PlayerStats";
import { PlayerVehicle } from "./PlayerVehicle";

/**
 * Player class that handles character movement, physics, and camera controls
 */
export const REACH_DISTANCE = 64;
export class Player implements IUsable {
	#playerCamera: PlayerCamera;
	#playerVehicle: PlayerVehicle;
	#playerInventory: PlayerInventory;
	#playerHud: PlayerHud;

	#defaultKeyboardControls!: WalkingControls;
	#keyboardControls!: IControls<unknown>;

	public flashlight: PlayerFlashLight;
	public stats: PlayerStats;

	#pauseMenu: PauseMenu;

	/**
	 * Creates a new Player instance
	 * @param scene The Babylon.js scene
	 * @param camera The camera to use for the player's view
	 * @param canvas The HTML canvas element for input handling
	 */
	constructor(
		private engine: Engine,
		private scene: Scene,
		playerCam: PlayerCamera,
		private canvas: HTMLCanvasElement,
	) {
		this.#playerInventory = new PlayerInventory(scene, this, 10, 10);
		this.#playerVehicle = new PlayerVehicle(this.scene, playerCam);
		this.#playerCamera = playerCam;
		this.flashlight = new PlayerFlashLight(this.scene, playerCam.playerCamera);
		this.stats = new PlayerStats();

		this.#pauseMenu = new PauseMenu(() => this.resumeGame(), this);
		this.#playerHud = new PlayerHud(engine, this.scene, this);

		this.#defaultKeyboardControls = new WalkingControls(this);
		this.#keyboardControls = this.#defaultKeyboardControls;

		const inputController = new PlayerInputController(
			this.scene,
			this.canvas,
			this.#playerCamera,
			(key, isKeyDown) => this.#keyboardControls.handleKeyEvent(key, isKeyDown),
			() => this.#keyboardControls,
			() => this.pauseGame(),
		);

		const loopController = new PlayerLoopController(
			this.engine,
			this.scene,
			this.#playerVehicle,
			this.stats,
			this.#playerHud,
			this.#playerCamera,
			() => this.#keyboardControls,
			() => this.position,
		);

		inputController.bind();
		loopController.bind();
	}

	private pauseGame() {
		Map1.isPaused = true;
		this.#pauseMenu.show();
	}

	private resumeGame() {
		Map1.isPaused = false;
		this.#pauseMenu.hide();
		// Request pointer lock only if the canvas has focus
		const canvas = Map1.mainScene.getEngine().getRenderingCanvas();
		if (document.activeElement === canvas) {
			(Map1.mainScene.getEngine() as Engine).enterPointerlock();
		}
	}

	public get playerVehicle(): PlayerVehicle {
		return this.#playerVehicle;
	}

	public get playerBody(): IPlayerBody {
		return this.#playerVehicle;
	}

	public get playerCamera(): PlayerCamera {
		return this.#playerCamera;
	}

	public get keyboardControls(): IControls<unknown> {
		return this.#keyboardControls;
	}

	public set keyboardControls(keyboardControls: IControls<unknown>) {
		this.#keyboardControls = keyboardControls;
	}

	public get playerHud(): PlayerHud {
		return this.#playerHud;
	}

	public get playerInventory(): PlayerInventory {
		return this.#playerInventory;
	}

	public get defaultKeyboardControls(): WalkingControls {
		return this.#defaultKeyboardControls;
	}

	public get position(): Vector3 {
		return this.#playerVehicle.characterController.getPosition();
	}

	use(): void {
		const mesh = CrossHair.pickUsableMesh(this);
		if (!mesh) return;

		if (mesh.metadata) {
			const metadataContainer = mesh.metadata as MetadataContainer;
			if (
				metadataContainer instanceof MetadataContainer &&
				metadataContainer.has("use")
			) {
				const useFunc = metadataContainer.get<(player: Player) => void>("use");
				if (useFunc) {
					useFunc(this);
				}
			}
		}
	}
}
