import { type Scene, ShaderMaterial } from "@babylonjs/core";
import { DistantTerrain } from "../Generation/DistantTerrain/DistantTerrain";
import {
	disposeBlockBreakingVisuals,
	initializeBlockBreakingVisuals,
} from "../Player/Hud/BlockHighlight/BlockBreakingVisuals";
import type { Player } from "../Player/Player";
import { PlayerLoadingGate } from "../Player/PlayerLoadingGate";
import { PlayerStatePersistence } from "../Player/PlayerStatePersistence";
import { disposeSharedResources, initAtlas } from "../World/Chunk/ChunckMesher";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
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
		Map1.mainScene = scene;

		initializeBlockBreakingVisuals(scene);

		Map1.mainScene.skipPointerMovePicking = true;
		Map1.environment = new WorldEnvironment(Map1.mainScene);

		this.#playerStatePersistence = new PlayerStatePersistence(
			Map1.mainScene,
			this.#player,
		);

		Map1.mainScene.onDisposeObservable.add(() => {
			this.#playerStatePersistence?.dispose();
			this.#playerStatePersistence = null;

			this.#playerLoadingGate?.dispose();
			this.#playerLoadingGate = null;

			disposeBlockBreakingVisuals();
			disposeSharedResources();
			DistantTerrain.resetInstance();
			console.log("Map1 disposed and resources cleaned up.");
		});

		this.initPromise = this.asyncInit().then(() => {
			WorldStorage.initialize();
		});

		scene.onBeforeRenderObservable.add(() => {
			Map1.environment.update();
			this.#playerStatePersistence?.update();
		});
	}

	async asyncInit() {
		if (!Map1.mainScene.activeCamera) return;

		try {
			// 1. Build atlas first — DistantTerrain constructor needs it
			await this.loadTextures();
			await initAtlas();
			// 2. Now safe to construct DistantTerrain (atlas is ready)
			DistantTerrain.getInstance();

			// 3. Start chunk streaming — PlayerLoadingGate calls updateChunksAround
			//    which calls DistantTerrain.getInstance().update(), so it must come
			//    after step 2.
			this.#playerLoadingGate = new PlayerLoadingGate(
				Map1.mainScene,
				this.#player,
			);

			Map1.environment.initSSAO();
			console.log("Environment and textures loaded successfully.");
		} catch (error) {
			console.error("Error loading environment or textures:", error);
		}
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
}
