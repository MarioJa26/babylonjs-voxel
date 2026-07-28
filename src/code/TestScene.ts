import * as lite from "@babylonjs/lite";
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
import { Map1 } from "./Maps/Map1";
import { type EyeCamera, UnderWaterEffect } from "./Maps/UnderWaterEffect";
import { initializeBlockBreakingVisuals } from "./Player/Hud/BlockHighlight/BlockBreakingVisuals";
import { DroppedItem } from "./Player/Inventory/DroppedItem";
import { Player } from "./Player/Player";
import { PlayerCamera } from "./Player/PlayerCamera";
import { PlayerStatePersistence } from "./Player/PlayerStatePersistence";
import { updateGlobalUniforms } from "./World/Chunk/ChunkMesher";

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

	constructor(
		document: Document,
		private canvas: HTMLCanvasElement,
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

		scene.camera = playerCamera.playerCamera;

		const map = new Map1(engine, scene, player);
		await map.initPromise;

		// World is ready — now build meshes that depend on Map1.engine.
		initializeBlockBreakingVisuals(scene);
		DroppedItem.preloadAtlas();
		player.createHud(scene);
		player.respawn();

		// Wire player save/load. Instantiated AFTER respawn() so the restored
		// position wins over the respawn height recompute. Restores position +
		// inventory immediately and autosaves on interval / tab-hide / unload.
		this.#playerStatePersistence = new PlayerStatePersistence(scene, player);

		// C4: wire the (previously dormant) mob spawn/AI system.
		createMobCoordinator(this.scene, () => {
			const p = this.#player!.position;
			return vec3(p.x, p.y, p.z);
		});

		// Underwater visual effect — toggles a full-screen overlay whenever the
		// player's eyes are submerged. Updated before fog so fog reads the flag.
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

		await registerScene(scene);
		await startEngine(engine);

		showLiteExplorer(
			{ engine, scene, canvas: this.canvas, lite },
			{ mode: "overlay", layout: "single", theme: "dark" },
		);
	}

	public dispose(): void {
		this.#playerStatePersistence?.dispose();
		if (this.engine) stopEngine(this.engine);
		Map1.disposeAll();
		this.engine = undefined;
		this.scene = undefined;
		this.#player = undefined;
	}
}
