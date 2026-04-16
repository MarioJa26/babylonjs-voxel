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

	public checkSupport(
		_deltaTime: number,
		_downDirection: Vector3,
	): CharacterSurfaceInfo {
		return {
			supportedState:
				this.#position.y <= 0.001
					? CharacterSupportedState.SUPPORTED
					: CharacterSupportedState.UNSUPPORTED,
			averageSurfaceNormal: Vector3.Up(),
			averageSurfaceVelocity: Vector3.Zero(),
		};
	}

	public integrate(
		deltaTime: number,
		_supportInfo: CharacterSurfaceInfo,
		gravity: Vector3,
	): void {
		this.#velocity.addInPlace(gravity.scale(deltaTime));
		this.#position.addInPlace(this.#velocity.scale(deltaTime));
		if (this.#position.y < 0) {
			this.#position.y = 0;
			if (this.#velocity.y < 0) {
				this.#velocity.y = 0;
			}
		}
	}
}
