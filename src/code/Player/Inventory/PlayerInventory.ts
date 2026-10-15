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
	public readonly scene: SceneContext;

	readonly #player: Player;
	readonly #x: number;
	readonly #y: number;
	readonly #inventorySlots: ItemSlot[][];
	readonly #equipmentSlots = new Set<ItemSlot>();

	#inventoryControls: InventoryControls;

	public readonly onInventoryChangedObservable = new Observable<void>();

	public static currentlyHoveredSlot: ItemSlot | null = null;

	constructor(scene: SceneContext, player: Player, x: number, y: number) {
		this.scene = scene;
		this.#player = player;
		this.#x = x;
		this.#y = y;
		this.#inventorySlots = this.#createInventorySlots(x, y);

		this.#inventoryControls = new InventoryControls(
			this,
			player.keyboardControls,
			player,
		);

		void this.#loadInitialItems();
	}

	#createInventorySlots(width: number, height: number): ItemSlot[][] {
		const inventorySlots = new Array<ItemSlot[]>(height);

		for (let row = 0; row < height; row++) {
			const slotRow = new Array<ItemSlot>(width);

			for (let col = 0; col < width; col++) {
				slotRow[col] = new ItemSlot(row, col);
			}

			inventorySlots[row] = slotRow;
		}

		return inventorySlots;
	}

	async #loadInitialItems(): Promise<void> {
		await ensureItemRegistryLoaded();
		await generateShapeVariants();
		this.#notifyInventoryChanged();
	}

	#notifyInventoryChanged(): void {
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

		const slotElement = slot.divItemSlot;

		if (item.div.parentElement !== slotElement) {
			slotElement.appendChild(item.div);
		}
	}

	#clearKnownSlot(slot: ItemSlot, item: Item): void {
		slot.clearItemSlots();
		item.row = -1;
		item.col = -1;
	}

	#clearInventory(): void {
		const slots = this.#inventorySlots;

		for (let row = 0; row < this.#y; row++) {
			const slotRow = slots[row];

			for (let col = 0; col < this.#x; col++) {
				slotRow[col].clearItemSlots();
			}
		}
	}

	public getSavedInventoryState(): SavedInventoryState {
		const savedSlots = new Array<(SavedInventoryItem | null)[]>(this.#y);
		const inventorySlots = this.#inventorySlots;

		for (let row = 0; row < this.#y; row++) {
			const savedRow = new Array<SavedInventoryItem | null>(this.#x);
			const slotRow = inventorySlots[row];

			for (let col = 0; col < this.#x; col++) {
				const item = slotRow[col].item;

				if (item === null) {
					savedRow[col] = null;
					continue;
				}

				const savedItem: SavedInventoryItem = {
					itemId: item.itemId,
					stackSize: item.stackSize,
				};

				if (item.maxDurability > 0 && item.durability < item.maxDurability) {
					savedItem.durability = item.durability;
				}

				savedRow[col] = savedItem;
			}

			savedSlots[row] = savedRow;
		}

		return {
			width: this.#x,
			height: this.#y,
			slots: savedSlots,
		};
	}

	public restoreSavedInventoryState(savedState: unknown): boolean {
		if (!this.#isValidSavedInventoryState(savedState)) {
			return false;
		}

		this.#clearInventory();

		const inventorySlots = this.#inventorySlots;
		const savedSlots = savedState.slots;

		for (let row = 0; row < this.#y; row++) {
			const savedRow = savedSlots[row];
			const inventoryRow = inventorySlots[row];

			for (let col = 0; col < this.#x; col++) {
				const savedItem = savedRow[col];

				if (savedItem === null) {
					continue;
				}

				const item = this.#createItemById(savedItem.itemId, row, col);

				if (item === null) {
					continue;
				}

				item.stackSize = savedItem.stackSize;

				/*
				 * A corrupt durability value should not invalidate the entire
				 * inventory. Non-finite values are ignored and finite values
				 * are clamped to the item's supported range.
				 */
				const savedDurability = savedItem.durability;

				if (
					savedDurability !== undefined &&
					Number.isFinite(savedDurability) &&
					item.maxDurability > 0
				) {
					item.durability = Math.min(
						Math.max(0, Math.floor(savedDurability)),
						item.maxDurability,
					);
				}

				this.#placeItemInSlot(inventoryRow[col], item);
			}
		}

		this.#notifyInventoryChanged();
		return true;
	}

	#isValidSavedInventoryState(
		savedState: unknown,
	): savedState is SavedInventoryState {
		if (
			savedState === null ||
			typeof savedState !== "object" ||
			Array.isArray(savedState)
		) {
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
				const savedItem = savedRow[col];

				if (savedItem !== null && !this.#isValidSavedInventoryItem(savedItem)) {
					return false;
				}
			}
		}

		return true;
	}

	#isValidSavedInventoryItem(value: unknown): value is SavedInventoryItem {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return false;
		}

		const item = value as Partial<SavedInventoryItem>;

		return (
			Number.isInteger(item.itemId) &&
			Number.isInteger(item.stackSize) &&
			(item.stackSize as number) > 0
		);
	}

	public addItem(item: Item): number {
		if (item.stackSize <= 0) {
			return 0;
		}

		const slots = this.#inventorySlots;
		const itemId = item.itemId;

		let firstEmptySlot: ItemSlot | null = null;
		let changed = false;

		/*
		 * Remember the first empty slot while processing compatible stacks.
		 * This avoids performing a second full inventory scan.
		 */
		for (let row = 0; row < this.#y; row++) {
			const slotRow = slots[row];

			for (let col = 0; col < this.#x; col++) {
				const slot = slotRow[col];
				const existingItem = slot.item;

				if (existingItem === null) {
					firstEmptySlot ??= slot;
					continue;
				}

				if (existingItem.itemId !== itemId) {
					continue;
				}

				const previousStackSize = item.stackSize;

				Item.stackItemAtoB(item, existingItem);

				if (item.stackSize !== previousStackSize) {
					changed = true;
				}

				if (item.stackSize <= 0) {
					this.#notifyInventoryChanged();
					return 0;
				}
			}
		}

		if (firstEmptySlot !== null) {
			this.#placeItemInSlot(firstEmptySlot, item);
			this.#notifyInventoryChanged();
			return 0;
		}

		if (changed) {
			this.#notifyInventoryChanged();
		}

		return item.stackSize;
	}

	public hasItem(itemId: number, count: number): boolean {
		if (count <= 0) {
			return true;
		}

		let remaining = count;
		const slots = this.#inventorySlots;

		for (let row = 0; row < this.#y; row++) {
			const slotRow = slots[row];

			for (let col = 0; col < this.#x; col++) {
				const item = slotRow[col].item;

				if (item === null || item.itemId !== itemId) {
					continue;
				}

				remaining -= item.stackSize;

				if (remaining <= 0) {
					return true;
				}
			}
		}

		return false;
	}

	/** The item currently selected in the hotbar, or null if the slot is empty. */
	public getSelectedHotbarItem(): Item | null {
		const selectedSlot = this.#player.playerHud.selectedHotbarSlot;
		return this.#inventorySlots[0]?.[selectedSlot]?.item ?? null;
	}

	public removeItems(itemId: number, count: number): void {
		if (count <= 0) {
			return;
		}

		let remaining = count;
		let changed = false;

		const slots = this.#inventorySlots;

		for (let row = 0; row < this.#y && remaining > 0; row++) {
			const slotRow = slots[row];

			for (let col = 0; col < this.#x && remaining > 0; col++) {
				const slot = slotRow[col];
				const item = slot.item;

				if (item === null || item.itemId !== itemId) {
					continue;
				}

				changed = true;

				if (item.stackSize > remaining) {
					item.stackSize -= remaining;
					remaining = 0;
					break;
				}

				remaining -= item.stackSize;
				this.#clearKnownSlot(slot, item);
			}
		}

		if (changed) {
			this.#notifyInventoryChanged();
		}
	}

	public createAndAddItem(itemId: number, count: number): void {
		if (count <= 0) {
			return;
		}

		const item = this.#createItemById(itemId, -1, -1);

		if (item === null) {
			return;
		}

		item.stackSize = count;

		const remainder = this.addItem(item);

		if (remainder > 0) {
			this.dropItem(item, remainder);
		}
	}

	public dropItemFromHotbar(): void {
		const item = this.getSelectedHotbarItem();

		if (item === null) {
			return;
		}

		const dropEntireStack =
			this.#inventoryControls.underlyingControls.pressedKeys.has("control");

		this.dropItem(item, dropEntireStack ? item.stackSize : 1);
	}

	public dropItem(item: Item, quantity?: number): void {
		if (item.stackSize <= 0) {
			return;
		}

		const requestedQuantity = quantity ?? item.stackSize;
		const dropCount = Math.min(requestedQuantity, item.stackSize);

		if (dropCount <= 0) {
			return;
		}

		const worldItem = new Item(item.name, item.description, item.icon, -1, -1);

		worldItem.itemId = item.itemId;
		worldItem.blockId = item.blockId ?? item.itemId;
		worldItem.blockState = item.blockState ?? 0;
		worldItem.maxDurability = item.maxDurability;
		worldItem.durability = item.durability;
		worldItem.stackSize = dropCount;
		worldItem.refreshIconStyle();

		item.stackSize -= dropCount;

		const player = this.#player;
		const position = player.position;
		const velocity = player.velocity;
		const forward = player.playerCamera.getForwardDirection();

		dropWorldItem(
			worldItem,
			position.x + forward.x,
			position.y + forward.y + 0.5,
			position.z + forward.z,
			forward.x * 8 + velocity.x,
			forward.y * 8 + velocity.y,
			forward.z * 8 + velocity.z,
			player,
		);

		if (item.stackSize <= 0) {
			this.#deleteItemNoNotify(item);
		}

		this.#notifyInventoryChanged();
	}

	public moveItemToHotbar(slotFocused: ItemSlot): void {
		this.moveItem(slotFocused, [0, 0]);
	}

	public moveItemToInventory(slotFocused: ItemSlot): void {
		this.moveItem(slotFocused, [1, this.#y - 1]);
	}

	public moveItem(
		slotFocused: ItemSlot,
		targetBarIndexRange: [number, number],
	): void {
		const itemToMove = slotFocused.item;

		if (itemToMove === null) {
			return;
		}

		const start = Math.max(0, targetBarIndexRange[0]);
		const end = Math.min(this.#y - 1, targetBarIndexRange[1]);

		if (start > end) {
			return;
		}

		const slots = this.#inventorySlots;
		const itemId = itemToMove.itemId;

		let firstEmptySlot: ItemSlot | null = null;
		let changed = false;

		/*
		 * Stack and locate the first empty destination in one traversal.
		 * Existing stacks retain priority over empty slots.
		 */
		for (let row = start; row <= end; row++) {
			const slotRow = slots[row];

			for (let col = 0; col < this.#x; col++) {
				const slot = slotRow[col];

				if (slot === slotFocused) {
					continue;
				}

				const existingItem = slot.item;

				if (existingItem === null) {
					firstEmptySlot ??= slot;
					continue;
				}

				if (existingItem.itemId !== itemId) {
					continue;
				}

				const previousStackSize = itemToMove.stackSize;

				Item.stackItemAtoB(itemToMove, existingItem);

				if (itemToMove.stackSize !== previousStackSize) {
					changed = true;
				}

				if (itemToMove.stackSize <= 0) {
					this.#clearKnownSlot(slotFocused, itemToMove);
					this.#notifyInventoryChanged();
					return;
				}
			}
		}

		if (firstEmptySlot !== null) {
			slotFocused.clearItemSlots();
			this.#placeItemInSlot(firstEmptySlot, itemToMove);
			this.#notifyInventoryChanged();
			return;
		}

		if (changed) {
			this.#notifyInventoryChanged();
		}
	}

	public deleteItem(item: Item): void {
		if (this.#deleteItemNoNotify(item)) {
			this.#notifyInventoryChanged();
		}
	}

	/**
	 * Registers slots that live outside the inventory grid, such as armour and
	 * accessory slots.
	 */
	public registerEquipmentSlots(slots: readonly ItemSlot[]): void {
		for (const slot of slots) {
			slot.isEquipmentSlot = true;
			this.#equipmentSlots.add(slot);
		}
	}

	#deleteItemNoNotify(item: Item): boolean {
		const row = item.row;
		const col = item.col;

		if (row >= 0 && col >= 0) {
			const gridSlot = this.#inventorySlots[row]?.[col];

			if (gridSlot?.item === item) {
				this.#clearKnownSlot(gridSlot, item);
				return true;
			}
		}

		/*
		 * Equipment slots have coordinates outside the inventory grid, so they
		 * must be checked independently.
		 */
		for (const equipmentSlot of this.#equipmentSlots) {
			if (equipmentSlot.item === item) {
				this.#clearKnownSlot(equipmentSlot, item);
				return true;
			}
		}

		/*
		 * The item may have become detached from its slot bookkeeping. Remove
		 * its DOM element as a defensive fallback.
		 */
		const hadParent = item.div.parentElement !== null;

		if (hadParent) {
			item.div.remove();
		}

		item.row = -1;
		item.col = -1;

		return hadParent;
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

	public get x(): number {
		return this.#x;
	}

	public get y(): number {
		return this.#y;
	}
}
