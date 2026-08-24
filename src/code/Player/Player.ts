import type {
	EngineContext,
	Mesh,
	SceneContext,
	ShaderMaterial,
	Vec3,
} from "@babylonjs/lite";
import { addToScene } from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { tryCreateBoatFromMarker } from "@/code/World/Boat/BoatCreatorSystem";
import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { BlockType } from "@/code/World/Texture/BlockType";
import type { IControls } from "../Interface/IControls";
import { getIsPaused, isUiOpen, setIsPaused } from "../Lib/GameRuntimeState";
import { WalkingControls } from "./Controls/WalkingControls";
import {
	pickDroppedItem,
	pickTarget,
} from "./Hud/BlockHighlight/BlockRaycaster";
import { PauseMenu } from "./Hud/PauseMenu";
import { PlayerHud } from "./Hud/PlayerHud";
import { DroppedItem } from "./Inventory/DroppedItem";
import { setOnBlockPlaced } from "./Inventory/Item";
import { PlayerInventory } from "./Inventory/PlayerInventory";
import { PlayerBodyControlState } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import { PlayerFlashLight } from "./PlayerFlashLight";
import { PlayerInputController } from "./PlayerInputController";
import { PlayerLoopController } from "./PlayerLoopController";
import {
	applyRigSkin,
	createPlayerRigMesh,
	createRigShaderMaterial,
	PLAYER_LIGHT_SAMPLE_Y_OFFSET,
	packedLightToLightColor,
	setRigHeadPitch,
	setRigLightColor,
	setRigWalk,
	WALK_REF_SPEED,
	WALK_STRIDE_FACTOR,
} from "./PlayerModel";
import { PlayerStats } from "./PlayerStats";
import { PlayerVehicleMotor } from "./PlayerVehicleMotor";

