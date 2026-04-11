import { Mesh, Scene, Vector3 } from "@babylonjs/core";

import { Mount } from "../Entities/Mount";
import {
  IPlayerBody,
  PlayerBodyControlState,
  SavedBodyPosition,
} from "./PlayerBody";
import { PlayerCamera } from "./PlayerCamera";
import { PlayerVehicleMotor } from "./PlayerVehicleMotor";
import { SimpleCharacterController } from "./SimpleCharacterController";

export type SavedPlayerPosition = SavedBodyPosition;

export class PlayerVehicle implements IPlayerBody {
  public scene: Scene;
  public camera: PlayerCamera;
  public isMounted = false;
  public DASH = true;
  public mount: Mount | null = null;

  private readonly controlState = new PlayerBodyControlState();
  private readonly motor: PlayerVehicleMotor;

  constructor(scene: Scene, camera: PlayerCamera) {
    this.scene = scene;
    this.camera = camera;
    this.motor = new PlayerVehicleMotor({
      scene: this.scene,
      camera: this.camera,
      controls: this.controlState,
      getMount: () => this.mount,
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
}
