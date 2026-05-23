import { Engine, FreeCamera, Scene, ScenePerformancePriority, Vector3 } from "@babylonjs/core";
import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";
import { CustomBoat } from "./Entities/CustomBoat";
import { GenerationParams } from "./Generation/NoiseAndParameters/GenerationParams";
import { Map1 } from "./Maps/Map1";
import { Player } from "./Player/Player";
import { PlayerCamera } from "./Player/PlayerCamera";
import { updateGlobalUniforms } from "./World/Chunk/ChunckMesher";
import { Chunk } from "./World/Chunk/Chunk";
import { SvoDebugger } from "./World/Chunk/SvoDebugger";

export class TestScene {
	document: Document;
	//connection: MyConnection;
	scene?: Scene;
	engine: Engine;
	public readonly initPromise: Promise<void>;
	private frameCounter = 0;
	private player?: Player;
	readonly #onKeyDown: (ev: KeyboardEvent) => void;
	readonly #svoDebugger = new SvoDebugger();

	constructor(
		document: Document,
		private canvas: HTMLCanvasElement,
	) {
		this.document = document;
		this.engine = new Engine(this.canvas, true, {
			stencil: true,
			preserveDrawingBuffer: false,
		});
		this.engine.setHardwareScalingLevel(1.0);
		//this.connection = new MyConnection();

		window.addEventListener("keydown", (ev) => {
			// Ctrl+F
			if (ev.ctrlKey && ev.key.toLowerCase() === "f") {
				if (this.scene) {
					if (this.scene.debugLayer.isVisible()) {
						this.scene.debugLayer.hide();
					} else {
						this.scene.debugLayer.show();
					}
				}
			}

			if (ev.key.toLowerCase() === "f8") {
				this.#toggleSvoDebug();
			}
		};
		window.addEventListener("keydown", this.#onKeyDown);

		this.initPromise = this.init();

		this.engine.runRenderLoop(() => {
			// Update shader uniforms ONCE per frame
			this.frameCounter++;
			updateGlobalUniforms(this.frameCounter, this.player?.position);

			// Then render the scene
			this.scene?.render();
		});
	}

	async init() {
		this.scene = await this.createScene();
		//if (GLOBAL_VALUES.INIT_CONNECTION) await this.connection.connect();
	}

	// Playground scene creation
	async createScene() {
		const scene = new Scene(this.engine);

		scene.performancePriority = ScenePerformancePriority.Aggressive;
		scene.skipFrustumClipping = true;
		scene.autoClear = true;
		scene.autoClearDepthAndStencil = true;

		const camera = new FreeCamera("camera1", Vector3.Zero(), scene);

		const playerCamera = new PlayerCamera(camera, scene);

		const player = new Player(this.engine, scene, playerCamera, this.canvas);
		this.player = player;
		CustomBoat.configureChunkReloadContext(
			scene,
			player,
			GenerationParams.SEA_LEVEL,
		);
		const map = new Map1(scene, player);
		await map.initPromise;
		return scene;
	}
	public dispose(): void {
		window.removeEventListener("keydown", this.#onKeyDown);
		this.#svoDebugger.dispose();
		this.engine.stopRenderLoop();
		this.scene?.dispose(); // fires onDisposeObservable → your cleanup runs
		this.engine.dispose();
	}

	#toggleSvoDebug(): void {
		if (!this.scene) return;

		const camera = Map1.mainScene?.activeCamera;
		if (!camera) return;

		const pos = camera.position;
		const chunkRadius = 3;
		const worldRadius = chunkRadius * Chunk.SIZE;

		this.#svoDebugger.toggleNear(this.scene, pos.x, pos.y, pos.z, worldRadius, {
			maxDepth: 3,
			colorByDepth: true,
			skipAir: false,
		});

		const state = this.#svoDebugger.isVisible ? "ON" : "OFF";
		console.log(
			`[SVO Debug] ${state} — ${chunkRadius} chunk radius around player`,
		);
	}
}
