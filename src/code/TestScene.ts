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
import { beginFrameClock } from "./Lib/FrameClock";
import { FRAME_WORK_BUDGET } from "./Lib/FrameWorkBudget";
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
import { SETTING_PARAMS } from "./World/SETTINGS_PARAMS";
import { createFallbackSpawn } from "./World/SpawnPoint";
import { getServerNameFromUrl, worldSeedFor } from "./World/WorldContext";
import { WorldStorage } from "./World/WorldStorage";

const ENABLE_LITE_EXPLORER = false;
const MULTIPLAYER_ROOM_NAME = "__mp__";
const MSAA_SAMPLE_COUNT = 4;
const MIN_DEVICE_PIXEL_RATIO = 0.5;

/**
 * Lite native port of the engine/bootstrap entry point.
 *
 * Creates the WebGPU engine, scene, and follow camera, registers the scene,
 * and runs the render loop through startEngine's internal requestAnimationFrame
 * loop.
 */
export class TestScene {
	public readonly document: Document;
	public readonly initPromise: Promise<void>;

	public scene?: SceneContext;
	public engine?: EngineContext;

	#frameCounter = 0;
	#disposed = false;

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
		 * the surface and its pipelines.
		 */
		const savedSettings = loadGameSettings();

		const devicePixelRatio =
			typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

		const maxDevicePixelRatio = Math.max(
			MIN_DEVICE_PIXEL_RATIO,
			devicePixelRatio * savedSettings.renderScale,
		);

		const engine = await createEngine(this.canvas, {
			msaaSamples: savedSettings.msaaEnabled ? MSAA_SAMPLE_COUNT : 1,
			maxDevicePixelRatio,
		});

		/*
		 * dispose() may run while createEngine() is pending. Do not continue
		 * initializing a scene the caller has already retired.
		 */
		if (this.#disposed) {
			stopEngine(engine);
			return;
		}

		/*
		 * Keep surface dimensions cached through ResizeObserver so the render
		 * loop does not need to read canvas layout dimensions every frame.
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

		/*
		 * Initialization can involve world loading and network setup. Check
		 * again before registering or starting the scene.
		 */
		if (this.#disposed) {
			return;
		}

		await registerScene(scene);

		if (this.#disposed) {
			return;
		}

		await startEngine(engine);

		if (this.#disposed) {
			stopEngine(engine);
			return;
		}

		await initBlockBreakParticles(scene);

