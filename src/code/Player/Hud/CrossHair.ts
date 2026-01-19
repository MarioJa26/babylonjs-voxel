import {
  Scene,
  Engine,
  FreeCamera,
  PhysicsBody,
  Ray,
  Nullable,
  Vector3,
} from "@babylonjs/core";
import * as GUI from "@babylonjs/gui";
import { Player } from "../Player";
import { Map1 } from "@/code/Maps/Map1";
import { PlayerCamera } from "../PlayerCamera";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";

export class CrossHair {
  readonly #scene: Scene;
  readonly #camera: FreeCamera;
  readonly #engine: Engine;
  readonly #ui: GUI.AdvancedDynamicTexture =
    GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

  #crosshair = this.#createCrosshair("179");
  #hitMarker = this.#createHitMarker();

  constructor(engine: Engine, playerCamera: PlayerCamera, scene: Scene) {
    this.#engine = engine;
    this.#camera = playerCamera.playerCamera;
    this.#scene = scene;

    this.#registerEvents();
    this.#engine.enterPointerlock();
  }

  #createCrosshair(hitMarkerId: string): GUI.Image {
    const img = new GUI.Image(
      "crossHair",
      `/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair${hitMarkerId}.png`,
    );
    img.width = "48px";
    img.height = "48px";
    img.alpha = 1;
    this.#ui.addControl(img);
    return img;
  }

  #createHitMarker(): GUI.Image {
    const img = new GUI.Image("hitMarker", "/texture/gui/hitmarker01.png");
    img.width = "28px";
    img.height = "28px";
    img.alpha = 0;
    this.#ui.addControl(img);
    return img;
  }

  #showHitMarker(): void {
    let elapsedTime = 0;
    const durationSeconds = 0.33;

    const onRender = (): void => {
      elapsedTime += this.#engine.getDeltaTime() / 1000;
      this.#hitMarker.alpha = Math.max(
        0,
        this.#crosshair.alpha - elapsedTime / durationSeconds,
      );

      if (elapsedTime >= durationSeconds) {
        this.#scene.onBeforeRenderObservable.removeCallback(onRender);
        this.#hitMarker.alpha = 0;
      }
    };

    this.#scene.onBeforeRenderObservable.add(onRender);
  }

  #registerEvents(): void {
    this.#scene.onPointerDown = (e) => {
      if (e.button === 2) {
        return;
      }
      const ray: Ray = this.#camera.getForwardRay(200);
      const pick = this.#scene.pickWithRay(ray);

      if (!pick?.pickedMesh || pick.faceId === -1 || !pick.pickedPoint) {
        return;
      }

      const body: Nullable<PhysicsBody> = pick.pickedMesh.physicsBody;
      if (!body) return;

      const { mass = 1 } = body.getMassProperties();

      body.applyImpulse(ray.direction.scale(mass * 1.5), pick.pickedPoint);

      this.#showHitMarker();
    };
  }

  /**
   * Returns the position of the Babylon mesh that the player is currently
   * looking at, or null if no Babylon mesh is hit.
   * @param player The player to check for.
   * @returns The position of the Babylon mesh that the player is currently
   *          looking at, or null if no Babylon mesh is hit.
   */
  public static pickMesh(player: Player): Vector3 | null {
    const ray = player.playerCamera.playerCamera.getForwardRay(
      Player.REACH_DISTANCE,
    );
    const pick = Map1.mainScene.pickWithRay(ray);
    if (!pick?.pickedPoint) return null;
    const normal = pick.getNormal(true);
    if (!normal) return null;
    const hitPos = pick.pickedPoint.add(normal.scale(0.001));
    return new Vector3(
      Math.floor(hitPos.x),
      Math.floor(hitPos.y),
      Math.floor(hitPos.z),
    );
  }
  /**
   * Returns the block ID at the position that the player is currently
   * looking at, or null if no block is hit.
   * @param player The player to check for.
   * @returns The block ID at the position that the player is currently
   *          looking at, or null if no block is hit.
   */
  public static pickBlock(player: Player): number | null {
    const ray = player.playerCamera.playerCamera.getForwardRay(
      Player.REACH_DISTANCE,
    );
    const pick = Map1.mainScene.pickWithRay(ray);
    if (!pick?.pickedPoint) return null;
    const normal = pick.getNormal(true);
    if (!normal) return null;
    const hitPos = pick.pickedPoint.subtract(normal.scale(0.001));
    return ChunkLoadingSystem.getBlockByWorldCoords(
      Math.floor(hitPos.x),
      Math.floor(hitPos.y),
      Math.floor(hitPos.z),
    );
  }
  /**
   * Returns the position of the Babylon mesh that the player is currently
   * looking at, or null if no Babylon mesh is hit.
   * @param player The player to check for.
   * @returns The position of the Babylon mesh that the player is currently
   *          looking at, or null if no Babylon mesh is hit.
   */
  public static pickTarget(player: Player): Vector3 | null {
    const ray = player.playerCamera.playerCamera.getForwardRay(
      Player.REACH_DISTANCE,
    );
    const pick = Map1.mainScene.pickWithRay(ray);
    if (!pick?.pickedPoint) {
      return null;
    }
    const normal = pick.getNormal(true);
    if (!normal) return null;
    const hitPos = pick.pickedPoint.subtract(normal.scale(0.001));
    return new Vector3(
      Math.floor(hitPos.x),
      Math.floor(hitPos.y),
      Math.floor(hitPos.z),
    );
  }

  setCrosshair(number: string) {
    this.#crosshair.source = `/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair${number}.png`;
  }
}
