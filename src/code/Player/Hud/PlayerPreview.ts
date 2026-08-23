import {
	addToScene,
	createArcRotateCamera,
	createEngine,
	createMeshFromData,
	createSceneContext,
	disposeEngine,
	disposeMeshGpu,
	disposeScene,
	type EngineContext,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	registerScene,
	type SceneContext,
	type ShaderMaterial,
	setShaderTexture,
	startEngine,
	stopEngine,
	vec3,
} from "@babylonjs/lite";
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
	packedLightToLightColor,
	setRigLightColor,
} from "../PlayerModel";

const PREVIEW_SIZE = { width: 220, height: 320 } as const;
const SPIN_SPEED = Math.PI / 3;
const ATLAS_TEXTURE_PATH = "/texture/diffuse_atlas.png";

const ARMOR_SLOT_LABELS: readonly (readonly [id: string, label: string])[] = [
	["head", "Helmet"],
	["chest", "Chestplate"],
	["legs", "Leggings"],
	["feet", "Boots"],
];

const ACCESSORY_SLOT_LABELS: readonly (readonly [id: string, label: string])[] =
	[
		["necklace", "Necklace"],
		["ring1", "Ring"],
		["ring2", "Ring"],
	];

/**
 * Small standalone render surface showing a Minecraft-style player model
 * inside the inventory screen. Uses its own engine on a dedicated canvas.
 * The engine only runs while the inventory is open.
 */
export class PlayerPreview {
	readonly container: HTMLDivElement;

	canvas: HTMLCanvasElement;
	getLightLevel?: () => number;

	#engine: EngineContext | null = null;
	#scene: SceneContext | null = null;
	#model: Mesh | null = null;
	#rigMat: ShaderMaterial | null = null;
	#floor: Mesh | null = null;
	#floorMat: ShaderMaterial | null = null;

	#initPromise: Promise<void> | null = null;
	#running = false;
	#disposed = false;

	/*
	 * Stores the last packed light value so shader uniforms are updated only
	 * when the player's voxel lighting actually changes.
	 */
	#lastLightLevel: number | undefined;

	constructor(getLightLevel?: () => number) {
		this.getLightLevel = getLightLevel;

		this.container = document.createElement("div");
		this.container.className = "player-preview-panel";

		const name = document.createElement("div");
		name.className = "player-preview-name";
		name.textContent = getPlayerName().trim() || "Player";

		const body = document.createElement("div");
		body.className = "preview-body";

		this.canvas = document.createElement("canvas");
		this.canvas.className = "player-preview-canvas";
		this.canvas.width = PREVIEW_SIZE.width;
		this.canvas.height = PREVIEW_SIZE.height;
		body.appendChild(this.canvas);

		const armorStrip = document.createElement("div");
		armorStrip.className = "equipment-slots";
		PlayerPreview.#appendEquipSlots(armorStrip, ARMOR_SLOT_LABELS);
		body.appendChild(armorStrip);

		const accessories = document.createElement("div");
		accessories.className = "accessory-slots";
		PlayerPreview.#appendEquipSlots(accessories, ACCESSORY_SLOT_LABELS);

		this.container.append(name, body, accessories);
	}

