import {
  Scene,
  FreeCamera,
  Engine,
  PointerEventTypes,
  Vector3,
} from "@babylonjs/core";
import { IUsable } from "../Inferface/IUsable";
import { MetadataContainer } from "../Entities/MetaDataContainer";
import { WalkingControls } from "../Player/Controls/WalkingControls";
import { IControls } from "../Inferface/IControls";
import { PaddleBoatControls } from "./Controls/PaddleBoatControls";
import { PlayerHud } from "./Hud/PlayerHud";
import { PlayerInventory } from "./Inventory/PlayerInventory";
import { InventoryControls } from "./Controls/InventoryControls";
import { PlayerCamera } from "./PlayerCamera";
import { World } from "../World/World";
import { PlayerVehicle } from "./PlayerVehicle";
import { PlayerFlashLight } from "./PlayerFlashLight";

/**
 * Player class that handles character movement, physics, and camera controls
 */
export class Player implements IUsable {
  #camera: FreeCamera;
  #playerCamera: PlayerCamera;
  #playerVehicle: PlayerVehicle;
  #playerInventory: PlayerInventory;
  #playerHud: PlayerHud;

  #defaultKeyboardControls!: WalkingControls;
  #keyboardControls!: IControls<unknown>;

  public flashlight: PlayerFlashLight;

  static readonly REACH_DISTANCE = 16;

  /**
   * Creates a new Player instance
   * @param scene The Babylon.js scene
   * @param camera The camera to use for the player's view
   * @param canvas The HTML canvas element for input handling
   */
  constructor(
    private engine: Engine,
    private scene: Scene,
    playerCam: PlayerCamera,
    private canvas: HTMLCanvasElement
  ) {
    this.#playerInventory = new PlayerInventory(scene, this, 10, 10);
    this.#playerVehicle = new PlayerVehicle(this.scene, playerCam);
    this.#camera = playerCam.playerCamera;
    this.#playerCamera = playerCam;
    this.flashlight = new PlayerFlashLight(this.scene, playerCam.playerCamera);

    this.#playerHud = new PlayerHud(engine, this.scene, this, playerCam);

    this.initializeInputHandlers();
    this.initializeRenderLoop();
  }

  private initializeInputHandlers(): void {
    this.initializeKeyboardInput();
    this.initializePointerLock();
  }

  private initializeKeyboardInput(): void {
    this.#defaultKeyboardControls = new WalkingControls(this);
    this.#keyboardControls = this.#defaultKeyboardControls;

    window.addEventListener("keydown", (event) => {
      event.preventDefault();
      const key = event.key.toLowerCase();
      this.#keyboardControls.handleKeyEvent(key, true);
    });

    window.addEventListener("keyup", (event) => {
      event.preventDefault();
      const key = event.key.toLowerCase();
      this.#keyboardControls.handleKeyEvent(key, false);
    });
  }

  private initializePointerLock(): void {
    this.canvas.addEventListener("click", () => {
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock();
      }
    });

    window.addEventListener("mousedown", (event) => {
      if (this.#keyboardControls instanceof InventoryControls)
        this.#keyboardControls.handleMouseEvent(event, true);
      else if (this.#keyboardControls instanceof WalkingControls) {
        this.#keyboardControls.handleMouseEvent(event, true);
      }
    });

    this.scene.onPointerObservable.add((pointerInfo) => {
      if (document.pointerLockElement !== this.canvas) return;
      switch (pointerInfo.type) {
        case PointerEventTypes.POINTERMOVE: {
          this.#playerCamera.handleMouseMovement(
            pointerInfo.event.movementX,
            pointerInfo.event.movementY
          );
          break;
        }
        case PointerEventTypes.POINTERWHEEL: {
          const wheelEvent = pointerInfo.event as WheelEvent;
          if (wheelEvent.deltaY > 0) {
            this.#keyboardControls.handleKeyEvent("wheel_down", false);
          } else if (wheelEvent.deltaY < 0) {
            this.#keyboardControls.handleKeyEvent("wheel_up", false);
          }
          break;
        }
      }
    });
  }

  private initializeRenderLoop(): void {
    this.scene.onBeforeRenderObservable.add(() =>
      this.#playerVehicle.updateCameraAndVisuals()
    );

    this.scene.onAfterPhysicsObservable.add(() => {
      this.#playerVehicle.update(this.scene.deltaTime / 1000);
    });

    this.scene.onBeforeRenderObservable.add(() => {
      if (this.#keyboardControls instanceof PaddleBoatControls)
        this.#keyboardControls.update();

      // Ensure world chunks are generated around the player when they move between chunks
      const playerPos = this.position;
      World.updateChunksAround(playerPos.x, playerPos.y, playerPos.z);

      //if (GlobalValues.DEBUG) {
      PlayerHud.updateDebugInfo(
        "Player Pos",
        `${playerPos.x.toFixed(2)}, ${playerPos.y.toFixed(
          2
        )}, ${playerPos.z.toFixed(2)}`
      );
      const chunkX = World.worldToChunkCoord(playerPos.x);
      const chunkY = World.worldToChunkCoord(playerPos.y);
      const chunkZ = World.worldToChunkCoord(playerPos.z);

      const cameraPos = this.#playerCamera.position;
      PlayerHud.updateDebugInfo(
        "Camera Pos",
        `${cameraPos.x.toFixed(2)}, ${cameraPos.y.toFixed(
          2
        )}, ${cameraPos.z.toFixed(2)}`
      );

      const cameraYaw = this.#playerCamera.cameraYaw;
      const cameraPitch = this.#playerCamera.cameraPitch;
      PlayerHud.updateDebugInfo(
        "Camera Angle",
        `Yaw: ${cameraYaw.toFixed(2)}, Pitch: ${cameraPitch.toFixed(2)}`
      );

      PlayerHud.updateDebugInfo("Chunk Pos", `${chunkX}, ${chunkY}, ${chunkZ}`);

      PlayerHud.updateDebugInfo("FPS", this.engine.getFps().toFixed());
      PlayerHud.updateDebugInfo("Meshes", this.scene.meshes.length);
      PlayerHud.updateDebugInfo(
        "Physics Bodies",
        this.scene.meshes.filter((m) => m.physicsBody).length
      );
    });
  }

  public get playerVehicle(): PlayerVehicle {
    return this.#playerVehicle;
  }

  public get playerCamera(): PlayerCamera {
    return this.#playerCamera;
  }

  public get keyboardControls(): IControls<unknown> {
    return this.#keyboardControls;
  }
  public set keyboardControls(keyboardControls: IControls<unknown>) {
    this.#keyboardControls = keyboardControls;
  }
  public get playerHud(): PlayerHud {
    return this.#playerHud;
  }
  public get playerInventory(): PlayerInventory {
    return this.#playerInventory;
  }

  public get defaultKeyboardControls(): WalkingControls {
    return this.#defaultKeyboardControls;
  }

  public get position(): Vector3 {
    return this.#playerVehicle.characterController.getPosition();
  }

  use(): void {
    const ray = this.#camera.getForwardRay(200);
    const pick = this.scene.pickWithRay(ray);

    if (!pick || pick.faceId === -1 || !pick.pickedMesh) {
      return;
    }

    const mesh = pick.pickedMesh;
    if (mesh.metadata) {
      const metadataContainer = mesh.metadata as MetadataContainer;
      if (
        metadataContainer instanceof MetadataContainer &&
        metadataContainer.has("use")
      ) {
        const useFunc = metadataContainer.get<(player: Player) => void>("use");
        if (useFunc) {
          useFunc(this);
        }
      }
    }
  }
}
