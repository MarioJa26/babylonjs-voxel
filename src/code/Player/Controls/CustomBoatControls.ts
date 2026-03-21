import { Matrix, Mesh, Vector3 } from "@babylonjs/core";
import { IControls } from "../../Inferface/IControls";
import { Player } from "../Player";
import { Mount } from "@/code/Entities/Mount";

export type BoatControlEntity = {
  mount: Mount;
  submergedPoints: number;
  boatPosition: Vector3;
  boatMesh: Mesh;
  currentYaw: number;
  applyImpulse(impulse: Vector3, worldPoint: Vector3): void;
  applyAngularImpulse(impulse: Vector3): void;
};

export class CustomBoatControls implements IControls<BoatControlEntity> {
  public pressedKeys = new Set<string>();
  #controlledEntity: BoatControlEntity;
  #inputDirection = new Vector3(0, 0, 0);

  #player: Player;

  public static KEY_LEFT = ["a", "arrowleft"];
  public static KEY_RIGHT = ["d", "arrowright"];
  public static KEY_UP = ["w", "arrowup"];
  public static KEY_DOWN = ["s", "arrowdown"];
  public static KEY_USE = ["e"];
  public static KEY_JUMP = [" "];
  public static KEY_SPRINT = ["shift"];
  public static KEY_FLASH = ["f"];

  public static MOUSE_WHEEL_UP = ["wheel_up"];
  public static MOUSE_WHEEL_DOWN = ["wheel_down"];

  #pushVectorUp = new Vector3(0, 0.5, 0);
  #pushVectorDown = new Vector3(0, -0.5, 0);

