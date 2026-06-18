import { Vector3 } from "@babylonjs/core";

export enum CharacterSupportedState {
	UNSUPPORTED = 0,
	SUPPORTED = 1,
}

export type CharacterSurfaceInfo = {
	supportedState: CharacterSupportedState;
	averageSurfaceNormal: Vector3;
	averageSurfaceVelocity: Vector3;
};

export class SimpleCharacterController {
	public keepDistance = 0;
	public keepContactTolerance = 0;
	public maxCastIterations = 0;
	public penetrationRecoverySpeed = 0;
	public maxSlopeCosine = 0;

	#position: Vector3;
	#velocity = Vector3.Zero();

	static readonly #cachedSurfaceNormal = Vector3.Up();
	static readonly #cachedSurfaceVelocity = Vector3.Zero();
	static readonly #cachedSurfaceInfo: CharacterSurfaceInfo = {
		supportedState: CharacterSupportedState.UNSUPPORTED,
		averageSurfaceNormal: SimpleCharacterController.#cachedSurfaceNormal,
		averageSurfaceVelocity: SimpleCharacterController.#cachedSurfaceVelocity,
	};

	constructor(startPosition: Vector3) {
		this.#position = startPosition.clone();
	}

	public getPosition(): Vector3 {
		return this.#position;
	}

	public setPosition(position: Vector3): void {
		this.#position.copyFrom(position);
	}

	public getVelocity(): Vector3 {
		return this.#velocity;
	}

	public setVelocity(velocity: Vector3): void {
		this.#velocity.copyFrom(velocity);
	}

	public checkSupport(): CharacterSurfaceInfo {
		const info = SimpleCharacterController.#cachedSurfaceInfo;
		info.supportedState =
			this.#position.y <= 0.001
				? CharacterSupportedState.SUPPORTED
				: CharacterSupportedState.UNSUPPORTED;
		return info;
	}

	public integrate(deltaTime: number, gravity: Vector3): void {
		this.#velocity.x += gravity.x * deltaTime;
		this.#velocity.y += gravity.y * deltaTime;
		this.#velocity.z += gravity.z * deltaTime;
		this.#position.x += this.#velocity.x * deltaTime;
		this.#position.y += this.#velocity.y * deltaTime;
		this.#position.z += this.#velocity.z * deltaTime;
		if (this.#position.y < 0) {
			this.#position.y = 0;
			if (this.#velocity.y < 0) {
				this.#velocity.y = 0;
			}
		}
	}
}
