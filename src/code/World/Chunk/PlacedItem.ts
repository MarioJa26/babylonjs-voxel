import {
  MeshBuilder,
  PhysicsAggregate,
  PhysicsShapeType,
} from "@babylonjs/core";
import { Map1 } from "@/code/Maps/Map1";
import { Item } from "@/code/Player/Inventory/Item";

export class PlacedItem {
  #physBox: PhysicsAggregate;
  #item: Item;

  static readonly SIZE = 1;

  constructor(item: Item, x: number, y: number, z: number) {
    const collider = MeshBuilder.CreateBox(
      "blockCollider",
      { size: PlacedItem.SIZE },
      Map1.mainScene
    );
    collider.visibility = 0;
    collider.isPickable = false;
    collider.position.set(x + 0.5, y + 0.5, z + 0.5);

    this.#physBox = new PhysicsAggregate(
      collider,
      PhysicsShapeType.BOX,
      { mass: 0 },
      Map1.mainScene
    );

    this.#item = item;
  }

  get physBox(): PhysicsAggregate {
    return this.#physBox;
  }
  get item(): Item {
    return this.#item;
  }
}
