import { FreeCamera, Scene, Vector3 } from "@babylonjs/core";
import MapFog from "../Maps/MapFog";
import { SettingParams } from "../World/SettingParams";

export class PlayerCamera {
  #playerCamera: FreeCamera;

  #followDistance = 0.001;
  #eyeHeight = 1.8;

  // Camera control
  #cameraPitch = 0;
  #cameraYaw = 0;
  readonly #maxPitch = Math.PI / 2 - 0.003;
  public mouseSensitivity = 0.003;
  // Zoom values
  readonly #minZoom = 0.01;
  readonly #maxZoom = 10000;
  readonly #zoomSpeed = 20.333;

  constructor(playerCamera: FreeCamera, private scene: Scene) {
    this.#playerCamera = playerCamera;

    playerCamera.fov = SettingParams.CAMERA_FOV * (Math.PI / 180);
    playerCamera.minZ = 0.1;
    playerCamera.maxZ = 100000;
  }

  public moveWithPlayer(characterPosition: Vector3): void {
    // Compute forward direction from yaw/pitch
    const forward = new Vector3(
      Math.sin(this.#cameraYaw) * Math.cos(this.#cameraPitch),
      -Math.sin(this.#cameraPitch),
      Math.cos(this.#cameraYaw) * Math.cos(this.#cameraPitch)
    ).normalize();

    if (this.#followDistance > this.#minZoom) {
      this.#eyeHeight = 1.8;
    } else {
      this.#eyeHeight = 0.66;
    }

    // Place camera behind the character
    this.#playerCamera.position = characterPosition
      .add(new Vector3(0, this.#eyeHeight, 0))
      .subtract(forward.scale(this.#followDistance));

    // Make the camera look at the character
    this.#playerCamera.target = characterPosition.add(
      new Vector3(0, this.#eyeHeight, 0)
    );

    if (this.position.y < 2.1) {
      this.scene.fogStart = MapFog.fogStartUnderWater;
      this.scene.fogEnd = MapFog.fogEndUnderWater;
    } else {
      this.scene.fogStart = MapFog.fogStartAboveWater;
      this.scene.fogEnd = MapFog.fogEndAboveWater;
    }
  }

  public handleMouseMovement(deltaX: number, deltaY: number): void {
    this.#cameraYaw -= -deltaX * this.mouseSensitivity;
    this.#cameraPitch += deltaY * this.mouseSensitivity;

    // Clamp pitch to prevent camera flipping
    this.#cameraPitch = Math.max(
      -this.#maxPitch,
      Math.min(this.#maxPitch, this.#cameraPitch)
    );
  }

  public zoomIn(): void {
    if (this.#followDistance - this.#zoomSpeed > this.#minZoom)
      this.#followDistance -= this.#zoomSpeed;
    else this.#followDistance = this.#minZoom;
  }

  public zoomOut(): void {
    if (this.#followDistance + this.#zoomSpeed < this.#maxZoom)
      this.#followDistance += this.#zoomSpeed;
    else this.#followDistance = this.#maxZoom;
  }

  public get cameraYaw(): number {
    return this.#cameraYaw;
  }

  public get cameraPitch(): number {
    return this.#cameraPitch;
  }

  public get playerCamera(): FreeCamera {
    return this.#playerCamera;
  }

  public set fov(value: number) {
    this.#playerCamera.fov = value * (Math.PI / 180);
  }

  get position(): Vector3 {
    return this.#playerCamera.position.clone();
  }

  set position(position: Vector3) {
    this.#playerCamera.position = position;
  }

  set target(target: Vector3) {
    this.#playerCamera.target = target;
  }
}
