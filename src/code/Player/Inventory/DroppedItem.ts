import {
  Mesh,
  MeshBuilder,
  Observer,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { Item } from "./Item";
import { IUsable } from "@/code/Inferface/IUsable";
import { Player } from "../Player";
import { MetadataContainer } from "@/code/Entities/MetaDataContainer";
import { Map1 } from "@/code/Maps/Map1";
import { MaterialFactory } from "@/code/World/Texture/MaterialFactory";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";

export class DroppedItem implements IUsable {
  #boxMesh: Mesh;
  #item: Item;
  #velocity = Vector3.Zero();
  #halfSize = 0.25;
  #observer: Observer<Scene> | null = null;
  static readonly GRAVITY = -18;
  static readonly STEP_SIZE = 0.2;
  static readonly EPSILON = 0.001;
  static readonly AIR_DAMPING_PER_SEC = 1.8;
  static readonly GROUND_DAMPING_PER_SEC = 8.0;
  static readonly MIN_SPEED = 0.03;

  constructor(item: Item, x: number, y: number, z: number) {
    const size = 0.5 + item.stackSize * 0.005;
    this.#boxMesh = MeshBuilder.CreateBox(
      "box",
      { width: size, height: size, depth: size },
      Map1.mainScene,
    );
    this.#boxMesh.metadata = new MetadataContainer();
    this.#boxMesh.metadata.add("use", (player: Player) => this.use(player));

    this.#boxMesh.isPickable = true;
    this.#boxMesh.position = new Vector3(x, y, z);
    const midMat = new StandardMaterial("midGrid", Map1.mainScene);

    const concreteMat = MaterialFactory.createMaterialByFolder(
      Map1.mainScene,
      item.materialFolder || "", // folder
      1, // uvScale
      ".png", // extension
      true, // diff
      true, // nor
      true, // ao
      false, // spec
    );
    midMat.diffuseTexture = concreteMat.diffuseTexture;
    midMat.bumpTexture = concreteMat.bumpTexture;
    midMat.ambientTexture = concreteMat.ambientTexture;
    this.#boxMesh.material = midMat;

    this.#boxMesh.renderingGroupId = 1;
    this.#halfSize = size * 0.5;
    this.#item = item;

    this.#observer = Map1.mainScene.onBeforeRenderObservable.add(() => {
      this.#updatePhysics();
    });
  }

  pushItem(direction: Vector3): void {
    this.#velocity.addInPlace(direction);
  }

  use(player: Player): void {
    const remainder = player.playerInventory.addItem(this.#item);
    if (remainder <= 0) {
      this.#dispose();
    }
  }
  #dispose(): void {
    if (this.#observer) {
      Map1.mainScene.onBeforeRenderObservable.remove(this.#observer);
      this.#observer = null;
    }
    this.#boxMesh.dispose();
  }

  #updatePhysics(): void {
    if (this.#boxMesh.isDisposed()) {
      if (this.#observer) {
        Map1.mainScene.onBeforeRenderObservable.remove(this.#observer);
        this.#observer = null;
      }
      return;
    }

    const dt = Map1.mainScene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    this.#velocity.y += DroppedItem.GRAVITY * dt;
    this.#moveAxis("x", this.#velocity.x * dt);
    this.#moveAxis("y", this.#velocity.y * dt);
    this.#moveAxis("z", this.#velocity.z * dt);

    const grounded = this.#isGrounded();
    const damping = grounded
      ? DroppedItem.GROUND_DAMPING_PER_SEC
      : DroppedItem.AIR_DAMPING_PER_SEC;
    const keep = Math.max(0, 1 - damping * dt);
    this.#velocity.scaleInPlace(keep);

    if (grounded && this.#velocity.y < 0) {
      this.#velocity.y = 0;
    }

    if (Math.abs(this.#velocity.x) < DroppedItem.MIN_SPEED) {
      this.#velocity.x = 0;
    }
    if (Math.abs(this.#velocity.y) < DroppedItem.MIN_SPEED) {
      this.#velocity.y = 0;
    }
    if (Math.abs(this.#velocity.z) < DroppedItem.MIN_SPEED) {
      this.#velocity.z = 0;
    }
  }

  #moveAxis(axis: "x" | "y" | "z", delta: number): void {
    if (delta === 0) return;
    let remaining = delta;

    while (Math.abs(remaining) > 0) {
      const step =
        Math.abs(remaining) > DroppedItem.STEP_SIZE
          ? DroppedItem.STEP_SIZE * Math.sign(remaining)
          : remaining;

      const pos = this.#boxMesh.position.clone();
      if (axis === "x") pos.x += step;
      else if (axis === "y") pos.y += step;
      else pos.z += step;

      if (this.#overlapsSolid(pos)) {
        if (axis === "x") this.#velocity.x = 0;
        else if (axis === "y") this.#velocity.y = 0;
        else this.#velocity.z = 0;
        break;
      }

      this.#boxMesh.position.copyFrom(pos);
      remaining -= step;
    }
  }

  #overlapsSolid(position: Vector3): boolean {
    const minX = position.x - this.#halfSize;
    const maxX = position.x + this.#halfSize;
    const minY = position.y - this.#halfSize;
    const maxY = position.y + this.#halfSize;
    const minZ = position.z - this.#halfSize;
    const maxZ = position.z + this.#halfSize;

    const x0 = Math.floor(minX + DroppedItem.EPSILON);
    const x1 = Math.floor(maxX - DroppedItem.EPSILON);
    const y0 = Math.floor(minY + DroppedItem.EPSILON);
    const y1 = Math.floor(maxY - DroppedItem.EPSILON);
    const z0 = Math.floor(minZ + DroppedItem.EPSILON);
    const z1 = Math.floor(maxZ - DroppedItem.EPSILON);

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
          if (blockId !== 0 && blockId !== 30) {
            return true;
          }
        }
      }
    }
    return false;
  }

  #isGrounded(): boolean {
    const probe = this.#boxMesh.position.clone();
    probe.y -= 0.06;
    return this.#overlapsSolid(probe);
  }

  get boxMesh(): Mesh {
    return this.#boxMesh;
  }

  get item(): Item {
    return this.#item;
  }
}
