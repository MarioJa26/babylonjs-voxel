import type { EngineContext, SceneContext } from "@babylonjs/lite";
import type { MobRegistry } from "../Entities/Mobs/Mob";
import { preloadMobSkins } from "../Entities/Mobs/MobInstancePool";
import { XpOrb } from "../Entities/Mobs/XpOrb";
import { initDistantTerrain } from "../Generation/DistantTerrain/DistantTerrain";
import { setGameTimeScale } from "../Lib/GameRuntimeState";
import {
	WEATHER_RAMP_SEC,
	WeatherCycle,
	WeatherPhase,
} from "../Lib/WeatherCycle";
import type { RemoteMobManager } from "../Network/RemoteMobManager";
import type { Player } from "../Player/Player";
import { PlayerLoadingGate } from "../Player/PlayerLoadingGate";
import {
	disposeSharedResources,
	initAtlas,
	initEngineContext,
} from "../World/Chunk/Meshing/ChunkMesher";
import { FarTileManager } from "../World/FarTiles/FarTileManager";
import { WorldStorage } from "../World/WorldStorage";
import { disposeRain, updateRain } from "./RainSystem";
import { WorldEnvironment } from "./WorldEnvironment";

/**
 * Lite (native) port of Map1 — MILESTONE slice.
 * Wires the Lite world: environment (lights/sky), chunk atlas + streaming,
 * and the player loading gate. Distant terrain, mobs, items, HUD and
 * persistence are deferred to later slices.
 */
export class Map1 {
	public static mainScene: SceneContext;
	public static engine: EngineContext;
	public static environment: WorldEnvironment;
	public static mobRegistry: MobRegistry | null = null;
	public static remoteMobManager: RemoteMobManager | null = null;
	/** The local player, exposed for world entities (e.g. mob drops) that
	 * need to route through NetworkManager without a direct reference. */
	public static mainPlayer: Player | null = null;

	/**
	 * Local weather cycle. Only drives the rain when the world is NOT
	 * server-driven — in multiplayer the server owns the weather and this
	 * cycle is left idle.
	 */
	static #weather = new WeatherCycle();

	/**
	 * Ceiling on the local rain intensity, 0..1.
	 *
	 * Exposed through the debug panel so a developer can dial the weather
	 * down (or off entirely) without touching the cycle's schedule. It caps
	 * the cycle rather than replacing it, so the schedule keeps running and
	 * the weather comes back on its own once the ceiling is raised again.
	 */
	static #rainCeiling = 1;

	/** Latest rain intensity received from the server, 0..1. */
	static #serverRain = 0;

	/** Eased copy of the server intensity, so the broadcast cadence does
	 * not show up as stepping. */
	static #serverRainSmoothed = 0;

	/** True when the server owns the rain intensity (multiplayer). */
	static #rainIsServerDriven = false;

	#player: Player;

	public readonly initPromise: Promise<void>;

	constructor(engine: EngineContext, scene: SceneContext, player: Player) {
		this.#player = player;
		Map1.mainPlayer = player;
		Map1.engine = engine;
		Map1.mainScene = scene;

		Map1.environment = new WorldEnvironment(engine, scene);
		initEngineContext(engine, scene);

		this.initPromise = this.asyncInit();
	}

