import {
	Color3,
	Mesh,
	MeshBuilder,
	type Scene,
	ShaderMaterial,
	StandardMaterial,
} from "@babylonjs/core";
import type { Player } from "../Player/Player";
import { PlayerLoadingGate } from "../Player/PlayerLoadingGate";
import { PlayerStatePersistence } from "../Player/PlayerStatePersistence";
import { initAtlas } from "../World/Chunk/ChunckMesher";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";
import { getTransformedShapeBoxes } from "../World/Shape/BlockShapeTransforms";
import { TextureAtlasFactory } from "../World/Texture/TextureAtlasFactory";
import { TextureDefinitions } from "../World/Texture/TextureDefinitions";
import { WorldStorage } from "../World/WorldStorage";
import { BlockBreakParticles } from "./BlockBreakParticles";
import { WorldEnvironment } from "./WorldEnvironment";

export class Map1 {
	public static mainScene: Scene;
	public static environment: WorldEnvironment;
	#player: Player;
	#playerStatePersistence: PlayerStatePersistence | null = null;
	#playerLoadingGate: PlayerLoadingGate | null = null;

	public readonly initPromise: Promise<void>;

	constructor(scene: Scene, player: Player) {
		this.#player = player;
		Map1.initCrackingMesh();
		Map1.mainScene = scene;
		Map1.mainScene.skipPointerMovePicking = true;
		Map1.environment = new WorldEnvironment(Map1.mainScene);

		this.#playerStatePersistence = new PlayerStatePersistence(
			Map1.mainScene,
			this.#player,
		);
		this.#playerLoadingGate = new PlayerLoadingGate(
			Map1.mainScene,
			this.#player,
		);

		Map1.mainScene.onDisposeObservable.add(() => {
			this.#playerStatePersistence?.dispose();
			this.#playerStatePersistence = null;
			this.#playerLoadingGate?.dispose();
			this.#playerLoadingGate = null;
		});

		this.initPromise = this.asyncInit().then(async () => {
			WorldStorage.initialize();
			initAtlas();
		});

		scene.onBeforeRenderObservable.add(() => {
			Map1.environment.update();
			this.#playerStatePersistence?.update();
		});
	}

	async asyncInit() {
		if (!Map1.mainScene.activeCamera) return;
		try {
			await this.loadTextures();
			Map1.environment.initSSAO();
			console.log("Environment and textures loaded successfully.");
		} catch (error) {
			console.error("Error loading environment or textures:", error);
		}
	}

	/**
	 * Sets the time of day.
	 * @param time A value between 0 (start of day) and 1 (end of day).
	 */
	public static setTime(time: number): void {
		if (Map1.environment) {
			Map1.environment.setTime(time);
		}
	}

	public static get timeScale() {
		return Map1.environment ? Map1.environment.timeScale : 0;
	}
	public static set timeScale(v: number) {
		if (Map1.environment) Map1.environment.timeScale = v;
	}

	public static get isPaused() {
		return Map1.environment ? Map1.environment.isPaused : false;
	}
	public static set isPaused(v: boolean) {
		if (Map1.environment) Map1.environment.isPaused = v;
	}

	public static setDebug(enabled: boolean) {
		const chunkMaterials = new Set<ShaderMaterial>();
		Map1.mainScene.meshes.forEach((mesh) => {
			if (mesh.material instanceof ShaderMaterial) {
				chunkMaterials.add(mesh.material);
			}
		});

		chunkMaterials.forEach((material) => {
			const wasFrozen = material.isFrozen;
			if (wasFrozen) material.unfreeze();
			material.wireframe = enabled;
			if (wasFrozen) material.freeze();
		});
	}

	async loadTextures(): Promise<void> {
		if (GLOBAL_VALUES.CREATE_ATLAS) {
			await TextureAtlasFactory.buildAtlas(Map1.mainScene, TextureDefinitions);
			const atlas = TextureAtlasFactory.getDiffuse();
			if (atlas) {
				BlockBreakParticles.setAtlasTexture(atlas);
			}
		}
	}

	static #crackingMesh: Mesh | null = null;
	static #crackMaterials: StandardMaterial[] = [];
	static #crackingShapeKey = "";

	public static updateCrackingState(
		block: { x: number; y: number; z: number } | null,
		progress: number,
		blockId?: number,
		blockState = 0,
	) {
		if (!block || progress <= 0) {
			if (Map1.#crackingMesh) Map1.#crackingMesh.isVisible = false;
			return;
		}

		if (Map1.#crackingMesh) {
			if (typeof blockId === "number") {
				Map1.#ensureCrackingShape(blockId, blockState);
			}
			Map1.#crackingMesh.isVisible = true;
			Map1.#crackingMesh.position.set(
				Math.floor(block.x),
				Math.floor(block.y),
				Math.floor(block.z),
			);

			const stage = Math.min(9, Math.floor(progress * 10));
			if (Map1.#crackMaterials[stage]) {
				Map1.#crackingMesh.material = Map1.#crackMaterials[stage];
			}
		}
	}

	private static async initCrackingMesh() {
		Map1.#crackingMesh = Map1.#createUnitCrackingMesh();
		Map1.#crackingMesh.isPickable = false;
		Map1.#crackingMesh.isVisible = false;
		Map1.#crackingMesh.renderingGroupId = 1;

		for (let i = 0; i < 10; i++) {
			const mat = new StandardMaterial(`crackMat${i}`, Map1.mainScene);
			mat.diffuseColor = new Color3(
				SETTING_PARAMS.HIGHLIGHT_COLOR[0],
				SETTING_PARAMS.HIGHLIGHT_COLOR[1],
				SETTING_PARAMS.HIGHLIGHT_COLOR[2],
			);
			mat.alpha = 0.1 + (i / 9) * 0.6;
			mat.backFaceCulling = false;
			mat.disableLighting = true;
			mat.zOffset = -1;
			Map1.#crackMaterials.push(mat);
		}
	}

	static #createUnitCrackingMesh(): Mesh {
		const mesh = MeshBuilder.CreateBox(
			"crackingMeshUnitCube",
			{ size: 1.04 },
			Map1.mainScene,
		);
		mesh.position.set(0.5, 0.5, 0.5);
		Map1.#bakeLocalOffset(mesh);
		return mesh;
	}

	static #bakeLocalOffset(mesh: Mesh): void {
		mesh.bakeCurrentTransformIntoVertices();
		mesh.position.set(0, 0, 0);
	}

	static #buildCrackingMeshForBlock(blockId: number, blockState: number): Mesh {
		const inflation = 0.04;
		const parts: Mesh[] = [];
		let index = 0;

		for (const box of getTransformedShapeBoxes(blockId, blockState)) {
			const width = box.max[0] - box.min[0];
			const height = box.max[1] - box.min[1];
			const depth = box.max[2] - box.min[2];
			if (width <= 0 || height <= 0 || depth <= 0) continue;

			const part = MeshBuilder.CreateBox(
				`crackingMeshPart_${index++}`,
				{
					width: width + inflation,
					height: height + inflation,
					depth: depth + inflation,
				},
				Map1.mainScene,
			);
			part.position.set(
				(box.min[0] + box.max[0]) * 0.5,
				(box.min[1] + box.max[1]) * 0.5,
				(box.min[2] + box.max[2]) * 0.5,
			);
			Map1.#bakeLocalOffset(part);
			parts.push(part);
		}

		if (parts.length === 0) {
			return Map1.#createUnitCrackingMesh();
		}

		if (parts.length === 1) {
			return parts[0];
		}

		const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
		if (!merged || !(merged instanceof Mesh)) {
			const fallback = parts[0];
			for (let i = 1; i < parts.length; i++) parts[i].dispose();
			return fallback;
		}

		return merged;
	}

	static #ensureCrackingShape(blockId: number, blockState: number) {
		const shapeKey = `${blockId}:${blockState}`;
		if (shapeKey === Map1.#crackingShapeKey) return;
		if (!Map1.#crackingMesh) return;

		const oldMesh = Map1.#crackingMesh;
		const newMesh = Map1.#buildCrackingMeshForBlock(blockId, blockState);
		newMesh.position.copyFrom(oldMesh.position);
		newMesh.isPickable = false;
		newMesh.isVisible = oldMesh.isVisible;
		newMesh.renderingGroupId = oldMesh.renderingGroupId;
		newMesh.material = oldMesh.material;
		Map1.#crackingMesh = newMesh;
		Map1.#crackingShapeKey = shapeKey;
		oldMesh.dispose();
	}
}
