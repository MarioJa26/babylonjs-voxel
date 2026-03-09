import { Mesh, Scene, Vector3 } from "@babylonjs/core";

import type { Mount } from "../Entities/Mount";
import type { PlayerCamera } from "./PlayerCamera";
import type { SimpleCharacterController } from "./SimpleCharacterController";

export type SavedBodyPosition = {
  x: number;
  y: number;
  z: number;
};

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
