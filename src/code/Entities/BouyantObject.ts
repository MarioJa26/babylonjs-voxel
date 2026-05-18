import {
	Color3,
	type Mesh,
	type Scene,
	StandardMaterial,
	Vector3,
} from "@babylonjs/core";
import type { WaterMaterial } from "@babylonjs/materials";
export class BouyantObject {
	public scene: Scene;
	public mesh: Mesh;
	public waterMaterial: WaterMaterial;
	public waterHeight: number;
	private verticalVelocity = 0;
	readonly #renderHandle: () => void;

	constructor(
		scene: Scene,
		mesh: Mesh,
		waterMaterial: WaterMaterial,
		waterHeight: number,
	) {
		this.scene = scene;
		this.mesh = mesh;
		this.waterMaterial = waterMaterial;
		this.waterHeight = waterHeight;
		this.mesh.position = new Vector3(0, 2, 0); // Start above water

		const boatMat = new StandardMaterial("boatMat", this.scene);
		boatMat.diffuseColor = new Color3(0.6, 0.6, 0.3);
		this.mesh.material = boatMat;

		let time = 0;
		this.#renderHandle = () => {
			time += this.scene.getEngine().getDeltaTime() / 100000;
			const dt = this.scene.getEngine().getDeltaTime() / 1000;
			const x = this.mesh.position.x;
			const z = this.mesh.position.z;
			const inv05 = 1 / 0.05;
			const waveTime = time * waterMaterial.waveSpeed;
			const targetY = Math.abs(
				Math.sin(x * inv05 + waveTime) *
					waterMaterial.waveHeight *
					waterMaterial.windDirection.x *
					5.0 +
					Math.cos(z * inv05 + waveTime) *
						waterMaterial.waveHeight *
						waterMaterial.windDirection.y *
						5.0,
			);

			let deltaY = targetY - mesh.position.y + waterHeight / 2;
			if (deltaY > 2) deltaY = 2;
			if (deltaY < -2) deltaY = -2;

			this.verticalVelocity += deltaY * 2.5 * dt;
			this.verticalVelocity *= 0.94;
			this.mesh.position.y += this.verticalVelocity;
		};
		this.scene.onBeforeRenderObservable.add(this.#renderHandle);
	}

	dispose(): void {
		this.scene.onBeforeRenderObservable.removeCallback(this.#renderHandle);
	}
}