  #pushStrength = 2;
  #pushNoseUpStrength = -3;
  #angularPushStrength = 1;
  #angularRotationStrength = 0.45;
  #pushAngularVectorLeft = new Vector3(
    this.#pushNoseUpStrength,
    -this.#angularPushStrength,
    this.#angularRotationStrength,
  );
  #pushAngularVectorRight = new Vector3(
    this.#pushNoseUpStrength,
    this.#angularPushStrength,
    -this.#angularRotationStrength,
  );

  // Reusable rotation matrix — built from currentYaw each tick, never from the mesh
  static readonly #rotationMatrix = new Matrix();

  constructor(paddleBoat: BoatControlEntity, player: Player) {
    this.#controlledEntity = paddleBoat;
    this.#inputDirection = player.playerVehicle.inputDirection;
    this.#player = player;
  }

  public handleKeyEvent(key: string, isKeyDown: boolean) {
    if (isKeyDown) {
      this.onKeyDown(key);
    } else {
      this.onKeyUp(key);
    }
  }

  public onKeyDown(key: string) {
    this.pressedKeys.add(key);

    if (CustomBoatControls.KEY_RIGHT.includes(key)) {
      this.#inputDirection.x = 1;
    } else if (CustomBoatControls.KEY_LEFT.includes(key)) {
      this.#inputDirection.x = -1;
    } else if (CustomBoatControls.KEY_UP.includes(key)) {
      this.#inputDirection.y = -1;
    } else if (CustomBoatControls.KEY_DOWN.includes(key)) {
      this.#inputDirection.y = 1;
    } else if (CustomBoatControls.KEY_USE.includes(key)) {
      this.#player.use();
    }
  }

  public onKeyUp(key: string) {
    if (CustomBoatControls.KEY_UP.includes(key)) {
      if (this.#pressedKeysHas(CustomBoatControls.KEY_DOWN)) {
        this.#inputDirection.y = 1;
      } else {
        this.#inputDirection.y = 0;
      }
    } else if (CustomBoatControls.KEY_DOWN.includes(key)) {
      if (this.#pressedKeysHas(CustomBoatControls.KEY_UP)) {
        this.#inputDirection.y = -1;
      } else {
        this.#inputDirection.y = 0;
      }
    } else if (CustomBoatControls.KEY_RIGHT.includes(key)) {
      if (this.#pressedKeysHas(CustomBoatControls.KEY_LEFT)) {
        this.#inputDirection.x = -1;
      } else {
        this.#inputDirection.x = 0;
      }
    } else if (CustomBoatControls.KEY_LEFT.includes(key)) {
      if (this.#pressedKeysHas(CustomBoatControls.KEY_RIGHT)) {
        this.#inputDirection.x = 1;
      } else {
        this.#inputDirection.x = 0;
      }
    } else if (CustomBoatControls.KEY_FLASH.includes(key)) {
      this.#player.flashlight.toggle();
    }

    if (CustomBoatControls.MOUSE_WHEEL_UP.includes(key)) {
      this.#controlledEntity.mount.getMountedUser()?.playerCamera.zoomIn();
      this.pressedKeys.delete(key);
    } else if (CustomBoatControls.MOUSE_WHEEL_DOWN.includes(key)) {
      this.#controlledEntity.mount.getMountedUser()?.playerCamera.zoomOut();
      this.pressedKeys.delete(key);
    }
    this.pressedKeys.delete(key);
  }

  #tick() {
    if (this.#controlledEntity.submergedPoints <= 1) {
      return;
    }

    const position = this.#controlledEntity.boatPosition;

    // Build rotation matrix from currentYaw — the hull mesh is always identity
    // so we can never use boatMesh.rotationQuaternion or boatMesh.forward here.
    Matrix.RotationYToRef(
      this.#controlledEntity.currentYaw,
      CustomBoatControls.#rotationMatrix,
    );

    const angularLeftWorld = Vector3.TransformNormal(
      this.#pushAngularVectorLeft,
      CustomBoatControls.#rotationMatrix,
    );
    const angularRightWorld = Vector3.TransformNormal(
      this.#pushAngularVectorRight,
      CustomBoatControls.#rotationMatrix,
    );

    // Forward is +Z in local space, rotated by current yaw
    const forward = Vector3.TransformNormal(
      new Vector3(0, 0, 1),
      CustomBoatControls.#rotationMatrix,
    ).scale(this.#pushStrength);

    // Sprint cancels push
    if (this.#pressedKeysHas(CustomBoatControls.KEY_SPRINT)) {
      forward.copyFrom(Vector3.Zero());
      angularLeftWorld.x = angularLeftWorld.x >> 1;
      angularLeftWorld.y = angularLeftWorld.y << 1;
      angularLeftWorld.z = angularLeftWorld.z >> 1;

      angularRightWorld.x = angularRightWorld.x >> 1;
      angularRightWorld.y = angularRightWorld.y << 1;
      angularRightWorld.z = angularRightWorld.z >> 1;
    }

    this.#handleUpDown(forward, position);
    this.#handleLeftRight(forward, position, angularLeftWorld, angularRightWorld);
  }

  #handleUpDown(forward: Vector3, position: Vector3) {
    if (this.#inputDirection.y < 0) {
      forward.scaleInPlace(0.4);
      this.#controlledEntity.applyImpulse(this.#pushVectorUp, position);
    } else if (this.#inputDirection.y > 0) {
      forward.scaleInPlace(0.4);
      this.#controlledEntity.applyImpulse(this.#pushVectorDown, position);
    }
  }

  #handleLeftRight(
    forward: Vector3,
    position: Vector3,
    angularLeftWorld: Vector3,
    angularRightWorld: Vector3,
  ) {
    if (this.#inputDirection.x > 0) {
      this.#controlledEntity.applyImpulse(forward, position);
      this.#controlledEntity.applyAngularImpulse(angularRightWorld);
    } else if (this.#inputDirection.x < 0) {
      this.#controlledEntity.applyImpulse(forward, position);
      this.#controlledEntity.applyAngularImpulse(angularLeftWorld);
    }
  }

  #pressedKeysHas(keys: string[]) {
    return keys.some((k) => this.pressedKeys.has(k));
  }

  public get controlledEntity(): BoatControlEntity {
    return this.#controlledEntity;
  }

  public get inputDirection(): Vector3 {
    return this.#inputDirection;
  }

  public update(): void {
    this.#tick();
  }
}
