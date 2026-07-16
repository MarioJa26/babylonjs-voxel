import type { Scene } from "@babylonjs/core";
import {
	createSpotLight,
	type FreeCamera,
	type SpotLight,
} from "@babylonjs/lite";

export class PlayerFlashLight {
	#flashlight: SpotLight;
	#camera: FreeCamera;
	#enabled = false;

	constructor(scene: Scene, playerCamera: FreeCamera) {
		// Create flashlight (SpotLight) parented to the camera so it follows
		// the view. Lite has no per-camera view-matrix observable, so the
		// light is attached in camera-local space (forward = +Z local).
		this.#camera = playerCamera;
		const pos: [number, number, number] = [
			playerCamera.position.x,
			playerCamera.position.y,
			playerCamera.position.z,
		];
		this.#flashlight = createSpotLight(
			pos,
			[0, 0, 1], // forward direction (camera-local)
			Math.PI / 4, // angle
			1.2, // exponent
			1.5, // intensity
		);
		this.#flashlight.diffuse = [1, 1, 0.5];
		this.#flashlight.specular = [1, 1, 1];
		this.#flashlight.range = 210;
		const flAny = this.#flashlight as unknown as {
			setEnabled?(v: boolean): void;
			dispose?(): void;
		};
		flAny.setEnabled?.(false);
		this.#flashlight.parent = playerCamera;
		void scene;
	}

	public toggle() {
		this.#enabled = !this.#enabled;
		(
			this.#flashlight as unknown as { setEnabled?(v: boolean): void }
		).setEnabled?.(this.#enabled);
	}

	public dispose(): void {
		(this.#flashlight as unknown as { dispose?(): void }).dispose?.();
	}
}
