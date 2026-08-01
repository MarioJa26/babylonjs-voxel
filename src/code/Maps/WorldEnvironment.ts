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
	createSphere,
	type DirectionalLight,
	type EngineContext,
	getCameraPosition,
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
	private skybox: Mesh | null = null;
	private skyMaterial: ShaderMaterial | null = null;

	private timeOfDay = 120000;
	public timeScale = 0;
	public isPaused = false;
	public wetness = 0.1;

	// Per-frame update caches: the sun only moves while timeScale > 0 and the
	// dome only needs moving when the camera crosses a block boundary. Avoids
	// material-UBO version bumps + mesh world-matrix writes (and their
	// queue.writeBuffer calls) on every idle frame.
	private lastSunDir: [number, number, number] = [NaN, NaN, NaN];
	private lastSunIntensity = NaN;
	private lastDomeX = 0;
	private lastDomeY = 0;
	private lastDomeZ = 0;
	private lastFarPlane = NaN;

	constructor(engine: EngineContext, scene: SceneContext) {
		WorldEnvironment.instance = this;
		this.engine = engine;
		this.scene = scene;
		this.createLights();
		this.createSkybox();
	}

	private createLights(): void {
		const dir = GLOBAL_VALUES.skyLightDirection;
		this.dirLight = createDirectionalLight([dir.x, dir.y, dir.z], 1.0);
	}

	private createSkybox(): void {
		this.skybox = createSphere(this.engine);
		this.skyMaterial = createSkyMaterial();
		this.skybox.material = this.skyMaterial;
		// Lite has no infiniteDistance flag, so we keep the dome centred on the
		// camera each frame (see update()) and size it just inside the camera far
		// plane (default 10000) so it is not clipped. The sky shader uses the
		// normalized view direction, so it reads as an infinite dome.
		if (this.scene.camera) this.syncDome();
		// Sky tint behind the dome so any gap reads as sky, not black.
		this.scene.clearColor = { r: 0.5, g: 0.7, b: 0.9, a: 1.0 };
		addToScene(this.scene, this.skybox);
	}

	/** Move/resize the sky dome only when the camera or far plane actually
	 *  moved — avoids a world-matrix version bump (and mesh-UBO writeBuffer)
	 *  on every idle frame. */
	private syncDome(): void {
		const skybox = this.skybox;
		const cam = this.scene.camera;
		if (!skybox || !cam) return;
		const camPos = getCameraPosition(cam);
		if (
			Math.abs(camPos.x - this.lastDomeX) > 1.25 ||
			Math.abs(camPos.y - this.lastDomeY) > 1.25 ||
			Math.abs(camPos.z - this.lastDomeZ) > 1.25
		) {
			skybox.position.copyFrom(camPos);
			this.lastDomeX = camPos.x;
			this.lastDomeY = camPos.y;
			this.lastDomeZ = camPos.z;
		}
		const farPlane = cam.farPlane;
		if (farPlane !== this.lastFarPlane) {
			const r = 0.9 * farPlane;
			skybox.scaling.set(r, r, r);
			this.lastFarPlane = farPlane;
		}
	}

	public update(deltaMs: number): void {
		// Lite has no infiniteDistance flag, so keep the dome centred on the
		// camera and sized just inside the far plane (recomputed in case the
		// camera was created after construction).
		this.syncDome();

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

		// Only touch the lights/material when a value actually changed (the
		// sun is static while timeScale === 0), so steady-state frames skip
		// every material-UBO version bump + writeBuffer.
		if (this.dirLight && sunIntensity !== this.lastSunIntensity) {
			this.dirLight.intensity = 1.0 * sunIntensity;
			this.lastSunIntensity = sunIntensity;
		}

		if (
			this.skyMaterial &&
			(sx !== this.lastSunDir[0] ||
				sy !== this.lastSunDir[1] ||
				sz !== this.lastSunDir[2])
		) {
			// Sky disc/gradient must point TOWARD the sun (+sunPos). Chunk
			// lighting keeps using GLOBAL_VALUES.skyLightDirection (=-sunPos),
			// which ChunkMesher negates back to +sunPos, so only the sky
			// uniform is flipped here.
			setShaderUniform(this.skyMaterial, "sunDirection", [sx, sy, sz]);
			this.lastSunDir[0] = sx;
			this.lastSunDir[1] = sy;
			this.lastSunDir[2] = sz;
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
	}
}
