import {
	createEngine,
	createSceneContext,
	type EngineContext,
	enableSurfaceResizeObserver,
	onBeforeRender,
	registerScene,
	type SceneContext,
	startEngine,
	stopEngine,
	vec3,
} from "@babylonjs/lite";
import { applyAudioSettings } from "./Audio/AudioManager";
import { Arrow } from "./Entities/Arrow/Arrow";
import { createMayaDungeonEncounter } from "./Entities/MayaDungeonEncounter";
import { preloadMobSkins } from "./Entities/Mobs/MobInstancePool";
import { createMobCoordinator } from "./Entities/Mobs/MobSetup";
import { setTerrainSeed } from "./Generation/TerrainHeightMap";
import { computeSeedAsInt } from "./Generation/WorldSeed";
import { initBlockBreakParticles } from "./Maps/BlockBreakParticles";
import { Map1 } from "./Maps/Map1";
import { type EyeCamera, UnderWaterEffect } from "./Maps/UnderWaterEffect";
import { NetworkManager } from "./Network/NetworkManager";
import { RemoteItemManager } from "./Network/RemoteItemManager";
import { RemoteMobManager } from "./Network/RemoteMobManager";
import { findSavedServerByName, getPlayerName } from "./Network/serverList";
import { initializeBlockBreakingVisuals } from "./Player/Hud/BlockHighlight/BlockBreakingVisuals";
import { DroppedItem } from "./Player/Inventory/DroppedItem";
import { Player } from "./Player/Player";
import { PlayerCamera } from "./Player/PlayerCamera";
import { PlayerStatePersistence } from "./Player/PlayerStatePersistence";
import { applyGameSettingsToEngine, loadGameSettings } from "./UI/GameSettings";
import { installLightDebugTool } from "./World/Chunk/LightDebugTool";
import { updateGlobalUniforms } from "./World/Chunk/Meshing/ChunkMesher";
import { ensureDefaultInstance } from "./World/Chunk/Simulation/WaterSimulation";
import { createFallbackSpawn } from "./World/SpawnPoint";
import { getServerNameFromUrl, worldSeedFor } from "./World/WorldContext";
import { WorldStorage } from "./World/WorldStorage";

const ENABLE_LITE_EXPLORER = false;
const MULTIPLAYER_ROOM_NAME = "__mp__";
const MSAA_SAMPLE_COUNT = 4;
const MIN_DEVICE_PIXEL_RATIO = 0.5;

/**
 * Lite native port of the engine/bootstrap entry point.
 * Creates the WebGPU engine, scene, and follow camera, registers the scene,
 * and runs the render loop through startEngine's internal rAF.
 */
export class TestScene {
	public readonly document: Document;
	public readonly initPromise: Promise<void>;

	public scene?: SceneContext;
	public engine?: EngineContext;

	#frameCounter = 0;
	#player?: Player;
	#playerStatePersistence?: PlayerStatePersistence;
	#disposeLightDebugTool?: () => void;
	#networkManager?: NetworkManager;
	#remoteMobManager?: RemoteMobManager;
	#remoteItemManager?: RemoteItemManager;

	public constructor(
		document: Document,
		private readonly canvas: HTMLCanvasElement,
		private readonly worldName: string,
	) {
		this.document = document;
		this.initPromise = this.init();
	}

