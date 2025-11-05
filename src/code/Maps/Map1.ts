import {
  Color3,
  Effect,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Scene,
  ShaderMaterial,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  Vector3,
  SSAORenderingPipeline,
  Color4,
} from "@babylonjs/core";
import { GridMaterial, WaterMaterial } from "@babylonjs/materials";
import { AdvancedBoat } from "../Entities/AdvancedBoat";
import { MyTestBlock } from "./MyTestBlock";
import { Player } from "../Player/Player";
import { UnderWaterEffect } from "./UnderWaterEffect";
import { Chunk } from "../World/Chunk/Chunk";
import { TextureAtlasFactory } from "../World/Texture/TextureAtlasFactory";
import { ChunkMesher } from "../World/Chunk/ChunckMesher";
import { GlobalValues } from "../World/GlobalValues";
import { SkyShader } from "../World/Light/SkyShader";
import { TerrainGenerator } from "../World/Generation/TerrainGenarator";
import { PlayerHud } from "../Player/Hud/PlayerHud";
import { CrossHair } from "../Player/Hud/CrossHair";

export class Map1 {
  public static mainScene: Scene;
  #player: Player;
  public static shadowGenerator: ShadowGenerator;
  #blockHighlightMesh!: Mesh;

  static #timeOfDay = 0; // Time in milliseconds, progresses from 0 to dayDurationMs
  static readonly #dayDurationMs = 10 * 60 * 1000; // 10 minutes for a full day
  public static timeScale = 1.0;

  constructor(scene: Scene, player: Player) {
    this.#player = player;
    Map1.mainScene = this.CreateScene(scene);

    this.asyncInit().then(async () => {
      ChunkMesher.initAtlas();
      // Now that textures are ready, generate terrain and remesh.
      Chunk.chunkInstances.forEach((chunk) => {
        if (chunk.chunkY === 0) {
          for (let x = 0; x < Chunk.SIZE; x++) {
            for (let z = 0; z < Chunk.SIZE; z++) {
              TerrainGenerator.generateChunkColumn(chunk, x, z);
            }
          }
        }
      });
    });
    scene.onBeforeRenderObservable.add(() => {
      this.updateDayNightCycle();
      this.updateBlockHighlight();
    });
  }

