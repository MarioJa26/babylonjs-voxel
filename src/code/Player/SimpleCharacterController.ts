import { type Vec3, Vec3Up } from "@babylonjs/lite";
import { vec3Zero } from "../Lib/Math";

export enum CharacterSupportedState {
	UNSUPPORTED = 0,
	SUPPORTED = 1,
}

export type CharacterSurfaceInfo = {
	supportedState: CharacterSupportedState;
	averageSurfaceNormal: Vec3;
	averageSurfaceVelocity: Vec3;
};

export class SimpleCharacterController {
	public keepDistance = 0;
	public keepContactTolerance = 0;
	public maxCastIterations = 0;
	public penetrationRecoverySpeed = 0;
	public maxSlopeCosine = 0;

	#position: Vec3;
	#velocity = vec3Zero();

	static readonly #cachedSurfaceNormal = Vec3Up;
	static readonly #cachedSurfaceVelocity = vec3Zero();
	static readonly #cachedSurfaceInfo: CharacterSurfaceInfo = {
		supportedState: CharacterSupportedState.UNSUPPORTED,
		averageSurfaceNormal: SimpleCharacterController.#cachedSurfaceNormal,
		averageSurfaceVelocity: SimpleCharacterController.#cachedSurfaceVelocity,
	};

	constructor(startPosition: Vec3) {
		this.#position = startPosition;
	}

	public getPosition(): Vec3 {
		return this.#position;
	}

	public setPosition(position: Vec3): void {
		this.#position = position;
	}

	public getVelocity(): Vec3 {
		return this.#velocity;
	}

	public setVelocity(velocity: Vec3): void {
		this.#velocity = velocity;
	}

	public checkSupport(): CharacterSurfaceInfo {
		const info = SimpleCharacterController.#cachedSurfaceInfo;
		info.supportedState =
			this.#position.y <= 0.001
				? CharacterSupportedState.SUPPORTED
				: CharacterSupportedState.UNSUPPORTED;
		return info;
	}

	public integrate(deltaTime: number, gravity: Vec3): void {
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
