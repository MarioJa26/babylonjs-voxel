import {
	createFreeCamera,
	type FreeCamera,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";

/**
 * Lite native port of PlayerCamera.
 * Third-person follow camera. Drives a Lite `FreeCamera`'s
 * `position`/`target` ObservableVec3 directly.
 */
export class PlayerCamera {
	#playerCamera: FreeCamera;

	#followDistance = 0.001;
	#eyeHeight = 1.8;

	// Smoothed vertical eye height in world units.
	// Lazily initialized so the first move/snap is exact.
	#smoothedEyeY: number = this.#eyeHeight;
	readonly #verticalSmoothSpeed = 36;

	#cameraPitch = 0;
	#cameraYaw = 0;
	readonly #maxPitch = Math.PI / 2 - 0.003;
	public mouseSensitivity = 0.003;

	readonly #minZoom = 0.01;
	readonly #maxZoom = 10000;
	readonly #zoomSpeed = 5.0;

	// Cached unit forward vector. Updated only when yaw/pitch changes.
	#forwardX = 0;
	#forwardY = 0;
	#forwardZ = 1;

	constructor() {
		this.#playerCamera = createFreeCamera(
			{ x: 0, y: this.#eyeHeight, z: 0 },
			{ x: 0, y: this.#eyeHeight, z: 1 },
		);

		this.#playerCamera.fov = SETTING_PARAMS.CAMERA_FOV * (Math.PI / 180);
		this.#playerCamera.nearPlane = 0.1;
		// Must exceed the far-tile horizon (FAR_TILE_DISTANCE chunks) so the
		// full 512-chunk render distance stays inside the frustum.
		this.#playerCamera.farPlane = 20000;
	}

	/**
	 * Follow `characterPosition`. When `deltaSeconds` is provided the vertical
	 * eye height is exponentially eased toward the player, so block steps do not
	 * jerk the view. Horizontal tracking stays exact. Omitted/zero delta snaps
	 * immediately, which is used for teleports.
	 */
	public moveWithPlayer(characterPosition: Vec3, deltaSeconds?: number): void {
		const eye = this.#followDistance > this.#minZoom ? this.#eyeHeight : 0.66;
		const targetY = characterPosition.y + eye;

		let cameraY = targetY;

		if (deltaSeconds !== undefined && deltaSeconds > 0) {
			this.#smoothedEyeY +=
				(targetY - this.#smoothedEyeY) *
				(1 - Math.exp(-this.#verticalSmoothSpeed * deltaSeconds));

			cameraY = this.#smoothedEyeY;
		} else {
			this.#smoothedEyeY = targetY;
		}

		const distance = this.#followDistance;

		this.#playerCamera.position.set(
			characterPosition.x - this.#forwardX * distance,
			cameraY - this.#forwardY * distance,
			characterPosition.z - this.#forwardZ * distance,
		);

		this.#playerCamera.target.set(
			characterPosition.x,
			cameraY,
			characterPosition.z,
		);
	}

	/** Snap the camera straight to a position, for respawn / save restore / locks. */
	public snapToPlayer(characterPosition: Vec3): void {
		this.moveWithPlayer(characterPosition, 0);
	}

	public handleMouseMovement(deltaX: number, deltaY: number): void {
		this.#cameraYaw += deltaX * this.mouseSensitivity;
		this.#cameraPitch += deltaY * this.mouseSensitivity;

		if (this.#cameraPitch > this.#maxPitch) {
			this.#cameraPitch = this.#maxPitch;
		} else if (this.#cameraPitch < -this.#maxPitch) {
			this.#cameraPitch = -this.#maxPitch;
		}

		this.#updateForwardCache();
	}

	public zoomIn(): void {
		this.#followDistance = Math.max(
			this.#minZoom,
			this.#followDistance - this.#zoomSpeed,
		);
	}

	public zoomOut(): void {
		this.#followDistance = Math.min(
			this.#maxZoom,
			this.#followDistance + this.#zoomSpeed,
		);
	}

	public get cameraYaw(): number {
		return this.#cameraYaw;
	}

	public set cameraYaw(value: number) {
		this.#cameraYaw = value;
		this.#updateForwardCache();
	}

	public get cameraPitch(): number {
		return this.#cameraPitch;
	}

	public set cameraPitch(value: number) {
		if (value > this.#maxPitch) {
			value = this.#maxPitch;
		} else if (value < -this.#maxPitch) {
			value = -this.#maxPitch;
		}
		this.#cameraPitch = value;
		this.#updateForwardCache();
	}

	/** Full 3D unit vector pointing in the direction the camera is looking. */
	public getForwardDirection(): Vec3 {
		return vec3(this.#forwardX, this.#forwardY, this.#forwardZ);
	}

	/** True when zoomed out far enough to see the player body, meaning third-person. */
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
		const position = this.#playerCamera.position;
		return { x: position.x, y: position.y, z: position.z };
	}

	public set position(position: Vec3) {
		this.#playerCamera.position.set(position.x, position.y, position.z);
	}

	public set target(target: Vec3) {
		this.#playerCamera.target.set(target.x, target.y, target.z);
	}

	#updateForwardCache(): void {
		const cosPitch = Math.cos(this.#cameraPitch);

		this.#forwardX = Math.sin(this.#cameraYaw) * cosPitch;
		this.#forwardY = -Math.sin(this.#cameraPitch);
		this.#forwardZ = Math.cos(this.#cameraYaw) * cosPitch;
	}
}
