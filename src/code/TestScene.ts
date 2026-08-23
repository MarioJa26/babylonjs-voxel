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
import { createMobCoordinator } from "./Entities/Mobs/MobSetup";
import { setTerrainSeed } from "./Generation/TerrainHeightMap";
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
import { updateGlobalUniforms } from "./World/Chunk/ChunkMesher";
import { installLightDebugTool } from "./World/Chunk/LightDebugTool";
import { createFallbackSpawn } from "./World/SpawnPoint";
import { getServerNameFromUrl, worldSeedFor } from "./World/WorldContext";
import { WorldStorage } from "./World/WorldStorage";

const ENABLE_LITE_EXPLORER = false;

/**
 * Lite native port of the engine/bootstrap entry point.
 * Creates the WebGPU engine + scene + follow camera, registers the
 * scene, and runs the render loop through startEngine's internal rAF.
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
	#remoteMobManager?: RemoteMobManager;
	#remoteItemManager?: RemoteItemManager;

	constructor(
		document: Document,
		private canvas: HTMLCanvasElement,
		private readonly worldName: string,
	) {
		this.document = document;
		this.initPromise = this.init();
	}

	async init(): Promise<void> {
		// Load persisted settings BEFORE the engine exists: render scale and
		// MSAA are surface-creation options (canvas size + pipeline sample
		// counts) and cannot be changed afterwards without a full rebuild.
		const savedSettings = loadGameSettings();
		const dpr =
			typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
		const engine = await createEngine(this.canvas, {
			msaaSamples: savedSettings.msaaEnabled ? 4 : 1,
			maxDevicePixelRatio: Math.max(0.5, dpr * savedSettings.renderScale),
		});
		const scene = createSceneContext(engine, {
			defaultRenderTask: true,
		});

		this.engine = engine;
		this.scene = scene;

		// Apply locally persisted options before anything reads the params.
		applyGameSettingsToEngine(savedSettings);

		const playerCamera = new PlayerCamera();
		playerCamera.mouseSensitivity = savedSettings.mouseSensitivity;
		const player = new Player(engine, scene, playerCamera, this.canvas);

		this.#player = player;
		this.#disposeLightDebugTool = installLightDebugTool(
			() => this.#player?.position,
		);

		scene.camera = playerCamera.playerCamera;

		const serverNick = getServerNameFromUrl();

		if (serverNick !== null) {
			await this.initMultiplayer(
				engine,
				scene,
				player,
				playerCamera,
				serverNick,
			);
		} else {
			await this.initSingleplayer(engine, scene, player, playerCamera);
		}

		await registerScene(scene);
		await startEngine(engine);
		this.#installFpsCap(engine, savedSettings.fpsCap);

		if (ENABLE_LITE_EXPLORER) {
			await this.showLiteExplorer(engine, scene);
		}
	}

	/**
	 * Cap the engine's rAF loop without patching lite.
	 *
	 * startEngine() schedules an uncapped requestAnimationFrame chain, so on
	 * 120Hz+ monitors the GPU renders flat-out. We wrap `engine._renderFn`:
	 * when a frame is due we call the original (which re-schedules our
	 * wrapper — exactly one chain), and when skipped WE re-schedule instead.
	 */
	#installFpsCap(engine: EngineContext, fpsCap: number): void {
		if (!fpsCap || fpsCap <= 0) return; // 0 = uncapped
		const anyEngine = engine as unknown as {
			_renderFn: ((now: number) => void) | null;
			_animFrameId: number;
		};
		const original = anyEngine._renderFn;
		if (!original) return;
		const minInterval = 1000 / Math.min(fpsCap, 240) - 1;
		let lastRender = -Infinity;
		const wrapped = (now: number): void => {
			if (anyEngine._renderFn !== wrapped) return; // engine stopped
			if (now - lastRender >= minInterval || now < lastRender) {
				lastRender = now;
				original(now); // re-schedules `wrapped`
			} else {
				anyEngine._animFrameId = requestAnimationFrame(wrapped);
			}
		};
		cancelAnimationFrame(anyEngine._animFrameId);
		anyEngine._renderFn = wrapped;
		anyEngine._animFrameId = requestAnimationFrame(wrapped);
	}

	private async initMultiplayer(
		engine: EngineContext,
		scene: SceneContext,
		player: Player,
		playerCamera: PlayerCamera,
		serverNick: string,
	): Promise<void> {
		const saved = findSavedServerByName(serverNick);
		const serverUrl = saved?.url ?? reconstructWsUrl(serverNick);
		const playerName =
			getPlayerName() || `Player${Math.floor(Math.random() * 1000)}`;

		const map = new Map1(engine, scene, player);
		const mpT0 = performance.now();

		this.#networkManager = new NetworkManager(player, serverUrl);
		player.networkManager = this.#networkManager;
		player.setDefaultBlockEditCallbacks(this.#networkManager);

		// Stable server-side room name so all players on the same server share a world.
		void this.#networkManager.connect(playerName, "__mp__");

		// Server-authoritative mobs: render remote mobs driven by MobSpawn /
		// MobUpdateBatch / MobDespawn. Created after connect so its binary
		// handler is registered for the lifetime of the connection.
		this.#remoteMobManager = new RemoteMobManager(
			this.#networkManager.netClient,
		);
		Map1.remoteMobManager = this.#remoteMobManager;

		// Server-authoritative items: render remote dropped items driven by
		// ItemSpawn / ItemUpdateBatch / ItemDespawn. Created after connect so
		// its binary handler is registered for the lifetime of the connection.
		this.#remoteItemManager = new RemoteItemManager(
			this.#networkManager.netClient,
		);

		await map.initPromise;

		console.log(
			`[MP-init] map.initPromise resolved ${(performance.now() - mpT0).toFixed(0)}ms after MP start (WorldStorage + PlayerLoadingGate)`,
		);

		this.initSharedPlayerSystems(scene, player);
		player.respawn();

		this.registerFrameUpdate(scene, playerCamera, (deltaMs) => {
			this.#networkManager?.tick(deltaMs);
			this.#remoteMobManager?.update(deltaMs);
			this.#remoteItemManager?.update(deltaMs);
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

		// Build the local spawn immediately so the loading gate can proceed
		// without waiting for server-provided spawn data.
		createFallbackSpawn(0, 0);

		this.initSharedPlayerSystems(scene, player);
		player.respawn();

		this.#playerStatePersistence = new PlayerStatePersistence(
			scene,
			player,
			this.worldName,
		);

		createMobCoordinator(scene, () => {
			const p = this.#player!.position;
			return vec3(p.x, p.y, p.z);
		});

		this.registerFrameUpdate(scene, playerCamera, () => {
			this.#playerStatePersistence?.update();
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

		onBeforeRender(scene, (deltaMs) => {
			this.#frameCounter++;
			Map1.update(deltaMs);
			this.#player?.tick(deltaMs);
			perModeUpdate(deltaMs);
			underWaterEffect.updateFromCamera();
			updateGlobalUniforms(this.#frameCounter);
		});
	}

	private async showLiteExplorer(
		engine: EngineContext,
		scene: SceneContext,
	): Promise<void> {
		const [{ showLiteExplorer }, lite] = await Promise.all([
			import("babylon-lite-explorer"),
			import("@babylonjs/lite"),
		]);

		showLiteExplorer(
			{ engine, scene, canvas: this.canvas, lite },
			{ mode: "overlay", layout: "single", theme: "dark" },
		);
	}

	public dispose(): void {
		this.#disposeLightDebugTool?.();
		this.#playerStatePersistence?.dispose();
		this.#networkManager?.disconnect();
		this.#remoteMobManager?.dispose();
		this.#remoteItemManager?.dispose();

		void WorldStorage.flush();

		if (this.engine) {
			stopEngine(this.engine);
		}

		Map1.disposeAll();

		this.engine = undefined;
		this.scene = undefined;
		this.#player = undefined;
		this.#playerStatePersistence = undefined;
		this.#networkManager = undefined;
		this.#remoteMobManager = undefined;
		this.#remoteItemManager = undefined;
		Map1.remoteMobManager = null;
		this.#disposeLightDebugTool = undefined;
	}
}

/**
 * Rebuild a ws:// or wss:// URL from a saved-server nickname.
 * Used as a fallback when the nickname in the URL is not in the saved-servers
 * list, for example a shared host:port link.
 */
function reconstructWsUrl(nick: string | null): string | undefined {
	if (!nick) return undefined;
	if (nick.includes("://")) return nick;

	const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${nick}`;
}