	async asyncInit() {
		try {
			await initAtlas();
			// Mob skins must exist before any pool constructor runs — the
			// instanced shader bind group throws on an unbound sampler.
			await preloadMobSkins();
			await initDistantTerrain();
			// Far tiles (LOD6+): real decimated geometry out to the horizon.
			FarTileManager.init(Map1.engine, Map1.mainScene);
			await WorldStorage.initialize();
			new PlayerLoadingGate(Map1.mainScene, this.#player);
		} catch (error) {
			console.error("Error loading environment or textures:", error);
		}
	}

	public static update(deltaMs: number = 16.67): void {
		/*
		 * Weather first: the environment update pushes the rain intensity to
		 * the sky shader, so it has to see this frame's value rather than
		 * the previous one.
		 */
		Map1.updateWeather(deltaMs);
		Map1.environment?.update(deltaMs);
		updateRain(deltaMs);
	}

	/**
	 * Drive the rain intensity.
	 *
	 * Singleplayer: the local weather cycle decides, capped by the debug
	 * ceiling. Multiplayer: the server owns it, and the received value is
	 * eased so the 5-second broadcast cadence does not read as stepping.
	 */
	private static updateWeather(deltaMs: number): void {
		const environment = Map1.environment;
		if (!environment) return;

		if (Map1.#rainIsServerDriven) {
			const step = deltaMs / WEATHER_RAMP_SEC;
			const target = Map1.#serverRain;

			if (Map1.#serverRainSmoothed < target) {
				Map1.#serverRainSmoothed = Math.min(
					target,
					Map1.#serverRainSmoothed + step,
				);
			} else if (Map1.#serverRainSmoothed > target) {
				Map1.#serverRainSmoothed = Math.max(
					target,
					Map1.#serverRainSmoothed - step,
				);
			}

			environment.rainIntensity = Map1.#serverRainSmoothed;
			return;
		}

		Map1.#weather.update(deltaMs * 0.001);
		environment.rainIntensity = Math.min(
			Map1.#weather.intensity,
			Map1.#rainCeiling,
		);
	}

	/**
	 * Apply the server's rain intensity (multiplayer).
	 *
	 * The server is authoritative over the weather, so the local cycle stops
	 * driving the rain from here on.
	 *
	 * `force` marks the value as a deliberate jump — a weather command
	 * rather than a point on the weather curve. The eased copy is there to
	 * smooth the server's broadcast cadence, so a forced value snaps
	 * straight to it: the command has to land at once.
	 */
	public static setServerRain(intensity: number, force = false): void {
		Map1.#rainIsServerDriven = true;
		Map1.#serverRain = Math.min(Math.max(intensity, 0), 1);

		if (force) {
			Map1.#serverRainSmoothed = Map1.#serverRain;
		}
	}

	/**
	 * Force the local weather.
	 *
	 * Used by the weather command in singleplayer, where the local cycle
	 * owns the rain. The cycle jumps straight to the new state, so the
	 * change is visible immediately rather than easing in.
	 */
	public static setWeather(raining: boolean): void {
		Map1.#weather.force(raining ? WeatherPhase.Raining : WeatherPhase.Clear);
	}

	/**
	 * Cap the local rain intensity, 0..1.
	 *
	 * Debug control: 1 lets the weather cycle run untouched, 0 stops the
	 * rain entirely.
	 */
	public static setRainCeiling(ceiling: number): void {
		Map1.#rainCeiling = Math.min(Math.max(ceiling, 0), 1);
	}

	/** Current rain intensity, 0..1. */
	public static get rainIntensity(): number {
		return Map1.environment?.rainIntensity ?? 0;
	}

	public static setTime(time: number): void {
		if (Map1.environment) {
			Map1.environment.setTime(time);
		}
	}

	public static get timeScale() {
		return Map1.environment ? Map1.environment.timeScale : 0;
	}

	public static set timeScale(v: number) {
		if (Map1.environment) Map1.environment.timeScale = v;
		setGameTimeScale(v);
	}

	public static get isPaused() {
		return Map1.environment ? Map1.environment.isPaused : false;
	}

	public static set isPaused(v: boolean) {
		if (Map1.environment) Map1.environment.isPaused = v;
	}

	public static setDebug(_enabled: boolean): void {
		// Deferred: wireframe toggle needs the Lite material list.
		console.warn("Map1.setDebug deferred in Lite milestone build.");
	}

	public static disposeAll(): void {
		Map1.mobRegistry?.disposeAll();
		XpOrb.disposeAll();
		Map1.mobRegistry = null;
		Map1.remoteMobManager = null;
		Map1.environment?.dispose();
		disposeRain();
		disposeSharedResources();
	}
}
