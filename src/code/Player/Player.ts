import type {
	EngineContext,
	Mesh,
	SceneContext,
	ShaderMaterial,
	Vec3,
} from "@babylonjs/lite";
import { addToScene } from "@babylonjs/lite";
import { CustomBoat } from "@/code/Entities/CustomBoat";
import { interactWithGlyph } from "@/code/Entities/MayaTempleGlyphs";
import { type IMountableUser, Mount } from "@/code/Entities/Mount";
import { igniteTnt } from "@/code/Entities/PrimedTnt";
import { activeWorldSeedAsInt } from "@/code/Entities/TempleLootTable";
import { Map1 } from "@/code/Maps/Map1";
import type { BoatChunk } from "@/code/World/Boat/BoatChunk";
import { tryCreateBoatFromMarker } from "@/code/World/Boat/BoatCreatorSystem";
import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { tntBlastRadius } from "@/code/World/ExplosionSim";
import { BlockType } from "@/code/World/Texture/BlockType";
import type { IControls } from "../Interface/IControls";
import { getIsPaused, isUiOpen, setIsPaused } from "../Lib/GameRuntimeState";
import { WalkingControls } from "./Controls/WalkingControls";
import {
	pickDroppedItem,
	pickTarget,
} from "./Hud/BlockHighlight/BlockRaycaster";
import {
	setOnExplosion,
	setOnTntIgnite,
} from "./Hud/BlockHighlight/BreakingBlockHandler";
import { PauseMenu } from "./Hud/PauseMenu";
import { PlayerHud } from "./Hud/PlayerHud";
import { DroppedItem } from "./Inventory/DroppedItem";
import { HeldItemView } from "./Inventory/HeldItemView";
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
	PUNCH_DURATION_S,
	packedLightToLightColor,
	setRigHeadPitch,
	setRigLightColor,
	setRigPunch,
	setRigWalk,
	WALK_REF_SPEED,
	WALK_STRIDE_FACTOR,
} from "./PlayerModel";
import { PlayerStats } from "./PlayerStats";
import { PlayerVehicleMotor } from "./PlayerVehicleMotor";

const BODY_LIGHT_REFRESH_INTERVAL_MS = 250;
const BODY_WALK_SMOOTHING_RATE = 10;
const BODY_YAW_INTERPOLATION = 0.25;
const BODY_MOVEMENT_EPSILON_SQUARED = 1e-6;
const SECONDS_PER_MILLISECOND = 0.001;
const THROW_VELOCITY = 8;

interface WorldBlockPosition {
	x: number;
	y: number;
	z: number;
}

interface BoatDynamicContext {
	kind?: unknown;
	boatChunk?: BoatChunk;
}

interface BlockEditCallbacks {
	onBlockPlaced: (
		x: number,
		y: number,
		z: number,
		blockId: number,
		blockState: number,
	) => void;
	onBlockBroken: (x: number, y: number, z: number, blockId: number) => void;
	onExplosion: (x: number, y: number, z: number, radius: number) => void;
	onTntIgnite: (
		x: number,
		y: number,
		z: number,
		fuse: number,
		radius: number,
	) => void;
}

function floorBlockPosition(
	position: Pick<WorldBlockPosition, "x" | "y" | "z">,
): WorldBlockPosition {
	return {
		x: Math.floor(position.x),
		y: Math.floor(position.y),
		z: Math.floor(position.z),
	};
}

// Mount must not import Player because that would introduce an import cycle.
// The Player module therefore supplies the structural mountability predicate.
Mount.isMountableUser = (value: unknown): value is IMountableUser => {
	if (value === null || typeof value !== "object") {
		return false;
	}

	return (
		"playerVehicle" in value &&
		"playerCamera" in value &&
		"keyboardControls" in value &&
		"defaultKeyboardControls" in value
	);
};

/**
 * Lite native Player implementation.
 *
 * Movement is owned by PlayerVehicleMotor. Player coordinates input, HUD,
 * world interaction, third-person rendering and multiplayer callbacks.
 */
