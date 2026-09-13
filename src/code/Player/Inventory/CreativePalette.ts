import { generateShapeVariants } from "../Crafting/ShapeVariantGenerator";
import { Item } from "./Item";
import {
	ensureItemRegistryLoaded,
	getAllRegisteredItems,
} from "./ItemRegistry";
import { ItemSlot } from "./ItemSlot";
import type { PlayerInventory } from "./PlayerInventory";

interface PaletteEntry {
	readonly slot: ItemSlot;
	readonly itemId: number;
	readonly maxStack: number;
	item: Item | null;
}

/**
 * Minecraft-style creative palette: a scrollable grid appended below the
 * player's inventory rows that lists every registered item.
 *
 * Creative semantics:
 * - Dragging an item out of the palette leaves a fresh copy behind.
 * - Dropping an item onto the palette destroys it.
 * - Double-clicking a palette entry adds a full stack to the inventory.
 */
export class CreativePalette {
	readonly container: HTMLDivElement;

	#inventory: PlayerInventory;
	#grid: HTMLDivElement;
	#entries: PaletteEntry[] = [];
	#inventoryChangedId: number;
	#disposed = false;

	constructor(inventory: PlayerInventory) {
		this.#inventory = inventory;

		this.container = document.createElement("div");
		this.container.classList.add("creative-palette");

		const label = document.createElement("div");
		label.classList.add("creative-palette-label");
		label.textContent = "Creative";

		this.#grid = document.createElement("div");
		this.#grid.classList.add("creative-palette-grid");

		this.container.append(label, this.#grid);

		// Use one delegated listener rather than one dblclick closure per slot.
		this.#grid.addEventListener("dblclick", this.#handleDoubleClick);

		// Restore palette entries affected by inventory operations.
		this.#inventoryChangedId = inventory.onInventoryChangedObservable.add(
			this.#refreshDrainedSlots,
		);
	}

	/** Waits for the registry and shape variants, then fills the grid. */
	async build(): Promise<void> {
		await ensureItemRegistryLoaded();
		await generateShapeVariants();

		// Prevent an asynchronous build from repopulating a disposed palette.
		if (this.#disposed) {
			return;
		}

		this.#populate();
	}

	public dispose(): void {
		if (this.#disposed) {
			return;
		}

		this.#disposed = true;

		this.#inventory.onInventoryChangedObservable.remove(
			this.#inventoryChangedId,
		);

		this.#grid.removeEventListener("dblclick", this.#handleDoubleClick);

		this.#clearSlots();
		this.container.remove();
	}

	#handleDoubleClick = (event: MouseEvent): void => {
		const target = event.target;

		if (!(target instanceof Element)) {
			return;
		}

		const slotElement = target.closest<HTMLElement>(
			"[data-creative-entry-index]",
		);

		if (slotElement === null || !this.#grid.contains(slotElement)) {
			return;
		}

		const index = Number(slotElement.dataset.creativeEntryIndex);

		if (!Number.isInteger(index)) {
			return;
		}

		const entry = this.#entries[index];

		if (entry === undefined) {
			return;
		}

		this.#inventory.createAndAddItem(entry.itemId, entry.maxStack);
	};

	#clearSlots(): void {
		for (let i = 0; i < this.#entries.length; i++) {
			this.#entries[i].slot.dispose();
		}

		this.#entries.length = 0;
		this.#grid.replaceChildren();
	}

	#populate(): void {
		this.#clearSlots();

		const definitions = getAllRegisteredItems();
		const columns = Math.max(1, this.#inventory.x);
		const fragment = document.createDocumentFragment();

		let rowDiv: HTMLDivElement | null = null;
		let visibleIndex = 0;

		for (let i = 0; i < definitions.length; i++) {
			const definition = definitions[i];

			// Skip air and invalid IDs.
			if (definition.id < 1) {
				continue;
			}

			if (visibleIndex % columns === 0) {
				rowDiv = document.createElement("div");
				rowDiv.classList.add("inventory-row");
				fragment.appendChild(rowDiv);
			}

			const slot = new ItemSlot(-1, -1);
			const entryIndex = this.#entries.length;

			const entry: PaletteEntry = {
				slot,
				itemId: definition.id,
				maxStack: definition.maxStack ?? 64,
				item: null,
			};

			this.#entries.push(entry);

			slot.destroysDroppedItems = true;
			slot.divItemSlot.dataset.creativeEntryIndex = String(entryIndex);

			slot.onDraggedOut = () => {
				this.#replaceSlotItem(entry);
			};

			rowDiv!.appendChild(slot.divItemSlot);
			this.#replaceSlotItem(entry);

			visibleIndex++;
		}

		// Attach all generated rows in one DOM operation.
		this.#grid.appendChild(fragment);
	}

	/**
	 * Creates a new catalog copy when the previous Item object was removed
	 * from the palette slot.
	 */
	#replaceSlotItem(entry: PaletteEntry): void {
		entry.slot.clearItemSlots();
		entry.item = null;

		try {
			const item = Item.createById(entry.itemId, -1, -1);
			item.stackSize = entry.maxStack;

			entry.slot.item = item;
			entry.item = item;
		} catch {
			// Leave the slot empty if the registered item cannot be created.
		}
	}

	/**
	 * Restores only entries that were taken or partially drained.
	 *
	 * A partially drained stack is restored in place to avoid allocating a
	 * new Item and redrawing the slot on every inventory change.
	 */
	#refreshDrainedSlots = (): void => {
		if (this.#disposed) {
			return;
		}

		for (let i = 0; i < this.#entries.length; i++) {
			const entry = this.#entries[i];
			const slotItem = entry.slot.item;

			if (slotItem === null || slotItem !== entry.item) {
				this.#replaceSlotItem(entry);
				continue;
			}

			if (slotItem.stackSize !== entry.maxStack) {
				slotItem.stackSize = entry.maxStack;
			}
		}
	};
}
