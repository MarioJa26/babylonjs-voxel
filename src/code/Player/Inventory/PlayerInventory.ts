import { addVec3, type SceneContext, vec3 } from "@babylonjs/lite";
import { Observable } from "@/code/Lib/Math";
import { InventoryControls } from "../Controls/InventoryControls";
import { generateShapeVariants } from "../Crafting/ShapeVariantGenerator";
import type { Player } from "../Player";
import { DroppedItem } from "./DroppedItem";
import { Item } from "./Item";
import {
	ensureItemRegistryLoaded,
	getAllRegisteredItems,
} from "./ItemRegistry";
import { ItemSlot } from "./ItemSlot";
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
	scene: SceneContext;
	#player: Player;
	#x: number;
	#y: number;
	#inventorySlots: ItemSlot[][];

	public onInventoryChangedObservable = new Observable<void>();
	#inventoryControls: InventoryControls;

	public static currentlyHoveredSlot: ItemSlot | null = null;

	constructor(scene: SceneContext, player: Player, x: number, y: number) {
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
		void this.#loadInitialItems();
	}

	#generateInventorySlots() {
		for (let i = 0; i < this.#inventorySlots.length; i++) {
			for (let j = 0; j < this.#inventorySlots[i].length; j++) {
				this.#inventorySlots[i][j] = new ItemSlot(i, j);
			}
		}
	}

	async #loadInitialItems() {
		await ensureItemRegistryLoaded();
		await generateShapeVariants();
		this.#generateFakeItems();
	}

	#generateFakeItems() {
		const definitions = getAllRegisteredItems();
		const width = this.#inventorySlots[0].length;
		const height = this.#inventorySlots.length;
		const slotCount = width * height;
		const placed = new Set<number>();

		const placeItem = (
			def: (typeof definitions)[number],
			row: number,
			col: number,
		) => {
			if (this.#inventorySlots[row][col].item) return false;
			const item = this.#createItemById(def.id, row, col);
			if (!item) return false;
			item.stackSize = def.maxStack ?? Math.min(64, def.id);
			this.#inventorySlots[row][col].item = item;
			this.#inventorySlots[row][col].divItemSlot?.appendChild(item.div);
			placed.add(def.id);
			return true;
		};

		// Pass 1: Keep existing IDs in their slots when they fit the grid.
		for (const def of definitions) {
			if (placed.has(def.id)) continue;
			if (def.id < 1 || def.id > slotCount) continue;
			const row = Math.floor((def.id - 1) / width);
			const col = (def.id - 1) % width;
			placeItem(def, row, col);
		}

		// Pass 2: Fill remaining empty slots with any extra items (variants, etc.).
		const emptySlots: Array<[number, number]> = [];
		for (let row = 0; row < height; row++) {
			for (let col = 0; col < width; col++) {
				if (!this.#inventorySlots[row][col].item) {
					emptySlots.push([row, col]);
				}
			}
		}

		let emptyIndex = 0;
		for (const def of definitions) {
			if (placed.has(def.id)) continue;
			if (emptyIndex >= emptySlots.length) break;
			const [row, col] = emptySlots[emptyIndex++];
			placeItem(def, row, col);
		}
	}

	#createItemById(itemId: number, row: number, col: number): Item | null {
		try {
			return Item.createById(itemId, row, col);
		} catch {
			return null;
		}
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
		let item: Item;
		try {
			item = Item.createById(itemId, -1, -1);
		} catch {
			return;
		}
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
		);
		worldItem.itemId = item.itemId;
		worldItem.blockId = item.blockId ?? item.itemId;
		worldItem.blockState = item.blockState ?? 0;
		worldItem.refreshIconStyle();
		worldItem.stackSize = quantity ?? item.stackSize;
		item.stackSize -= worldItem.stackSize;

		// Drop from the player's current world position (Lite PlayerVehicle has
		// no display capsule — use the plain position instead).
		const playerPosition = vec3(
			this.#player.position.x,
			this.#player.position.y,
			this.#player.position.z,
		);

		// Full 3D look direction so the item lands in front of AND in the
		// direction the player is looking (including pitch).
		const forward = this.#player.playerCamera.getForwardDirection();
		const dropPosition = addVec3(playerPosition, forward);

		const droppedItem = new DroppedItem(
			worldItem,
			dropPosition.x,
			dropPosition.y + 0.5,
			dropPosition.z,
		);

		// Launch in the look direction, plus the player's own momentum so the
		// item inherits the player's movement (thrown forward while running).
		droppedItem.addVelocity(
			forward.x * 8 + this.#player.velocity.x,
			forward.y * 8 + this.#player.velocity.y,
			forward.z * 8 + this.#player.velocity.z,
		);

		if (item.row >= 0 && item.col >= 0) {
			if (item.stackSize <= 0) {
				this.deleteItem(item);
				return;
			}
		}
		this.onInventoryChangedObservable.notifyObservers();
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
		const slot =
			item.row >= 0 && item.col >= 0
				? this.#inventorySlots[item.row]?.[item.col]
				: undefined;
		slot?.clearItemSlots();
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