export class Player {
	public static readonly USE_REPEAT_INTERVAL_MS = 120;

	readonly #engine: EngineContext;
	readonly #scene: SceneContext;
	readonly #canvas: HTMLCanvasElement;

	readonly #playerCamera: PlayerCamera;
	readonly #stats: PlayerStats;
	readonly #playerVehicle: PlayerVehicleMotor;
	readonly #walkingControls: WalkingControls;
	readonly #flashlight: PlayerFlashLight;
	readonly #playerInventory: PlayerInventory;
	readonly #inputController: PlayerInputController;

	#playerHud!: PlayerHud;
	#pauseMenu!: PauseMenu;
	#loopController!: PlayerLoopController;

	#pickInFlight = false;
	#useHeld = false;
	#lastUseRepeatMs = 0;

	#playerBodyMesh: Mesh | null = null;
	#playerBodyMat: ShaderMaterial | null = null;
	#bodyHeldItem: HeldItemView | null = null;
	#bodySkinBound = false;

	#lastBodyX = Number.NaN;
	#lastBodyZ = Number.NaN;
	#bodyYaw = 0;

	#bodyLightX = Number.NaN;
	#bodyLightY = Number.NaN;
	#bodyLightZ = Number.NaN;
	#bodyLightSampleMs = Number.NEGATIVE_INFINITY;

	#bodyWalkPhase = 0;
	#bodyWalkAmp = 0;

	// Infinity represents the resting punch pose.
	#punchT = Number.POSITIVE_INFINITY;

	public networkManager?: import("../Network/NetworkManager").NetworkManager;

	/** Current active keyboard control scheme. */
	public keyboardControls: IControls<unknown>;

