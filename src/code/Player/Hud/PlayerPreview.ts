import {
	addToScene,
	createArcRotateCamera,
	createDirectionalLight,
	createEngine,
	createHemisphericLight,
	createMeshFromData,
	createSceneContext,
	createStandardMaterial,
	disposeEngine,
	disposeMeshGpu,
	disposeScene,
	type EngineContext,
	loadTexture2D,
	type Mesh,
	onBeforeRender,
	rebuildMaterial,
	registerScene,
	type SceneContext,
	startEngine,
	stopEngine,
	vec3,
} from "@babylonjs/lite";
import { getAtlasTile } from "@/code/World/Texture/BlockTextures";
import { BlockType } from "@/code/World/Texture/BlockType";
import {
	atlasSize,
	atlasTileSize,
} from "@/code/World/Texture/TextureAtlasFactory";
import {
	applyPlayerSkin,
	buildFloorSlabData,
	createPlayerRigMesh,
} from "../PlayerModel";

const PREVIEW_SIZE = { width: 220, height: 300 };
const SPIN_SPEED = Math.PI / 2.5; // rad/s
const ATLAS_TEXTURE_PATH = "/texture/diffuse_atlas.png";

/** Equipment slot ids shown beside/below the character, Minecraft-style. */
const ARMOR_SLOT_LABELS: readonly [string, string][] = [
	["head", "Helmet"],
	["chest", "Chestplate"],
	["legs", "Leggings"],
	["feet", "Boots"],
];

const ACCESSORY_SLOT_LABELS: readonly [string, string][] = [
	["necklace", "Necklace"],
	["ring1", "Ring"],
	["ring2", "Ring"],
];

/**
 * Small standalone render surface showing a Minecraft-style player model
 * inside the inventory screen. Uses its own tiny engine on a dedicated
 * canvas; the engine only runs while the inventory is open. Lighting
 * follows the voxel light level at the player's position (when supplied).
 */
export class PlayerPreview {
	readonly container: HTMLDivElement;

	#canvas: HTMLCanvasElement;
	#getLightLevel?: () => number;

	#engine: EngineContext | null = null;
	#scene: SceneContext | null = null;
	#model: Mesh | null = null;
	#floor: Mesh | null = null;
	#initPromise: Promise<void> | null = null;
	#running = false;
	#alive = false;

