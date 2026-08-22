import {
	addToScene,
	createCapsule,
	createDefaultCamera,
	createEngine,
	createSceneContext,
	createStandardMaterial,
	disposeEngine,
	disposeMeshGpu,
	disposeScene,
	onBeforeRender,
	registerScene,
	startEngine,
	stopEngine,
	type EngineContext,
	type Mesh,
	type SceneContext,
} from "@babylonjs/lite";

const PREVIEW_SIZE = { width: 210, height: 270 };
const SPIN_SPEED = Math.PI / 2.5; // rad/s
const PLAYER_HEIGHT = 1.75;
const PLAYER_RADIUS = 0.3;
const PLAYER_COLOR: [number, number, number] = [0.2, 0.9, 0.8];

/**
 * Small standalone render surface showing the player's character mesh
 * inside the inventory screen. Uses its own tiny engine on a dedicated
 * canvas; the engine only runs while the inventory is open.
 */
export class PlayerPreview {
	readonly container: HTMLDivElement;

	#canvas: HTMLCanvasElement;
	#engine: EngineContext | null = null;
	#scene: SceneContext | null = null;
	#mesh: Mesh | null = null;
	#initPromise: Promise<void> | null = null;
	#running = false;

	constructor() {
		this.container = document.createElement("div");
		this.container.className = "player-preview-panel";

		this.#canvas = document.createElement("canvas");
		this.#canvas.className = "player-preview-canvas";
		this.#canvas.width = PREVIEW_SIZE.width;
		this.#canvas.height = PREVIEW_SIZE.height;
		this.container.appendChild(this.#canvas);
	}

	/** Show (and lazily boot) the preview. Safe to call repeatedly. */
	show(): void {
		this.#ensureInit()
			.then(() => this.#start())
			.catch((e) => console.error("PlayerPreview unavailable:", e));
	}

	/** Pause rendering while the inventory is closed. */
	hide(): void {
		if (!this.#engine || !this.#running) return;
		this.#running = false;
		stopEngine(this.#engine);
	}

	dispose(): void {
		this.hide();

		if (this.#mesh) disposeMeshGpu(this.#mesh);
		if (this.#scene) disposeScene(this.#scene);
		if (this.#engine) disposeEngine(this.#engine);

		this.#mesh = null;
		this.#scene = null;
		this.#engine = null;
		this.#initPromise = null;

		this.container.remove();
	}

	#ensureInit(): Promise<void> {
		this.#initPromise ??= this.#init();
		return this.#initPromise;
	}

	async #init(): Promise<void> {
		const engine = await createEngine(this.#canvas, {});
		const scene = createSceneContext(engine, { defaultRenderTask: true });

		const mesh = createCapsule(engine, {
			height: PLAYER_HEIGHT,
			radius: PLAYER_RADIUS,
		});
		const mat = createStandardMaterial();
		mat.diffuseColor = PLAYER_COLOR;
		mat.disableLighting = true;
		mesh.material = mat;
		mesh.pickable = false;
		addToScene(scene, mesh);

		this.#mesh = mesh;
		this.#engine = engine;
		this.#scene = scene;

		addToScene(scene, createDefaultCamera(scene));

		onBeforeRender(scene, (deltaMs) => {
			if (this.#mesh) {
				this.#mesh.rotation.y += (deltaMs / 1000) * SPIN_SPEED;
			}
		});

		await registerScene(scene);
	}

	#start(): void {
		if (!this.#engine || this.#running) return;
		this.#running = true;
		void startEngine(this.#engine);
	}
}