	constructor(
		engine: EngineContext,
		scene: SceneContext,
		playerCam: PlayerCamera,
		canvas: HTMLCanvasElement,
	) {
		this.#engine = engine;
		this.#scene = scene;
		this.#canvas = canvas;
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
	 * Builds the HUD after world initialization.
	 */
	public createHud(scene: SceneContext): void {
		if (this.#playerHud) {
			return;
		}

		this.#playerHud = new PlayerHud(scene, this);
		this.#createPlayerBody(scene);

		this.#loopController = new PlayerLoopController(
			scene,
			this.#playerVehicle,
			this.#stats,
			this.#playerHud,
			this.#playerCamera,
			() => this.keyboardControls,
			() => this.#playerVehicle.position,
		);

		this.#loopController.bind();

		this.#pauseMenu = new PauseMenu(() => this.#resume(), this);

		this.#pauseMenu.setLeaveServerCallback(() => {
			this.networkManager?.disconnect();
			window.location.href = "/";
		});
	}

	/**
	 * Creates the visible Minecraft-style third-person body.
	 */
	#createPlayerBody(scene: SceneContext): void {
		const body = createPlayerRigMesh(this.#engine, "playerBodyRig", "center");

		const material = createRigShaderMaterial("playerBodyRigMat");

		body.material = material;
		body.pickable = false;

		// An unbound skin sampler produces an invalid render pass.
		body.visible = false;

		addToScene(scene, body);

		this.#playerBodyMesh = body;
		this.#playerBodyMat = material;
		this.#bodyHeldItem = new HeldItemView();

		applyRigSkin(this.#engine, material, () => {
			this.#bodySkinBound = true;
		});
	}

	/**
	 * Recomputes spawn height against currently loaded terrain.
	 */
	public respawn(): void {
		this.#playerVehicle.respawn();
	}

	public tick(deltaMs: number): void {
		const loopController = this.#loopController;

		if (!loopController) {
			return;
		}

		/*
		 * The controller must continue receiving ticks while paused so frame
		 * profiling sections outside the pause gate can still be committed.
		 */
		loopController.tick(deltaMs);

		if (!getIsPaused()) {
			this.#updatePlayerBody(deltaMs);
		}
	}

	/**
	 * Starts the third-person punch or mining animation.
	 */
	public triggerPunch(): void {
		this.#punchT = 0;
	}

	#updatePlayerBody(deltaMs: number): void {
		const body = this.#playerBodyMesh;

		if (body === null) {
			return;
		}

		const deltaSeconds = deltaMs * SECONDS_PER_MILLISECOND;

		this.#advancePunchAnimation(deltaSeconds);

		const isVisible = this.#playerCamera.isThirdPerson && this.#bodySkinBound;

		body.visible = isVisible;

		if (!isVisible) {
			this.#bodyHeldItem?.hide();
			this.#lastBodyX = Number.NaN;
			this.#lastBodyZ = Number.NaN;
			return;
		}

		const vehicle = this.#playerVehicle;
		const position = vehicle.position;
		const velocity = vehicle.velocity;

		const x = position.x;
		const y = position.y;
		const z = position.z;

		const velocityX = velocity.x;
		const velocityZ = velocity.z;

		const horizontalSpeed = Math.sqrt(
			velocityX * velocityX + velocityZ * velocityZ,
		);

		const walkPhase =
			this.#bodyWalkPhase + horizontalSpeed * deltaSeconds * WALK_STRIDE_FACTOR;

		const targetAmplitude = Math.min(1, horizontalSpeed / WALK_REF_SPEED);

		const smoothing = Math.min(1, deltaSeconds * BODY_WALK_SMOOTHING_RATE);

		const walkAmplitude =
			this.#bodyWalkAmp + (targetAmplitude - this.#bodyWalkAmp) * smoothing;

		this.#bodyWalkPhase = walkPhase;
		this.#bodyWalkAmp = walkAmplitude;

		const material = this.#playerBodyMat;
		const punchT = this.#punchT;

		if (material !== null) {
			setRigWalk(material, walkPhase, walkAmplitude);
			setRigHeadPitch(material, this.#playerCamera.cameraPitch);
			setRigPunch(material, punchT);
		}

		body.position.set(x, y, z);

		this.#updateBodyLighting(material, x, y, z);
		this.#updateBodyFacing(body, x, z);
		this.#updateBodyHeldItem(body, walkPhase, walkAmplitude, punchT);
	}

	#advancePunchAnimation(deltaSeconds: number): void {
		const punchT = this.#punchT;

		if (punchT >= 1) {
			return;
		}

		const nextPunchT = punchT + deltaSeconds / PUNCH_DURATION_S;

		this.#punchT = nextPunchT >= 1 ? Number.POSITIVE_INFINITY : nextPunchT;
	}

	#updateBodyLighting(
		material: ShaderMaterial | null,
		x: number,
		y: number,
		z: number,
	): void {
		const sampledY = y + PLAYER_LIGHT_SAMPLE_Y_OFFSET;

		const lightX = Math.floor(x);
		const lightY = Math.floor(sampledY);
		const lightZ = Math.floor(z);
		const nowMs = performance.now();

		const voxelChanged =
			lightX !== this.#bodyLightX ||
			lightY !== this.#bodyLightY ||
			lightZ !== this.#bodyLightZ;

		const refreshExpired =
			nowMs - this.#bodyLightSampleMs > BODY_LIGHT_REFRESH_INTERVAL_MS;

		if (!voxelChanged && !refreshExpired) {
			return;
		}

		this.#bodyLightX = lightX;
		this.#bodyLightY = lightY;
		this.#bodyLightZ = lightZ;
		this.#bodyLightSampleMs = nowMs;

		if (material === null) {
			return;
		}

		const packedLight = getLightByWorldCoords(x, sampledY, z);

		setRigLightColor(material, packedLightToLightColor(packedLight));
	}

	#updateBodyFacing(body: Mesh, x: number, z: number): void {
		const lastX = this.#lastBodyX;
		const lastZ = this.#lastBodyZ;

		this.#lastBodyX = x;
		this.#lastBodyZ = z;

		if (Number.isNaN(lastX)) {
			return;
		}

		const deltaX = x - lastX;
		const deltaZ = z - lastZ;
		const movementSquared = deltaX * deltaX + deltaZ * deltaZ;

		if (movementSquared <= BODY_MOVEMENT_EPSILON_SQUARED) {
			return;
		}

		const targetYaw = Math.atan2(deltaX, deltaZ);
		const yawDelta = targetYaw - this.#bodyYaw;

		// Normalize the angular difference to [-PI, PI].
		const shortestDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));

		this.#bodyYaw += shortestDelta * BODY_YAW_INTERPOLATION;
		body.rotation.y = this.#bodyYaw;
	}

	#updateBodyHeldItem(
		body: Mesh,
		walkPhase: number,
		walkAmplitude: number,
		punchT: number,
	): void {
		const item = this.#playerInventory.getSelectedHotbarItem();

		this.#bodyHeldItem?.updateAvatar(
			item !== null && item.stackSize > 0 ? item.itemId : 0,
			item?.blockState ?? 0,
			body,
			walkPhase,
			walkAmplitude,
			punchT,
		);
	}

	#onPauseRequested(): void {
		if (getIsPaused() || isUiOpen() || !this.#pauseMenu) {
			return;
		}

		const isMultiplayer = this.networkManager !== undefined;

		if (!isMultiplayer) {
			setIsPaused(true);
			Map1.isPaused = true;
		}

		this.#pauseMenu.show(isMultiplayer);

		if (document.pointerLockElement !== null) {
			void document.exitPointerLock();
		}
	}

	#resume(): void {
		if (this.networkManager === undefined) {
			setIsPaused(false);
			Map1.isPaused = false;
		}

		this.#pauseMenu.hide();
		void this.#canvas.requestPointerLock();
	}

	public onKeyEvent(key: string, isKeyDown: boolean): void {
		this.keyboardControls.handleKeyEvent(key, isKeyDown);
	}

	public get position(): Vec3 {
		return this.#playerVehicle.position;
	}

	/**
	 * Current world-space body velocity in metres per second.
	 */
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
		return this.#scene;
	}

	/**
	 * KEY_USE ("e"): interacts with the usable target under the crosshair.
	 */
	public use(): void {
		if (this.#pickInFlight) {
			return;
		}

		const vehicle = this.#playerVehicle;

		// While mounted, E always dismounts.
		if (vehicle.isMounted && vehicle.mount) {
			vehicle.mount.dismount();
			return;
		}

		// Dropped items take priority over block interactions.
		if (this.tryPickupItem()) {
			return;
		}

		this.#pickInFlight = true;

		try {
			const blockHit = pickTarget(this);

			if (!blockHit) {
				return;
			}

			switch (blockHit.blockId) {
				case BlockType.MasonTable:
					this.#toggleMasonTable();
					return;

				case BlockType.BoatCreator:
					this.#useBoatCreator(blockHit);
					return;

				case BlockType.WoodCrate:
					this.#toggleWoodCrate(blockHit);
					return;

				case BlockType.Kiln:
				case BlockType.Furnace:
				case BlockType.Whetstone:
				case BlockType.Crucible:
				case BlockType.Anvil:
				case BlockType.Smeltery:
					this.#toggleStation(blockHit);
					return;

				case BlockType.Tnt:
					this.#igniteBlock(blockHit);
					return;

				case BlockType.TempleGlyph:
					this.#useTempleGlyph(blockHit);
					return;

				default:
					if (tntBlastRadius(blockHit.blockId) !== null) {
						this.#igniteBlock(blockHit);
					}
			}
		} finally {
			this.#pickInFlight = false;
		}
	}

	#toggleMasonTable(): void {
		const hud = this.#playerHud;

		if (hud.isMasonTableOpen) {
			hud.hideMasonTableUI();
		} else {
			hud.showMasonTableUI();
		}
	}

	#useBoatCreator(blockHit: {
		x: number;
		y: number;
		z: number;
		dynamicContext?: unknown;
	}): void {
		const dynamicContext = blockHit.dynamicContext as BoatDynamicContext | null;

		if (dynamicContext?.kind === "boatChunk" && dynamicContext.boatChunk) {
			const wheelBoat = CustomBoat.getBoatForChunk(dynamicContext.boatChunk);

			wheelBoat?.mount.mount(this);
			return;
		}

		const { x, y, z } = floorBlockPosition(blockHit);
		tryCreateBoatFromMarker(this, x, y, z);
	}

	#toggleWoodCrate(blockHit: WorldBlockPosition): void {
		const hud = this.#playerHud;

		if (hud.isWoodCrateOpen) {
			hud.hideWoodCrateUI();
			return;
		}

		const { x, y, z } = floorBlockPosition(blockHit);
		hud.showWoodCrateUI(x, y, z);
	}

	#toggleStation(blockHit: WorldBlockPosition): void {
		const hud = this.#playerHud;

		if (hud.isStationOpen) {
			hud.hideStationUI();
			return;
		}

		const { x, y, z } = floorBlockPosition(blockHit);
		hud.showStationUI(x, y, z);
	}

	#igniteBlock(blockHit: WorldBlockPosition): void {
		const { x, y, z } = floorBlockPosition(blockHit);
		igniteTnt(x, y, z);
	}

	#useTempleGlyph(blockHit: WorldBlockPosition): void {
		const { x, y, z } = floorBlockPosition(blockHit);
		const networkManager = this.networkManager;

		const result = interactWithGlyph(
			x,
			y,
			z,
			activeWorldSeedAsInt(),
			networkManager?.isConnected === true
				? networkManager.onBlockPlaced
				: undefined,
		);

		const hud = this.#playerHud;

		switch (result.kind) {
			case "toggled":
				hud.showTempleMessage(
					result.charged ? "The seal takes the light." : "The seal dims.",
				);
				return;

			case "gate-locked":
				hud.showTempleMessage(
					`The gate is sealed. ${result.chargedCount} of ${result.requiredCount} seals answer.`,
				);
				return;

			case "gate-open":
				hud.showTempleMessage("The gate grinds open. Something stirs below.");
				return;
		}
	}

	/**
	 * Picks up one nearby dropped item, prioritizing the crosshair target.
	 *
	 * Returns true when an item was found and used.
	 */
	public tryPickupItem(): boolean {
		if (this.#pickInFlight) {
			return false;
		}

		this.#pickInFlight = true;

		try {
			const dropped = pickDroppedItem(this) ?? DroppedItem.nearestTo(this);

			if (!dropped) {
				return false;
			}

			dropped.use(this);
			return true;
		} finally {
			this.#pickInFlight = false;
		}
	}

	/**
	 * Tracks the physical E key state for hold-to-pick-up behavior.
	 */
	public setUseHeld(held: boolean): void {
		if (this.#useHeld === held) {
			return;
		}

		this.#useHeld = held;

		if (held) {
			this.#lastUseRepeatMs = performance.now();
		}
	}

	/**
	 * Collects one nearby item per repeat interval while E is held.
	 */
	public updateUseHeld(): void {
		if (!this.#useHeld || isUiOpen() || this.#pickInFlight) {
			return;
		}

		const nowMs = performance.now();

		if (nowMs - this.#lastUseRepeatMs < Player.USE_REPEAT_INTERVAL_MS) {
			return;
		}

		this.#lastUseRepeatMs = nowMs;
		this.tryPickupItem();
	}

	/**
	 * Wires multiplayer block-edit callbacks.
	 */
	public setDefaultBlockEditCallbacks(net: BlockEditCallbacks): void {
		setOnBlockPlaced(net.onBlockPlaced);
		this.#walkingControls.setOnBlockBroken(net.onBlockBroken);
		setOnExplosion(net.onExplosion);
		setOnTntIgnite(net.onTntIgnite);
	}
}