  async asyncInit() {
    try {
      await Promise.all([this.CreateEnvironment(), this.loadTextures()]);
      if (GlobalValues.ENABLE_SSAO)
        new SSAORenderingPipeline(
          "ssaopipeline",
          Map1.mainScene,
          { ssaoRatio: 0.5, combineRatio: 2.0 },
          [Map1.mainScene.activeCamera!]
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
    Map1.#timeOfDay = (time % 1) * Map1.#dayDurationMs;
  }

  private updateBlockHighlight() {
    if (!this.#blockHighlightMesh) {
      // Create the highlight mesh if it doesn't exist
      this.#blockHighlightMesh = MeshBuilder.CreateBox(
        "blockHighlight",
        { size: 1.01 },
        Map1.mainScene
      );
      this.#blockHighlightMesh.isPickable = false;

      // Create a transparent material for the box faces
      const highlightMaterial = new StandardMaterial(
        "highlightMat",
        Map1.mainScene
      );
      highlightMaterial.alpha = 0.2; // Set transparency (0=invisible, 1=solid)
      highlightMaterial.diffuseColor = new Color3(1, 1, 1); // Set face color to white
      this.#blockHighlightMesh.material = highlightMaterial;

      this.#blockHighlightMesh.enableEdgesRendering();
      this.#blockHighlightMesh.edgesWidth = 1.0;
      this.#blockHighlightMesh.edgesColor = new Color4(0, 0, 0, 0.5);
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
    if (Map1.timeScale < 0.001) return;
    // Increment time of day based on frame delta time
    Map1.#timeOfDay +=
      Map1.mainScene.getEngine().getDeltaTime() * Map1.timeScale;
    Map1.#timeOfDay %= Map1.#dayDurationMs;

    // For debug display
    const timeAsHour = (Map1.#timeOfDay / Map1.#dayDurationMs) * 24;
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
        (Map1.#timeOfDay / Map1.#dayDurationMs) *
        1000
      ).toString();

    // Time within the current cycle
    const timeInCycle = Map1.#timeOfDay;

    // Angle around the full circle (0..2PI)
    const angle = (timeInCycle / Map1.#dayDurationMs) * 2 * Math.PI;

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
    hemiLight.intensity = 0.3;
    const dirLight = new DirectionalLight(
      "dirLight",
      new Vector3(-1, -2, -1),
      scene
    );
    dirLight.intensity = 0.3;
    dirLight.position = new Vector3(20, 40, 20);
    Map1.shadowGenerator = new ShadowGenerator(1024, dirLight);
    Map1.shadowGenerator.useBlurExponentialShadowMap = true;
    Map1.shadowGenerator.blurKernel = 32;
    return scene;
  }

  private CreateEnvironment(): void {
    const ground = MeshBuilder.CreateGround(
      "ground",
      { width: 1000, height: 1000 },
      Map1.mainScene
    );
    ground.isPickable = true;
    ground.position = new Vector3(0, -5, 0);
    ground.receiveShadows = true;

    const gridMaterial = new GridMaterial("gridMaterial", Map1.mainScene);
    gridMaterial.majorUnitFrequency = 10;
    gridMaterial.minorUnitVisibility = 0.2;
    gridMaterial.gridRatio = 1;
    gridMaterial.backFaceCulling = false;
    gridMaterial.mainColor = new Color3(0.2, 0.2, 0.2);
    gridMaterial.lineColor = new Color3(0.4, 0.4, 0.4);
    gridMaterial.opacity = 1;
    ground.material = gridMaterial;

    new PhysicsAggregate(
      ground,
      PhysicsShapeType.BOX,
      { mass: 0 },
      Map1.mainScene
    );

    const goldberg = MeshBuilder.CreateGoldberg("goldberg", {
      size: 0.4,
      m: 3,
      n: 3,
      sideOrientation: Mesh.DOUBLESIDE,
    });
    goldberg.position = new Vector3(0, 5, 5);
    goldberg.checkCollisions = true;
    goldberg.receiveShadows = true;

    const goldbergMat = new GridMaterial("goldbergGrid", Map1.mainScene);
    goldbergMat.mainColor = new Color3(0.8, 0.6, 0.2);
    goldbergMat.lineColor = goldbergMat.mainColor.scale(0.5); // slightly darker lines
    goldberg.material = goldbergMat;

    goldberg.metadata = new PhysicsAggregate(
      goldberg,
      PhysicsShapeType.SPHERE,
      { mass: 0.1 },
      Map1.mainScene
    );

    const goldberg2 = MeshBuilder.CreateGoldberg("goldberg2", {
      size: 0.4,
      m: 1,
      n: 1,
      sideOrientation: Mesh.BACKSIDE,
    });
    goldberg2.position = new Vector3(2, 5, 5);
    goldberg2.checkCollisions = true;

    const goldbergMat2 = new GridMaterial("goldbergGrid2", Map1.mainScene);
    goldbergMat2.mainColor = new Color3(0.18, 0.6, 0.2);
    goldbergMat2.lineColor = goldbergMat2.mainColor.scale(0.5);
    goldberg2.material = goldbergMat2;

    goldberg2.metadata = new PhysicsAggregate(
      goldberg2,
      PhysicsShapeType.SPHERE,
      { mass: 0.1, restitution: 0.8 },
      Map1.mainScene
    );

    for (let x = 0; x < 0; x++) {
      for (let y = 0; y < 5; y++) {
        for (let z = 0; z < 3; z++) {
          new MyTestBlock(Map1.mainScene, x + 9, y + 6, z);
        }
      }
    }

    const skybox = this.createSkybox();
    this.createWater(goldberg, goldberg2, skybox, ground);
  }

  private createWater(
    goldberg: Mesh,
    goldberg2: Mesh,
    skybox: Mesh,
    ground: Mesh
  ): void {
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
    waterMaterial.addToRenderList(goldberg);
    waterMaterial.addToRenderList(goldberg2);
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
    const skybox = MeshBuilder.CreateBox(
      "skyBox",
      { size: 1000.0 },
      Map1.mainScene
    );
    skybox.isPickable = false;

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
    skyboxMaterial.onBind = (mesh) => {
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
    const textureFolders = [
      { name: "cobble", path: "/texture/cobble/cobble05_1k" },
      { name: "factory_wall", path: "/texture/metal/factory_wall_1k" },
      { name: "gravelly_sand", path: "/texture/sand/gravelly_sand_1k" },
      { name: "brick_wall_10", path: "/texture/brick/brick_wall_10_1k" },
      {
        name: "castle_brick_red",
        path: "/texture/brick/castle_brick_02_red_1k",
      },
      { name: "metal01", path: "/texture/metal/metal01_1k" },
      {
        name: "concrete_tile_facade",
        path: "/texture/stone/concrete_tile_facade_1k",
      },
      { name: "gray_rocks", path: "/texture/stone/gray_rocks_1k" },
      { name: "stone_tile_wall", path: "/texture/stone/stone_tile_wall_1k" },
      { name: "bark_willow_02", path: "/texture/wood/bark_willow_02_1k" },
      { name: "diagonal_parquet", path: "/texture/wood/diagonal_parquet_1k" },
      { name: "old_wood_floor", path: "/texture/wood/old_wood_floor_1k" },
      { name: "wood_table", path: "/texture/wood/wood_table_1k" },
      { name: "rocky_terrain_02", path: "/texture/dirt/rocky_terrain_02_1k" },
      { name: "grass001", path: "/texture/dirt/Grass001_1K" },
    ];
    await TextureAtlasFactory.buildAtlas(Map1.mainScene, textureFolders);
  }
}
