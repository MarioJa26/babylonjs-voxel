import { Vector3 } from "@babylonjs/core";

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
