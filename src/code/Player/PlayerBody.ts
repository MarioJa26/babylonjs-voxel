import { type Mesh, type Scene, Vector3 } from "@babylonjs/core";

import type { Mount } from "../Entities/Mount";
import type { PlayerCamera } from "./PlayerCamera";
import type { SimpleCharacterController } from "./SimpleCharacterController";

export type SavedBodyPosition = {
	x: number;
	y: number;
	z: number;
};

export class PlayerBodyControlState {
	public readonly inputDirection = new Vector3(0, 0, 0);
	public wantJump = 0;
	public isSprinting = false;
	public isFlying = false;
	public isJumpHeld = false;

	public reset(): void {
		this.inputDirection.set(0, 0, 0);
		this.wantJump = 0;
		this.isSprinting = false;
		this.isJumpHeld = false;
	}
}

export interface IPlayerBody {
	scene: Scene;
	camera: PlayerCamera;
	inputDirection: Vector3;
	wantJump: number;
	isSprinting: boolean;
	isFlying: boolean;
	isJumpHeld: boolean;
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

	getSavedPosition(): SavedBodyPosition;
	restoreSavedPosition(position: unknown): boolean;
}
