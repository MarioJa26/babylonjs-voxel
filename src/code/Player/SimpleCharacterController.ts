import type { Vec3 } from "@babylonjs/lite";
import { vec3Zero } from "../Lib/Math";

export class SimpleCharacterController {
	#position: Vec3;
	#velocity = vec3Zero();

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
}