	constructor(getLightLevel?: () => number) {
		// getLightLevel returns PACKED voxel light (sky << 4 | block), as
		// returned by ChunkLoadingSystem.getLightByWorldCoords.
		this.#getLightLevel = getLightLevel;

		this.container = document.createElement("div");
		this.container.className = "player-preview-panel";

		const body = document.createElement("div");
		body.className = "preview-body";

		this.#canvas = document.createElement("canvas");
		this.#canvas.className = "player-preview-canvas";
		this.#canvas.width = PREVIEW_SIZE.width;
		this.#canvas.height = PREVIEW_SIZE.height;
		body.appendChild(this.#canvas);

		const armorStrip = document.createElement("div");
		armorStrip.className = "equipment-slots";
		for (const [id, label] of ARMOR_SLOT_LABELS) {
			armorStrip.appendChild(PlayerPreview.#createEquipSlot(id, label));
		}
		body.appendChild(armorStrip);

		const accessories = document.createElement("div");
		accessories.className = "accessory-slots";
		for (const [id, label] of ACCESSORY_SLOT_LABELS) {
			accessories.appendChild(PlayerPreview.#createEquipSlot(id, label));
		}

		this.container.appendChild(body);
		this.container.appendChild(accessories);
	}

	static #createEquipSlot(id: string, label: string): HTMLDivElement {
		const slot = document.createElement("div");
		slot.className = "equip-slot";
		slot.dataset.slot = id;
		slot.dataset.label = label.charAt(0);
		slot.title = label;
		return slot;
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
		this.#alive = false;

		if (this.#model) disposeMeshGpu(this.#model);
		if (this.#floor) disposeMeshGpu(this.#floor);
		if (this.#scene) disposeScene(this.#scene);
		if (this.#engine) disposeEngine(this.#engine);

		this.#model = null;
		this.#floor = null;
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
		this.#alive = true;

		// Explicit dark clear so "nothing drawn" is never mistaken for white.
		scene.clearColor = { r: 0.04, g: 0.055, b: 0.07, a: 1 };

		// Lights — hemispheric keeps every surface readable, directional adds
		// shape. Kept modest: combined intensity above ~1 washes the skin out.
		const hemi = createHemisphericLight([0, 1, 0], 0.55);
		addToScene(scene, hemi);
		addToScene(scene, createDirectionalLight([-0.45, -1, -0.35], 0.5));

		// Character rig (single merged mesh so it rotates as one piece).
		const mesh = createPlayerRigMesh(engine, "playerPreviewRig");
		const mat = createStandardMaterial();
		mat.specularColor = [0, 0, 0];
		// The rig's winding comes from the game's custom-shader box builder;
		// disable culling so it can never be culled inside-out here.
		mat.backFaceCulling = false;
		mesh.material = mat;
		mesh.pickable = false;
		addToScene(scene, mesh);

		this.#model = mesh;
		this.#engine = engine;
		this.#scene = scene;

		applyPlayerSkin(engine, scene, mat, () => this.#alive);

		// Floor slab (top surface at feet level) — textured from the SAME
		// diffuse atlas the chunk shader uses, sampling exactly one Cobble
		// tile so it reads as a real block face. Gray until it loads.
		const tile = getAtlasTile(BlockType.Cobble) ?? [0, 0];
		const tx = Math.max(0, Math.min(atlasSize - 1, tile[0]));
		const ty = Math.max(0, Math.min(atlasSize - 1, tile[1]));
		const ts = atlasTileSize;
		const atlasRow = atlasSize - 1 - ty; // same v-flip as DroppedItem
		const u0 = tx * ts;
		const u1 = (tx + 1) * ts;
		const vLow = atlasRow * ts;
		const vHigh = (atlasRow + 1) * ts;

		const floorData = buildFloorSlabData(1.7, [u0, vHigh, u1, vLow]);
		const floor = createMeshFromData(
			engine,
			"playerPreviewFloor",
			floorData.positions,
			floorData.normals,
			floorData.indices,
			floorData.uvs,
		);
		const floorMat = createStandardMaterial();
		floorMat.diffuseColor = [0.6, 0.63, 0.66];
		floorMat.specularColor = [0, 0, 0];
		floorMat.backFaceCulling = false;
		floor.material = floorMat;
		floor.pickable = false;
		addToScene(scene, floor);
		this.#floor = floor;

		void loadTexture2D(engine, ATLAS_TEXTURE_PATH, {
			magFilter: "nearest",
			minFilter: "nearest",
			srgb: true,
		})
			.then((tex) => {
				if (!this.#alive) return;
				floorMat.diffuseTexture = tex;
				floorMat.diffuseColor = [1, 1, 1];
				rebuildMaterial(scene, floorMat);
			})
			.catch(() => {});

		// Deterministic framing of the whole rig — and it must actually become
		// the active camera, otherwise nothing renders at all.
		const camera = createArcRotateCamera(0.85, 1.25, 2.6, vec3(0, 0.8, 0));
		addToScene(scene, camera);
		scene.camera = camera;

		onBeforeRender(scene, (deltaMs) => {
			if (this.#model) {
				this.#model.rotation.y += (deltaMs / 1000) * SPIN_SPEED;
			}
			if (this.#getLightLevel && hemi) {
				// Decode packed voxel light (sky << 4 | block), same as the
				// dropped-item lighting in DroppedItem.
				const packed = this.#getLightLevel();
				const sky = ((packed >> 4) & 0xf) / 15;
				const block = (packed & 0xf) / 15;
				const level = Math.min(1, Math.max(sky, block));
				hemi.intensity = 0.35 + level * 0.55;
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
