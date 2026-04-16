import { PlayerHud } from "../Hud/PlayerHud";
import { Item } from "./Item";
import { PlayerInventory } from "./PlayerInventory";

export class ItemSlot {
	#item: Item | null = null;
	#divItemSlot: HTMLDivElement = document.createElement("div");

	row: number;
	col: number;

	constructor(row: number, col: number) {
		this.row = row;
		this.col = col;

		this.initalize();
	}

	public swapSlots(slot: ItemSlot) {
		// No-op if same slot
		if (slot === this) return;

		// --- If same item type, try stacking first ---
		if (this.#item && slot.#item && this.#item.itemId === slot.#item.itemId) {
			const remainder = Item.stackItemAtoB(slot.#item, this.#item);
			// If fully stacked into the target slot, remove source item and its DOM
			if (remainder <= 0) {
				if (slot.#divItemSlot.contains(slot.#item.div)) {
					slot.#divItemSlot.removeChild(slot.#item.div);
				}
				slot.#item = null;
			}
			// Whether fully stacked or partially stacked, we are done (no positional swap)
			return;
		}

		// --- Swap item references and positions correctly ---
		const tempItem = this.#item;
		this.#item = slot.#item;
		slot.#item = tempItem;

		// Update item object's stored coordinates if you keep them on the Item
		if (this.#item) {
			this.#item.row = this.row;
			this.#item.col = this.col;
		}
		if (slot.#item) {
			slot.#item.row = slot.row;
			slot.#item.col = slot.col;
		}

		// --- Update the DOM for both slots in a safe way ---
		// Clear each container then append child if item exists.
		// Clearing using innerHTML avoids leftover nodes; using contains/removeChild is safer if you prefer.
		this.#divItemSlot.innerHTML = "";
		slot.#divItemSlot.innerHTML = "";

		if (this.#item) this.#divItemSlot.appendChild(this.#item.div);
		if (slot.#item) slot.#divItemSlot.appendChild(slot.#item.div);
	}

	public get divItemSlot(): HTMLDivElement {
		return this.#divItemSlot;
	}
	public set divItemSlot(div: HTMLDivElement) {
		this.#divItemSlot = div;
	}
	public set item(item: Item | null) {
		this.#item = item;
	}

	public get item(): Item | null {
		return this.#item;
	}

	public clearItemSlots() {
		if (this.#item && this.#divItemSlot.contains(this.#item.div)) {
			this.#divItemSlot.removeChild(this.#item.div);
		}
		this.#item = null;
	}

	public initalize() {
		const div = this.#divItemSlot;
		div.classList.add("inventory-slot");
		div.addEventListener("dragstart", () => {
			(window as any).draggedItem = this;
		});

		div.addEventListener("dragover", (e) => {
			e.preventDefault();
		});

		div.addEventListener("drop", (e) => {
			e.preventDefault();
			const dragged = (window as any).draggedItem as ItemSlot;
			if (dragged !== this) this.swapSlots(dragged);
		});

		div.addEventListener("mouseover", (e) => {
			PlayerInventory.currentlyHoveredSlot = this;
			if (this.item) {
				PlayerHud.showItemTooltip(this.item.name, e);
			}
		});

		div.addEventListener("mouseout", () => {
			PlayerInventory.currentlyHoveredSlot = null;
			PlayerHud.hideItemTooltip();
		});
	}
}
