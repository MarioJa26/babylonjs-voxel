import { Mesh, MeshBuilder, Scene, StandardMaterial } from "@babylonjs/core";
import { AdvancedBoat } from "../Entities/AdvancedBoat";
import { Player } from "../Player/Player";
import { TextureAtlasFactory } from "../World/Texture/TextureAtlasFactory";
import { ChunkMesher } from "../World/Chunk/ChunckMesher";
import { GlobalValues } from "../World/GlobalValues";
import { CrossHair } from "../Player/Hud/CrossHair";
import { TextureDefinitions } from "../World/Texture/TextureDefinitions";
import { GenerationParams } from "../World/Generation/NoiseAndParameters/GenerationParams";
import { SettingParams } from "../World/SettingParams";
import { WorldStorage } from "../World/WorldStorage";
import { WorldEnvironment } from "./WorldEnvironment";
export class Map1 {
  public static mainScene: Scene;
  public static environment: WorldEnvironment;
  #player: Player;
  #blockHighlightMesh!: Mesh;

  public readonly initPromise: Promise<void>;

  constructor(scene: Scene, player: Player) {
    this.#player = player;
    Map1.mainScene = this.CreateScene(scene);
    Map1.environment = new WorldEnvironment(Map1.mainScene);

    this.initPromise = this.asyncInit().then(async () => {
      WorldStorage.initialize();
      ChunkMesher.initAtlas();
    });

    scene.onBeforeRenderObservable.add(() => {
      this.updateBlockHighlight();
      Map1.environment.update();
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

  private updateBlockHighlight() {
    if (this.#player.playerVehicle instanceof AdvancedBoat) return;

    if (!this.#blockHighlightMesh) {
      // Create the highlight mesh if it doesn't exist
      this.#blockHighlightMesh = MeshBuilder.CreateBox(
        "blockHighlight",
        { size: 1.005 },
        Map1.mainScene,
      );
      this.#blockHighlightMesh.isPickable = false;
      this.#blockHighlightMesh.renderingGroupId = 1;

      // Create a transparent material for the box faces
      const highlightMaterial = new StandardMaterial(
        "highlightMat",
        Map1.mainScene,
      );
      highlightMaterial.alpha = SettingParams.HIGHLIGHT_ALPHA;
      highlightMaterial.diffuseColor = SettingParams.HIGHLIGHT_COLOR;
      this.#blockHighlightMesh.material = highlightMaterial;

      this.#blockHighlightMesh.enableEdgesRendering();
      this.#blockHighlightMesh.edgesWidth = SettingParams.HIGHLIGHT_EDGE_WIDTH;
      this.#blockHighlightMesh.edgesColor = SettingParams.HIGHLIGHT_EDGE_COLOR;
      this.#blockHighlightMesh.visibility = 0; // Initially hidden
    }
    const hit = CrossHair.pickTarget(this.#player);

    if (hit) {
      this.#blockHighlightMesh.position.set(
        Math.floor(hit.x) + 0.5,
        Math.floor(hit.y) + 0.5,
        Math.floor(hit.z) + 0.5,
      );
      this.#blockHighlightMesh.visibility = 1;
    } else {
      // Hide if nothing is hit
      this.#blockHighlightMesh.visibility = 0;
    }
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
    }
  }
}
