import {
	Engine,
	FreeCamera,
	Scene,
	ScenePerformancePriority,
	Vector3,
} from "@babylonjs/core";
import { CustomBoat } from "./Entities/CustomBoat";
import { GenerationParams } from "./Generation/NoiseAndParameters/GenerationParams";
import { Map1 } from "./Maps/Map1";
import { Player } from "./Player/Player";
import { PlayerCamera } from "./Player/PlayerCamera";
import { updateGlobalUniforms } from "./World/Chunk/ChunkMesher";

export class TestScene {
	document: Document;
	scene?: Scene;
	engine: Engine;
	public readonly initPromise: Promise<void>;
	private frameCounter = 0;
	readonly #onKeyDown: (ev: KeyboardEvent) => void;

	constructor(
		document: Document,
		private canvas: HTMLCanvasElement,
	) {
		this.document = document;
		this.engine = new Engine(this.canvas);
		this.#onKeyDown = async (ev) => {
			// Ctrl+F
			if (ev.ctrlKey && ev.key.toLowerCase() === "f") {
				if (this.scene) {
					if (this.scene.debugLayer.isVisible()) {
						this.scene.debugLayer.hide();
					} else {
						await import("@babylonjs/core/Debug/debugLayer");
						await import("@babylonjs/inspector");
						this.scene.debugLayer.show();
					}
				}
			}
		};
		window.addEventListener("keydown", this.#onKeyDown);

		this.initPromise = this.init();

		this.engine.runRenderLoop(() => {
			// Update shader uniforms ONCE per frame
			this.frameCounter++;
			updateGlobalUniforms(this.frameCounter);

			// Then render the scene
			this.scene?.render();
		});
	}

	async init() {
		this.scene = await this.createScene();
	}

	// Playground scene creation
	async createScene() {
		// This creates a basic Babylon Scene object (non-mesh)
		const scene = new Scene(this.engine);

		scene.performancePriority = ScenePerformancePriority.BackwardCompatible;
		scene.autoClear = false; // Color buffer
		scene.autoClearDepthAndStencil = false; // Depth and stencil

		// This creates and positions a free camera (non-mesh)
		const camera = new FreeCamera("camera1", Vector3.Zero(), scene);

		const playerCamera = new PlayerCamera(camera, scene);

		const player = new Player(this.engine, scene, playerCamera, this.canvas);
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
		this.engine.stopRenderLoop();
		this.scene?.dispose();
		this.engine.dispose();
	}
}
