import {
  Color3,
  CubeTexture,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  Vector3,
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

export class Map1 {
  public static mainScene: Scene;
  #player: Player;
  public static shadowGenerator: ShadowGenerator;

  constructor(scene: Scene, player: Player) {
    this.#player = player;
    Map1.mainScene = this.CreateScene(scene);

    this.asyncInit().then(async () => {
      ChunkMesher.initAtlas();
      // Now that the material is ready, tell all existing chunks to remesh.
      Chunk.chunkInstances.forEach((chunk) => chunk.scheduleRemesh());
    });
    scene.onBeforeRenderObservable.add(this.updateDayNightCycle);
  }

  async asyncInit() {
    try {
      await Promise.all([this.CreateEnvironment(), this.loadTextures()]);
      console.log("Environment and textures loaded successfully.");
    } catch (error) {
      console.error("Error loading environment or textures:", error);
    }
  }
  private updateDayNightCycle() {
    // Duration of a full day in minutes (keeps your original value)
    const dayDurationMinutes = 10;
    const dayDurationMs = dayDurationMinutes * 60 * 1000;

    // Time within the current cycle
    const timeInCycle = Date.now() % dayDurationMs;

    // Angle around the full circle (0..2PI)
    const angle = (timeInCycle / dayDurationMs) * 2 * Math.PI;

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
    const waterHeight = 2;
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
    const skyboxMaterial = new StandardMaterial("skyBox", Map1.mainScene);
    skyboxMaterial.backFaceCulling = false;

    skyboxMaterial.reflectionTexture = new CubeTexture(
      "texture/skybox/skybox",
      Map1.mainScene
    );
    skyboxMaterial.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
    skyboxMaterial.diffuseColor = new Color3(0, 0, 0.1);
    skybox.setEnabled(true);
    skybox.material = skyboxMaterial;
    return skybox;
  }

  private createBlock() {
    const midBlock = MeshBuilder.CreateBox(
      "midBlock",
      { width: 9, height: 1.5, depth: 400 },
      Map1.mainScene
    );
    midBlock.position = new Vector3(0, 0, 0);
    midBlock.rotation.x = 0.1;

    const midMat = new GridMaterial("midGrid", Map1.mainScene);
    midMat.mainColor = new Color3(0.5, 0.5, 0.5);
    midMat.lineColor = midMat.mainColor.scale(0.5);
    midBlock.material = midMat;

    midBlock.checkCollisions = true;
    midBlock.isPickable = true;
    new PhysicsAggregate(
      midBlock,
      PhysicsShapeType.BOX,
      { mass: 0 },
      Map1.mainScene
    );
    // Create left block
    const leftBlock = MeshBuilder.CreateBox(
      "leftBlock",
      { width: 100, height: 10, depth: 250 },
      Map1.mainScene
    );
    leftBlock.position = new Vector3(-54, -2, 0);

    const leftMat = new GridMaterial("leftGrid", Map1.mainScene);
    leftMat.mainColor = new Color3(0.3, 0.5, 0.5);
    leftMat.lineColor = leftMat.mainColor.scale(0.5);
    leftBlock.material = leftMat;

    leftBlock.checkCollisions = true;
    leftBlock.isPickable = true;
    new PhysicsAggregate(
      leftBlock,
      PhysicsShapeType.BOX,
      { mass: 0 },
      Map1.mainScene
    );

    // Create right block
    const rightBlock = MeshBuilder.CreateBox(
      "rightBlock",
      { width: 30, height: 10, depth: 500 },
      Map1.mainScene
    );
    rightBlock.position = new Vector3(19, -2, 0);

    const rightMat = new GridMaterial("rightGrid", Map1.mainScene);
    rightMat.mainColor = new Color3(0.5, 0.5, 0.5);
    rightMat.lineColor = rightMat.mainColor.scale(0.5);
    rightBlock.material = rightMat;

    rightBlock.checkCollisions = true;
    rightBlock.isPickable = true;
    new PhysicsAggregate(
      rightBlock,
      PhysicsShapeType.BOX,
      { mass: 0 },
      Map1.mainScene
    );

    // Create right block
    const rightBlock2 = MeshBuilder.CreateBox(
      "rightBlock2",
      { width: 100, height: 8, depth: 140 },
      Map1.mainScene
    );
    rightBlock2.position = new Vector3(-80, 0, 250);

    rightBlock2.material = rightMat;

    rightBlock2.checkCollisions = true;
    rightBlock2.isPickable = false;
    new PhysicsAggregate(
      rightBlock2,
      PhysicsShapeType.BOX,
      { mass: 0 },
      Map1.mainScene
    );
    midBlock.receiveShadows = true;
    leftBlock.receiveShadows = true;
    rightBlock.receiveShadows = true;
    rightBlock2.receiveShadows = true;

    this.createaChunkMarker(rightMat);
  }
  private createaChunkMarker(mat: GridMaterial) {
    const chunkMarker = MeshBuilder.CreateBox(
      "chunkMarker",
      { width: 1, height: 20, depth: 1 },
      Map1.mainScene
    );
    chunkMarker.position = new Vector3(0, 0, 0);
    chunkMarker.isPickable = false;
    chunkMarker.material = mat;

    const chunkMarker2 = MeshBuilder.CreateBox(
      "chunkMarker2",
      { width: 1, height: 20, depth: 1 },
      Map1.mainScene
    );
    chunkMarker2.position = new Vector3(Chunk.SIZE, 0, 0);
    chunkMarker2.isPickable = false;
    chunkMarker2.material = mat;

    const chunkMarker3 = MeshBuilder.CreateBox(
      "chunkMarker3",
      { width: 1, height: 20, depth: 1 },
      Map1.mainScene
    );
    chunkMarker3.position = new Vector3(0, 0, Chunk.SIZE);
    chunkMarker3.isPickable = false;
    chunkMarker3.material = mat;

    const chunkMarker4 = MeshBuilder.CreateBox(
      "chunkMarker4",
      { width: 1, height: 20, depth: 1 },
      Map1.mainScene
    );
    chunkMarker4.position = new Vector3(Chunk.SIZE, 0, Chunk.SIZE);
    chunkMarker4.isPickable = false;
    chunkMarker4.material = mat;
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
