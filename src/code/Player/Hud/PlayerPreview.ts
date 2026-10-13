import {
	addBillboardSpriteIndex,
	addFacingBillboardSystem,
	addToScene,
	billboardBlendAlpha,
	createArcRotateCamera,
	createDynamicTexture,
	createEngine,
	createFacingBillboardSystem,
	createGridSpriteAtlas,
	createMeshFromData,
	createSceneContext,
	disposeEngine,
	disposeMeshGpu,
	disposeScene,
	type EngineContext,
	enableSurfaceResizeObserver,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	registerScene,
	type SceneContext,
	type ShaderMaterial,
	setShaderTexture,
	startEngine,
	stopEngine,
	updateDynamicTexture,
	vec3,
} from "@babylonjs/lite";
import {
	NAME_TAG_HEIGHT_WORLD,
	rasteriseNameTag,
} from "@/code/Network/RemotePlayerRenderer";
import { getPlayerName } from "@/code/Network/serverList";
import { getAtlasTile } from "@/code/World/Texture/BlockTextures";
import { BlockType } from "@/code/World/Texture/BlockType";
import {
	atlasSize,
	atlasTileSize,
} from "@/code/World/Texture/TextureAtlasFactory";
import {
	applyRigSkin,
	buildFloorSlabData,
	createPlayerRigMesh,
	createRigShaderMaterial,
	getRigFallbackTexture,
	PLAYER_MODEL_HEIGHT,
	packedLightToLightColor,
	setRigLightColor,
} from "../PlayerModel";

const PREVIEW_SIZE = { width: 220, height: 440 } as const;
const SPIN_SPEED_PER_MS = (Math.PI / 3) * 0.001;
const ATLAS_TEXTURE_PATH = "/texture/diffuse_atlas.png";

const PREVIEW_CLEAR_COLOR = {
	r: 0.04,
	g: 0.055,
	b: 0.07,
	a: 1,
} as const;

/**
 * Small standalone render surface showing a Minecraft-style player model
 * inside the inventory screen. Uses its own engine on a dedicated canvas.
 * The engine only runs while the inventory is open.
 */
export class PlayerPreview {
	readonly container: HTMLDivElement;
	readonly canvas: HTMLCanvasElement;

	getLightLevel?: () => number;

	#engine: EngineContext | null = null;
	#scene: SceneContext | null = null;
	#model: Mesh | null = null;
	#rigMat: ShaderMaterial | null = null;
	#floor: Mesh | null = null;
	#floorMat: ShaderMaterial | null = null;

	#initPromise: Promise<void> | null = null;
	#running = false;
	#visible = false;
	#disposed = false;
	#lastLightLevel: number | undefined;

	constructor(getLightLevel?: () => number) {
		this.getLightLevel = getLightLevel;

		const container = document.createElement("div");
		container.className = "player-preview-panel";

		const canvas = document.createElement("canvas");
		canvas.className = "player-preview-canvas";
		canvas.width = PREVIEW_SIZE.width;
		canvas.height = PREVIEW_SIZE.height;

		container.appendChild(canvas);

		this.container = container;
		this.canvas = canvas;
	}

