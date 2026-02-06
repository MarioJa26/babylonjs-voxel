import { Observable, Ray, Scene, Vector3 } from "@babylonjs/core";
import { Player } from "../Player";
import { DroppedItem } from "./DroppedItem";
import { Item } from "./Item";
import { ItemSlot } from "./ItemSlot";
import { InventoryControls } from "../Controls/InventoryControls";
import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import { MaterialFactory } from "@/code/World/Texture/MaterialFactory";
import { AdvancedBoat } from "@/code/Entities/AdvancedBoat";
import { Map1 } from "@/code/Maps/Map1";
import { GenerationParams } from "@/code/World/Generation/NoiseAndParameters/GenerationParams";

export class PlayerInventory {
  scene: Scene;
  #player: Player;
  #x: number;
  #y: number;
  #inventorySlots: ItemSlot[][];

  public onInventoryChangedObservable = new Observable<void>();
  #inventoryControls: InventoryControls;

  public static currentlyHoveredSlot: ItemSlot | null = null;

  constructor(scene: Scene, player: Player, x: number, y: number) {
    this.scene = scene;
    this.#player = player;
    this.#x = x;
    this.#y = y;
    this.#inventorySlots = Array.from({ length: y }, () => Array(x).fill(null));

    this.#inventoryControls = new InventoryControls(
      this,
      player.keyboardControls,
      this.#player,
    );

