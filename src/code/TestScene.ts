import {
	createEngine,
	createSceneContext,
	type EngineContext,
	onBeforeRender,
	registerScene,
	type SceneContext,
	startEngine,
	stopEngine,
	vec3,
} from "@babylonjs/lite";
import { showLiteExplorer } from "babylon-lite-explorer";
import { createMobCoordinator } from "./Entities/Mobs/MobSetup";
import { setTerrainSeed } from "./Generation/TerrainHeightMap";
import { Map1 } from "./Maps/Map1";
import { type EyeCamera, UnderWaterEffect } from "./Maps/UnderWaterEffect";
import { NetworkManager } from "./Network/NetworkManager";
import { initializeBlockBreakingVisuals } from "./Player/Hud/BlockHighlight/BlockBreakingVisuals";
import { DroppedItem } from "./Player/Inventory/DroppedItem";
import { Player } from "./Player/Player";
import { PlayerCamera } from "./Player/PlayerCamera";
import { PlayerStatePersistence } from "./Player/PlayerStatePersistence";
import { updateGlobalUniforms } from "./World/Chunk/ChunkMesher";
import { installLightDebugTool } from "./World/Chunk/LightDebugTool";
import { worldSeedFor } from "./World/WorldContext";

/**
 * Lite (native) port of the engine/bootstrap entry point.
 * Creates the WebGPU engine + scene + follow camera, registers the
 * scene, and runs the render loop (startEngine's internal rAF).
 */
export class TestScene {
	document: Document;
	scene?: SceneContext;
	engine?: EngineContext;
	public readonly initPromise: Promise<void>;
	#frameCounter = 0;
	#player?: Player;
	#playerStatePersistence?: PlayerStatePersistence;
	#disposeLightDebugTool?: () => void;
	#networkManager?: NetworkManager;

	constructor(
		document: Document,
		private canvas: HTMLCanvasElement,
		private readonly worldName: string,
	) {
		this.document = document;
		this.initPromise = this.init();
	}

	async init() {
		const engine = await createEngine(this.canvas, {});
		const scene = createSceneContext(engine, {
			defaultRenderTask: true,
		});
		this.engine = engine;
		this.scene = scene;

		const playerCamera = new PlayerCamera();
		const player = new Player(engine, scene, playerCamera, this.canvas);
		this.#player = player;

		this.#disposeLightDebugTool = installLightDebugTool(
			() => this.#player?.position,
		);

		scene.camera = playerCamera.playerCamera;

		// Multiplayer: connect to server if URL has ?mp=1
		const urlParams = new URLSearchParams(window.location.search);
		const isMultiplayer = urlParams.has("mp");

		if (isMultiplayer) {
			// Multiplayer mode — no local world creation.
			// The server uses its config seed; we receive it via WorldConfig on join.
			const serverUrl = urlParams.get("server") ?? undefined;
			const playerName =
				urlParams.get("name") ?? `Player${Math.floor(Math.random() * 1000)}`;

			// Init a minimal Map1 (needed for player/environment/rendering)
			const map = new Map1(engine, scene, player);
			await map.initPromise;

			initializeBlockBreakingVisuals(scene);
			DroppedItem.preloadAtlas();
			player.createHud(scene);
			player.respawn();

			this.#networkManager = new NetworkManager(player, serverUrl);
			player.networkManager = this.#networkManager;
			player.setDefaultBlockEditCallbacks(this.#networkManager);

			void this.#networkManager.connect(playerName, this.worldName);

			const underWaterEffect = new UnderWaterEffect(
				scene,
				playerCamera.playerCamera as unknown as EyeCamera,
				null,
			);

			onBeforeRender(scene, (deltaMs) => {
				this.#frameCounter++;
				Map1.update(deltaMs);
				this.#player?.tick(deltaMs);
				this.#networkManager?.tick(deltaMs);
				underWaterEffect.updateFromCamera();
				updateGlobalUniforms(this.#frameCounter);
			});
		} else {
			// Singleplayer mode — seed terrain and create the full world
			setTerrainSeed(worldSeedFor(this.worldName));

			const map = new Map1(engine, scene, player);
			await map.initPromise;

			initializeBlockBreakingVisuals(scene);
			DroppedItem.preloadAtlas();
			player.createHud(scene);
			player.respawn();

			this.#playerStatePersistence = new PlayerStatePersistence(
				scene,
				player,
				this.worldName,
			);

			createMobCoordinator(this.scene, () => {
				const p = this.#player!.position;
				return vec3(p.x, p.y, p.z);
			});

			const underWaterEffect = new UnderWaterEffect(
				scene,
				playerCamera.playerCamera as unknown as EyeCamera,
				null,
			);

			onBeforeRender(scene, (deltaMs) => {
				this.#frameCounter++;
				Map1.update(deltaMs);
				this.#player?.tick(deltaMs);
				this.#playerStatePersistence?.update();
				underWaterEffect.updateFromCamera();
				updateGlobalUniforms(this.#frameCounter);
			});
		}

		await registerScene(scene);
		await startEngine(engine);
		/*
		showLiteExplorer(
			{ engine, scene, canvas: this.canvas, lite },
			{ mode: "overlay", layout: "single", theme: "dark" },
		);*/
	}

	public dispose(): void {
		this.#disposeLightDebugTool?.();
		this.#playerStatePersistence?.dispose();
		this.#networkManager?.disconnect();
		if (this.engine) stopEngine(this.engine);
		Map1.disposeAll();
		this.engine = undefined;
		this.scene = undefined;
		this.#player = undefined;
	}
}
