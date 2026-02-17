import {
  Scene,
  Engine,
  FreeCamera,
  PhysicsBody,
  Ray,
  Nullable,
  Vector3,
  AbstractMesh,
  PickingInfo,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
} from "@babylonjs/core";
import * as GUI from "@babylonjs/gui";
import { Player } from "../Player";
import { Map1 } from "@/code/Maps/Map1";
import { PlayerCamera } from "../PlayerCamera";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { SettingParams } from "@/code/World/SettingParams";

export class CrossHair {
  readonly #scene: Scene;
  readonly #camera: FreeCamera;
  readonly #engine: Engine;
  readonly #ui: GUI.AdvancedDynamicTexture =
    GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
  readonly #player: Player;

  #crosshair = this.#createCrosshair("179");
  #hitMarker = this.#createHitMarker();
  #blockHighlightMesh: Mesh;

  constructor(
    engine: Engine,
    playerCamera: PlayerCamera,
    scene: Scene,
    player: Player,
  ) {
    this.#engine = engine;
    this.#camera = playerCamera.playerCamera;
    this.#scene = scene;
    this.#player = player;

    this.#registerEvents();
    this.#engine.enterPointerlock();
    this.#blockHighlightMesh = this.#createBlockHighlight();
    this.#scene.onBeforeRenderObservable.add(() => {
      this.#updateBlockHighlight();
    });
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

  #createBlockHighlight(): Mesh {
    const mesh = MeshBuilder.CreateBox(
      "blockHighlight",
      { size: 1.005 },
      this.#scene,
    );
    mesh.isPickable = false;
    mesh.renderingGroupId = 1;

    const highlightMaterial = new StandardMaterial("highlightMat", this.#scene);
    highlightMaterial.alpha = SettingParams.HIGHLIGHT_ALPHA;
    highlightMaterial.diffuseColor = new Color3(
      SettingParams.HIGHLIGHT_COLOR[0],
      SettingParams.HIGHLIGHT_COLOR[1],
      SettingParams.HIGHLIGHT_COLOR[2],
    );
    mesh.material = highlightMaterial;

    mesh.enableEdgesRendering();
    mesh.edgesWidth = SettingParams.HIGHLIGHT_EDGE_WIDTH;
    mesh.edgesColor = new Color4(
      SettingParams.HIGHLIGHT_EDGE_COLOR[0],
      SettingParams.HIGHLIGHT_EDGE_COLOR[1],
      SettingParams.HIGHLIGHT_EDGE_COLOR[2],
      SettingParams.HIGHLIGHT_EDGE_COLOR[3],
    );
    mesh.visibility = 0;
    return mesh;
  }

  #updateBlockHighlight() {
    const hit = CrossHair.pickTarget(this.#player);
    if (hit) {
      this.#blockHighlightMesh.position.set(
        hit.x + 0.5,
        hit.y + 0.5,
        hit.z + 0.5,
      );
      this.#blockHighlightMesh.visibility = 1;
    } else {
      this.#blockHighlightMesh.visibility = 0;
    }
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

  public static pick(
    player: Player,
    predicate?: (mesh: AbstractMesh) => boolean,
  ): PickingInfo | null {
    const ray = player.playerCamera.playerCamera.getForwardRay(
      Player.REACH_DISTANCE,
    );
    return Map1.mainScene.pickWithRay(ray, (mesh) => {
      if (!mesh.isPickable || !mesh.isEnabled()) return false;
      if (predicate) return predicate(mesh);
      return true;
    });
  }

  /**
   * Returns the position of the Babylon mesh that the player is currently
   * looking at, or null if no Babylon mesh is hit.
   * @param player The player to check for.
   * @returns The position of the Babylon mesh that the player is currently
   *          looking at, or null if no Babylon mesh is hit.
   */
  public static pickMesh(player: Player): Vector3 | null {
    const info = this.pick(player);
    if (!info?.pickedPoint) return null;
    const normal = info.getNormal(true);
    if (!normal) return null;
    const hitPos = info.pickedPoint.add(normal.scale(0.001));
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
    const pos = this.pickTarget(player);
    if (!pos) return null;
    return ChunkLoadingSystem.getBlockByWorldCoords(pos.x, pos.y, pos.z);
  }
  /**
   * Returns the position of the Babylon mesh that the player is currently
   * looking at, or null if no Babylon mesh is hit.
   * @param player The player to check for.
   * @returns The position of the Babylon mesh that the player is currently
   *          looking at, or null if no Babylon mesh is hit.
   */
  public static pickTarget(player: Player): Vector3 | null {
    const info = this.pick(
      player,
      (mesh) => mesh.name.indexOf("c_water") === -1,
    );
    if (!info?.pickedPoint) return null;
    const normal = info.getNormal(true);
    if (!normal) return null;
    const hitPos = info.pickedPoint.subtract(normal.scale(0.001));
    return new Vector3(
      Math.floor(hitPos.x),
      Math.floor(hitPos.y),
      Math.floor(hitPos.z),
    );
  }

  public static getPlacementPosition(player: Player): Vector3 | null {
    const info = this.pick(
      player,
      (mesh) => mesh.name.indexOf("c_water") === -1,
    );
    if (!info?.pickedPoint) return null;
    const normal = info.getNormal(true);
    if (!normal) return null;
    const hitPos = info.pickedPoint.add(normal.scale(0.001));
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
