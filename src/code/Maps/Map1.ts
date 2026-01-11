import {
  Effect,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  Texture,
  Vector3,
  SSAORenderingPipeline,
} from "@babylonjs/core";
import { WaterMaterial } from "@babylonjs/materials";
import { AdvancedBoat } from "../Entities/AdvancedBoat";
import { Player } from "../Player/Player";
import { UnderWaterEffect } from "./UnderWaterEffect";
import { TextureAtlasFactory } from "../World/Texture/TextureAtlasFactory";
import { ChunkMesher } from "../World/Chunk/ChunckMesher";
import { GlobalValues } from "../World/GlobalValues";
import { SkyShader } from "../World/Light/SkyShader";
import { PlayerHud } from "../Player/Hud/PlayerHud";
import { CrossHair } from "../Player/Hud/CrossHair";
import { TextureDefinitions } from "../World/Texture/TextureDefinitions";
import { GenerationParams } from "../World/Generation/NoiseAndParameters/GenerationParams";
import { SettingParams } from "../World/SettingParams";
import { WorldStorage } from "../World/WorldStorage";
export class Map1 {
  public static mainScene: Scene;
  #player: Player;
  #blockHighlightMesh!: Mesh;

  static #timeOfDay = 200000; // Time in milliseconds, progresses from 0 to dayDurationMs
  public static timeScale = 0;
  public static isPaused = false;
  public readonly initPromise: Promise<void>;

  constructor(scene: Scene, player: Player) {
    this.#player = player;
    Map1.mainScene = this.CreateScene(scene);

    this.initPromise = this.asyncInit().then(async () => {
      await WorldStorage.initialize();
      ChunkMesher.initAtlas();
    });

    scene.onBeforeRenderObservable.add(() => {
      this.updateBlockHighlight();
      if (Map1.isPaused) return; // Don't update game logic if paused
      this.updateDayNightCycle();
    });
  }

