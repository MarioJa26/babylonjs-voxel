import { Ray, Scene, Vector3 } from "@babylonjs/core";
import { Player } from "../Player";
import { DroppedItem } from "./DroppedItem";
import { Item } from "./Item";
import { ItemSlot } from "./ItemSlot";
import { InventoryControls } from "../Controls/InventoryControls";

export class PlayerInventory {
  scene: Scene;
  #player: Player;
  #x: number;
  #y: number;
  #inventorySlots: ItemSlot[][];

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
      this.#player
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
    let itemId = 2;
    let temp = 1;
    for (let i = 0; i < this.#inventorySlots.length && temp < 15; i++) {
      for (let j = 0; j < this.#inventorySlots[i].length; j++) {
        const item = new Item(
          "Fake Item",
          "This is a fake item",
          "/texture/cobble/cobble05_1k/cobble05_diff_1k.png",
          "/texture/cobble/cobble05_1k",
          i,
          j
        );
        item.stackSize = temp++;
        this.#inventorySlots[i][j].item = item;
        this.#inventorySlots[i][j].divItemSlot!.appendChild(item.div);
      }
    }
    let x = 0;
    let y = 1;
    let item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/metal/factory_wall_1k/factory_wall_diff_1k.png",
      "/texture/metal/factory_wall_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 0;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/sand/gravelly_sand_1k/gravelly_sand_diff_1k.png",
      "/texture/sand/gravelly_sand_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 0;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/brick/brick_wall_10_1k/brick_wall_10_diff_1k.png",
      "/texture/brick/brick_wall_10_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 0;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/brick/castle_brick_02_red_1k/castle_brick_02_red_diff_1k.png",
      "/texture/brick/castle_brick_02_red_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 0;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/metal/metal01_1k/metal01_diff_1k.png",
      "/texture/metal/metal01_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 0;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/stone/concrete_tile_facade_1k/concrete_tile_facade_diff_1k.png",
      "/texture/stone/concrete_tile_facade_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 0;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/stone/gray_rocks_1k/gray_rocks_diff_1k.png",
      "/texture/stone/gray_rocks_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 0;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/stone/stone_tile_wall_1k/stone_tile_wall_diff_1k.png",
      "/texture/stone/stone_tile_wall_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 0;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/wood/bark_willow_02_1k/bark_willow_02_diff_1k.png",
      "/texture/wood/bark_willow_02_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 1;
    y = 0;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/wood/diagonal_parquet_1k/diagonal_parquet_diff_1k.png",
      "/texture/wood/diagonal_parquet_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 1;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/wood/old_wood_floor_1k/old_wood_floor_diff_1k.png",
      "/texture/wood/old_wood_floor_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 1;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/wood/wood_table_1k/wood_table_diff_1k.png",
      "/texture/wood/wood_table_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 1;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/dirt/rocky_terrain_02_1k/rocky_terrain_02_diff_1k.png",
      "/texture/dirt/rocky_terrain_02_1k",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);

    x = 1;
    y++;
    item = new Item(
      "Fake Item",
      "This is a fake item",
      "/texture/dirt/Grass001_1K/Grass001_diff_1K.png",
      "/texture/dirt/Grass001_1K",
      x,
      y
    );
    item.itemId = itemId++;
    this.#inventorySlots[x][y] = new ItemSlot(x, y);
    this.#inventorySlots[x][y].item = item;
    this.#inventorySlots[x][y].divItemSlot!.appendChild(item.div);
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
    return item.stackSize;
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
      item.materialFolder,
      -1, // No row
      -1 // No col
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
      dropPosition.z
    );

    droppedItem.pushItem(cam.direction.scale(3));

    if (item.stackSize <= 0) this.deleteItem(item);
  }

  public moveItemToHotbar(slotFocused: ItemSlot): void {
    this.moveItem(slotFocused, [0, 0]);
  }

  public moveItemToInventory(slotFocused: ItemSlot): void {
    this.moveItem(slotFocused, [1, this.inventory.length - 1]);
  }
  public moveItem(
    slotFocused: ItemSlot,
    targetBarIndexRange: [number, number]
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
  }

  public deleteItem(item: Item) {
    if (!item) return;

    item.div.parentElement?.removeChild(item.div);
    this.#inventorySlots[item.row][item.col].clearItemSlots();
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