	/** Show and lazily initialize the preview. Safe to call repeatedly. */
	show(): void {
		if (this.#disposed) return;

		this.#visible = true;

		void this.#ensureInit()
			.then(() => {
				/*
				 * hide() may have been called while initialization was still
				 * awaiting engine creation, asset loading, or registration.
				 */
				if (!this.#disposed && this.#visible) {
					this.#start();
				}
			})
			.catch((error: unknown) => {
				if (!this.#disposed) {
					console.error("PlayerPreview unavailable:", error);
				}
			});
	}

	/** Pause rendering while the inventory is closed. */
	hide(): void {
		this.#visible = false;

		const engine = this.#engine;
		if (!engine || !this.#running) return;

		this.#running = false;
		stopEngine(engine);
	}

	dispose(): void {
		if (this.#disposed) return;

		this.#disposed = true;
		this.#visible = false;

		const engine = this.#engine;
		if (engine && this.#running) {
			this.#running = false;
			stopEngine(engine);
		}

		this.#releaseOwnedResources();
		this.#initPromise = null;
		this.getLightLevel = undefined;
		this.#lastLightLevel = undefined;

		this.container.remove();
	}

	#ensureInit(): Promise<void> {
		if (this.#disposed) {
			return Promise.reject(
				new Error("Cannot initialize a disposed PlayerPreview."),
			);
		}

		const existingPromise = this.#initPromise;
		if (existingPromise) {
			return existingPromise;
		}

		const initPromise = this.#init();
		this.#initPromise = initPromise;

		void initPromise.catch(() => {
			/*
			 * Only clear the promise if it still belongs to this attempt.
			 * This permits retrying after a transient initialization failure.
			 */
			if (!this.#disposed && this.#initPromise === initPromise) {
				this.#initPromise = null;
			}
		});

		return initPromise;
	}

	async #init(): Promise<void> {
		const engine = await createEngine(this.canvas, {});
		enableSurfaceResizeObserver(engine);

		if (this.#disposed) {
			disposeEngine(engine);
			return;
		}

		const scene = createSceneContext(engine, {
			defaultRenderTask: true,
		});

		scene.clearColor = PREVIEW_CLEAR_COLOR;

		this.#engine = engine;
		this.#scene = scene;

		const model = createPlayerRigMesh(engine, "playerPreviewRig");
		const rigMat = createRigShaderMaterial("playerPreviewRigMat");

		model.material = rigMat;
		model.pickable = false;
		model.visible = false;

		addToScene(scene, model);

		this.#model = model;
		this.#rigMat = rigMat;

		applyRigSkin(
			engine,
			rigMat,
			() => {
				if (!this.#disposed && this.#model === model) {
					model.visible = true;
				}
			},
			() => !this.#disposed && this.#model === model,
		);

		const floor = this.#createFloor(engine, scene);
		this.#createNameTag(engine, scene);

		const camera = createArcRotateCamera(0.85, 1.25, 3, vec3(0, 1, 0));

		addToScene(scene, camera);
		scene.camera = camera;

		onBeforeRender(scene, (deltaMs) => {
			const currentModel = this.#model;
			if (currentModel) {
				currentModel.rotation.y += deltaMs * SPIN_SPEED_PER_MS;
			}

			this.#updateLight();
		});

		/*
		 * Apply lighting before the first frame so neither material briefly
		 * renders with the shader's default tint.
		 */
		this.#updateLight(true);

		if (this.#disposed) {
			this.#disposeInitialization(engine, scene, model, floor);
			return;
		}

		await registerScene(scene);

		if (this.#disposed) {
			this.#disposeInitialization(engine, scene, model, floor);
		}
	}

	#createFloor(engine: EngineContext, scene: SceneContext): Mesh {
		const tile = getAtlasTile(BlockType.Cobble);
		const tileX = PlayerPreview.#clampAtlasCoordinate(tile?.[0] ?? 0);
		const tileY = PlayerPreview.#clampAtlasCoordinate(tile?.[1] ?? 0);
		const atlasRow = atlasSize - 1 - tileY;

		const u0 = tileX * atlasTileSize;
		const u1 = u0 + atlasTileSize;
		const vLow = atlasRow * atlasTileSize;
		const vHigh = vLow + atlasTileSize;

		const floorData = buildFloorSlabData(1, [u0, vLow, u1, vHigh]);

		const floor = createMeshFromData(
			engine,
			"playerPreviewFloor",
			floorData.positions,
			floorData.normals,
			floorData.indices,
			floorData.uvs,
		);

		const floorMat = createRigShaderMaterial("playerPreviewFloorMat");

		setShaderTexture(floorMat, "diffuseTexture", getRigFallbackTexture(engine));

		floor.material = floorMat;
		floor.pickable = false;

		addToScene(scene, floor);

		this.#floor = floor;
		this.#floorMat = floorMat;

		void loadTexture2D(engine, ATLAS_TEXTURE_PATH, {
			magFilter: "nearest",
			minFilter: "nearest",
		})
			.then((texture) => {
				if (
					this.#disposed ||
					this.#engine !== engine ||
					this.#floorMat !== floorMat
				) {
					return;
				}

				setShaderTexture(floorMat, "diffuseTexture", texture);
			})
			.catch(() => {
				/*
				 * Keep the fallback texture when atlas loading fails.
				 */
			});

		return floor;
	}

