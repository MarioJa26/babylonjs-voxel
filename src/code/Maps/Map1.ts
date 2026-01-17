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
  private dirLight?: DirectionalLight;

  static #timeOfDay = 450000; // Time in milliseconds, progresses from 0 to dayDurationMs
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
        { size: 1.005 },
        Map1.mainScene
      );
      this.#blockHighlightMesh.isPickable = false;
      this.#blockHighlightMesh.renderingGroupId = 1;

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

    // Compute smooth solar parameters (CPU)
    const t = Map1.#timeOfDay / SettingParams.DAY_DURATION_MS; // 0..1
    const angle = t * Math.PI * 2; // full orbit

    // Use spherical coordinates:
    // - azimuth rotates horizontally
    // - elevationAngle is limited so sun rises/sets smoothly
    const maxElevation = 1.1; // radians (~28.6°). Tune to taste.
    const elevationAngle = Math.sin(angle) * maxElevation; // -max..max

    // Cartesian direction (sun direction vector, normalized on assignment)
    const sx = Math.cos(elevationAngle) * Math.cos(angle);
    const sz = Math.cos(elevationAngle) * Math.sin(angle);
    const sy = Math.sin(elevationAngle);

    const len = Math.hypot(sx, sy, sz) || 1;
    // GlobalValues.skyLightDirection is expected normalized
    GlobalValues.skyLightDirection.x = sx / len;
    GlobalValues.skyLightDirection.y = sy / len;
    GlobalValues.skyLightDirection.z = sz / len;

    // Sun intensity driven by elevation (zero below horizon)
    const sunIntensity = Math.max(0.0, Math.sin(angle)); // 0..1, tune multiplier below

    // Update engine directional light if present (direction points FROM light)
    if (this.dirLight) {
      this.dirLight.direction = new Vector3(
        GlobalValues.skyLightDirection.x,
        GlobalValues.skyLightDirection.y,
        GlobalValues.skyLightDirection.z
      );
      // Scale base intensity with elevation (tune multiplier)
      this.dirLight.intensity = 1.0 * sunIntensity;
    }
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

    // (No further sun math here — the spherical Cartesian sun direction above is the single source of truth.)
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
    // keep a reference so we can update it every frame
    this.dirLight = dirLight;

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
      { diameter: 50000.11, segments: 1 },
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
    if (GlobalValues.CREATE_ATLAS) {
      await TextureAtlasFactory.buildAtlas(Map1.mainScene, TextureDefinitions);
    }
  }
}