/**
 * Lite (native) port of the Player.
 *
 * Wires gameplay clusters into the Babylon Lite runtime:
 *   - movement is owned by `PlayerVehicleMotor`
 *   - per-frame: move, update terrain/player body, refresh HUD/controller loop
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
	#pickInFlight = false;
	#interactionsDisposed = false;
	#loopController!: PlayerLoopController;
	#playerBodyMesh: Mesh | null = null;
	#playerBodyMat: ShaderMaterial | null = null;
	#bodySkinBound = false;
	// Third-person body facing: derived from movement (Minecraft-style).
	#lastBodyX = Number.NaN;
	#lastBodyZ = Number.NaN;
	#bodyYaw = 0;
	// Voxel-light sampling cache (re-tint on voxel change OR every 250ms so
	// the day/night sun factor updates while standing still).
	#bodyLightX = Number.NaN;
	#bodyLightY = Number.NaN;
	#bodyLightZ = Number.NaN;
	#bodyLightSampleMs = Number.NEGATIVE_INFINITY;
	// Walk-swing state for the third-person rig.
	#bodyWalkPhase = 0;
	#bodyWalkAmp = 0;

	networkManager?: import("../Network/NetworkManager").NetworkManager;

	// Current keyboard control scheme.
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
	}

	/**
	 * Build the HUD once the world has initialized.
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
		this.#pauseMenu.setLeaveServerCallback(() => {
			this.networkManager?.disconnect();
			window.location.href = "/";
		});
	}

	/** Visible Minecraft-style player model for third-person mode. */
	#createPlayerBody(scene: SceneContext): void {
		const body = createPlayerRigMesh(this.engine, "playerBodyRig", "center");
		const mat = createRigShaderMaterial("playerBodyRigMat");

		body.material = mat;
		body.pickable = false;
		// Hidden until the skin texture binds (unbound sampler = invalid pass).
		body.visible = false;

		addToScene(scene, body);
		this.#playerBodyMesh = body;
		this.#playerBodyMat = mat;

		applyRigSkin(this.engine, mat, () => {
			this.#bodySkinBound = true;
		});
	}

	/** Recompute spawn height against the loaded terrain. */
	public respawn(): void {
		this.#playerVehicle.respawn();
	}

	public tick(deltaMs: number): void {
		if (getIsPaused() || !this.#loopController) return;

		this.#loopController.tick(deltaMs);
		this.#updatePlayerBody(deltaMs);
	}

	#updatePlayerBody(deltaMs: number): void {
		const body = this.#playerBodyMesh;
		if (!body) return;

		// Walk swing: phase advances with ground speed; amplitude eases toward
		// full stride at WALK_REF_SPEED and decays back to the rest pose.
		{
			const v = this.velocity;
			const hSpeed = Math.hypot(v.x, v.z);
			const dt = deltaMs / 1000;
			this.#bodyWalkPhase += hSpeed * dt * WALK_STRIDE_FACTOR;
			const targetAmp = Math.min(1, hSpeed / WALK_REF_SPEED);
			this.#bodyWalkAmp +=
				(targetAmp - this.#bodyWalkAmp) * Math.min(1, dt * 10);
			const mat = this.#playerBodyMat;
			if (mat) {
				setRigWalk(mat, this.#bodyWalkPhase, this.#bodyWalkAmp);
				setRigHeadPitch(mat, this.#playerCamera.cameraPitch);
			}
		}

		// Don't render until the skin texture is bound (unbound sampler would
		// produce an invalid pass), and only in third person.
		const visible = this.#playerCamera.isThirdPerson && this.#bodySkinBound;
		body.visible = visible;

		if (!visible) {
			this.#lastBodyX = Number.NaN;
			return;
		}

		const { x, y, z } = this.position;
		body.position.set(x, y, z);

		// Re-tint the model when it crosses into a different voxel so its
		// brightness follows the light the player actually stands in — and
		// re-sample on a short interval so the day/night sun factor keeps
		// updating even while standing still.
		{
			const lx = Math.floor(x);
			const ly = Math.floor(y + PLAYER_LIGHT_SAMPLE_Y_OFFSET);
			const lz = Math.floor(z);
			const nowMs = performance.now();
			if (
				lx !== this.#bodyLightX ||
				ly !== this.#bodyLightY ||
				lz !== this.#bodyLightZ ||
				nowMs - this.#bodyLightSampleMs > 250
			) {
				this.#bodyLightX = lx;
				this.#bodyLightY = ly;
				this.#bodyLightZ = lz;
				this.#bodyLightSampleMs = nowMs;
				const mat = this.#playerBodyMat;
				if (mat) {
					setRigLightColor(
						mat,
						packedLightToLightColor(
							getLightByWorldCoords(x, y + PLAYER_LIGHT_SAMPLE_Y_OFFSET, z),
						),
					);
				}
			}
		}

		// Face the movement direction (Minecraft-style), smoothing through the
		// shortest arc so the model never spins the long way around.
		if (!Number.isNaN(this.#lastBodyX)) {
			const dx = x - this.#lastBodyX;
			const dz = z - this.#lastBodyZ;
			if (dx * dx + dz * dz > 1e-6) {
				const targetYaw = Math.atan2(dx, dz);
				const diff = Math.atan2(
					targetYaw - this.#bodyYaw,
					Math.cos(targetYaw - this.#bodyYaw),
				);
				this.#bodyYaw += diff * 0.25;
				body.rotation.y = this.#bodyYaw;
			}
		}
		this.#lastBodyX = x;
		this.#lastBodyZ = z;
	}

	#onPauseRequested(): void {
		if (getIsPaused() || isUiOpen() || !this.#pauseMenu) return;

		const isMultiplayer = this.networkManager !== undefined;

		if (!isMultiplayer) {
			setIsPaused(true);
			Map1.isPaused = true;
		}

		this.#pauseMenu.show(isMultiplayer);

		if (document.pointerLockElement) {
			document.exitPointerLock();
		}
	}

	#resume(): void {
		if (!this.networkManager) {
			setIsPaused(false);
			Map1.isPaused = false;
		}

		this.#pauseMenu.hide();
		this.canvas.requestPointerLock();
	}

	public onKeyEvent(key: string, isKeyDown: boolean): void {
		this.keyboardControls?.handleKeyEvent(key, isKeyDown);
	}

	public get position(): Vec3 {
		return this.#playerVehicle.position;
	}

	/** Current world-space velocity of the player body, in m/s. */
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

	/** KEY_USE ('e') — interact with the usable target under the crosshair. */
	public use(): void {
		if (this.#pickInFlight || this.#interactionsDisposed) return;

		this.#pickInFlight = true;

		try {
			const dropped = pickDroppedItem(this) ?? DroppedItem.nearestTo(this);
			if (dropped) {
				dropped.use(this);
				return;
			}

			const blockHit = pickTarget(this);
			if (!blockHit) return;

			switch (blockHit.blockId) {
				case BlockType.MasonTable:
					if (this.#playerHud.isMasonTableOpen) {
						this.#playerHud.hideMasonTableUI();
					} else {
						this.#playerHud.showMasonTableUI();
					}
					return;

				case BlockType.BoatCreator: {
					const x = Math.floor(blockHit.x);
					const y = Math.floor(blockHit.y);
					const z = Math.floor(blockHit.z);

					tryCreateBoatFromMarker(this, x, y, z);
					return;
				}

				case BlockType.WoodCrate: {
					if (this.#playerHud.isWoodCrateOpen) {
						this.#playerHud.hideWoodCrateUI();
						return;
					}

					const x = Math.floor(blockHit.x);
					const y = Math.floor(blockHit.y);
					const z = Math.floor(blockHit.z);

					this.#playerHud.showWoodCrateUI(x, y, z);
					return;
				}

				default:
					return;
			}
		} finally {
			this.#pickInFlight = false;
		}
	}

	/**
	 * Kept for API compatibility.
	 *
	 * The previous implementation allocated a GPU picker but never used it for
	 * picking. This now simply disables future interactions after disposal.
	 */
	public disposePicker(): void {
		this.#interactionsDisposed = true;
	}

	/**
	 * Wire block edit callbacks for multiplayer.
	 * Called by TestScene when multiplayer is active.
	 */
	public setDefaultBlockEditCallbacks(net: {
		onBlockPlaced: (x: number, y: number, z: number, blockId: number) => void;
		onBlockBroken: (x: number, y: number, z: number, blockId: number) => void;
	}): void {
		setOnBlockPlaced(net.onBlockPlaced);
		this.#walkingControls.setOnBlockBroken(net.onBlockBroken);
	}
}
