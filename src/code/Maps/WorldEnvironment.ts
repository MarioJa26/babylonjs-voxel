/**
 * Babylon Lite (native) port of WorldEnvironment.
 * Creates the hemispheric + directional lights, the skybox (sphere +
 * SkyShaderLite material), and drives the day/night sun direction.
 *
 * Note: the chunk shaders receive the sun direction via their own uniforms
 * (updated from GLOBAL_VALUES.skyLightDirection in ChunkMesher's
 * per-frame pass), so the Lite lights here only affect Standard/PBR
 * materials (boats/items) which are ported in a later phase.
 */
import {
	addToScene,
	createDirectionalLight,
	createHemisphericLight,
	createSphere,
	type DirectionalLight,
	type EngineContext,
	getCameraPosition,
	type HemisphericLight,
	type Mesh,
	removeFromScene,
	type SceneContext,
	type ShaderMaterial,
	setShaderUniform,
} from "@babylonjs/lite";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { createSkyMaterial } from "../World/Light/SkyShaderLite";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";

export class WorldEnvironment {
	public static instance: WorldEnvironment;

	private engine: EngineContext;
	private scene: SceneContext;
	private dirLight: DirectionalLight | null = null;
	private hemiLight: HemisphericLight | null = null;
	private skybox: Mesh | null = null;
	private skyMaterial: ShaderMaterial | null = null;

	private timeOfDay = 120000;
	public timeScale = 0;
	public isPaused = false;
	public wetness = 0.0;

	constructor(engine: EngineContext, scene: SceneContext) {
		WorldEnvironment.instance = this;
		this.engine = engine;
		this.scene = scene;
		this.createLights();
		this.createSkybox();
	}

	private createLights(): void {
		this.hemiLight = createHemisphericLight(
			[0.1, 1, 0.1],
			SETTING_PARAMS.HEMISPHERIC_LIGHT_INTENSITY,
		);

		const dir = GLOBAL_VALUES.skyLightDirection;
		this.dirLight = createDirectionalLight([dir.x, dir.y, dir.z], 1.0);
	}

	private createSkybox(): void {
		this.skybox = createSphere(this.engine);
		this.skyMaterial = createSkyMaterial(this.engine, this.scene);
		this.skybox.material = this.skyMaterial;
		// Lite has no infiniteDistance flag, so we keep the dome centred on the
		// camera each frame (see update()) and size it just inside the camera far
		// plane (default 10000) so it is not clipped. The sky shader uses the
		// normalized view direction, so it reads as an infinite dome.
		const cam = this.scene.camera;
		const r = cam ? 0.9 * cam.farPlane : 9000;
		this.skybox.scaling.set(r, r, r);
		// Sky tint behind the dome so any gap reads as sky, not black.
		this.scene.clearColor = { r: 0.5, g: 0.7, b: 0.9, a: 1.0 };
		addToScene(this.scene, this.skybox);
	}

	public update(deltaMs: number): void {
		// Lite has no infiniteDistance flag, so keep the dome centred on the
		// camera and sized just inside the far plane (recomputed in case the
		// camera was created after construction).
		const cam = this.scene.camera;
		if (this.skybox && cam) {
			this.skybox.position.copyFrom(getCameraPosition(cam));
			const r = 0.9 * cam.farPlane;
			this.skybox.scaling.set(r, r, r);
		}

		if (this.isPaused) return;

		this.timeOfDay += deltaMs * this.timeScale;
		this.timeOfDay %= SETTING_PARAMS.DAY_DURATION_MS;

		const t = this.timeOfDay / SETTING_PARAMS.DAY_DURATION_MS; // 0..1
		const angle = t * Math.PI * 2;

		const maxElevation = 1.1;
		const elevationAngle = Math.sin(angle) * maxElevation;

		const sx = Math.cos(elevationAngle) * Math.cos(angle);
		const sz = Math.cos(elevationAngle) * Math.sin(angle);
		const sy = Math.sin(elevationAngle);

		GLOBAL_VALUES.skyLightDirection.x = -sx;
		GLOBAL_VALUES.skyLightDirection.y = -sy;
		GLOBAL_VALUES.skyLightDirection.z = -sz;

		const sunIntensity = Math.max(0.0, Math.sin(angle));

		if (this.dirLight) {
			this.dirLight.intensity = 1.0 * sunIntensity;
		}

		if (this.skyMaterial) {
			// Sky disc/gradient must point TOWARD the sun (+sunPos). Chunk
			// lighting keeps using GLOBAL_VALUES.skyLightDirection (=-sunPos),
			// which ChunkMesher negates back to +sunPos, so only the sky
			// uniform is flipped here.
			setShaderUniform(this.skyMaterial, "sunDirection", [sx, sy, sz]);
		}
	}

	public setTime(time: number): void {
		this.timeOfDay = (time % 1) * SETTING_PARAMS.DAY_DURATION_MS;
	}

	public dispose(): void {
		if (this.skybox && this.scene) {
			removeFromScene(this.scene, this.skybox);
		}
		this.skybox = null;
		this.skyMaterial = null;
		this.dirLight = null;
		this.hemiLight = null;
	}
}
