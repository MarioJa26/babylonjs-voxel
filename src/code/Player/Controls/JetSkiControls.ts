import { Matrix, Vector3 } from "@babylonjs/core";
import type { IControls } from "../../Inferface/IControls";
import type { Player } from "../Player";
import { DebugControlHelper } from "./DebugControlHelper";
import type { BoatControlEntity } from "./PaddleBoatControls";

export class JetSkiControls implements IControls<BoatControlEntity> {
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

	#pushStrength = 10;
	#pushNoseUpStrength = -3;
	#angularPushStrength = 5;
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

		if (DebugControlHelper.handleKey(key)) return;

		if (JetSkiControls.KEY_RIGHT.includes(key)) {
			this.#inputDirection.x = 1;
		} else if (JetSkiControls.KEY_LEFT.includes(key)) {
			this.#inputDirection.x = -1;
		} else if (JetSkiControls.KEY_UP.includes(key)) {
			this.#inputDirection.y = -1;
		} else if (JetSkiControls.KEY_DOWN.includes(key)) {
			this.#inputDirection.y = 1;
		}
	}

	public onKeyUp(key: string) {
		if (JetSkiControls.KEY_UP.includes(key)) {
			if (this.#pressedKeysHas(JetSkiControls.KEY_DOWN)) {
				this.#inputDirection.y = 1;
			} else {
				this.#inputDirection.y = 0;
			}
		} else if (JetSkiControls.KEY_DOWN.includes(key)) {
			if (this.#pressedKeysHas(JetSkiControls.KEY_UP)) {
				this.#inputDirection.y = -1;
			} else {
				this.#inputDirection.y = 0;
			}
		} else if (JetSkiControls.KEY_RIGHT.includes(key)) {
			if (this.#pressedKeysHas(JetSkiControls.KEY_LEFT)) {
				this.#inputDirection.x = -1;
			} else {
				this.#inputDirection.x = 0;
			}
		} else if (JetSkiControls.KEY_LEFT.includes(key)) {
			if (this.#pressedKeysHas(JetSkiControls.KEY_RIGHT)) {
				this.#inputDirection.x = 1;
			} else {
				this.#inputDirection.x = 0;
			}
		} else if (JetSkiControls.KEY_USE.includes(key)) {
			this.#player.use();
		} else if (JetSkiControls.KEY_FLASH.includes(key)) {
			this.#player.flashlight.toggle();
		}

		if (JetSkiControls.MOUSE_WHEEL_UP.includes(key)) {
			this.#controlledEntity.mount.getMountedUser()?.playerCamera.zoomIn();
			this.pressedKeys.delete(key);
		} else if (JetSkiControls.MOUSE_WHEEL_DOWN.includes(key)) {
			this.#controlledEntity.mount.getMountedUser()?.playerCamera.zoomOut();
			this.pressedKeys.delete(key);
		}
		this.pressedKeys.delete(key);
	}

	static readonly #rotationMatrix = new Matrix();
	#tick() {
		if (this.#controlledEntity.submergedPoints <= 1) {
			return;
		}
		const position = this.#controlledEntity.boatPosition;
		this.#controlledEntity.boatMesh.rotationQuaternion!.toRotationMatrix(
			JetSkiControls.#rotationMatrix,
		);
		const angularLeftWorld = Vector3.TransformNormal(
			this.#pushAngularVectorLeft,
			JetSkiControls.#rotationMatrix,
		);
		const angularRightWorld = Vector3.TransformNormal(
			this.#pushAngularVectorRight,
			JetSkiControls.#rotationMatrix,
		);

		const forward = this.#controlledEntity.boatMesh.forward.scale(
			this.#pushStrength,
		);

		// Sprint cancels push
		if (this.#pressedKeysHas(JetSkiControls.KEY_SPRINT)) {
			forward.copyFrom(Vector3.Zero());
			angularLeftWorld.x = angularLeftWorld.x >> 1;
			angularLeftWorld.y = angularLeftWorld.y << 1;
			angularLeftWorld.z = angularLeftWorld.z >> 1;

			angularRightWorld.x = angularRightWorld.x >> 1;
			angularRightWorld.y = angularRightWorld.y << 1;
			angularRightWorld.z = angularRightWorld.z >> 1;
		}
		this.#handleUpDown(forward, position);
		this.#handleLeftRight(
			forward,
			position,
			angularLeftWorld,
			angularRightWorld,
		);
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
