import { createFreeCamera, type FreeCamera, type Vec3 } from "@babylonjs/lite";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";

const DEG_TO_RAD = Math.PI / 180;

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

/** Atomic camera snapshot. See `writeFrameState`. */
export interface CameraFrameState {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	forwardX: number;
	forwardY: number;
	forwardZ: number;
}

/**
 * Lite native port of PlayerCamera.
 * Third-person follow camera. Drives a Lite `FreeCamera`'s
 * `position` and `target` ObservableVec3 directly.
 */
export class PlayerCamera {
	#playerCamera: FreeCamera;

	#followDistance = 0.001;
	#eyeHeight = 1.8;

	// Smoothed vertical eye height in world units.
	// Lazily synchronized by moveWithPlayer/snapToPlayer.
	#smoothedEyeY = this.#eyeHeight;
	readonly #verticalSmoothSpeed = 36;

	#cameraPitch = 0;
	#cameraYaw = 0;
	readonly #maxPitch = Math.PI / 2 - 0.003;

	public mouseSensitivity = 0.003;

	// Explosion screen shake. 0 = steady, 1 = full trauma.
	#trauma = 0;
	readonly #traumaDecayPerSec = 1.4;
	readonly #traumaMaxOffset = 0.45;

	readonly #minZoom = 0.01;
	readonly #maxZoom = 10000;
	readonly #zoomSpeed = 5;

	// Eye height used at exactly #minZoom. A separate concept from the body
	// visibility boundary below: [minZoom] uses the low first-person eye,
	// (minZoom..bodyVisible] uses the full eye height but still counts as
	// first person, and (bodyVisible..] is third person. Intentional.
	readonly #minZoomEyeHeight = 0.66;
	readonly #bodyVisibleDistance = 0.5;

	// Cached unit forward vector. Updated only when yaw/pitch changes.
	#forwardX = 0;
	#forwardY = 0;
	#forwardZ = 1;

	/** Base, unzoomed FOV in degrees. */
	#baseFov = SETTING_PARAMS.CAMERA_FOV;

	// Shared scratch objects. Callers must consume their values immediately.
	readonly #forwardScratch: Vec3 = { x: 0, y: 0, z: 0 };
	readonly #positionScratch: Vec3 = { x: 0, y: 0, z: 0 };

	constructor() {
		const eyeHeight = this.#eyeHeight;

		this.#playerCamera = createFreeCamera(
			{ x: 0, y: eyeHeight, z: 0 },
			{ x: 0, y: eyeHeight, z: 1 },
		);

		this.#playerCamera.fov = this.#baseFov * DEG_TO_RAD;
		this.#playerCamera.nearPlane = 0.1;