	#createNameTag(engine: EngineContext, scene: SceneContext): void {
		const nameTag = rasteriseNameTag(getPlayerName(), 0.575);
		const nameTagWidthWorld =
			NAME_TAG_HEIGHT_WORLD * (nameTag.width / nameTag.height);

		const texture = createDynamicTexture(
			engine,
			nameTag.width,
			nameTag.height,
			{
				magFilter: "nearest",
				minFilter: "nearest",
			},
		);

		updateDynamicTexture(engine, texture, nameTag.canvas, {
			invertY: false,
		});

		const atlas = createGridSpriteAtlas(texture, {
			cellWidthPx: nameTag.width,
			cellHeightPx: nameTag.height,
		});

		const billboard = createFacingBillboardSystem(atlas, {
			capacity: 1,
			blendMode: billboardBlendAlpha,
		});

		addFacingBillboardSystem(scene, billboard);

		addBillboardSpriteIndex(billboard, {
			position: [0, PLAYER_MODEL_HEIGHT + 0.2, 0],
			sizeWorld: [nameTagWidthWorld, NAME_TAG_HEIGHT_WORLD],
			color: [0.37, 0.37, 0.25, 1],
		});
	}

	#updateLight(force = false): void {
		const getLightLevel = this.getLightLevel;
		if (!getLightLevel) return;

		const packedLight = getLightLevel();

		if (!force && packedLight === this.#lastLightLevel) {
			return;
		}

		this.#lastLightLevel = packedLight;

		const color = packedLightToLightColor(packedLight);
		const rigMat = this.#rigMat;
		const floorMat = this.#floorMat;

		if (rigMat) {
			setRigLightColor(rigMat, color);
		}

		if (floorMat) {
			setRigLightColor(floorMat, color);
		}
	}

	#start(): void {
		const engine = this.#engine;

		if (this.#disposed || !this.#visible || !engine || this.#running) {
			return;
		}

		this.#running = true;

		void startEngine(engine).catch((error: unknown) => {
			if (this.#engine === engine) {
				this.#running = false;
			}

			if (!this.#disposed) {
				console.error("PlayerPreview could not start:", error);
			}
		});
	}

	#releaseOwnedResources(): void {
		const model = this.#model;
		const floor = this.#floor;
		const scene = this.#scene;
		const engine = this.#engine;

		/*
		 * Clear state first so late asynchronous callbacks cannot observe
		 * resources while they are being destroyed.
		 */
		this.#model = null;
		this.#floor = null;
		this.#rigMat = null;
		this.#floorMat = null;
		this.#scene = null;
		this.#engine = null;

		if (model) disposeMeshGpu(model);
		if (floor) disposeMeshGpu(floor);
		if (scene) disposeScene(scene);
		if (engine) disposeEngine(engine);
	}

	#disposeInitialization(
		engine: EngineContext,
		scene: SceneContext,
		model: Mesh,
		floor: Mesh,
	): void {
		/*
		 * Dispose only resources still owned by this initialization attempt.
		 * dispose() may already have cleared and destroyed some or all of them.
		 */
		if (this.#model === model) {
			this.#model = null;
			disposeMeshGpu(model);
		}

		if (this.#floor === floor) {
			this.#floor = null;
			disposeMeshGpu(floor);
		}

		if (this.#scene === scene) {
			this.#scene = null;
			disposeScene(scene);
		}

		if (this.#engine === engine) {
			this.#engine = null;
			disposeEngine(engine);
		}

		this.#rigMat = null;
		this.#floorMat = null;
	}

	static #clampAtlasCoordinate(value: number): number {
		return Math.min(Math.max(value, 0), atlasSize - 1);
	}
}
