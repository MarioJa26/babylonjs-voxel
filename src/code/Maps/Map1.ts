import type { EngineContext, SceneContext } from "@babylonjs/lite";
import type { MobRegistry } from "../Entities/Mobs/Mob";
import { initDistantTerrain } from "../Generation/DistantTerrain/DistantTerrain";
import { setGameTimeScale } from "../Lib/GameRuntimeState";
import type { RemoteMobManager } from "../Network/RemoteMobManager";
import type { Player } from "../Player/Player";
import { PlayerLoadingGate } from "../Player/PlayerLoadingGate";
import {
	disposeSharedResources,
	initAtlas,
	initEngineContext,
} from "../World/Chunk/ChunkMesher";
import { WorldStorage } from "../World/WorldStorage";
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

	#player: Player;

	public readonly initPromise: Promise<void>;

	constructor(engine: EngineContext, scene: SceneContext, player: Player) {
		this.#player = player;
		Map1.engine = engine;
		Map1.mainScene = scene;

		Map1.environment = new WorldEnvironment(engine, scene);
		initEngineContext(engine, scene);

		this.initPromise = this.asyncInit();
	}

	async asyncInit() {
		try {
			await initAtlas();
			await initDistantTerrain();
			await WorldStorage.initialize();
			new PlayerLoadingGate(Map1.mainScene, this.#player);
		} catch (error) {
			console.error("Error loading environment or textures:", error);
		}
	}

	public static update(deltaMs: number = 16.67): void {
		Map1.environment?.update(deltaMs);
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
		Map1.mobRegistry = null;
		Map1.remoteMobManager = null;
		Map1.environment?.dispose();
		disposeSharedResources();
	}
}
