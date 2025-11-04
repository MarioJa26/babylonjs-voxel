import {
  Scene,
  Engine,
  Vector3,
  HemisphericLight,
  FreeCamera,
  HavokPlugin,
  ImportMeshAsync,
  Texture,
  PhysicsAggregate,
  PhysicsShapeType,
  HingeConstraint,
  StandardMaterial,
  AssetsManager,
  AbstractMesh,
  SimplificationType,
  Mesh,
  TransformNode,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders";
import { Player } from "./Player/Player";
import { distanceCullMeshes } from "../BabylonExamples/occlusion";
import { Map1 } from "./Maps/Map1";
import { PlayerCamera } from "./Player/PlayerCamera";
import MapFog from "./Maps/MapFog";

export class TestScene {
  document: Document;
  scene?: Scene;
  engine: Engine;
  models!: AbstractMesh[];

  constructor(document: Document, private canvas: HTMLCanvasElement) {
    this.document = document;
    this.engine = new Engine(this.canvas);

    this.init();

    // this.CreateEnvironment2();

    this.engine.runRenderLoop(() => {
      this.scene?.render();
      const divFps = document.getElementById("fps")!;
      divFps.innerHTML = this.engine.getFps().toFixed() + " fps";
    });
  }

  async init() {
    this.scene = await this.createScene();
  }

  // Playground scene creation
  async createScene() {
    // This creates a basic Babylon Scene object (non-mesh)
    const scene = new Scene(this.engine);

    // This creates and positions a free camera (non-mesh)
    const camera = new FreeCamera("camera1", new Vector3(0, 5, -5), scene);
    camera.fov = 1.35;
    camera.minZ = 0.2;

    // This creates a light, aiming 0,1,0 - to the sky (non-mesh)
    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);

    // Default intensity is 1. Let's dim the light a small amount
    light.intensity = 0.7;

    // Initialize Havok plugin
    const hk = new HavokPlugin(false, await HavokPhysics());

    // Enable physics in the scene with a gravity
    scene.enablePhysics(new Vector3(0, -9.80665, 0), hk);

    // Load GLB exported from Blender using Physics extension enabled
    //await this.CreateEnvironment2();
    const mapFog = new MapFog(scene);
    const playerCamera = new PlayerCamera(camera, scene);
    const player = new Player(this.engine, scene, playerCamera, this.canvas);
    const map = new Map1(scene, player);
    return scene;
  }

  async CreateEnvironment(): Promise<void> {
    const assetsManager = new AssetsManager(this.scene);
    const meshTask = assetsManager.addMeshTask(
      "lightingSceneTask",
      "",
      "./models/",
      "city.glb"
    );

    await new Promise<void>((resolve, reject) => {
      meshTask.onSuccess = (task) => {
        this.models = task.loadedMeshes;
        const scaleingFactor = 3;
        const root = new TransformNode("sceneRoot", this.scene);
        root.rotation = new Vector3(Math.PI / 2, 0, 0);
        root.scaling = new Vector3(
          scaleingFactor,
          scaleingFactor,
          scaleingFactor
        );
        this.models.forEach((mesh) => {
          mesh.parent = root;

          mesh.checkCollisions = true;
          if (mesh.isVisible && mesh.getTotalVertices() > 1) {
            new PhysicsAggregate(
              mesh,
              PhysicsShapeType.MESH,
              { mass: 0 },
              this.scene
            );
          }
          mesh.occlusionType = AbstractMesh.OCCLUSION_TYPE_OPTIMISTIC;
          mesh.occlusionRetryCount = 1;
          if (mesh instanceof Mesh && mesh.getTotalVertices() > 350) {
            mesh.simplify(
              [
                { quality: 0.7, distance: 30 },
                { quality: 0.4, distance: 60 },
                { quality: 0.1, distance: 95 },
              ],
              true,
              SimplificationType.QUADRATIC
            );
          }
        });

        // Distance cull: hide anything further than 80 units
        if (this.scene) {
          distanceCullMeshes(this.scene, this.models, 80, 30);
        }
        resolve();
      };
      meshTask.onError = (task, message, exception) => {
        console.error("Failed to load LightingScene.glb", message, exception);
        reject(exception);
      };
      assetsManager.load();
    });
  }

  async CreateEnvironment2(): Promise<void> {
    ImportMeshAsync(
      "https://raw.githubusercontent.com/CedricGuillemet/dump/master/CharController/levelTest.glb",
      this.scene!
    ).then(() => {
      // Load a texture that will be used as lightmap. This Lightmap was made using this process : https://www.youtube.com/watch?v=Q4Ajd06eTak
      const lightmap = new Texture(
        "https://raw.githubusercontent.com/CedricGuillemet/dump/master/CharController/lightmap.jpg"
      );
      // Meshes using the lightmap
      const lightmapped = [
        "level_primitive0",
        "level_primitive1",
        "level_primitive2",
      ];
      lightmapped.forEach((meshName) => {
        const mesh = this.scene!.getMeshByName(meshName);
        // Create static physics shape for these particular meshes
        if (!mesh) return;
        if (!mesh.material) {
          return;
        }
        new PhysicsAggregate(mesh, PhysicsShapeType.MESH);
        mesh.isPickable = false;
        const standardMat = mesh.material as StandardMaterial;
        standardMat.lightmapTexture = lightmap;
        standardMat.useLightmapAsShadowmap = true;
        const lmTex = standardMat.lightmapTexture as Texture;
        lmTex.uAng = Math.PI;
        lmTex.level = 1.6;
        lmTex.coordinatesIndex = 1;
        mesh.freezeWorldMatrix();
        mesh.doNotSyncBoundingInfo = true;
      });
      // static physics cubes
      const cubes = [
        "Cube",
        "Cube.001",
        "Cube.002",
        "Cube.003",
        "Cube.004",
        "Cube.005",
      ];
      cubes.forEach((meshName) => {
        const mesh = this.scene!.getMeshByName(meshName);
        if (mesh) {
          new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0.1 });
        }
      });
      // inclined plane
      const planeMesh = this.scene!.getMeshByName("Cube.006");
      if (!planeMesh) return;
      planeMesh.scaling.set(0.03, 3, 1);
      const mesh2 = this.scene!.getMeshByName("Cube.007");
      if (mesh2) {
        const fixedMass = new PhysicsAggregate(mesh2, PhysicsShapeType.BOX, {
          mass: 0.1,
        });
        const plane = new PhysicsAggregate(planeMesh, PhysicsShapeType.BOX, {
          mass: 0.1,
        });

        // plane joint
        const joint = new HingeConstraint(
          new Vector3(0.75, 0, 0),
          new Vector3(-0.25, 0, 0),
          new Vector3(0, 0, -1),
          new Vector3(0, 0, 1),
          this.scene!
        );
        fixedMass.body.addConstraint(plane.body, joint);
      }
    });
  }
}