		// Must exceed the far-tile horizon so the full render distance
		// remains inside the camera frustum.
		this.#playerCamera.farPlane = 20000;
	}

	/**
	 * Follow `characterPosition`.
	 *
	 * With a positive `deltaSeconds`, vertical movement is exponentially
	 * smoothed while horizontal tracking remains exact. An omitted, zero, or
	 * negative delta snaps immediately, which is useful for teleports.
	 */
	public moveWithPlayer(characterPosition: Vec3, deltaSeconds?: number): void {
		const distance = this.#followDistance;
		const eyeHeight =
			distance > this.#minZoom ? this.#eyeHeight : this.#minZoomEyeHeight;
		const targetY = characterPosition.y + eyeHeight;

		let cameraY: number;

		if (deltaSeconds !== undefined && deltaSeconds > 0) {
			const smoothing = 1 - Math.exp(-this.#verticalSmoothSpeed * deltaSeconds);

			cameraY = this.#smoothedEyeY + (targetY - this.#smoothedEyeY) * smoothing;

			this.#smoothedEyeY = cameraY;
		} else {
			cameraY = targetY;
			this.#smoothedEyeY = targetY;
		}

		let shakeX = 0;
		let shakeY = 0;
		let shakeZ = 0;

		let trauma = this.#trauma;

		if (trauma > 0) {
			if (deltaSeconds !== undefined && deltaSeconds > 0) {
				trauma -= this.#traumaDecayPerSec * deltaSeconds;

				if (trauma <= 0) {
					trauma = 0;
					this.#trauma = 0;
				} else {
					this.#trauma = trauma;
				}
			}

			if (trauma > 0) {
				const shakeScale = trauma * trauma * this.#traumaMaxOffset;

				shakeX = (Math.random() * 2 - 1) * shakeScale;
				shakeY = (Math.random() * 2 - 1) * shakeScale;
				shakeZ = (Math.random() * 2 - 1) * shakeScale;
			}
		}

		const characterX = characterPosition.x;
		const characterZ = characterPosition.z;

		this.#playerCamera.position.set(
			characterX - this.#forwardX * distance + shakeX,
			cameraY - this.#forwardY * distance + shakeY,
			characterZ - this.#forwardZ * distance + shakeZ,
		);

		this.#playerCamera.target.set(
			characterX + shakeX * 0.5,
			cameraY + shakeY * 0.5,
			characterZ + shakeZ * 0.5,
		);
	}

	/**
	 * Add explosion-shake trauma.
	 * The accumulated value is clamped to the range 0..1.
	 */
	public addTrauma(amount: number): void {
		this.#trauma = clamp(this.#trauma + amount, 0, 1);
	}

	/** Snap the camera to the player for respawns, restores, or locks. */
	public snapToPlayer(characterPosition: Vec3): void {
		this.moveWithPlayer(characterPosition, 0);
	}

	public handleMouseMovement(deltaX: number, deltaY: number): void {
		this.#cameraYaw += deltaX * this.mouseSensitivity;
		this.#cameraPitch = clamp(
			this.#cameraPitch + deltaY * this.mouseSensitivity,
			-this.#maxPitch,
			this.#maxPitch,
		);

		this.#updateForwardCache();
	}

	public zoomIn(): void {
		const nextDistance = this.#followDistance - this.#zoomSpeed;
		this.#followDistance =
			nextDistance < this.#minZoom ? this.#minZoom : nextDistance;
	}

	public zoomOut(): void {
		const nextDistance = this.#followDistance + this.#zoomSpeed;
		this.#followDistance =
			nextDistance > this.#maxZoom ? this.#maxZoom : nextDistance;
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
		this.#cameraPitch = clamp(value, -this.#maxPitch, this.#maxPitch);
		this.#updateForwardCache();
	}

	/**
	 * Returns a shared scratch vector containing the camera's forward
	 * direction. Do not retain or mutate it; prefer `writeForwardDirection`
	 * for hot paths.
	 */
	public getForwardDirection(): Vec3 {
		const result = this.#forwardScratch;

		result.x = this.#forwardX;
		result.y = this.#forwardY;
		result.z = this.#forwardZ;

		return result;
	}

	/**
	 * Non-allocating forward-direction read. `out` may be caller-owned
	 * storage; nothing is retained.
	 */
	public writeForwardDirection(out: Vec3): void {
		out.x = this.#forwardX;
		out.y = this.#forwardY;
		out.z = this.#forwardZ;
	}

	/** True when zoomed out far enough to see the player body. */
	public get isThirdPerson(): boolean {
		return this.#followDistance > this.#bodyVisibleDistance;
	}

	/**
	 * Atomic camera snapshot: position, yaw/pitch, and the cached forward
	 * vector are captured together so callers cannot observe a half-updated
	 * camera (e.g. new position with a stale yaw).
	 */
	public writeFrameState(out: CameraFrameState): void {
		const position = this.#playerCamera.position;

		out.x = position.x;
		out.y = position.y;
		out.z = position.z;
		out.yaw = this.#cameraYaw;
		out.pitch = this.#cameraPitch;
		out.forwardX = this.#forwardX;
		out.forwardY = this.#forwardY;
		out.forwardZ = this.#forwardZ;
	}

	public get playerCamera(): FreeCamera {
		return this.#playerCamera;
	}

	public set fov(value: number) {
		this.#baseFov = value;
		this.#playerCamera.fov = value * DEG_TO_RAD;
	}

	/**
	 * Apply a bow-draw zoom effect.
	 *
	 * @param drawProgress 0 = no zoom, 1 = full draw zoom.
	 */
	public setBowZoom(drawProgress: number): void {
		const progress = clamp(drawProgress, 0, 1);
		const zoomFactor = 1 - 0.22 * progress * progress;

		this.#playerCamera.fov = this.#baseFov * zoomFactor * DEG_TO_RAD;
	}

	/** Restore the camera to its base FOV. */
	public clearBowZoom(): void {
		this.#playerCamera.fov = this.#baseFov * DEG_TO_RAD;
	}

	/**
	 * Returns a shared scratch vector containing the camera position.
	 * Do not retain or mutate it; prefer `writePosition` for hot paths.
	 *
	 * Note: successive reads alias — `const a = camera.position; const b =
	 * camera.position;` leaves `a === b`.
	 */
	public get position(): Vec3 {
		const position = this.#playerCamera.position;
		const result = this.#positionScratch;

		result.x = position.x;
		result.y = position.y;
		result.z = position.z;

		return result;
	}

	/**
	 * Non-allocating camera-position read. `out` may be caller-owned
	 * storage; nothing is retained.
	 */
	public writePosition(out: Vec3): void {
		const position = this.#playerCamera.position;

		out.x = position.x;
		out.y = position.y;
		out.z = position.z;
	}

	/** Scalar camera-position reads for when only one axis is needed. */
	public get x(): number {
		return this.#playerCamera.position.x;
	}

	public get y(): number {
		return this.#playerCamera.position.y;
	}

	public get z(): number {
		return this.#playerCamera.position.z;
	}

	public set position(position: Vec3) {
		this.#playerCamera.position.set(position.x, position.y, position.z);
	}

	public set target(target: Vec3) {
		this.#playerCamera.target.set(target.x, target.y, target.z);
	}

	#updateForwardCache(): void {
		const pitch = this.#cameraPitch;
		const yaw = this.#cameraYaw;
		const cosPitch = Math.cos(pitch);

		this.#forwardX = Math.sin(yaw) * cosPitch;
		this.#forwardY = -Math.sin(pitch);
		this.#forwardZ = Math.cos(yaw) * cosPitch;
	}
}
