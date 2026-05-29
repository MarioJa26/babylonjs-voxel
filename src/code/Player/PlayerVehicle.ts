import type { Mesh, Scene, Vector3 } from "@babylonjs/core";

import type { Mount } from "../Entities/Mount";
import {
	type IPlayerBody,
	PlayerBodyControlState,
	type SavedBodyPosition,
} from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import type { PlayerStats } from "./PlayerStats";
import { PlayerVehicleMotor } from "./PlayerVehicleMotor";
import type { SimpleCharacterController } from "./SimpleCharacterController";

export type SavedPlayerPosition = SavedBodyPosition;

export class PlayerVehicle implements IPlayerBody {
	public scene: Scene;
	public camera: PlayerCamera;
	public isMounted = false;
	public DASH = true;
	public mount: Mount | null = null;

	private readonly controlState = new PlayerBodyControlState();
	private readonly motor: PlayerVehicleMotor;

	constructor(scene: Scene, camera: PlayerCamera, playerStats: PlayerStats) {
		this.scene = scene;
		this.camera = camera;
		this.motor = new PlayerVehicleMotor({
			scene: this.scene,
			camera: this.camera,
			controls: this.controlState,
			getMount: () => this.mount,
			playerStats,
		});
	}

	public toggleFlying(): void {
		this.isFlying = !this.isFlying;
	}

	public get inputDirection(): Vector3 {
		return this.controlState.inputDirection;
	}

	public get wantJump(): number {
		return this.controlState.wantJump;
	}

	public set wantJump(value: number) {
		this.controlState.wantJump = value;
	}

	public get isSprinting(): boolean {
		return this.controlState.isSprinting;
	}

	public set isSprinting(value: boolean) {
		this.controlState.isSprinting = value;
	}

	public get isFlying(): boolean {
		return this.controlState.isFlying;
	}

	public set isFlying(value: boolean) {
		this.controlState.isFlying = value;
	}

	public get isJumpHeld(): boolean {
		return this.controlState.isJumpHeld;
	}

	public set isJumpHeld(value: boolean) {
		this.controlState.isJumpHeld = value;
	}

	public clearControlState(): void {
		this.controlState.reset();
	}

	public update(deltaTime: number): void {
		this.motor.update(deltaTime);
	}

	public updateCameraAndVisuals(): void {
		this.motor.updateCameraAndVisuals();
	}

	public lockMovementAtCurrentPosition(): void {
		this.motor.lockMovementAtCurrentPosition();
	}

	public unlockMovement(): void {
		this.motor.unlockMovement();
	}

	public get isMovementLocked(): boolean {
		return this.motor.isMovementLocked;
	}

	public getSavedPosition(): SavedPlayerPosition {
		return this.motor.getSavedPosition();
	}

	public restoreSavedPosition(position: unknown): boolean {
		return this.motor.restoreSavedPosition(position);
	}

	public get characterController(): SimpleCharacterController {
		return this.motor.characterController;
	}

	public get displayCapsule(): Mesh {
		return this.motor.displayCapsule;
	}

	public setMount(mount: Mount): void {
		this.mount = mount;
	}

	public wouldBlockOverlapPlayer(
		blockX: number,
		blockY: number,
		blockZ: number,
		blockShape: {
			boxes: Array<{
				min: [number, number, number];
				max: [number, number, number];
			}>;
			rotateY: boolean;
			usesSliceState: boolean;
		},
		rotation: number,
		slice: number,
		flipY: boolean,
	): boolean {
		return this.motor.wouldBlockOverlapPlayer(
			blockX,
			blockY,
			blockZ,
			blockShape,
			rotation,
			slice,
			flipY,
		);
	}
}