	public async init(): Promise<void> {
		/*
		 * Load persisted settings before creating the engine. Render scale and
		 * MSAA affect surface creation and cannot be changed without rebuilding
		 * the surface and pipelines.
		 */
		const savedSettings = loadGameSettings();

		const devicePixelRatio =
			typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

		const engine = await createEngine(this.canvas, {
			msaaSamples: savedSettings.msaaEnabled ? MSAA_SAMPLE_COUNT : 1,
			maxDevicePixelRatio: Math.max(
				MIN_DEVICE_PIXEL_RATIO,
				devicePixelRatio * savedSettings.renderScale,
			),
		});

		/*
		 * Keep surface dimensions cached through ResizeObserver so the render
		 * loop does not need to read canvas layout dimensions each frame.
		 */
		enableSurfaceResizeObserver(engine);

		const scene = createSceneContext(engine, {
			defaultRenderTask: true,
		});

		this.engine = engine;
		this.scene = scene;

		applyGameSettingsToEngine(savedSettings);
		applyAudioSettings(savedSettings);

		const playerCamera = new PlayerCamera();
		playerCamera.mouseSensitivity = savedSettings.mouseSensitivity;

		const player = new Player(engine, scene, playerCamera, this.canvas);

		this.#player = player;
		this.#disposeLightDebugTool = installLightDebugTool(
			this.#getPlayerPosition,
		);

		scene.camera = playerCamera.playerCamera;

		const serverNick = getServerNameFromUrl();

		if (serverNick === null) {
			await this.initSingleplayer(engine, scene, player, playerCamera);
		} else {
			await this.initMultiplayer(
				engine,
				scene,
				player,
				playerCamera,
				serverNick,
			);
		}

		await registerScene(scene);
		await startEngine(engine);
		await initBlockBreakParticles(scene);

