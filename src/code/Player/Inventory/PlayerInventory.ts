import type { SceneContext } from "@babylonjs/lite";
import { Observable } from "@/code/Lib/Math";
import { InventoryControls } from "../Controls/InventoryControls";
import { generateShapeVariants } from "../Crafting/ShapeVariantGenerator";
import type { Player } from "../Player";
import { dropWorldItem } from "./dropWorldItem";
import { Item } from "./Item";
import { ensureItemRegistryLoaded } from "./ItemRegistry";
import { ItemSlot } from "./ItemSlot";
import type {
	SavedInventoryItem,
	SavedInventoryState,
} from "./Types/InventoryTypes";

export class PlayerInventory {
	scene: SceneContext;

	#player: Player;
	#x: number;
	#y: number;
	#inventorySlots: ItemSlot[][];
	#inventoryControls: InventoryControls;

	public onInventoryChangedObservable = new Observable<void>();

	public static currentlyHoveredSlot: ItemSlot | null = null;

	constructor(scene: SceneContext, player: Player, x: number, y: number) {
		this.scene = scene;
		this.#player = player;
		this.#x = x;
		this.#y = y;
		this.#inventorySlots = new Array<ItemSlot[]>(y);

		this.#inventoryControls = new InventoryControls(
			this,
			player.keyboardControls,
			player,
		);

