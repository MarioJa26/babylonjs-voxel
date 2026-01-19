import {
  Mesh,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { Item } from "./Item";
import { IUsable } from "@/code/Inferface/IUsable";
import { Player } from "../Player";
import { MetadataContainer } from "@/code/Entities/MetaDataContainer";
import { Map1 } from "@/code/Maps/Map1";
import { MaterialFactory } from "@/code/World/Texture/MaterialFactory";

export class DroppedItem implements IUsable {
  #boxMesh: Mesh;
  #item: Item;

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
      item.materialFolder, // folder
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

    new PhysicsAggregate(
      this.#boxMesh,
      PhysicsShapeType.BOX,
      { mass: size },
      Map1.mainScene,
    );

    this.#item = item;
  }

  pushItem(direction: Vector3): void {
    this.#boxMesh
      .getPhysicsBody()
      ?.applyImpulse(direction, this.#boxMesh.getAbsolutePosition());
  }

  use(player: Player): void {
    const remainder = player.playerInventory.addItem(this.#item);
    if (remainder <= 0) {
      this.#boxMesh.dispose();
    }
  }
  private static createTexture(
    scene: Scene,
    path: string,
    uvScale: number,
  ): Texture {
    const tex = new Texture(path, scene);
    tex.uScale = uvScale;
    tex.vScale = uvScale;
    return tex;
  }
  get boxMesh(): Mesh {
    return this.#boxMesh;
  }

  get item(): Item {
    return this.#item;
  }
}
