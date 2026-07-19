import { type Mesh, scaleVec3InPlace, type Vec3, vec3 } from "@babylonjs/lite";
import type { Mount } from "@/code/Entities/Mount";
import type { IControls } from "@/code/Interface/IControls";
import {
	Matrix,
	setVec3,
	transformNormalVec3ToRef,
	vec3Zero,
} from "@/code/Lib/Math";
import type { Player } from "../Player";
import { handleDebugKey } from "./DebugControlHelper";

export type BoatControlEntity = {
	mount: Mount;
	submergedPoints: number;
	boatPosition: Vec3;
	boatMesh: Mesh;
	currentYaw: number;
	applyImpulse(impulse: Vec3, worldPoint: Vec3): void;
	applyAngularImpulse(impulse: Vec3): void;
};

export class CustomBoatControls implements IControls<BoatControlEntity> {
	readonly controlType = "customBoat";
	public pressedKeys = new Set<string>();
	#controlledEntity: BoatControlEntity;
	#inputDirection: Vec3;

	#player: Player;

	// Scratch vectors for per-frame #tick (avoids allocation)
	readonly #_angularLeft = vec3Zero();
	readonly #_angularRight = vec3Zero();
	readonly #_forward = vec3Zero();

	public static KEY_LEFT = ["a", "arrowleft"];
	public static KEY_RIGHT = ["d", "arrowright"];
	public static KEY_UP = ["w", "arrowup"];
	public static KEY_DOWN = ["s", "arrowdown"];
	public static KEY_USE = ["e"];
	public static KEY_JUMP = [" "];
	public static KEY_SPRINT = ["capslock"];
	public static KEY_FLASH = ["f"];

	public static MOUSE_WHEEL_UP = ["wheel_up"];
	public static MOUSE_WHEEL_DOWN = ["wheel_down"];

	#pushVectorUp = vec3(0, 0.5, 0);
	#pushVectorDown = vec3(0, -0.5, 0);

	#pushStrength = 3;
	#pushNoseUpStrength = -3;
	#angularPushStrength = 1;
	#angularRotationStrength = 0.45;
	#pushAngularVectorLeft = vec3(
		this.#pushNoseUpStrength,
		-this.#angularPushStrength,
		this.#angularRotationStrength,
	);
	#pushAngularVectorRight = vec3(
		this.#pushNoseUpStrength,
		this.#angularPushStrength,
		-this.#angularRotationStrength,
	);

	// Reusable rotation matrix — built from currentYaw each tick, never from the mesh
	static readonly #rotationMatrix = new Matrix();
	static readonly #_localForward = vec3(0, 0, 1);

	constructor(paddleBoat: BoatControlEntity, player: Player) {
		this.#controlledEntity = paddleBoat;
		// Share the same inputDirection Vector3 as WalkingControls so the motor
		// always reads the current control state regardless of which is active.
		const legacy = player as unknown as {
			playerVehicle: { inputDirection: Vec3 };
		};
		this.#inputDirection = legacy.playerVehicle.inputDirection;
		this.#player = player;

		// Clear all axes on entry so stale values from WalkingControls don't
		// persist into boat mode (WalkingControls uses .x and .z; we use the
		// same axes so there is no cross-pollution).
		setVec3(this.#inputDirection, 0, 0, 0);
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

		if (handleDebugKey(key)) return;

		this.#updateMovementAxesFromPressedKeys();

		if (CustomBoatControls.KEY_USE.includes(key)) {
			this.#player.use();
		}
	}

	public onKeyUp(key: string) {
		if (CustomBoatControls.KEY_FLASH.includes(key)) {
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
		this.#updateMovementAxesFromPressedKeys();
	}

	/**
	 * Mirror WalkingControls convention exactly:
	 *   inputDirection.z  = forward/back  (+1 = forward / W, -1 = back / S)
	 *   inputDirection.x  = strafe        (+1 = right  / D, -1 = left / A)
	 *
	 * This means PlayerVehicleMotor.getInputVelocity() works identically on the
	 * boat deck and on terrain — no special-case rotation needed.
	 */
	#updateMovementAxesFromPressedKeys() {
		const forward = this.#pressedKeysHas(CustomBoatControls.KEY_UP);
		const backward = this.#pressedKeysHas(CustomBoatControls.KEY_DOWN);
		const right = this.#pressedKeysHas(CustomBoatControls.KEY_RIGHT);
		const left = this.#pressedKeysHas(CustomBoatControls.KEY_LEFT);

		this.#inputDirection.z = forward === backward ? 0 : forward ? 1 : -1;
		this.#inputDirection.x = right === left ? 0 : right ? 1 : -1;
	}

	#tick() {
		if (this.#controlledEntity.submergedPoints <= 1) {
			return;
		}

		const position = this.#controlledEntity.boatPosition;

		// Build rotation matrix from currentYaw — the hull mesh is always identity
		// so we can never use boatMesh.rotationQuaternion or boatMesh.forward here.
		const rot = Matrix.RotationY(this.#controlledEntity.currentYaw);
		CustomBoatControls.#rotationMatrix.copyFrom(rot);

		transformNormalVec3ToRef(
			this.#pushAngularVectorLeft,
			CustomBoatControls.#rotationMatrix,
			this.#_angularLeft,
		);
		transformNormalVec3ToRef(
			this.#pushAngularVectorRight,
			CustomBoatControls.#rotationMatrix,
			this.#_angularRight,
		);

		// Forward is +Z in local space, rotated by current yaw.
		transformNormalVec3ToRef(
			CustomBoatControls.#_localForward,
			CustomBoatControls.#rotationMatrix,
			this.#_forward,
		);
		scaleVec3InPlace(this.#_forward, this.#pushStrength);

		// Sprint cancels push
		if (this.#pressedKeysHas(CustomBoatControls.KEY_SPRINT)) {
			this.#_forward.x = 0;
			this.#_forward.y = 0;
			this.#_forward.z = 0;

			this.#_angularLeft.x = this.#_angularLeft.x >> 1;
			this.#_angularLeft.y = this.#_angularLeft.y << 1;
			this.#_angularLeft.z = this.#_angularLeft.z >> 1;

			this.#_angularRight.x = this.#_angularRight.x >> 1;
			this.#_angularRight.y = this.#_angularRight.y << 1;
			this.#_angularRight.z = this.#_angularRight.z >> 1;
		}

		this.#handleForwardBack(this.#_forward, position);
		this.#handleLeftRight(
			this.#_forward,
			position,
			this.#_angularLeft,
			this.#_angularRight,
		);
	}

	/**
	 * W (z=1) = push boat forward/up, S (z=-1) = push boat back/down.
	 * Previously used inputDirection.y; now uses .z to match WalkingControls.
	 */
	#handleForwardBack(forward: Vec3, position: Vec3) {
		if (this.#inputDirection.z > 0) {
			scaleVec3InPlace(forward, 0.4);
			this.#controlledEntity.applyImpulse(this.#pushVectorUp, position);
		} else if (this.#inputDirection.z < 0) {
			scaleVec3InPlace(forward, 0.4);
			this.#controlledEntity.applyImpulse(this.#pushVectorDown, position);
		}
	}

	#handleLeftRight(
		forward: Vec3,
		position: Vec3,
		angularLeftWorld: Vec3,
		angularRightWorld: Vec3,
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
		for (const k of keys) {
			if (this.pressedKeys.has(k)) return true;
		}
		return false;
	}

	public get controlledEntity(): BoatControlEntity {
		return this.#controlledEntity;
	}

	public get inputDirection(): Vec3 {
		return this.#inputDirection;
	}

	public update(): void {
		this.#tick();
	}
}