  async asyncInit() {
    if (!Map1.mainScene.activeCamera) return;
    try {
      await Promise.all([this.CreateEnvironment(), this.loadTextures()]);
      if (SettingParams.ENABLE_SSAO)
        new SSAORenderingPipeline(
          "ssaopipeline",
          Map1.mainScene,
          {
            ssaoRatio: SettingParams.SSAO_RATIO,
            combineRatio: SettingParams.SSAO_COMBINE_RATIO,
          },
          [Map1.mainScene.activeCamera]
        );
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
    Map1.#timeOfDay = (time % 1) * SettingParams.DAY_DURATION_MS;
  }

  private updateBlockHighlight() {
    if (this.#player.playerVehicle instanceof AdvancedBoat) return;

    if (!this.#blockHighlightMesh) {
      // Create the highlight mesh if it doesn't exist
      this.#blockHighlightMesh = MeshBuilder.CreateBox(
        "blockHighlight",
        { size: 1.02 },
        Map1.mainScene
      );
      this.#blockHighlightMesh.isPickable = false;

      // Create a transparent material for the box faces
      const highlightMaterial = new StandardMaterial(
        "highlightMat",
        Map1.mainScene
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
        Math.floor(hit.z) + 0.5
      );
      this.#blockHighlightMesh.visibility = 1;
    } else {
      // Hide if nothing is hit
      this.#blockHighlightMesh.visibility = 0;
    }
  }

  private updateDayNightCycle() {
    if (Map1.isPaused) return;
    // Increment time of day based on frame delta time
    Map1.#timeOfDay +=
      Map1.mainScene.getEngine().getDeltaTime() * Map1.timeScale;
    Map1.#timeOfDay %= SettingParams.DAY_DURATION_MS;

    // For debug display
    const timeAsHour = (Map1.#timeOfDay / SettingParams.DAY_DURATION_MS) * 24;
    const hour = Math.floor(timeAsHour);
    const minute = Math.floor((timeAsHour - hour) * 60);
    const second = Math.floor(((timeAsHour - hour) * 60 - minute) * 60);
    PlayerHud.updateDebugInfo(
      "Time of Day",
      `${String(hour).padStart(2, "0")}:${String(minute).padStart(
        2,
        "0"
      )}:${String(second).padStart(2, "0")}`
    );
    PlayerHud.updateDebugInfo("Time Scale", Map1.timeScale.toFixed(2) + "x");

    // Update the time slider's position
    const timeSlider = document.getElementById(
      "timeSlider"
    ) as HTMLInputElement;
    if (timeSlider)
      timeSlider.value = (
        (Map1.#timeOfDay / SettingParams.DAY_DURATION_MS) *
        1000
      ).toString();

    // Time within the current cycle
    const timeInCycle = Map1.#timeOfDay;

    // Angle around the full circle (0..2PI)
    const angle = (timeInCycle / SettingParams.DAY_DURATION_MS) * 2 * Math.PI;

    // Use spherical-like parametrization:
    // - elevation controls vertical position (y)
    // - azimuth rotates the sun around the scene horizontally (x,z)
    const elevation = Math.sin(angle); // -1..1 (1 = overhead)
    const azimuth = angle; // full rotation for horizontal component
    const horizontalRadius = Math.cos(angle); // shrinks as elevation increases

    const x = horizontalRadius * Math.cos(azimuth);
    const z = horizontalRadius * Math.sin(azimuth);
    const y = -elevation; // negative so light points downward when sun is high

    // Normalize the vector to keep consistent intensity/direction
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    GlobalValues.skyLightDirection.x = x / len;
    GlobalValues.skyLightDirection.y = y / len;
    GlobalValues.skyLightDirection.z = z / len;
  }
  private CreateScene(scene: Scene): Scene {
    const hemiLight = new HemisphericLight(
      "hemiLight",
      new Vector3(100, 11, 55),
      scene
    );
    hemiLight.direction = new Vector3(-0.1, -1, -0.1);
    hemiLight.intensity = SettingParams.HEMISPHERIC_LIGHT_INTENSITY;
    const dirLight = new DirectionalLight(
      "dirLight",
      new Vector3(-1, -2, -1),
      scene
    );
    dirLight.intensity = SettingParams.DIRECTIONAL_LIGHT_INTENSITY;
    dirLight.position = new Vector3(20, 40, 20);

    new AdvancedBoat(
      scene,
      this.#player, // Note: #player is used here before it's fully constructed if we pass it to Player constructor
      GenerationParams.SEA_LEVEL + 0.5
    );

    return scene;
  }

  private CreateEnvironment(): void {
    this.createSkybox();
    //this.createWater(skybox, ground);
  }

  private createWater(skybox: Mesh, ground: Mesh): void {
    const water = MeshBuilder.CreateGround(
      "water",
      { width: 1000, height: 1000, subdivisions: 15 },
      Map1.mainScene
    );
    const waterMaterial = new WaterMaterial("water_material", Map1.mainScene);
    waterMaterial.bumpTexture = new Texture(
      "/texture/water/water02.png",
      Map1.mainScene
    );

    waterMaterial.windForce = 1;
    waterMaterial.waveHeight = 0.1;
    waterMaterial.bumpHeight = 2;
    waterMaterial.waveLength = 0.1;
    waterMaterial.colorBlendFactor = 0.3;
    waterMaterial.waveSpeed = 15;
    waterMaterial.alpha = 0.67;
    waterMaterial.addToRenderList(skybox);
    water.material = waterMaterial;
    const waterHeight = 40;
    water.position.y = waterHeight;
    water.isPickable = false;

    const advancedBoat = new AdvancedBoat(
      Map1.mainScene,
      this.#player,
      waterHeight + waterMaterial.waveHeight
    );
    waterMaterial.addToRenderList(advancedBoat.boatMesh);

    const groundTexture = new Texture(
      "/texture/sand/sand01_diff.jpg",
      Map1.mainScene
    );
    groundTexture.uScale = 16;
    groundTexture.vScale = 16;

    const waterMaterialUpsideDown = waterMaterial.clone("water_material");
    waterMaterialUpsideDown.bumpTexture = new Texture(
      "/texture/water/water02.png",
      Map1.mainScene
    );
    const underWaterEffect = new UnderWaterEffect(
      Map1.mainScene,
      this.#player.playerCamera.playerCamera,
      this.#player,
      groundTexture
    );
    // Create the water mesh for the upside-down water material and apply the material
    const upsideDownWater = water.clone("upsideDownWater");
    upsideDownWater.material = waterMaterialUpsideDown;

    // Invert the upside-down water mesh
    upsideDownWater.scaling.y = -1;
    upsideDownWater.position.y = waterHeight + waterMaterial.waveHeight + 0.4; // Position it below the water surface
    // Add same objects to render list for reflection
    ground.material = underWaterEffect.material;
    waterMaterialUpsideDown.addToRenderList(ground);
    waterMaterialUpsideDown.addToRenderList(advancedBoat.boatMesh);
  }

  private createSkybox(): Mesh {
    // Skybox
    const skybox = MeshBuilder.CreateSphere(
      "skyBox",
      { diameter: 13000.11, segments: 1 },
      Map1.mainScene
    );
    skybox.isPickable = false;
    skybox.infiniteDistance = true;
    skybox.ignoreCameraMaxZ = true;

    // Register the new sky shader
    Effect.ShadersStore["skyVertexShader"] = SkyShader.skyVertexShader;
    Effect.ShadersStore["skyFragmentShader"] = SkyShader.skyFragmentShader;

    // Create a ShaderMaterial using the sky shader
    const skyboxMaterial = new ShaderMaterial(
      "skyShaderMaterial",
      Map1.mainScene,
      {
        vertex: "sky",
        fragment: "sky",
      },
      {
        attributes: ["position"],
        uniforms: ["worldViewProjection", "sunDirection"],
      }
    );

    skyboxMaterial.backFaceCulling = false;

    // Update the sun's direction uniform every frame
    skyboxMaterial.onBind = () => {
      const effect = skyboxMaterial.getEffect();
      if (effect) {
        effect.setVector3(
          "sunDirection",
          GlobalValues.skyLightDirection.negate()
        );
      }
    };

    skybox.setEnabled(true);
    skybox.material = skyboxMaterial;
    return skybox;
  }

  async loadTextures(): Promise<void> {
    await TextureAtlasFactory.buildAtlas(Map1.mainScene, TextureDefinitions);
  }
}