		if (ENABLE_LITE_EXPLORER) {
			await this.showLiteExplorer(engine, scene);
		}
	}

	/**
	 * Stable callback stored once instead of creating an inline callback when
	 * installing the light debug tool.
	 */
	readonly #getPlayerPosition = () => this.#player?.position;

	private async initMultiplayer(
		engine: EngineContext,
		scene: SceneContext,
		player: Player,
		playerCamera: PlayerCamera,
		serverNick: string,
	): Promise<void> {
		const savedServer = findSavedServerByName(serverNick);
		const serverUrl = savedServer?.url ?? reconstructWsUrl(serverNick);

		const savedPlayerName = getPlayerName();
		const playerName =
			savedPlayerName || `Player${Math.floor(Math.random() * 1000)}`;

		const map = new Map1(engine, scene, player);

		await preloadMobSkins();

		const networkManager = new NetworkManager(player, serverUrl);

		this.#networkManager = networkManager;
		player.networkManager = networkManager;
		player.setDefaultBlockEditCallbacks(networkManager);

		void networkManager.connect(playerName, MULTIPLAYER_ROOM_NAME);

		const netClient = networkManager.netClient;

		const remoteMobManager = new RemoteMobManager(netClient);
		this.#remoteMobManager = remoteMobManager;
		Map1.remoteMobManager = remoteMobManager;

		const remoteItemManager = new RemoteItemManager(netClient);
		this.#remoteItemManager = remoteItemManager;

		Arrow.ensureNetworkHandler(netClient);

		await map.initPromise;

		this.initSharedPlayerSystems(scene, player);
		player.respawn();

		const persistence = new PlayerStatePersistence(
			scene,
			player,
			this.worldName,
			{ persistPosition: false },
		);

		this.#playerStatePersistence = persistence;

		/*
		 * Capture initialized instances directly. This avoids repeated private
		 * field lookups and optional-chain checks in the per-frame hot path.
		 * These objects already remain alive for the registered scene callback.
		 */
		this.registerFrameUpdate(scene, playerCamera, (deltaMs: number): void => {
			persistence.update();
			networkManager.tick(deltaMs);
			remoteMobManager.update(deltaMs);
			remoteItemManager.update(deltaMs);
		});
	}

	private async initSingleplayer(
		engine: EngineContext,
		scene: SceneContext,
		player: Player,
		playerCamera: PlayerCamera,
	): Promise<void> {
		setTerrainSeed(worldSeedFor(this.worldName));

		const map = new Map1(engine, scene, player);
		await map.initPromise;

		await ensureDefaultInstance();

		this.initSharedPlayerSystems(scene, player);

		createFallbackSpawn(0, 0);
		player.respawn();

		const persistence = new PlayerStatePersistence(
			scene,
			player,
			this.worldName,
		);

		this.#playerStatePersistence = persistence;

		/*
		 * The coordinator may request the player position frequently. Reusing
		 * this vector removes one object allocation per query.
		 *
		 * The returned value is borrowed and must not be retained or mutated by
		 * the coordinator.
		 */
		const coordinatorPosition = vec3(0, 0, 0);

		createMobCoordinator(scene, () => {
			const position = player.position;

			coordinatorPosition.x = position.x;
			coordinatorPosition.y = position.y;
			coordinatorPosition.z = position.z;

			return coordinatorPosition;
		});

		// Maya temple dungeons are populated on the main thread from the shared
		// layout, not by worldgen — the chunk worker has no way to create mobs.
		// Runs singleplayer only; in multiplayer the server owns the spawns and
		// RemoteMobManager renders them.
		createMayaDungeonEncounter(
			scene,
			() => {
				const position = player.position;

				coordinatorPosition.x = position.x;
				coordinatorPosition.y = position.y;
				coordinatorPosition.z = position.z;

				return coordinatorPosition;
			},
			computeSeedAsInt(worldSeedFor(this.worldName)),
		);

		this.registerFrameUpdate(scene, playerCamera, (): void => {
			persistence.update();
		});
	}

	private initSharedPlayerSystems(scene: SceneContext, player: Player): void {
		initializeBlockBreakingVisuals(scene);
		void DroppedItem.preloadAtlas();
		player.createHud(scene);
	}

	private registerFrameUpdate(
		scene: SceneContext,
		playerCamera: PlayerCamera,
		perModeUpdate: (deltaMs: number) => void,
	): void {
		const underWaterEffect = new UnderWaterEffect(
			scene,
			playerCamera.playerCamera as unknown as EyeCamera,
			null,
		);

		onBeforeRender(scene, (deltaMs: number): void => {
			const frameCounter = ++this.#frameCounter;
			const player = this.#player;

			Map1.update(deltaMs);

			if (player !== undefined) {
				player.tick(deltaMs);
			}

			perModeUpdate(deltaMs);
			underWaterEffect.updateFromCamera();
			updateGlobalUniforms(frameCounter);
		});
	}

	private async showLiteExplorer(
		engine: EngineContext,
		scene: SceneContext,
	): Promise<void> {
		const explorerModulePromise = import("babylon-lite-explorer");
		const liteModulePromise = import("@babylonjs/lite");

		const explorerModule = await explorerModulePromise;
		const lite = await liteModulePromise;

		explorerModule.showLiteExplorer(
			{
				engine,
				scene,
				canvas: this.canvas,
				lite,
			},
			{
				mode: "overlay",
				layout: "single",
				theme: "dark",
			},
		);
	}

	public dispose(): void {
		this.#disposeLightDebugTool?.();
		this.#playerStatePersistence?.dispose();
		this.#networkManager?.disconnect();
		this.#remoteMobManager?.dispose();
		this.#remoteItemManager?.dispose();

		void WorldStorage.flush();

		const engine = this.engine;

		if (engine !== undefined) {
			stopEngine(engine);
		}

		Map1.disposeAll();
		Map1.remoteMobManager = null;

		this.engine = undefined;
		this.scene = undefined;
		this.#player = undefined;
		this.#playerStatePersistence = undefined;
		this.#networkManager = undefined;
		this.#remoteMobManager = undefined;
		this.#remoteItemManager = undefined;
		this.#disposeLightDebugTool = undefined;
	}
}

/**
 * Rebuild a ws:// or wss:// URL from a saved-server nickname.
 * Used when the nickname in the URL is not in the saved-server list.
 */
function reconstructWsUrl(nick: string | null): string | undefined {
	if (!nick) {
		return undefined;
	}

	if (nick.includes("://")) {
		return nick;
	}

	const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";

	return `${scheme}//${nick}`;
}
