import { Color3, StandardMaterial } from "@babylonjs/core";
import { MaterialFactory } from "../../World/Texture/MaterialFactory";
import { Map1 } from "@/code/Maps/Map1";
import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import { IUsable } from "@/code/Inferface/IUsable";
import { Player } from "../Player";

export class Item implements IUsable {
  name: string;
  description: string;
  icon: string;
  materialFolder: string;
  material: StandardMaterial;

  itemId = 1;

  #maxStack = 64;
  #stackSize = Math.round(Math.random() * this.#maxStack);
  #div: HTMLDivElement = document.createElement("div");
  #stackLabel: HTMLSpanElement = document.createElement("span");
  row: number;
  col: number;

  constructor(
    name: string,
    description: string,
    icon: string,
    materialFolder: string,
    row: number,
    col: number,
  ) {
    this.name = name;
    this.description = description;
    this.icon = icon;
    this.materialFolder = materialFolder;
    this.material = MaterialFactory.createMaterialByFolder(
      Map1.mainScene,
      materialFolder,
      1,
      ".png",
      true,
      true,
      true,
      false,
    );
    this.material.specularColor = new Color3(0.24, 0.3, 0.3);
    this.row = row;
    this.col = col;
    this.#div = this.createDiv();
  }

  static createById(itemId: number): Item {
    const textureDef = TextureDefinitions.find((t) => t.id === itemId);
    if (!textureDef) throw new Error("Item not found");
    const item = new Item(
      textureDef.name,
      "Crafted Item",
      MaterialFactory.getTexturePathFromFolder(textureDef.path)!,
      textureDef.path,
      -1,
      -1,
    );
    item.itemId = itemId;

    return item;
  }

  use(player: Player): void {
    //
  }

  createDiv(): HTMLDivElement {
    this.#div.classList.add("inventory-item");
    this.#div.style.backgroundImage = `url(${this.icon})`;

    this.#stackLabel.innerText = this.#stackSize.toString();
    this.#stackLabel.classList.add("stack-label");

    this.#div.appendChild(this.#stackLabel);

    this.#div.draggable = true;

    return this.#div;
  }

  public static stackItemAtoB(itemA: Item, itemB: Item): number {
    if (itemA.itemId !== itemB.itemId) return itemA.stackSize;
    //StackSize is limited to maxStackSize
    const stackSize = itemA.stackSize + itemB.stackSize;
    itemB.stackSize = stackSize;
    itemA.stackSize = stackSize - itemB.stackSize;
    if (itemA.stackSize <= 0) {
      itemA.div.parentElement?.removeChild(itemA.div);
      return 0;
    }
    return itemA.stackSize;
  }

  public set stackSize(value: number) {
    this.#stackSize = Math.min(value, this.#maxStack);
    this.#stackLabel.innerText = this.#stackSize.toString();
  }
  public get stackSize(): number {
    return this.#stackSize;
  }

  get div(): HTMLDivElement {
    return this.#div;
  }
}