    this.#generateInventorySlots();
    this.#generateFakeItems();
  }

  #generateInventorySlots() {
    for (let i = 0; i < this.#inventorySlots.length; i++) {
      for (let j = 0; j < this.#inventorySlots[i].length; j++) {
        this.#inventorySlots[i][j] = new ItemSlot(i, j);
      }
    }
  }

  #generateFakeItems() {
    for (const textureDef of TextureDefinitions) {
      const i = Math.floor(
        (textureDef.id - 1) / this.#inventorySlots[0].length,
      );
      // Only add the item if it fits within the inventory's height
      if (i < this.#inventorySlots.length) {
        const j = (textureDef.id - 1) % this.#inventorySlots[0].length;
        const item = new Item(
          textureDef.name,
          "Description for " + textureDef.name,
          MaterialFactory.getTexturePathFromFolder(textureDef.path)!,
          i,
          j,
          textureDef.path,
        );
        item.itemId = textureDef.id;
        item.stackSize = textureDef.id;
        this.#inventorySlots[i][j].item = item;
        this.#inventorySlots[i][j].divItemSlot!.appendChild(item.div);
      }
    }

    const boat = new Item(
      "Small Row Boat",
      "Boat",
      "/texture/other/boat-row-small.png",
      9,
      9,
    );
    boat.stackSize = 1;
    boat.use = (player: Player) => {
      const ray: Ray = player.playerCamera.playerCamera.getForwardRay(200);
      const pick = Map1.mainScene.pickWithRay(ray);

      new AdvancedBoat(
        Map1.mainScene,
        player,
        GenerationParams.SEA_LEVEL,
        pick?.pickedPoint || player.position,
      );
    };
    boat.name = "Boat";
    boat.itemId = 100;
    this.#inventorySlots[9][9].item = boat;
    this.#inventorySlots[9][9].divItemSlot!.appendChild(boat.div);
  }

  public addItem(item: Item): number {
    for (let i = 0; i < this.#inventorySlots.length; i++) {
      for (let j = 0; j < this.#inventorySlots[i].length; j++) {
        if (this.#inventorySlots[i][j].item) {
          const itemInInventory = this.#inventorySlots[i][j].item!;
          const remainder = Item.stackItemAtoB(item, itemInInventory);

          if (remainder <= 0) return remainder;
          else continue;
        } else {
          item.row = i;
          item.col = j;
          this.#inventorySlots[i][j].item = item;
          this.#inventorySlots[i][j].divItemSlot.appendChild(item.div);
          return 0;
        }
      }
    }
    this.onInventoryChangedObservable.notifyObservers();
    return item.stackSize;
  }

  public hasItem(itemId: number, count: number): boolean {
    let found = 0;
    for (const row of this.#inventorySlots) {
      for (const slot of row) {
        if (slot.item && slot.item.itemId === itemId) {
          found += slot.item.stackSize;
          if (found >= count) return true;
        }
      }
    }
    return false;
  }

  public removeItems(itemId: number, count: number): void {
    let remaining = count;
    for (const row of this.#inventorySlots) {
      for (const slot of row) {
        if (remaining <= 0) return;
        if (slot.item && slot.item.itemId === itemId) {
          if (slot.item.stackSize > remaining) {
            slot.item.stackSize -= remaining;
            remaining = 0;
          } else {
            remaining -= slot.item.stackSize;
            this.deleteItem(slot.item);
          }
        }
      }
    }
    this.onInventoryChangedObservable.notifyObservers();
  }

  public createAndAddItem(itemId: number, count: number): void {
    const textureDef = TextureDefinitions.find((t) => t.id === itemId);
    if (!textureDef) return;

    const item = new Item(
      textureDef.name,
      "Crafted Item",
      textureDef.path,
      -1,
      -1,
      MaterialFactory.getTexturePathFromFolder(textureDef.path)!,
    );
    item.itemId = itemId;
    item.stackSize = count;

    const remainder = this.addItem(item);
    if (remainder > 0) {
      this.dropItem(item, remainder);
    }
  }

  public dropItemFromHotbar() {
    const item =
      this.#inventorySlots[0][this.#player.playerHud.selectedHotbarSlot].item;

    if (item) {
      if (this.#inventoryControls.underlyingControls.pressedKeys.has("control"))
        this.dropItem(item, item.stackSize);
      else this.dropItem(item, 1);
    }
  }
  public dropItem(item: Item, quantity?: number) {
    if (!item || item.stackSize <= 0) return; // Create a new, clean Item instance for the world to prevent state corruption. // This decouples the inventory item from the world item.
    const worldItem = new Item(
      item.name,
      item.description,
      item.icon,
      -1, // No row
      -1, // No col
      item.materialFolder,
    );
    worldItem.itemId = item.itemId;
    worldItem.stackSize = quantity ?? item.stackSize;
    item.stackSize -= worldItem.stackSize;

    const playerPosition =
      this.#player.playerVehicle.displayCapsule.position.clone();

    const cam =
      this.scene.activeCamera?.getForwardRay() ??
      new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, 0));
    const dropPosition = playerPosition.add(cam.direction.scale(2)); // Create the dropped item at the calculated position using the new clean item

    const droppedItem = new DroppedItem(
      worldItem,
      dropPosition.x,
      dropPosition.y + 0.5,
      dropPosition.z,
    );

    droppedItem.pushItem(cam.direction.scale(3));

    if (item.stackSize <= 0) {
      this.deleteItem(item);
    } else this.onInventoryChangedObservable.notifyObservers();
  }

  public moveItemToHotbar(slotFocused: ItemSlot): void {
    this.moveItem(slotFocused, [0, 0]);
  }

  public moveItemToInventory(slotFocused: ItemSlot): void {
    this.moveItem(slotFocused, [1, this.inventory.length - 1]);
  }
  public moveItem(
    slotFocused: ItemSlot,
    targetBarIndexRange: [number, number],
  ): void {
    const itemToMove = slotFocused.item;
    if (!itemToMove) return;

    // --- First Pass: Try to stack with existing items ---
    for (
      let barIndex = targetBarIndexRange[0];
      barIndex <= targetBarIndexRange[1];
      barIndex++
    ) {
      for (let i = 0; i < this.inventory[barIndex].length; i++) {
        const slot = this.inventory[barIndex][i];
        const itemInSlot = slot.item;

        if (itemInSlot && itemInSlot.itemId === itemToMove.itemId) {
          const remainder = Item.stackItemAtoB(itemToMove, itemInSlot);
          if (remainder === 0) {
            slotFocused.clearItemSlots();
            return;
          }
        }
      }
    }

    // --- Second Pass: Move to an empty slot ---
    for (
      let barIndex = targetBarIndexRange[0];
      barIndex <= targetBarIndexRange[1];
      barIndex++
    ) {
      for (let i = 0; i < this.inventory[barIndex].length; i++) {
        const slot = this.inventory[barIndex][i];
        if (!slot.item) {
          slotFocused.clearItemSlots();

          itemToMove.row = slot.row;
          itemToMove.col = slot.col;
          slot.divItemSlot.appendChild(itemToMove.div);
          slot.item = itemToMove;

          return;
        }
      }
    }
    this.onInventoryChangedObservable.notifyObservers();
  }

  public deleteItem(item: Item) {
    if (!item) return;

    item.div.parentElement?.removeChild(item.div);
    this.#inventorySlots[item.row][item.col].clearItemSlots();
    this.onInventoryChangedObservable.notifyObservers();
  }

  public get inventoryControls(): InventoryControls {
    return this.#inventoryControls;
  }

  public set inventoryControls(value: InventoryControls) {
    this.#inventoryControls = value;
  }

  public get inventory(): ItemSlot[][] {
    return this.#inventorySlots;
  }

  get x(): number {
    return this.#x;
  }

  get y(): number {
    return this.#y;
  }
}
