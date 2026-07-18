import {
	createFreeCamera,
	type FreeCamera,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";

/**
 * Lite (native) port of PlayerCamera.
 * Third-person follow camera. Drives a Lite `FreeCamera`'s
 * `position`/`target` (ObservableVec3) directly.
 */
export class PlayerCamera {
	#playerCamera: FreeCamera;
	#followDistance = 0.001;
	#eyeHeight = 1.8;

	#cameraPitch = 0;
	#cameraYaw = 0;
	readonly #maxPitch = Math.PI / 2 - 0.003;
	public mouseSensitivity = 0.003;

	readonly #minZoom = 0.01;
	readonly #maxZoom = 10000;
	readonly #zoomSpeed = 20.333;

	constructor() {
		this.#playerCamera = createFreeCamera(
			{ x: 0, y: this.#eyeHeight, z: 0 },
			{ x: 0, y: this.#eyeHeight, z: 1 },
		);
		this.#playerCamera.fov = SETTING_PARAMS.CAMERA_FOV * (Math.PI / 180);
		this.#playerCamera.nearPlane = 0.1;
		this.#playerCamera.farPlane = 13000;
	}

	public moveWithPlayer(characterPosition: Vec3): void {
		const cosP = Math.cos(this.#cameraPitch);
		const fx = Math.sin(this.#cameraYaw) * cosP;
		const fy = -Math.sin(this.#cameraPitch);
		const fz = Math.cos(this.#cameraYaw) * cosP;

		const eye = this.#followDistance > this.#minZoom ? this.#eyeHeight : 0.66;
		const cy = characterPosition.y + eye;

		this.#playerCamera.position.set(
			characterPosition.x - fx * this.#followDistance,
			cy - fy * this.#followDistance,
			characterPosition.z - fz * this.#followDistance,
		);
		this.#playerCamera.target.set(characterPosition.x, cy, characterPosition.z);
	}

	public handleMouseMovement(deltaX: number, deltaY: number): void {
		this.#cameraYaw -= -deltaX * this.mouseSensitivity;
		this.#cameraPitch += deltaY * this.mouseSensitivity;
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

	/** Full 3D unit vector pointing in the direction the camera is looking. */
	public getForwardDirection(): Vec3 {
		const cosP = Math.cos(this.#cameraPitch);
		return vec3(
			Math.sin(this.#cameraYaw) * cosP,
			-Math.sin(this.#cameraPitch),
			Math.cos(this.#cameraYaw) * cosP,
		);
	}

	/** True when zoomed out far enough to see the player body (third-person). */
	public get isThirdPerson(): boolean {
		return this.#followDistance > 0.5;
	}

	public get playerCamera(): FreeCamera {
		return this.#playerCamera;
	}

	public set fov(value: number) {
		this.#playerCamera.fov = value * (Math.PI / 180);
	}

	public get position(): Vec3 {
		const p = this.#playerCamera.position;
		return { x: p.x, y: p.y, z: p.z };
	}

	public set position(position: Vec3) {
		this.#playerCamera.position.set(position.x, position.y, position.z);
	}

	public set target(target: Vec3) {
		this.#playerCamera.target.set(target.x, target.y, target.z);
	}
}
