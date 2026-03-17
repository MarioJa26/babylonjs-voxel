import {
  Scene,
  Engine,
  Ray,
  Vector3,
  AbstractMesh,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
} from "@babylonjs/core";
import * as GUI from "@babylonjs/gui";
import { Player } from "../Player";
import { PlayerCamera } from "../PlayerCamera";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { SettingParams } from "@/code/World/SettingParams";
import { BlockType } from "@/code/World/BlockType";
import { MetadataContainer } from "@/code/Entities/MetaDataContainer";

type BlockRaycastHit = {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  t: number;
};

export class CrossHair {
  static readonly #meshRayMarchStep = 0.25;
  static readonly #meshBoundsEpsilon = 0.001;
  static readonly #sharedPoint = new Vector3(0, 0, 0);

  readonly #scene: Scene;
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
    this.#scene = scene;
    this.#player = player;

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

  static #sharedRay: Ray | null = null;
  static readonly #sharedHit: BlockRaycastHit = {
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 0,
    nz: 0,
    t: 0,
  };

  static #getSharedForwardRay(player: Player, length: number): Ray {
    if (!this.#sharedRay) {
      this.#sharedRay = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 1);
    }

    player.playerCamera.playerCamera.getForwardRayToRef(
      this.#sharedRay,
      length,
    );
    return this.#sharedRay;
  }

  static #raycastFirstBlock(
    player: Player,
    shouldHitBlockId: (
      x: number,
      y: number,
      z: number,
      blockId: number,
    ) => boolean,
  ): BlockRaycastHit | null {
    const ray = this.#getSharedForwardRay(player, Player.REACH_DISTANCE);

    const ox = ray.origin.x;
    const oy = ray.origin.y;
    const oz = ray.origin.z;
    const dx = ray.direction.x;
    const dy = ray.direction.y;
    const dz = ray.direction.z;

    const maxDistance = ray.length;
    if (!(maxDistance > 0)) return null;

    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const invDx = stepX === 0 ? Infinity : 1 / Math.abs(dx);
    const invDy = stepY === 0 ? Infinity : 1 / Math.abs(dy);
    const invDz = stepZ === 0 ? Infinity : 1 / Math.abs(dz);

    const nextBoundaryX = stepX > 0 ? x + 1 : x;
    const nextBoundaryY = stepY > 0 ? y + 1 : y;
    const nextBoundaryZ = stepZ > 0 ? z + 1 : z;

    let tMaxX = stepX === 0 ? Infinity : (nextBoundaryX - ox) / dx;
    let tMaxY = stepY === 0 ? Infinity : (nextBoundaryY - oy) / dy;
    let tMaxZ = stepZ === 0 ? Infinity : (nextBoundaryZ - oz) / dz;

    const tDeltaX = invDx;
    const tDeltaY = invDy;
    const tDeltaZ = invDz;

    // Skip the voxel the ray starts in (avoids "picking yourself" when inside a block)
    let t = 0;
    let nx = 0;
    let ny = 0;
    let nz = 0;

    while (true) {
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          x += stepX;
          t = tMaxX;
          tMaxX += tDeltaX;
          nx = -stepX;
          ny = 0;
          nz = 0;
        } else {
          z += stepZ;
          t = tMaxZ;
          tMaxZ += tDeltaZ;
          nx = 0;
          ny = 0;
          nz = -stepZ;
        }
      } else {
        if (tMaxY < tMaxZ) {
          y += stepY;
          t = tMaxY;
          tMaxY += tDeltaY;
          nx = 0;
          ny = -stepY;
          nz = 0;
        } else {
          z += stepZ;
          t = tMaxZ;
          tMaxZ += tDeltaZ;
          nx = 0;
          ny = 0;
          nz = -stepZ;
        }
      }

      if (t > maxDistance) return null;

      const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
      if (shouldHitBlockId(x, y, z, blockId)) {
        const out = this.#sharedHit;
        out.x = x;
        out.y = y;
        out.z = z;
        out.nx = nx;
        out.ny = ny;
        out.nz = nz;
        out.t = t;
        return out;
      }
    }
  }

  static #isInsideMeshBounds(mesh: AbstractMesh, point: Vector3): boolean {
    if (mesh.isDisposed()) return false;
    const bounds = mesh.getBoundingInfo().boundingBox;
    const min = bounds.minimumWorld;
    const max = bounds.maximumWorld;
    const eps = this.#meshBoundsEpsilon;
    return (
      point.x >= min.x - eps &&
      point.x <= max.x + eps &&
      point.y >= min.y - eps &&
      point.y <= max.y + eps &&
      point.z >= min.z - eps &&
      point.z <= max.z + eps
    );
  }

  static #rayMarchFirstMesh(
    player: Player,
    maxDistance: number,
    predicate?: (mesh: AbstractMesh) => boolean,
  ): AbstractMesh | null {
    const ray = this.#getSharedForwardRay(player, maxDistance);
    const sceneMeshes = player.playerVehicle.scene.meshes;
    const candidates = sceneMeshes.filter((mesh) => {
      if (!mesh.isPickable || !mesh.isEnabled()) return false;
      if (predicate) return predicate(mesh);
      return true;
    });
    if (candidates.length === 0) return null;

    const origin = ray.origin;
    const dir = ray.direction;
    const marchLength = ray.length;
    const step = this.#meshRayMarchStep;
    const p = this.#sharedPoint;

    for (let t = 0; t <= marchLength; t += step) {
      p.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
      for (const mesh of candidates) {
        if (this.#isInsideMeshBounds(mesh, p)) {
          return mesh;
        }
      }
    }

    return null;
  }

  public static pickUsableMesh(
    player: Player,
    maxDistance = Player.REACH_DISTANCE,
  ): AbstractMesh | null {
    return this.#rayMarchFirstMesh(player, maxDistance, (mesh) => {
      const metadata = mesh.metadata;
      return metadata instanceof MetadataContainer && metadata.has("use");
    });
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
   * Returns the first solid non-water block position along the player's view ray.
   */
  public static pickTarget(player: Player): Vector3 | null {
    const hit = this.#raycastFirstBlock(
      player,
      (_x, _y, _z, blockId) =>
        blockId !== BlockType.Air && blockId !== BlockType.Water,
    );
    if (!hit) return null;
    return new Vector3(hit.x, hit.y, hit.z);
  }

  public static pickWaterPlacementTarget(player: Player): Vector3 | null {
    const hit = this.#raycastFirstBlock(
      player,
      (_x, _y, _z, blockId) => blockId === BlockType.Water,
    );
    if (!hit) return null;
    return new Vector3(hit.x, hit.y, hit.z);
  }

  public static getPlacementPosition(player: Player): Vector3 | null {
    const hit = this.#raycastFirstBlock(
      player,
      (_x, _y, _z, blockId) =>
        blockId !== BlockType.Air && blockId !== BlockType.Water,
    );
    if (!hit) return null;

    const hitPos = new Vector3(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz);
    return new Vector3(
      Math.floor(hitPos.x),
      Math.floor(hitPos.y),
      Math.floor(hitPos.z),
    );
  }
  public static getPlacementHit(
    player: Player,
  ): { pos: Vector3; ny: number; hitFracY: number } | null {
    const hit = this.#raycastFirstBlock(
      player,
      (_x, _y, _z, blockId) =>
        blockId !== BlockType.Air && blockId !== BlockType.Water,
    );
    if (!hit) return null;

    const ray = this.#getSharedForwardRay(player, Player.REACH_DISTANCE);

    // exact world Y where the ray struck the block face
    const worldHitY = ray.origin.y + ray.direction.y * hit.t;
    // fractional position within the block (0 = bottom, 1 = top)
    const hitFracY = worldHitY - Math.floor(worldHitY);

    const hitPos = new Vector3(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz);
    const pos = new Vector3(
      Math.floor(hitPos.x),
      Math.floor(hitPos.y),
      Math.floor(hitPos.z),
    );

    return { pos, ny: hit.ny, hitFracY };
  }

  setCrosshair(number: string) {
    this.#crosshair.source = `/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair${number}.png`;
  }
}
