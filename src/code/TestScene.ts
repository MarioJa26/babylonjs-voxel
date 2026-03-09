import {
  Scene,
  Engine,
  Vector3,
  FreeCamera,
} from "@babylonjs/core";
import "@babylonjs/core/Debug/debugLayer";
import "@babylonjs/inspector";
import { Player } from "./Player/Player";
import { Map1 } from "./Maps/Map1";
import { PlayerCamera } from "./Player/PlayerCamera";
import { ChunkLoadingSystem } from "./World/Chunk/ChunkLoadingSystem";
import { ChunkMesher } from "./World/Chunk/ChunckMesher";

export class TestScene {
  document: Document;
  //connection: MyConnection;
  scene?: Scene;
  engine: Engine;
  public readonly initPromise: Promise<void>;
  private frameCounter = 0;

  constructor(
    document: Document,
    private canvas: HTMLCanvasElement,
  ) {
    this.document = document;
    this.engine = new Engine(this.canvas);
    //this.connection = new MyConnection();

    window.addEventListener("keydown", (ev) => {
      // Ctrl+F
      if (ev.ctrlKey && ev.key.toLowerCase() === "f") {
        if (this.scene) {
          if (this.scene.debugLayer.isVisible()) {
            this.scene.debugLayer.hide();
          } else {
            this.scene.debugLayer.show();
          }
        }
      }
    });

    this.initPromise = this.init();

    this.engine.runRenderLoop(() => {
      // Update shader uniforms ONCE per frame
      this.frameCounter++;
      ChunkMesher.updateGlobalUniforms(this.frameCounter);

      // Then render the scene
      this.scene?.render();
    });
  }

  async init() {
    this.scene = await this.createScene();
    //if (GlobalValues.INIT_CONNECTION) await this.connection.connect();
  }

  // Playground scene creation
  async createScene() {
    // This creates a basic Babylon Scene object (non-mesh)
    const scene = new Scene(this.engine);

    // This creates and positions a free camera (non-mesh)
    const camera = new FreeCamera("camera1", Vector3.Zero(), scene);

    const playerCamera = new PlayerCamera(camera, scene);
    new ChunkLoadingSystem(); // This will create all the initial chunks
    const player = new Player(this.engine, scene, playerCamera, this.canvas);
    const map = new Map1(scene, player);
    map.initPromise;
    return scene;
  }
}
