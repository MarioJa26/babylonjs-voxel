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

const PREVIEW_SIZE = { width: 220, height: 320 };
const SPIN_SPEED = Math.PI / 3.0; // rad/s
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
	#rigMat: ShaderMaterial | null = null;
	#floor: Mesh | null = null;
	#floorMat: ShaderMaterial | null = null;
	#initPromise: Promise<void> | null = null;
	#running = false;
	#alive = false;

	constructor(getLightLevel?: () => number) {
		// getLightLevel returns PACKED voxel light (sky << 4 | block), as
		// returned by ChunkLoadingSystem.getLightByWorldCoords.
		this.#getLightLevel = getLightLevel;

		this.container = document.createElement("div");
		this.container.className = "player-preview-panel";

		// Player name above the model, Minecraft-inventory style.
		const name = document.createElement("div");
		name.className = "player-preview-name";
		name.textContent = getPlayerName().trim() || "Steve";
		this.container.appendChild(name);

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
		this.#rigMat = null;
		this.#floorMat = null;
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

		// No scene lights needed: rig + floor both use the unlit textured
		// ShaderMaterial tinted by the voxel-light color (see below), so the
		// block under the model is colored EXACTLY like the model itself.

		// Character rig (single merged mesh so it rotates as one piece).
		const mesh = createPlayerRigMesh(engine, "playerPreviewRig");
		const mat = createRigShaderMaterial("playerPreviewRigMat");
		mesh.material = mat;
		mesh.pickable = false;
		// DroppedItem pattern: stay hidden until the texture is bound —
		// drawing with an unbound sampler invalidates the render pass.
		mesh.visible = false;
		addToScene(scene, mesh);

		this.#model = mesh;
		this.#rigMat = mat;
		this.#engine = engine;
		this.#scene = scene;

		applyRigSkin(
			engine,
			mat,
			() => {
				if (this.#alive) mesh.visible = true;
			},
			() => this.#alive,
		);

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

		const floorData = buildFloorSlabData(1.0, [u0, vLow, u1, vHigh]);
		const floor = createMeshFromData(
			engine,
			"playerPreviewFloor",
			floorData.positions,
			floorData.normals,
			floorData.indices,
			floorData.uvs,
		);
		// Same unlit rig shader as the model — its UVs are final atlas coords
		// (buildFloorSlabData "atlas" mode), so one material swap makes the
		// slab share the model's exact voxel-light tint.
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
			.then((tex) => {
				if (!this.#alive || !this.#floorMat) return;
				setShaderTexture(this.#floorMat, "diffuseTexture", tex);
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
			if (this.#getLightLevel) {
				// Match the in-world rig lighting: colored sky/torch mix from
				// packed voxel light (sky << 4 | block). Applied to BOTH the
				// model and the floor slab so they share one exact color.
				const color = packedLightToLightColor(this.#getLightLevel());
				if (this.#rigMat) setRigLightColor(this.#rigMat, color);
				if (this.#floorMat) setRigLightColor(this.#floorMat, color);
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