	static #appendEquipSlots(
		parent: HTMLElement,
		slots: readonly (readonly [id: string, label: string])[],
	): void {
		const fragment = document.createDocumentFragment();

		for (let i = 0; i < slots.length; i++) {
			const [id, label] = slots[i];
			fragment.appendChild(PlayerPreview.#createEquipSlot(id, label));
		}

		parent.appendChild(fragment);
	}

	static #createEquipSlot(id: string, label: string): HTMLDivElement {
		const slot = document.createElement("div");
		slot.className = "equip-slot";
		slot.dataset.slot = id;
		slot.dataset.label = label[0] ?? "";
		slot.title = label;
		return slot;
	}

	/** Show and lazily initialize the preview. Safe to call repeatedly. */
	show(): void {
		if (this.#disposed) return;

		void this.#ensureInit()
			.then(() => {
				if (!this.#disposed) {
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
		const engine = this.#engine;

		if (!engine || !this.#running) return;

		this.#running = false;
		stopEngine(engine);
	}

	dispose(): void {
		if (this.#disposed) return;

		this.#disposed = true;
		this.hide();

		const model = this.#model;
		const floor = this.#floor;
		const scene = this.#scene;
		const engine = this.#engine;

		/*
		 * Clear references before disposing GPU objects. This prevents late
		 * async callbacks from observing resources that are being destroyed.
		 */
		this.#model = null;
		this.#floor = null;
		this.#rigMat = null;
		this.#floorMat = null;
		this.#scene = null;
		this.#engine = null;
		this.#initPromise = null;
		this.getLightLevel = undefined;
		this.#lastLightLevel = undefined;

		if (model) disposeMeshGpu(model);
		if (floor) disposeMeshGpu(floor);
		if (scene) disposeScene(scene);
		if (engine) disposeEngine(engine);

		this.container.remove();
	}

	#ensureInit(): Promise<void> {
		if (this.#disposed) {
			return Promise.reject(
				new Error("Cannot initialize a disposed PlayerPreview."),
			);
		}

		if (!this.#initPromise) {
			this.#initPromise = this.#init().catch((error: unknown) => {
				/*
				 * Permit a later show() call to retry initialization after a
				 * transient engine or asset-loading failure.
				 */
				if (!this.#disposed) {
					this.#initPromise = null;
				}

				throw error;
			});
		}

		return this.#initPromise;
	}

	async #init(): Promise<void> {
		const engine = await createEngine(this.canvas, {});

		/*
		 * dispose() may run while createEngine() is awaiting.
		 */
		if (this.#disposed) {
			disposeEngine(engine);
			return;
		}

		const scene = createSceneContext(engine, {
			defaultRenderTask: true,
		});

		scene.clearColor = {
			r: 0.04,
			g: 0.055,
			b: 0.07,
			a: 1,
		};

		this.#engine = engine;
		this.#scene = scene;

		const mesh = createPlayerRigMesh(engine, "playerPreviewRig");
		const rigMat = createRigShaderMaterial("playerPreviewRigMat");

		mesh.material = rigMat;
		mesh.pickable = false;
		mesh.visible = false;

		addToScene(scene, mesh);

		this.#model = mesh;
		this.#rigMat = rigMat;

		applyRigSkin(
			engine,
			rigMat,
			() => {
				if (!this.#disposed && this.#model === mesh) {
					mesh.visible = true;
				}
			},
			() => !this.#disposed && this.#model === mesh,
		);

		const tile = getAtlasTile(BlockType.Cobble);
		const tileX = PlayerPreview.#clampAtlasCoordinate(tile?.[0] ?? 0);
		const tileY = PlayerPreview.#clampAtlasCoordinate(tile?.[1] ?? 0);
		const atlasRow = atlasSize - 1 - tileY;

		const u0 = tileX * atlasTileSize;
		const u1 = (tileX + 1) * atlasTileSize;
		const vLow = atlasRow * atlasTileSize;
		const vHigh = (atlasRow + 1) * atlasTileSize;

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
				 * The fallback texture remains bound if atlas loading fails.
				 */
			});

		const camera = createArcRotateCamera(0.85, 1.25, 2.6, vec3(0, 0.8, 0));

		addToScene(scene, camera);
		scene.camera = camera;

		onBeforeRender(scene, (deltaMs) => {
			const currentModel = this.#model;

			if (currentModel) {
				currentModel.rotation.y += deltaMs * 0.001 * SPIN_SPEED;
			}

			const getLightLevel = this.getLightLevel;
			if (!getLightLevel) return;

			const packedLight = getLightLevel();

			if (packedLight === this.#lastLightLevel) return;
			this.#lastLightLevel = packedLight;

			const color = packedLightToLightColor(packedLight);

			const currentRigMat = this.#rigMat;
			if (currentRigMat) {
				setRigLightColor(currentRigMat, color);
			}

			const currentFloorMat = this.#floorMat;
			if (currentFloorMat) {
				setRigLightColor(currentFloorMat, color);
			}
		});

		/*
		 * Apply the initial light immediately so the first rendered frame
		 * does not briefly use the shader's default tint.
		 */
		this.#updateLight();

		if (this.#disposed) {
			this.#disposeInitializedResources(engine, scene, mesh, floor);
			return;
		}

		await registerScene(scene);

		/*
		 * dispose() may also run while registerScene() is awaiting.
		 */
		if (this.#disposed) {
			this.#disposeInitializedResources(engine, scene, mesh, floor);
		}
	}

	#updateLight(): void {
		const getLightLevel = this.getLightLevel;
		if (!getLightLevel) return;

		const packedLight = getLightLevel();
		this.#lastLightLevel = packedLight;

		const color = packedLightToLightColor(packedLight);

		if (this.#rigMat) {
			setRigLightColor(this.#rigMat, color);
		}

		if (this.#floorMat) {
			setRigLightColor(this.#floorMat, color);
		}
	}

	#disposeInitializedResources(
		engine: EngineContext,
		scene: SceneContext,
		model: Mesh,
		floor: Mesh,
	): void {
		/*
		 * Only dispose resources still owned by this initialization attempt.
		 * Normal dispose() may already have cleared and destroyed them.
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

	#start(): void {
		const engine = this.#engine;

		if (this.#disposed || !engine || this.#running) return;

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

	static #clampAtlasCoordinate(value: number): number {
		if (value <= 0) return 0;
		if (value >= atlasSize - 1) return atlasSize - 1;
		return value;
	}
}
