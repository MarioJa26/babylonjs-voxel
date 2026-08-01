import { type Mesh, scaleVec3, type Vec3, vec3 } from "@babylonjs/lite";
import type { Mount } from "@/code/Entities/Mount";
import type { IControls } from "@/code/Interface/IControls";
import { Matrix, transformNormalVec3ToRef, vec3Zero } from "@/code/Lib/Math";
import type { Player } from "../Player";
import { handleDebugKey } from "./DebugControlHelper";

export type BoatControlEntity = {
	mount: Mount;
	submergedPoints: number;
	boatMesh: Mesh;
	currentYaw: number;
	applyImpulse(impulse: Vec3, worldPoint: Vec3): void;
	applyAngularImpulse(impulse: Vec3): void;
	getBoatPositionToRef(out: Vec3): void;
};

export class PaddleBoatControls implements IControls<BoatControlEntity> {
	readonly controlType = "paddleBoat";
	public pressedKeys = new Set<string>();
	#controlledEntity: BoatControlEntity;
	#inputDirection = vec3Zero();

	#player: Player;

	// Scratch vectors for per-frame #tick (avoids allocation)
	readonly #_angularLeft = vec3Zero();
	readonly #_angularRight = vec3Zero();
	readonly #_forward = vec3Zero();
	readonly #_position = vec3Zero();

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

	#pushStrength = 2;
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

	constructor(paddleBoat: BoatControlEntity, player: Player) {
		this.#controlledEntity = paddleBoat;
		const legacy = player as unknown as {
			playerVehicle: { inputDirection: Vec3 };
		};
		this.#inputDirection = legacy.playerVehicle.inputDirection;
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

		if (handleDebugKey(key)) return;

		if (PaddleBoatControls.KEY_RIGHT.includes(key)) {
			this.#inputDirection.x = 1;
		} else if (PaddleBoatControls.KEY_LEFT.includes(key)) {
			this.#inputDirection.x = -1;
		} else if (PaddleBoatControls.KEY_UP.includes(key)) {
			this.#inputDirection.y = -1;
		} else if (PaddleBoatControls.KEY_DOWN.includes(key)) {
			this.#inputDirection.y = 1;
		} else if (PaddleBoatControls.KEY_USE.includes(key)) {
			this.#player.use();
		}
	}

	public onKeyUp(key: string) {
		if (PaddleBoatControls.KEY_UP.includes(key)) {
			if (this.#pressedKeysHas(PaddleBoatControls.KEY_DOWN)) {
				this.#inputDirection.y = 1;
			} else {
				this.#inputDirection.y = 0;
			}
		} else if (PaddleBoatControls.KEY_DOWN.includes(key)) {
			if (this.#pressedKeysHas(PaddleBoatControls.KEY_UP)) {
				this.#inputDirection.y = -1;
			} else {
				this.#inputDirection.y = 0;
			}
		} else if (PaddleBoatControls.KEY_RIGHT.includes(key)) {
			if (this.#pressedKeysHas(PaddleBoatControls.KEY_LEFT)) {
				this.#inputDirection.x = -1;
			} else {
				this.#inputDirection.x = 0;
			}
		} else if (PaddleBoatControls.KEY_LEFT.includes(key)) {
			if (this.#pressedKeysHas(PaddleBoatControls.KEY_RIGHT)) {
				this.#inputDirection.x = 1;
			} else {
				this.#inputDirection.x = 0;
			}
		} else if (PaddleBoatControls.KEY_FLASH.includes(key)) {
			this.#player.flashlight.toggle();
		}

		if (PaddleBoatControls.MOUSE_WHEEL_UP.includes(key)) {
			this.#controlledEntity.mount.getMountedUser()?.playerCamera.zoomIn();
			this.pressedKeys.delete(key);
		} else if (PaddleBoatControls.MOUSE_WHEEL_DOWN.includes(key)) {
			this.#controlledEntity.mount.getMountedUser()?.playerCamera.zoomOut();
			this.pressedKeys.delete(key);
		}
		this.pressedKeys.delete(key);
	}

	static readonly #rotationMatrix = new Matrix();
	static readonly #_localForward = vec3(0, 0, 1);
	#tick() {
		if (this.#controlledEntity.submergedPoints <= 1) {
			return;
		}
		this.#controlledEntity.getBoatPositionToRef(this.#_position);
		const position = this.#_position;
		// Lite `Mesh` has no rotationQuaternion — derive heading from currentYaw.
		Matrix.RotationYToRef(
			this.#controlledEntity.currentYaw,
			PaddleBoatControls.#rotationMatrix,
		);
		transformNormalVec3ToRef(
			this.#pushAngularVectorLeft,
			PaddleBoatControls.#rotationMatrix,
			this.#_angularLeft,
		);
		transformNormalVec3ToRef(
			this.#pushAngularVectorRight,
			PaddleBoatControls.#rotationMatrix,
			this.#_angularRight,
		);

		transformNormalVec3ToRef(
			PaddleBoatControls.#_localForward,
			PaddleBoatControls.#rotationMatrix,
			this.#_forward,
		);
		scaleVec3(this.#_forward, this.#pushStrength);

		// Sprint cancels push
		if (this.#pressedKeysHas(PaddleBoatControls.KEY_SPRINT)) {
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
		this.#handleUpDown(this.#_forward, position);
		this.#handleLeftRight(
			this.#_forward,
			position,
			this.#_angularLeft,
			this.#_angularRight,
		);
	}
	#handleUpDown(forward: Vec3, position: Vec3) {
		if (this.#inputDirection.y < 0) {
			scaleVec3(forward, 0.4);
			this.#controlledEntity.applyImpulse(this.#pushVectorUp, position);
		} else if (this.#inputDirection.y > 0) {
			scaleVec3(forward, 0.4);
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
