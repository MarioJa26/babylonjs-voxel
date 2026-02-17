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
import { VoxelAabbCollider } from "@/code/World/Collision/VoxelAabbCollider";

export class DroppedItem implements IUsable {
  #boxMesh: Mesh;
  #item: Item;
  #velocity = Vector3.Zero();
  #halfSize = 0.25;
  #voxelCollider!: VoxelAabbCollider;
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
    this.#voxelCollider = new VoxelAabbCollider(
      new Vector3(this.#halfSize, this.#halfSize, this.#halfSize),
      (x, y, z) => {
        const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
        return blockId !== 0 && blockId !== 30;
      },
      DroppedItem.EPSILON,
      {
        scene: Map1.mainScene,
        name: "droppedItemAABB",
        position: this.#boxMesh.position,
        renderingGroupId: 1,
      },
    );

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
    this.#voxelCollider.dispose();
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
    this.#voxelCollider.moveAxis(
      this.#boxMesh.position,
      this.#velocity,
      axis,
      delta,
      DroppedItem.STEP_SIZE,
    );
  }

  #overlapsSolid(position: Vector3): boolean {
    return this.#voxelCollider.overlaps(position);
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