		if (ENABLE_LITE_EXPLORER && !this.#disposed) {
			await this.showLiteExplorer(engine, scene);
		}
	}

	/**
	 * Stable callback used by the light-debug tool.
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

		/*
		 * Map initialization and skin preloading are independent. Start both
		 * before constructing networking systems so their asynchronous work
		 * overlaps.
		 */
		const map = new Map1(engine, scene, player);
		const mapReady = map.initPromise;
		const mobSkinsReady = preloadMobSkins();

		/*
		 * Build the HUD before connecting. The server's connected callback
		 * sends the held-item selection and reads player.playerHud.
		 */
		player.createHud(scene);

		const networkManager = new NetworkManager(player, serverUrl);

		this.#networkManager = networkManager;

		player.networkManager = networkManager;
		player.setDefaultBlockEditCallbacks(networkManager);

		/*
		 * Connection deliberately remains outside the scene-startup critical
		 * path. Observe rejection so a failed join cannot become an unhandled
		 * promise rejection.
		 */
		void networkManager
			.connect(playerName, MULTIPLAYER_ROOM_NAME)
			.catch((error: unknown) => {
				if (this.#disposed) {
					return;
				}

				console.error("[TestScene] Multiplayer connection failed:", error);

				networkManager.notifySystemMessage(
					"Unable to connect to the multiplayer server.",
				);
			});

		const netClient = networkManager.netClient;

		const remoteMobManager = new RemoteMobManager(netClient);

		this.#remoteMobManager = remoteMobManager;
		Map1.remoteMobManager = remoteMobManager;

		const remoteItemManager = new RemoteItemManager(netClient);

		this.#remoteItemManager = remoteItemManager;

		Arrow.ensureNetworkHandler(netClient);

		/*
		 * Both operations are already running, so await them together rather
		 * than paying their latency sequentially.
		 */
		await Promise.all([mapReady, mobSkinsReady]);

		if (this.#disposed) {
			return;
		}

		this.initSharedPlayerSystems(scene, player);
		player.respawn();

		const persistence = new PlayerStatePersistence(
			scene,
			player,
			this.worldName,
			{
				persistPosition: false,
			},
		);

		this.#playerStatePersistence = persistence;

		/*
		 * Capture initialized instances once. The per-frame callback performs
		 * no manager lookup, optional chaining, or temporary allocation.
		 */
		this.registerFrameUpdate(
			scene,
			player,
			playerCamera,
			(deltaMs: number): void => {
				persistence.update();
				networkManager.tick(deltaMs);
				remoteMobManager.update(deltaMs);
				remoteItemManager.update(deltaMs);
			},
		);
	}

	private async initSingleplayer(
		engine: EngineContext,
		scene: SceneContext,
		player: Player,
		playerCamera: PlayerCamera,
	): Promise<void> {
		/*
		 * worldSeedFor may normalize or hash the world name. Calculate it once
		 * and share the result between terrain generation and encounter seeding.
		 */
		const worldSeed = worldSeedFor(this.worldName);

		setTerrainSeed(worldSeed);

		const map = new Map1(engine, scene, player);

		await map.initPromise;

		if (this.#disposed) {
			return;
		}

		await ensureDefaultInstance();

		if (this.#disposed) {
			return;
		}

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
		 * The mob systems may request the player position frequently. Reuse
		 * one borrowed vector rather than allocating a new vector per query.
		 */
		const coordinatorPosition = vec3(0, 0, 0);

		const getCoordinatorPosition = () => {
			const position = player.position;

			coordinatorPosition.x = position.x;
			coordinatorPosition.y = position.y;
			coordinatorPosition.z = position.z;

			return coordinatorPosition;
		};

		createMobCoordinator(scene, getCoordinatorPosition);

		/*
		 * Maya temple dungeons are populated on the main thread from the
		 * shared layout. Multiplayer servers own their encounter spawns.
		 */
		createMayaDungeonEncounter(
			scene,
			getCoordinatorPosition,
			computeSeedAsInt(worldSeed),
		);

		this.registerFrameUpdate(scene, player, playerCamera, (): void => {
			persistence.update();
		});
	}

	private initSharedPlayerSystems(scene: SceneContext, player: Player): void {
		initializeBlockBreakingVisuals(scene);

		/*
		 * preloadAtlas currently starts its own loading process and returns void,
		 * so it must not be treated as a Promise.
		 */
		try {
			DroppedItem.preloadAtlas();
		} catch (error: unknown) {
			if (!this.#disposed) {
				console.warn(
					"[TestScene] Failed to start dropped-item atlas preload:",
					error,
				);
			}
		}

		player.createHud(scene);
	}

	private registerFrameUpdate(
		scene: SceneContext,
		player: Player,
		playerCamera: PlayerCamera,
		perModeUpdate: (deltaMs: number) => void,
	): void {
		const underWaterEffect = new UnderWaterEffect(
			scene,
			playerCamera.playerCamera as unknown as EyeCamera,
			null,
		);

		/*
		 * Cache configuration lookups outside the frame loop. These settings
		 * are treated as startup constants by the existing implementation.
		 */
		const uploadBudgetBytes = SETTING_PARAMS.FRAME_UPLOAD_BUDGET_BYTES;

		const collisionBudgetChecks = SETTING_PARAMS.FRAME_COLLISION_BUDGET_CHECKS;

		const decompressionBudget = SETTING_PARAMS.FRAME_DECOMPRESSION_BUDGET;

		const meshBuildBudget = SETTING_PARAMS.FRAME_MESH_BUILD_BUDGET;

		const streamingTimeBudgetMs = SETTING_PARAMS.FRAME_STREAMING_TIME_BUDGET_MS;

		onBeforeRender(scene, (deltaMs: number): void => {
			if (this.#disposed) {
				return;
			}

			/*
			 * Sample the clock and reset frame budgets before any subsystem
			 * runs. Downstream systems must see the current frame's values.
			 */
			beginFrameClock(deltaMs);

			FRAME_WORK_BUDGET.beginFrame(
				uploadBudgetBytes,
				collisionBudgetChecks,
				decompressionBudget,
				meshBuildBudget,
				streamingTimeBudgetMs,
			);

			const frameCounter = ++this.#frameCounter;

			Map1.update(deltaMs);
			player.tick(deltaMs);
			perModeUpdate(deltaMs);

			underWaterEffect.updateFromCamera();
			updateGlobalUniforms(frameCounter);
		});
	}

	private async showLiteExplorer(
		engine: EngineContext,
		scene: SceneContext,
	): Promise<void> {
		/*
		 * The modules are independent, so load them concurrently.
		 */
		const [explorerModule, lite] = await Promise.all([
			import("babylon-lite-explorer"),
			import("@babylonjs/lite"),
		]);

		if (this.#disposed) {
			return;
		}

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
		if (this.#disposed) {
			return;
		}

		this.#disposed = true;

		/*
		 * Dispose external callbacks first so they cannot continue accessing
		 * player or scene state while teardown is underway.
		 */
		this.#disposeLightDebugTool?.();
		this.#disposeLightDebugTool = undefined;

		this.#playerStatePersistence?.dispose();
		this.#playerStatePersistence = undefined;

		this.#networkManager?.disconnect();
		this.#networkManager = undefined;

		this.#remoteMobManager?.dispose();
		this.#remoteMobManager = undefined;

		this.#remoteItemManager?.dispose();
		this.#remoteItemManager = undefined;

		/*
		 * Storage flush remains asynchronous, but rejection is observed to
		 * prevent teardown from producing an unhandled rejection.
		 */
		void WorldStorage.flush().catch((error: unknown) => {
			console.error("[TestScene] Failed to flush world storage:", error);
		});

		const engine = this.engine;

		if (engine !== undefined) {
			stopEngine(engine);
		}

		Map1.disposeAll();
		Map1.remoteMobManager = null;

		this.engine = undefined;
		this.scene = undefined;
		this.#player = undefined;
	}
}

/**
 * Rebuilds a ws:// or wss:// URL from a saved-server nickname.
 *
 * Used when the nickname in the URL is not present in the saved-server list.
 */
function reconstructWsUrl(nick: string | null): string | undefined {
	if (!nick) {
		return undefined;
	}

	if (nick.includes("://")) {
		return nick;
	}

	const protocol =
		typeof window !== "undefined" && window.location.protocol === "https:"
			? "wss:"
			: "ws:";

	return `${protocol}//${nick}`;
}
