import {
  Color3,
  Mesh,
  ShaderMaterial,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";
import { AdvancedBoat } from "../Entities/AdvancedBoat";
import { Player } from "../Player/Player";
import { TextureAtlasFactory } from "../World/Texture/TextureAtlasFactory";
import { ChunkMesher } from "../World/Chunk/ChunckMesher";
import { GlobalValues } from "../World/GlobalValues";
import { TextureDefinitions } from "../World/Texture/TextureDefinitions";
import { GenerationParams } from "../World/Generation/NoiseAndParameters/GenerationParams";
import { SettingParams } from "../World/SettingParams";
import { WorldStorage } from "../World/WorldStorage";
import { PlayerLoadingGate } from "../Player/PlayerLoadingGate";
import { PlayerStatePersistence } from "../Player/PlayerStatePersistence";
import { WorldEnvironment } from "./WorldEnvironment";
import { BlockBreakParticles } from "./BlockBreakParticles";

export class Map1 {
  public static mainScene: Scene;
  public static environment: WorldEnvironment;
  #player: Player;
  #playerStatePersistence: PlayerStatePersistence | null = null;
  #playerLoadingGate: PlayerLoadingGate | null = null;

  public readonly initPromise: Promise<void>;

  constructor(scene: Scene, player: Player) {
    this.#player = player;
    Map1.mainScene = this.CreateScene(scene);
    Map1.environment = new WorldEnvironment(Map1.mainScene);
    Map1.initCrackingMesh();
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
      ChunkMesher.initAtlas();
    });

    scene.onBeforeRenderObservable.add(() => {
      Map1.environment.update();
      ChunkMesher.updateGlobalUniforms(scene.getFrameId());
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
    this.mainScene.meshes.forEach((mesh) => {
      if (
        mesh.material instanceof ShaderMaterial &&
        mesh.name.startsWith("c_")
      ) {
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

  private CreateScene(scene: Scene): Scene {
    new AdvancedBoat(
      scene,
      this.#player, // Note: #player is used here before it's fully constructed if we pass it to Player constructor
      GenerationParams.SEA_LEVEL + 0.5,
    );

    return scene;
  }

  async loadTextures(): Promise<void> {
    if (GlobalValues.CREATE_ATLAS) {
      await TextureAtlasFactory.buildAtlas(Map1.mainScene, TextureDefinitions);
      const atlas = TextureAtlasFactory.getDiffuse();
      if (atlas) {
        BlockBreakParticles.setAtlasTexture(atlas);
      }
    }
  }

  static #crackingMesh: Mesh | null = null;
  static #crackMaterials: StandardMaterial[] = [];

  public static updateCrackingState(
    block: { x: number; y: number; z: number } | null,
    progress: number,
  ) {
    if (!block || progress <= 0) {
      if (this.#crackingMesh) this.#crackingMesh.isVisible = false;
      return;
    }

    if (this.#crackingMesh) {
      this.#crackingMesh.isVisible = true;
      this.#crackingMesh.position.set(
        Math.floor(block.x) + 0.5,
        Math.floor(block.y) + 0.5,
        Math.floor(block.z) + 0.5,
      );

      const stage = Math.min(9, Math.floor(progress * 10));
      if (this.#crackMaterials[stage]) {
        this.#crackingMesh.material = this.#crackMaterials[stage];
      }
    }
  }

  private static initCrackingMesh() {
    this.#crackingMesh = MeshBuilder.CreateBox(
      "crackingMesh",
      { size: 1.02 },
      this.mainScene,
    );
    this.#crackingMesh.isPickable = false;
    this.#crackingMesh.isVisible = false;
    this.#crackingMesh.renderingGroupId = 1;

    for (let i = 0; i < 10; i++) {
      const mat = new StandardMaterial(`crackMat${i}`, this.mainScene);
      mat.diffuseColor = new Color3(
        SettingParams.HIGHLIGHT_COLOR[0],
        SettingParams.HIGHLIGHT_COLOR[1],
        SettingParams.HIGHLIGHT_COLOR[2],
      );
      mat.alpha = 0.1 + (i / 9) * 0.6;
      mat.backFaceCulling = false;
      mat.disableLighting = true;
      mat.zOffset = -1;
      this.#crackMaterials.push(mat);
    }
  }
}
