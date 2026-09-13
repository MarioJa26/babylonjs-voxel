/**
 * Babylon Lite (native) port of WorldEnvironment.
 * Creates the hemispheric + directional lights, the skybox (camera-centred
 * box + SkyShaderLite material), and drives the day/night sun direction.
 *
 * Note: the chunk shaders receive the sun direction via their own uniforms
 * (updated from GLOBAL_VALUES.skyLightDirection in ChunkMesher's
 * per-frame pass), so the Lite lights here only affect Standard/PBR
 * materials (boats/items) which are ported in a later phase.
 */
import {
	addToScene,
	createDirectionalLight,
	createMeshFromData,
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

const DOME_MOVE_THRESHOLD = 1.25;
/**
 * Uniform scale applied to the unit sky box (half-extent 1). A ray from the
 * box centre exits through a corner at √3 × scale, which MUST stay inside the
 * camera far plane or the sky clips open. 0.5 → worst-case exit 0.87 × far.
 * (The old dome was a sphere where exit distance == scale, hence the old 0.9.)
 */
const SKY_BOX_FAR_SCALE = 0.5;
const MAX_SUN_ELEVATION = 1.1;
const TWO_PI = Math.PI * 2;

/**
 * Camera-centred unit cube (half-extent 1): 24 verts / 12 tris.
 *
 * The sky fragment shader only computes normalize(vPosition) — the
 * camera-local view ray — so ANY star-shaped surface around the camera
 * yields bit-identical pixels. Each face is a flat quad, and
 * perspective-correct interpolation across a flat quad lands exactly on the
 * face plane, so normalize() reproduces the true per-pixel ray direction
 * (same guarantee as a cubemap). The previous 32-segment sphere shaded the
 * same gradient through 2415 verts / 4624 tris every frame.
 * Winding is irrelevant: the material disables back-face culling.
 */
const SKY_BOX_POSITIONS = new Float32Array([
	// -Z
	-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
	// +Z
	-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
	// -X
	-1, -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1,
	// +X
	1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1,
	// -Y
	-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1,
	// +Y
	-1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1,
]);
const SKY_BOX_NORMALS = new Float32Array(24 * 3);
for (let face = 0; face < 6; face++) {
	const n =
		face === 0
			? [0, 0, -1]
			: face === 1
				? [0, 0, 1]
				: face === 2
					? [-1, 0, 0]
					: face === 3
						? [1, 0, 0]
						: face === 4
							? [0, -1, 0]
							: /* 5 */ [0, 1, 0];
	for (let v = 0; v < 4; v++) {
		const i = (face * 4 + v) * 3;
		SKY_BOX_NORMALS[i] = n[0];
		SKY_BOX_NORMALS[i + 1] = n[1];
		SKY_BOX_NORMALS[i + 2] = n[2];
	}
}
const SKY_BOX_INDICES = new Uint32Array(36);
for (let face = 0; face < 6; face++) {
	const b = face * 4;
	const o = face * 6;
	SKY_BOX_INDICES[o] = b;
	SKY_BOX_INDICES[o + 1] = b + 1;
	SKY_BOX_INDICES[o + 2] = b + 2;
	SKY_BOX_INDICES[o + 3] = b;
	SKY_BOX_INDICES[o + 4] = b + 2;
	SKY_BOX_INDICES[o + 5] = b + 3;
}

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

	// Per-frame update caches.
	private lastSunDirX = NaN;
	private lastSunDirY = NaN;
	private lastSunDirZ = NaN;
	private lastSunIntensity = NaN;

	private lastDomeX = 0;
	private lastDomeY = 0;
	private lastDomeZ = 0;
	private lastFarPlane = NaN;

	// Reused uniform payload to avoid allocating [sx, sy, sz] every sun update.
	private readonly sunDirectionUniform: [number, number, number] = [0, 0, 0];

	// Forces one sun/material refresh even when timeScale === 0.
	private forceSunUpdate = true;

	// Server time-sync anchor (multiplayer). Between WorldTime broadcasts the
	// sun interpolates from the last anchor instead of standing still, so it
	// glides across the sky rather than skipping in packet-sized steps.
	private serverTimeOfDay = NaN;
	private serverSyncAt = 0;
	private serverDayDurationMs = SETTING_PARAMS.DAY_DURATION_MS;
	private serverDayCycle = true;

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
		const skybox = createMeshFromData(
			this.engine,
			"skyBox",
			SKY_BOX_POSITIONS,
			SKY_BOX_NORMALS,
			SKY_BOX_INDICES,
		);
		const skyMaterial = createSkyMaterial();

		skybox.material = skyMaterial;
		skybox.pickable = false;
		skybox.receiveShadows = false;
		skybox.renderOrder = 300;

		this.skybox = skybox;
		this.skyMaterial = skyMaterial;

		// Lite has no infiniteDistance flag, so we keep the box centred on the
		// camera and size it just inside the camera far plane.
		this.syncDome();

		// Sky tint behind the dome so any gap reads as sky, not black.
		this.scene.clearColor = { r: 0.5, g: 0.7, b: 0.9, a: 1.0 };

		addToScene(this.scene, skybox);
	}

	/**
	 * Move/resize the sky dome only when the camera or far plane actually
	 * changed. This avoids unnecessary world-matrix version bumps and mesh
	 * UBO writes on idle frames.
	 */
	private syncDome(): void {
		const skybox = this.skybox;
		const cam = this.scene.camera;

		if (!skybox || !cam) return;

		const camPos = getCameraPosition(cam);
		const dx = camPos.x - this.lastDomeX;
		const dy = camPos.y - this.lastDomeY;
		const dz = camPos.z - this.lastDomeZ;

		if (
			Math.abs(dx) > DOME_MOVE_THRESHOLD ||
			Math.abs(dy) > DOME_MOVE_THRESHOLD ||
			Math.abs(dz) > DOME_MOVE_THRESHOLD
		) {
			skybox.position.copyFrom(camPos);
			this.lastDomeX = camPos.x;
			this.lastDomeY = camPos.y;
			this.lastDomeZ = camPos.z;
		}

		const farPlane = cam.farPlane;

		if (farPlane !== this.lastFarPlane) {
			const r = SKY_BOX_FAR_SCALE * farPlane;
			skybox.scaling.set(r, r, r);
			this.lastFarPlane = farPlane;
		}
	}

	public update(deltaMs: number): void {
		// Keep the dome centred on the camera and sized just inside the far
		// plane. This is still internally cached by syncDome().
		this.syncDome();

		if (this.isPaused) return;

		const shouldAdvanceTime = this.timeScale !== 0;

		// Static sun: after the first refresh, or after setTime(), skip all
		// lighting/material writes.
		if (!shouldAdvanceTime && !this.forceSunUpdate && this.serverSyncAt === 0)
			return;

		if (shouldAdvanceTime) {
			this.timeOfDay += deltaMs * this.timeScale;
			this.timeOfDay %= SETTING_PARAMS.DAY_DURATION_MS;
		} else if (this.serverSyncAt !== 0 && this.serverDayCycle) {
			// Interpolate between server WorldTime broadcasts so the sun moves
			// at the server's day rate instead of stepping every broadcast.
			// Keep timeOfDay in the client day basis (fraction × DAY_DURATION_MS).
			const dayFrac =
				(this.serverTimeOfDay +
					(performance.now() - this.serverSyncAt) / this.serverDayDurationMs) %
				1;
			this.timeOfDay = dayFrac * SETTING_PARAMS.DAY_DURATION_MS;
		}

		this.forceSunUpdate = false;

		const t = this.timeOfDay / SETTING_PARAMS.DAY_DURATION_MS;
		const angle = t * TWO_PI;

		const sinAngle = Math.sin(angle);
		const cosAngle = Math.cos(angle);
		const elevationAngle = sinAngle * MAX_SUN_ELEVATION;
		const cosElevation = Math.cos(elevationAngle);

		const sx = cosElevation * cosAngle;
		const sz = cosElevation * sinAngle;
		const sy = Math.sin(elevationAngle);

		GLOBAL_VALUES.skyLightDirection.x = -sx;
		GLOBAL_VALUES.skyLightDirection.y = -sy;
		GLOBAL_VALUES.skyLightDirection.z = -sz;

		const sunIntensity = Math.max(0.0, sinAngle);

		if (this.dirLight && sunIntensity !== this.lastSunIntensity) {
			this.dirLight.intensity = sunIntensity;
			this.lastSunIntensity = sunIntensity;
		}

		if (
			this.skyMaterial &&
			(sx !== this.lastSunDirX ||
				sy !== this.lastSunDirY ||
				sz !== this.lastSunDirZ)
		) {
			// Sky disc/gradient must point TOWARD the sun (+sunPos). Chunk
			// lighting keeps using GLOBAL_VALUES.skyLightDirection (=-sunPos),
			// which ChunkMesher negates back to +sunPos.
			this.sunDirectionUniform[0] = sx;
			this.sunDirectionUniform[1] = sy;
			this.sunDirectionUniform[2] = sz;

			setShaderUniform(
				this.skyMaterial,
				"sunDirection",
				this.sunDirectionUniform,
			);

			this.lastSunDirX = sx;
			this.lastSunDirY = sy;
			this.lastSunDirZ = sz;
		}
	}

	/** Current time of day in milliseconds (0..DAY_DURATION_MS). */
	public getTimeOfDayMs(): number {
		return this.timeOfDay;
	}

	public setTime(time: number): void {
		this.timeOfDay = (time % 1) * SETTING_PARAMS.DAY_DURATION_MS;

		// Static set (debug slider): drop any server interpolation anchor so
		// the sun holds the given time while timeScale === 0.
		this.serverTimeOfDay = NaN;
		this.serverSyncAt = 0;

		// Important when timeScale === 0: the next update must still apply the
		// new static sun direction/intensity.
		this.forceSunUpdate = true;
	}

	/**
	 * Anchor the sun to the server's authoritative time (multiplayer). Between
	 * WorldTime broadcasts update() extrapolates from this anchor at the
	 * server's day rate, so the sun glides instead of skipping.
	 */
	public syncWithServer(timeOfDay: number): void {
		this.serverTimeOfDay = timeOfDay % 1;
		this.serverSyncAt = performance.now();
		this.timeOfDay = this.serverTimeOfDay * SETTING_PARAMS.DAY_DURATION_MS;
		this.forceSunUpdate = true;
	}

	/** Apply the server's day/night settings (from WorldConfig on join). */
	public setServerDaySettings(dayDurationMs: number, dayCycle: boolean): void {
		this.serverDayDurationMs =
			Number.isFinite(dayDurationMs) && dayDurationMs > 0
				? dayDurationMs
				: SETTING_PARAMS.DAY_DURATION_MS;
		this.serverDayCycle = dayCycle;
	}

	public dispose(): void {
		if (this.skybox) {
			removeFromScene(this.scene, this.skybox);
		}

		this.skybox = null;
		this.skyMaterial = null;
		this.dirLight = null;
	}
}
