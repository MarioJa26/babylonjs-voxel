import { Observable, Ray, Scene, Vector3 } from "@babylonjs/core";
import { Player } from "../Player";
import { DroppedItem } from "./DroppedItem";
import { Item } from "./Item";
import { ItemSlot } from "./ItemSlot";
import { InventoryControls } from "../Controls/InventoryControls";
import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import { MaterialFactory } from "@/code/World/Texture/MaterialFactory";
import { CrossHair } from "../Hud/CrossHair";
import { BlockType } from "@/code/World/BlockType";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { AdvancedBoat } from "@/code/Entities/AdvancedBoat";
import { Map1 } from "@/code/Maps/Map1";
import { GenerationParams } from "@/code/World/Generation/NoiseAndParameters/GenerationParams";

export type SavedInventoryItem = {
  itemId: number;
  stackSize: number;
};

export type SavedInventoryState = {
  width: number;
  height: number;
  slots: (SavedInventoryItem | null)[][];
};

export class PlayerInventory {
  private static readonly BOAT_ITEM_ID = 100;

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
        const item = this.#createItemById(textureDef.id, i, j);
        if (!item) continue;
        item.itemId = textureDef.id;
        item.stackSize = textureDef.id;
        this.#inventorySlots[i][j].item = item;
        this.#inventorySlots[i][j].divItemSlot!.appendChild(item.div);
      }
    }

    const boat = this.#createItemById(PlayerInventory.BOAT_ITEM_ID, 9, 9);
    if (!boat) return;
    this.#inventorySlots[9][9].item = boat;
    this.#inventorySlots[9][9].divItemSlot!.appendChild(boat.div);
  }

  #createItemById(itemId: number, row: number, col: number): Item | null {
    if (itemId === PlayerInventory.BOAT_ITEM_ID) {
      return this.#createBoatItem(row, col);
    }

    const textureDef = TextureDefinitions.find((t) => t.id === itemId);
    if (!textureDef) return null;

    const item = new Item(
      textureDef.name,
      "Description for " + textureDef.name,
      MaterialFactory.getTexturePathFromFolder(textureDef.path)!,
      row,
      col,
      textureDef.path,
    );
    item.itemId = textureDef.id;
    return item;
  }

  #createBoatItem(row: number, col: number): Item {
    const boat = new Item(
      "Small Row Boat",
      "Boat",
      "/texture/other/boat-row-small.png",
      row,
      col,
    );
    boat.stackSize = 1;
    boat.use = (player: Player) => {
      const hit = CrossHair.pickWaterPlacementTarget(player);
      if (!hit) return;

      const blockAtHit = ChunkLoadingSystem.getBlockByWorldCoords(
        hit.x,
        hit.y,
        hit.z,
      );
      // We only target actual water blocks for boat placement.
      if (blockAtHit !== BlockType.Water) {
        console.log("Boat must be placed on water.");
        return;
      }

      // Place the boat on top of the water, not inside it.
      const spawnY = hit.y + 1;

      // The boat's center will be at this position.
      const spawnPos = new Vector3(hit.x + 0.5, spawnY + 0.5, hit.z + 0.5);

      // The boat's collision half-extents are (1.15, 0.6, 2.1).
      // We need space for the boat to spawn without being inside a solid block.
      // We check a 3x2x5 area (width, height, depth).
      const halfWidth = 1; // ceil(1.15) -> 2, so 1 block on each side. Total 3 wide.
      const halfHeight = 1; // ceil(0.6) -> 1, so 1 block up. Total 2 high.
      const halfDepth = 2; // ceil(2.1) -> 3, so 2 blocks on each side. Total 5 deep.

      for (let y = 0; y < halfHeight * 2; y++) {
        for (let x = -halfWidth; x <= halfWidth; x++) {
          for (let z = -halfDepth; z <= halfDepth; z++) {
            // Check around the block where the boat will be centered
            const checkX = hit.x + x;
            const checkY = spawnY + y;
            const checkZ = hit.z + z;

            const blockId = ChunkLoadingSystem.getBlockByWorldCoords(
              checkX,
              checkY,
              checkZ,
            );

            // We can only place in air or water.
            if (blockId !== BlockType.Air && blockId !== BlockType.Water) {
              console.log("Not enough space to place the boat.");
              return;
            }
          }
        }
      }

      new AdvancedBoat(
        Map1.mainScene,
        player,
        GenerationParams.SEA_LEVEL,
        spawnPos,
      );
    };
    boat.name = "Boat";
    boat.itemId = PlayerInventory.BOAT_ITEM_ID;
    return boat;
  }

  public getSavedInventoryState(): SavedInventoryState {
    const slots: (SavedInventoryItem | null)[][] = [];
    for (let row = 0; row < this.#inventorySlots.length; row++) {
      const savedRow: (SavedInventoryItem | null)[] = [];
      for (let col = 0; col < this.#inventorySlots[row].length; col++) {
        const item = this.#inventorySlots[row][col].item;
        if (!item) {
          savedRow.push(null);
          continue;
        }

        savedRow.push({
          itemId: item.itemId,
          stackSize: item.stackSize,
        });
      }
      slots.push(savedRow);
    }

    return {
      width: this.#x,
      height: this.#y,
      slots,
    };
  }

  public restoreSavedInventoryState(savedState: unknown): boolean {
    if (!this.#isValidSavedInventoryState(savedState)) {
      return false;
    }

    this.#clearInventory();

    for (let row = 0; row < savedState.slots.length; row++) {
      for (let col = 0; col < savedState.slots[row].length; col++) {
        const savedItem = savedState.slots[row][col];
        if (!savedItem) continue;

        const item = this.#createItemById(savedItem.itemId, row, col);
        if (!item) continue;
        item.stackSize = savedItem.stackSize;
        this.#inventorySlots[row][col].item = item;
        this.#inventorySlots[row][col].divItemSlot.appendChild(item.div);
      }
    }

    this.onInventoryChangedObservable.notifyObservers();
    return true;
  }

  #clearInventory(): void {
    for (const row of this.#inventorySlots) {
      for (const slot of row) {
        slot.clearItemSlots();
      }
    }
  }

  #isValidSavedInventoryState(
    savedState: unknown,
  ): savedState is SavedInventoryState {
    if (!savedState || typeof savedState !== "object") return false;

    const candidate = savedState as Partial<SavedInventoryState>;
    if (
      candidate.width !== this.#x ||
      candidate.height !== this.#y ||
      !Array.isArray(candidate.slots) ||
      candidate.slots.length !== this.#y
    ) {
      return false;
    }

    for (const row of candidate.slots) {
      if (!Array.isArray(row) || row.length !== this.#x) return false;
      for (const slot of row) {
        if (slot === null) continue;
        if (!this.#isValidSavedInventoryItem(slot)) return false;
      }
    }

    return true;
  }

  #isValidSavedInventoryItem(value: unknown): value is SavedInventoryItem {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<SavedInventoryItem>;
    return (
      Number.isInteger(item.itemId) &&
      Number.isInteger(item.stackSize) &&
      item.stackSize! > 0
    );
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
      MaterialFactory.getTexturePathFromFolder(textureDef.path)!,
      -1,
      -1,
      textureDef.path,
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

    droppedItem.pushItem(cam.direction.scale(6));

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
