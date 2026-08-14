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
//import { showLiteExplorer } from "babylon-lite-explorer";
import { createMobCoordinator } from "./Entities/Mobs/MobSetup";
import { setTerrainSeed } from "./Generation/TerrainHeightMap";
import { Map1 } from "./Maps/Map1";
import { type EyeCamera, UnderWaterEffect } from "./Maps/UnderWaterEffect";
import { NetworkManager } from "./Network/NetworkManager";
import { findSavedServerByName, getPlayerName } from "./Network/serverList";
import { initializeBlockBreakingVisuals } from "./Player/Hud/BlockHighlight/BlockBreakingVisuals";
import { DroppedItem } from "./Player/Inventory/DroppedItem";
import { Player } from "./Player/Player";
import { PlayerCamera } from "./Player/PlayerCamera";
import { PlayerStatePersistence } from "./Player/PlayerStatePersistence";
import { updateGlobalUniforms } from "./World/Chunk/ChunkMesher";
import { installLightDebugTool } from "./World/Chunk/LightDebugTool";
import { getServerNameFromUrl, worldSeedFor } from "./World/WorldContext";
import { WorldStorage } from "./World/WorldStorage";

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

		// Multiplayer: the URL is /server/<saved-server-nickname>. The nickname
		// maps (via the saved-servers list) to a ws:// address; the player name
		// is read from localStorage, never the URL.
		const serverNick = getServerNameFromUrl();
		const isMultiplayer = serverNick !== null;

		if (isMultiplayer) {
			// Multiplayer mode — no local world creation.
			// The server uses its config seed; we receive it via WorldConfig on join.
			const saved = serverNick ? findSavedServerByName(serverNick) : undefined;
			const serverUrl = saved?.url ?? reconstructWsUrl(serverNick);
			const playerName =
				getPlayerName() || `Player${Math.floor(Math.random() * 1000)}`;

			// Init a minimal Map1 (needed for player/environment/rendering)
			const map = new Map1(engine, scene, player);
			const mpT0 = performance.now();

			// Create the network manager and start connecting NOW — before the
			// world build finishes. The join POST must go out immediately; the
			// spawn-area chunks stream from the server once connected, so we
			// avoid generating (and then discarding) an entire local world.
			this.#networkManager = new NetworkManager(player, serverUrl);
			player.networkManager = this.#networkManager;
			player.setDefaultBlockEditCallbacks(this.#networkManager);
			// Keep a stable server-side world name ("__mp__") so all players on
			// a server share a room regardless of the URL nickname.
			void this.#networkManager.connect(playerName, "__mp__");

			await map.initPromise;
			console.log(
				`[MP-init] map.initPromise resolved ${(performance.now() - mpT0).toFixed(0)}ms after MP start (WorldStorage + PlayerLoadingGate)`,
			);

			initializeBlockBreakingVisuals(scene);
			void DroppedItem.preloadAtlas();
			player.createHud(scene);
			player.respawn();

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
		void WorldStorage.flush();
		if (this.engine) stopEngine(this.engine);
		Map1.disposeAll();
		this.engine = undefined;
		this.scene = undefined;
		this.#player = undefined;
	}
}

/**
 * Rebuild a ws:// (or wss:// on https) URL from a saved-server nickname.
 * Used as a fallback when the nickname in the URL isn't in the saved-servers
 * list (e.g. a shared link) — host:port style nicknames resolve directly.
 */
function reconstructWsUrl(nick: string | null): string | undefined {
	if (!nick) return undefined;
	if (nick.includes("://")) return nick;
	const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${nick}`;
}
