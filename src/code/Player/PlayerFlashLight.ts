import {
	type Camera,
	Color3,
	type FreeCamera,
	type Observer,
	Ray,
	type Scene,
	SpotLight,
	Vector3,
} from "@babylonjs/core";

export class PlayerFlashLight {
	#flashlight: SpotLight;
	#camera: FreeCamera;
	#viewMatrixObs: Observer<Camera> | null = null;

	constructor(scene: Scene, playerCamera: FreeCamera) {
		// Create flashlight (SpotLight)
		this.#camera = playerCamera;
		this.#flashlight = new SpotLight(
			"flashlight",
			this.#camera.position.clone(),
			Vector3.Zero(), // forward direction
			Math.PI / 4, // angle
			1.2, // exponent
			scene,
		);
		this.#flashlight.intensity = 1.5;
		this.#flashlight.diffuse = new Color3(1, 1, 0.5);
		this.#flashlight.specular = new Color3(1, 1, 1);
		this.#flashlight.range = 210;
		this.#flashlight.setEnabled(false);
		this.#flashlight.parent = this.#camera;

		// Update flashlight position on camera movement
		const scratchRay = new Ray(Vector3.Zero(), Vector3.Zero());
		this.#viewMatrixObs = this.#camera.onViewMatrixChangedObservable.add(() => {
			this.#flashlight.position.copyFrom(this.#camera.position);
			this.#camera.getForwardRayToRef(scratchRay, 0);
			this.#flashlight.direction.copyFrom(scratchRay.direction);
		});
	}

	public toggle() {
		this.#flashlight.setEnabled(!this.#flashlight.isEnabled());
	}

	public dispose(): void {
		if (this.#viewMatrixObs) {
			this.#camera.onViewMatrixChangedObservable.remove(this.#viewMatrixObs);
			this.#viewMatrixObs = null;
		}
		this.#flashlight.dispose();
	}
}
