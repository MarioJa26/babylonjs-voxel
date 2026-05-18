import { type FreeCamera, type Scene, Vector3 } from "@babylonjs/core";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import MapFog from "../Maps/MapFog";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";

export class PlayerCamera {
	#playerCamera: FreeCamera;
	#isUnderWater: boolean | null = null;

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

	// Scratch vectors to avoid per-frame allocation
	readonly #_forward = Vector3.Zero();
	readonly #_eyeOffset = Vector3.Zero();
	readonly #_tmp1 = Vector3.Zero();

	constructor(
		playerCamera: FreeCamera,
		private scene: Scene,
	) {
		this.#playerCamera = playerCamera;

		playerCamera.fov = SETTING_PARAMS.CAMERA_FOV * (Math.PI / 180);
		playerCamera.minZ = 0.1;
		playerCamera.maxZ = 100000;
	}

	public moveWithPlayer(characterPosition: Vector3): void {
		const cosP = Math.cos(this.#cameraPitch);
		this.#_forward.set(
			Math.sin(this.#cameraYaw) * cosP,
			-Math.sin(this.#cameraPitch),
			Math.cos(this.#cameraYaw) * cosP,
		);

		if (this.#followDistance > this.#minZoom) {
			this.#eyeHeight = 1.8;
		} else {
			this.#eyeHeight = 0.66;
		}

		this.#_eyeOffset.copyFromFloats(0, this.#eyeHeight, 0);

		// Camera position = character + eyeOffset - forward * followDistance
		this.#_forward.scaleToRef(this.#followDistance, this.#_tmp1);
		characterPosition.addToRef(this.#_eyeOffset, this.#playerCamera.position);
		this.#playerCamera.position.subtractInPlace(this.#_tmp1);

		// Camera target = character + eyeOffset — use setTarget() so rotation is recomputed.
		// Reuse #_tmp1 (now free after position calc) as a scratch target vector.
		characterPosition.addToRef(this.#_eyeOffset, this.#_tmp1);
		this.#playerCamera.setTarget(this.#_tmp1);

		const isUnderWater =
			this.#playerCamera.position.y < GenerationParams.SEA_LEVEL;
		if (this.#isUnderWater !== isUnderWater) {
			MapFog.applyToScene(this.scene, isUnderWater);
			this.#isUnderWater = isUnderWater;
		}
	}

	public handleMouseMovement(deltaX: number, deltaY: number): void {
		this.#cameraYaw -= -deltaX * this.mouseSensitivity;
		this.#cameraPitch += deltaY * this.mouseSensitivity;

		// Clamp pitch to prevent camera flipping
		this.#cameraPitch = Math.max(
			-this.#maxPitch,
			Math.min(this.#maxPitch, this.#cameraPitch),
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
		return this.#playerCamera.position;
	}

	set position(position: Vector3) {
		this.#playerCamera.position = position;
	}

	set target(target: Vector3) {
		this.#playerCamera.target = target;
	}
}
