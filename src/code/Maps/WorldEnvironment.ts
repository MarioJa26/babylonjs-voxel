import {
	DirectionalLight,
	Effect,
	HemisphericLight,
	type Mesh,
	MeshBuilder,
	type Scene,
	ShaderMaterial,
	SSAORenderingPipeline,
	Vector3,
} from "@babylonjs/core";

import { PlayerHud } from "../Player/Hud/PlayerHud";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { SkyShader } from "../World/Light/SkyShader";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";

export class WorldEnvironment {
	public static instance: WorldEnvironment;
	private scene: Scene;
	private dirLight!: DirectionalLight;
	private hemiLight!: HemisphericLight;
	private skybox!: Mesh;

	// Time cycle
	private timeOfDay = 120000;
	public timeScale = 0;
	public isPaused = false;
	public wetness = 0.0;

	constructor(scene: Scene) {
		WorldEnvironment.instance = this;
		this.scene = scene;
		this.createLights();
		this.createSkybox();
	}

	public initSSAO() {
		if (SETTING_PARAMS.ENABLE_SSAO && this.scene.activeCamera) {
			new SSAORenderingPipeline(
				"ssaopipeline",
				this.scene,
				{
					ssaoRatio: SETTING_PARAMS.SSAO_RATIO,
					combineRatio: SETTING_PARAMS.SSAO_COMBINE_RATIO,
				},
				[this.scene.activeCamera],
			);
		}
	}

	private createLights() {
		this.hemiLight = new HemisphericLight(
			"hemiLight",
			new Vector3(100, 11, 55),
			this.scene,
		);
		// Hemispheric "up" should point toward the sky, not the ground.
		this.hemiLight.direction = new Vector3(0.1, 1, 0.1);
		this.hemiLight.intensity = SETTING_PARAMS.HEMISPHERIC_LIGHT_INTENSITY;

		// Directional sun light used by non-chunk StandardMaterials (boats/items/etc.).
		this.dirLight = new DirectionalLight(
			"sunLight",
			GLOBAL_VALUES.skyLightDirection.clone(),
			this.scene,
		);
		this.dirLight.intensity = 1.0;
	}

	private createSkybox() {
		// Skybox
		this.skybox = MeshBuilder.CreateSphere(
			"skyBox",
			{ diameter: 50000.11, segments: 1 },
			this.scene,
		);
		this.skybox.isPickable = false;
		this.skybox.infiniteDistance = true;
		this.skybox.ignoreCameraMaxZ = true;

		// Register the new sky shader
		Effect.ShadersStore["skyVertexShader"] = SkyShader.skyVertexShader;
		Effect.ShadersStore["skyFragmentShader"] = SkyShader.skyFragmentShader;

		// Create a ShaderMaterial using the sky shader
		const skyboxMaterial = new ShaderMaterial(
			"skyShaderMaterial",
			this.scene,
			{
				vertex: "sky",
				fragment: "sky",
			},
			{
				attributes: ["position"],
				uniforms: ["worldViewProjection", "sunDirection"],
			},
		);

		skyboxMaterial.backFaceCulling = false;
		skyboxMaterial.disableDepthWrite = true;

		// Update the sun's direction uniform every frame
		skyboxMaterial.onBind = () => {
			const effect = skyboxMaterial.getEffect();
			if (effect) {
				effect.setVector3(
					"sunDirection",
					GLOBAL_VALUES.skyLightDirection.negate(),
				);
			}
		};

		this.skybox.setEnabled(true);
		this.skybox.material = skyboxMaterial;
	}

	public update() {
		if (this.isPaused) return;
		// Increment time of day based on frame delta time
		this.timeOfDay += this.scene.getEngine().getDeltaTime() * this.timeScale;
		this.timeOfDay %= SETTING_PARAMS.DAY_DURATION_MS;

		// Compute smooth solar parameters (CPU)
		const t = this.timeOfDay / SETTING_PARAMS.DAY_DURATION_MS; // 0..1
		const angle = t * Math.PI * 2; // full orbit

		// Use spherical coordinates:
		// - azimuth rotates horizontally
		// - elevationAngle is limited so sun rises/sets smoothly
		const maxElevation = 1.1; // radians (~28.6°). Tune to taste.
		const elevationAngle = Math.sin(angle) * maxElevation; // -max..max

		// Cartesian direction (sun direction vector, normalized on assignment)
		const sx = Math.cos(elevationAngle) * Math.cos(angle);
		const sz = Math.cos(elevationAngle) * Math.sin(angle);
		const sy = Math.sin(elevationAngle);

		const len = Math.hypot(sx, sy, sz) || 1;
		// GLOBAL_VALUES.skyLightDirection is expected normalized
		GLOBAL_VALUES.skyLightDirection.x = -sx / len;
		GLOBAL_VALUES.skyLightDirection.y = -sy / len;
		GLOBAL_VALUES.skyLightDirection.z = -sz / len;

		// Sun intensity driven by elevation (zero below horizon)
		const sunIntensity = Math.max(0.0, Math.sin(angle)); // 0..1, tune multiplier below

		// Update engine directional light if present (direction points FROM light)
		if (this.dirLight) {
			this.dirLight.direction = new Vector3(
				GLOBAL_VALUES.skyLightDirection.x,
				GLOBAL_VALUES.skyLightDirection.y,
				GLOBAL_VALUES.skyLightDirection.z,
			);
			// Scale base intensity with elevation (tune multiplier)
			this.dirLight.intensity = 1.0 * sunIntensity;
			const reflectivity = sunIntensity * (this.wetness * 0.95);
			this.dirLight.specular.set(reflectivity, reflectivity, reflectivity);
		}
		// For debug display
		const timeAsHour = (this.timeOfDay / SETTING_PARAMS.DAY_DURATION_MS) * 24;
		const hour = Math.floor(timeAsHour);
		const minute = Math.floor((timeAsHour - hour) * 60);
		const second = Math.floor(((timeAsHour - hour) * 60 - minute) * 60);
		PlayerHud.updateDebugInfo(
			"Time of Day",
			`${String(hour).padStart(2, "0")}:${String(minute).padStart(
				2,
				"0",
			)}:${String(second).padStart(2, "0")}`,
		);
		PlayerHud.updateDebugInfo("Time Scale", this.timeScale.toFixed(2) + "x");

		// Update the time slider's position
		const timeSlider = document.getElementById(
			"timeSlider",
		) as HTMLInputElement;
		if (timeSlider)
			timeSlider.value = (
				(this.timeOfDay / SETTING_PARAMS.DAY_DURATION_MS) *
				1000
			).toString();
	}

	public setTime(time: number): void {
		this.timeOfDay = (time % 1) * SETTING_PARAMS.DAY_DURATION_MS;
	}
}