		this.#generateInventorySlots();
		void this.#loadInitialItems();
	}

	#generateInventorySlots(): void {
		const height = this.#y;
		const width = this.#x;

		for (let row = 0; row < height; row++) {
			const slots = new Array<ItemSlot>(width);

			for (let col = 0; col < width; col++) {
				slots[col] = new ItemSlot(row, col);
			}

			this.#inventorySlots[row] = slots;
		}
	}

	async #loadInitialItems(): Promise<void> {
		await ensureItemRegistryLoaded();
		await generateShapeVariants();
		this.onInventoryChangedObservable.notifyObservers();
	}

	#createItemById(itemId: number, row: number, col: number): Item | null {
		try {
			return Item.createById(itemId, row, col);
		} catch {
			return null;
		}
	}

	#placeItemInSlot(slot: ItemSlot, item: Item): void {
		item.row = slot.row;
		item.col = slot.col;
		slot.item = item;

		const div = slot.divItemSlot;

		if (item.div.parentElement !== div) {
			div.appendChild(item.div);
		}
	}

	#clearInventory(): void {
		const slots = this.#inventorySlots;

		for (let row = 0, height = slots.length; row < height; row++) {
			const slotRow = slots[row];

			for (let col = 0, width = slotRow.length; col < width; col++) {
				slotRow[col].clearItemSlots();
			}
		}
	}

	public getSavedInventoryState(): SavedInventoryState {
		const height = this.#y;
		const width = this.#x;
		const inventorySlots = this.#inventorySlots;
		const savedSlots = new Array<(SavedInventoryItem | null)[]>(height);

		for (let row = 0; row < height; row++) {
			const savedRow = new Array<SavedInventoryItem | null>(width);
			const slotRow = inventorySlots[row];

			for (let col = 0; col < width; col++) {
				const item = slotRow[col].item;

				savedRow[col] =
					item === null
						? null
						: {
								itemId: item.itemId,
								stackSize: item.stackSize,
							};
			}

			savedSlots[row] = savedRow;
		}

		return {
			width,
			height,
			slots: savedSlots,
		};
	}

	public restoreSavedInventoryState(savedState: unknown): boolean {
		if (!this.#isValidSavedInventoryState(savedState)) {
			return false;
		}

		this.#clearInventory();

		const savedSlots = savedState.slots;

		for (let row = 0, height = savedSlots.length; row < height; row++) {
			const savedRow = savedSlots[row];

			for (let col = 0, width = savedRow.length; col < width; col++) {
				const savedItem = savedRow[col];
				if (savedItem === null) continue;

				const item = this.#createItemById(savedItem.itemId, row, col);
				if (item === null) continue;

				item.stackSize = savedItem.stackSize;
				this.#placeItemInSlot(this.#inventorySlots[row][col], item);
			}
		}

		this.onInventoryChangedObservable.notifyObservers();
		return true;
	}

	#isValidSavedInventoryState(
		savedState: unknown,
	): savedState is SavedInventoryState {
		if (savedState === null || typeof savedState !== "object") {
			return false;
		}

		const candidate = savedState as Partial<SavedInventoryState>;

		if (
			candidate.width !== this.#x ||
			candidate.height !== this.#y ||
			!Array.isArray(candidate.slots) ||
			candidate.slots.length !== this.#y
		) {
			return false;
		}

		for (let row = 0; row < this.#y; row++) {
			const savedRow = candidate.slots[row];

			if (!Array.isArray(savedRow) || savedRow.length !== this.#x) {
				return false;
			}

			for (let col = 0; col < this.#x; col++) {
				const slot = savedRow[col];

				if (slot !== null && !this.#isValidSavedInventoryItem(slot)) {
					return false;
				}
			}
		}

		return true;
	}

	#isValidSavedInventoryItem(value: unknown): value is SavedInventoryItem {
		if (value === null || typeof value !== "object") return false;

		const item = value as Partial<SavedInventoryItem>;

		return (
			Number.isInteger(item.itemId) &&
			Number.isInteger(item.stackSize) &&
			item.stackSize! > 0
		);
	}

	public addItem(item: Item): number {
		if (item.stackSize <= 0) return 0;

		const slots = this.#inventorySlots;
		const itemId = item.itemId;
		let changed = false;

		for (let row = 0, height = slots.length; row < height; row++) {
			const slotRow = slots[row];

			for (let col = 0, width = slotRow.length; col < width; col++) {
				const itemInInventory = slotRow[col].item;

				if (itemInInventory === null || itemInInventory.itemId !== itemId) {
					continue;
				}

				const before = item.stackSize;
				const remainder = Item.stackItemAtoB(item, itemInInventory);

				if (remainder !== before) {
					changed = true;
				}

				if (remainder <= 0) {
					this.onInventoryChangedObservable.notifyObservers();
					return 0;
				}
			}
		}

		for (let row = 0, height = slots.length; row < height; row++) {
			const slotRow = slots[row];

			for (let col = 0, width = slotRow.length; col < width; col++) {
				const slot = slotRow[col];

				if (slot.item === null) {
					this.#placeItemInSlot(slot, item);
					this.onInventoryChangedObservable.notifyObservers();
					return 0;
				}
			}
		}

		if (changed) {
			this.onInventoryChangedObservable.notifyObservers();
		}

		return item.stackSize;
	}

	public hasItem(itemId: number, count: number): boolean {
		if (count <= 0) return true;

		let found = 0;
		const slots = this.#inventorySlots;

		for (let row = 0, height = slots.length; row < height; row++) {
			const slotRow = slots[row];

			for (let col = 0, width = slotRow.length; col < width; col++) {
				const item = slotRow[col].item;

				if (item !== null && item.itemId === itemId) {
					found += item.stackSize;

					if (found >= count) {
						return true;
					}
				}
			}
		}

		return false;
	}

	/** The item currently selected in the hotbar, or null if the slot is empty. */
	public getSelectedHotbarItem(): Item | null {
		const slot =
			this.#inventorySlots[0]?.[this.#player.playerHud.selectedHotbarSlot];
		return slot?.item ?? null;
	}

	public removeItems(itemId: number, count: number): void {
		if (count <= 0) return;

		let remaining = count;
		let changed = false;
		const slots = this.#inventorySlots;

		for (
			let row = 0, height = slots.length;
			row < height && remaining > 0;
			row++
		) {
			const slotRow = slots[row];

			for (
				let col = 0, width = slotRow.length;
				col < width && remaining > 0;
				col++
			) {
				const slot = slotRow[col];
				const item = slot.item;

				if (item === null || item.itemId !== itemId) {
					continue;
				}

				changed = true;

				if (item.stackSize > remaining) {
					item.stackSize -= remaining;
					remaining = 0;
				} else {
					remaining -= item.stackSize;
					this.#deleteItemNoNotify(item);
				}
			}
		}

		if (changed) {
			this.onInventoryChangedObservable.notifyObservers();
		}
	}

	public createAndAddItem(itemId: number, count: number): void {
		if (count <= 0) return;

		const item = this.#createItemById(itemId, -1, -1);
		if (item === null) return;

		item.stackSize = count;

		const remainder = this.addItem(item);

		if (remainder > 0) {
			this.dropItem(item, remainder);
		}
	}

	public dropItemFromHotbar(): void {
		const slot =
			this.#inventorySlots[0]?.[this.#player.playerHud.selectedHotbarSlot];
		const item = slot?.item;

		if (item === null || item === undefined) return;

		const quantity = this.#inventoryControls.underlyingControls.pressedKeys.has(
			"control",
		)
			? item.stackSize
			: 1;

		this.dropItem(item, quantity);
	}

	public dropItem(item: Item, quantity?: number): void {
		if (item.stackSize <= 0) return;

		let dropCount = quantity ?? item.stackSize;

		if (dropCount <= 0) return;
		if (dropCount > item.stackSize) dropCount = item.stackSize;

		const worldItem = new Item(item.name, item.description, item.icon, -1, -1);

		worldItem.itemId = item.itemId;
		worldItem.blockId = item.blockId ?? item.itemId;
		worldItem.blockState = item.blockState ?? 0;
		worldItem.refreshIconStyle();
		worldItem.stackSize = dropCount;

		item.stackSize -= worldItem.stackSize;

		const player = this.#player;
		const forward = player.playerCamera.getForwardDirection();

		dropWorldItem(
			worldItem,
			player.position.x + forward.x,
			player.position.y + forward.y + 0.5,
			player.position.z + forward.z,
			forward.x * 8 + player.velocity.x,
			forward.y * 8 + player.velocity.y,
			forward.z * 8 + player.velocity.z,
			player,
		);

		if (item.row >= 0 && item.col >= 0 && item.stackSize <= 0) {
			this.#deleteItemNoNotify(item);
		}

		this.onInventoryChangedObservable.notifyObservers();
	}

	public moveItemToHotbar(slotFocused: ItemSlot): void {
		this.moveItem(slotFocused, [0, 0]);
	}

	public moveItemToInventory(slotFocused: ItemSlot): void {
		this.moveItem(slotFocused, [1, this.#inventorySlots.length - 1]);
	}

	public moveItem(
		slotFocused: ItemSlot,
		targetBarIndexRange: [number, number],
	): void {
		const itemToMove = slotFocused.item;
		if (itemToMove === null) return;

		const slots = this.#inventorySlots;
		const start = targetBarIndexRange[0] < 0 ? 0 : targetBarIndexRange[0];
		const end =
			targetBarIndexRange[1] >= slots.length
				? slots.length - 1
				: targetBarIndexRange[1];

		if (start > end) return;

		let changed = false;

		for (let row = start; row <= end; row++) {
			const slotRow = slots[row];

			for (let col = 0, width = slotRow.length; col < width; col++) {
				const slot = slotRow[col];

				if (slot === slotFocused) continue;

				const itemInSlot = slot.item;

				if (itemInSlot !== null && itemInSlot.itemId === itemToMove.itemId) {
					const before = itemToMove.stackSize;
					const remainder = Item.stackItemAtoB(itemToMove, itemInSlot);

					if (remainder !== before) {
						changed = true;
					}

					if (remainder <= 0) {
						slotFocused.clearItemSlots();
						this.onInventoryChangedObservable.notifyObservers();
						return;
					}
				}
			}
		}

		for (let row = start; row <= end; row++) {
			const slotRow = slots[row];

			for (let col = 0, width = slotRow.length; col < width; col++) {
				const slot = slotRow[col];

				if (slot.item === null) {
					slotFocused.clearItemSlots();
					this.#placeItemInSlot(slot, itemToMove);
					this.onInventoryChangedObservable.notifyObservers();
					return;
				}
			}
		}

		if (changed) {
			this.onInventoryChangedObservable.notifyObservers();
		}
	}

	public deleteItem(item: Item): void {
		if (this.#deleteItemNoNotify(item)) {
			this.onInventoryChangedObservable.notifyObservers();
		}
	}

	#deleteItemNoNotify(item: Item): boolean {
		if (item === null || item === undefined) return false;

		let changed = false;

		const parent = item.div.parentElement;
		if (parent !== null) {
			parent.removeChild(item.div);
			changed = true;
		}

		const slot =
			item.row >= 0 && item.col >= 0
				? this.#inventorySlots[item.row]?.[item.col]
				: undefined;

		if (slot !== undefined && slot.item === item) {
			slot.clearItemSlots();
			changed = true;
		}

		item.row = -1;
		item.col = -1;

		return changed;
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
