import { createScene } from "@/BabylonExamples/MyScene";
import {
  Scene,
  Engine,
  Vector3,
  HemisphericLight,
  FreeCamera,
  AssetsManager,
  HavokPlugin,
} from "@babylonjs/core";
import "@babylonjs/loaders";

export class FirstPersonControls {
  scene: Scene;
  engine: Engine;

  constructor(private canvas: HTMLCanvasElement) {
    this.engine = new Engine(this.canvas, true);
    this.scene = this.CreateScene();

    this.CreateEnvironment();

    this.CreateController();

    this.engine.runRenderLoop(() => {
      this.scene.render();
    });
  }

  CreateScene(): Scene {
    const scene = createScene(this.engine);
    new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);

    scene.onPointerDown = (evt) => {
      if (evt.button === 0) this.engine.enterPointerlock();
      if (evt.button === 1) this.engine.exitPointerlock();
    };

    // Initialize Havok physics plugin and enable physics
    const hk = new HavokPlugin();
    scene.enablePhysics(new Vector3(0, -9.8, 0), hk);

    return scene;
  }

  async CreateEnvironment(): Promise<void> {
    // Use AssetsManager to load the model
    const assetsManager = new AssetsManager(this.scene);
    const meshTask = assetsManager.addMeshTask(
      "level task",
      "",
      "./models/",
      "Prototype_Level.glb"
    );

    meshTask.onSuccess = (task: any) => {
      task.loadedMeshes.forEach((mesh: any) => {
        mesh.checkCollisions = true;
      });
    };

    assetsManager.load();
  }

  CreateController(): void {
    const camera = new FreeCamera("camera", new Vector3(0, 10, 0), this.scene);
    camera.attachControl();

    camera.applyGravity = true;
    camera.checkCollisions = true;

    camera.ellipsoid = new Vector3(1, 1, 1);

    camera.inertia = 0;
    camera.minZ = 0.45;
    camera.speed = 3;
    camera.angularSensibility = 800;

    camera.keysUp.push(87);
    camera.keysLeft.push(65);
    camera.keysDown.push(83);
    camera.keysRight.push(68);
  }
}
