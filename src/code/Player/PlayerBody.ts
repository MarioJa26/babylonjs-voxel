import type { Mesh, Scene } from "@babylonjs/core";
import { type Vec3, vec3 } from "@babylonjs/lite";
import type { Mount } from "../Entities/Mount";
import type { PlayerCamera } from "./PlayerCamera";
import type { SimpleCharacterController } from "./SimpleCharacterController";

export class PlayerBodyControlState {
	public inputDirection = vec3(0, 0, 0);
	public wantJump = 0;
	public isSprinting = false;
	public isFlying = false;
	public isJumpHeld = false;
	public isSneaking = false;

	public reset(): void {
		this.inputDirection = vec3(0, 0, 0);
		this.wantJump = 0;
		this.isSprinting = false;
		this.isJumpHeld = false;
		this.isSneaking = false;
	}
}

export interface IPlayerBody {
	scene: Scene;
	camera: PlayerCamera;
	inputDirection: Vec3;
	wantJump: number;
	isSprinting: boolean;
	isFlying: boolean;
	isJumpHeld: boolean;
	isSneaking: boolean;
	isClimbing: boolean;
	isMounted: boolean;
	mount: Mount | null;

	characterController: SimpleCharacterController;
	displayCapsule: Mesh;

	toggleFlying(): void;
	update(deltaTime: number): void;
	updateCameraAndVisuals(): void;

	lockMovementAtCurrentPosition(): void;
	unlockMovement(): void;
	isMovementLocked: boolean;
	clearControlState(): void;

	getSavedPosition(): Vec3;
	restoreSavedPosition(position: unknown): boolean;
}
