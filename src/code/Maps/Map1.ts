import { type Observer, type Scene, ShaderMaterial } from "@babylonjs/core";
import type { MobRegistry } from "../Entities/Mobs/Mob";
import { createMobCoordinator } from "../Entities/Mobs/MobSetup";
import { NeutralMob } from "../Entities/Mobs/NeutralMob";
import type { SpawnCoordinator } from "../Entities/SpawnCoordinator";
import { setSceneAccessor, setGameTimeScale } from "../Shared/GameRuntimeState";
import {
	dispose as disposeDistantTerrain,
	init as initDistantTerrain,
} from "../Generation/DistantTerrain/DistantTerrain";
import {
	disposeBlockBreakingVisuals,
	initializeBlockBreakingVisuals,
} from "../Player/Hud/BlockHighlight/BlockBreakingVisuals";
import { DroppedItem } from "../Player/Inventory/DroppedItem";
import type { Player } from "../Player/Player";
import { PlayerLoadingGate } from "../Player/PlayerLoadingGate";
import { PlayerStatePersistence } from "../Player/PlayerStatePersistence";
import { disposeSharedResources, initAtlas } from "../World/Chunk/ChunkMesher";
import { MaterialFactory } from "../World/Texture/MaterialFactory";
import { WorldStorage } from "../World/WorldStorage";
import { WorldEnvironment } from "./WorldEnvironment";

export class Map1 {
	public static mainScene: Scene;
	public static environment: WorldEnvironment;
	public static mobRegistry: MobRegistry | null = null;

	#player: Player;
	#playerStatePersistence: PlayerStatePersistence | null = null;
	#playerLoadingGate: PlayerLoadingGate | null = null;
	#spawnCoordinator: SpawnCoordinator | null = null;
	#renderObs: Observer<Scene> | null = null;

	public readonly initPromise: Promise<void>;

	constructor(scene: Scene, player: Player) {
		this.#player = player;
		Map1.mainScene = scene;
		setSceneAccessor(() => scene);

		initializeBlockBreakingVisuals(scene);

		Map1.mainScene.skipPointerMovePicking = true;
		Map1.environment = new WorldEnvironment(Map1.mainScene);

		this.#playerStatePersistence = new PlayerStatePersistence(
			Map1.mainScene,
			this.#player,
		);

		Map1.mainScene.onDisposeObservable.add(() => {
			if (this.#renderObs) {
				Map1.mainScene.onBeforeRenderObservable.remove(this.#renderObs);
				this.#renderObs = null;
			}
			this.#spawnCoordinator?.dispose();
			this.#spawnCoordinator = null;

			this.#playerStatePersistence?.dispose();
			this.#playerStatePersistence = null;

			this.#playerLoadingGate?.dispose();
			this.#playerLoadingGate = null;

			DroppedItem.disposeAll();
			DroppedItem.disposeTileTextures();
			NeutralMob.disposeAll();
			Map1.environment?.dispose();
			MaterialFactory.disposeAll();
			this.#player.dispose();

			disposeBlockBreakingVisuals();
			disposeSharedResources();
			disposeDistantTerrain();
		});

		this.initPromise = this.asyncInit().then(() => {
			WorldStorage.initialize();
		});

		this.#renderObs = scene.onBeforeRenderObservable.add(() => {
			Map1.environment.update();
			this.#playerStatePersistence?.update();
		});
	}

	async asyncInit() {
		if (!Map1.mainScene.activeCamera) return;

		try {
			await initAtlas();
			// 2. Now safe to construct DistantTerrain (atlas is ready)
			initDistantTerrain();

			// 3. Start chunk streaming — PlayerLoadingGate calls updateChunksAround
			//    which calls distant terrain's update(), so it must come
			//    after step 2.
			this.#playerLoadingGate = new PlayerLoadingGate(
				Map1.mainScene,
				this.#player,
			);

			// 4. Register mob types and start spawning
			this.#spawnCoordinator = createMobCoordinator(
				Map1.mainScene,
				() => this.#player.position,
			);

			Map1.environment.initSSAO();
		} catch (error) {
			console.error("Error loading environment or textures:", error);
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
		setGameTimeScale(v);
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
