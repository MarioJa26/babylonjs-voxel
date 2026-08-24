import { PlayerHud } from "../Hud/PlayerHud";
import { Item } from "./Item";
import { PlayerInventory } from "./PlayerInventory";

let draggedItem: ItemSlot | null = null;

export class ItemSlot implements EventListenerObject {
	#item: Item | null = null;
	#divItemSlot: HTMLDivElement;
	#destroysDroppedItems = false;

	/**
	 * Called after a drop where this slot was the drag source. Used by the
	 * creative palette to refill itself (its items are infinite copies).
	 */
	onDraggedOut?: (slot: ItemSlot) => void;

	row: number;
	col: number;

	constructor(row: number, col: number) {
		this.row = row;
		this.col = col;

		const div = document.createElement("div");
		div.classList.add("inventory-slot");

		this.#divItemSlot = div;
		this.initialize();
	}

	public swapSlots(slot: ItemSlot): void {
		if (slot === this) return;

		const targetItem = this.#item;
		const sourceItem = slot.#item;

		if (
			targetItem !== null &&
			sourceItem !== null &&
			targetItem.itemId === sourceItem.itemId
		) {
			const remainder = Item.stackItemAtoB(sourceItem, targetItem);

			if (remainder <= 0) {
				slot.#item = null;
				slot.#render();
			}

			return;
		}

		this.#item = sourceItem;
		slot.#item = targetItem;

		if (sourceItem !== null) {
			sourceItem.row = this.row;
			sourceItem.col = this.col;
		}

		if (targetItem !== null) {
			targetItem.row = slot.row;
			targetItem.col = slot.col;
		}

		this.#render();
		slot.#render();
	}

	public get divItemSlot(): HTMLDivElement {
		return this.#divItemSlot;
	}

	/** When true, items dropped onto this slot are destroyed (creative trash). */
	public get destroysDroppedItems(): boolean {
		return this.#destroysDroppedItems;
	}

	public set destroysDroppedItems(value: boolean) {
		this.#destroysDroppedItems = value;
	}

	public set divItemSlot(div: HTMLDivElement) {
		const oldDiv = this.#divItemSlot;

		oldDiv.removeEventListener("dragstart", this);
		oldDiv.removeEventListener("dragend", this);
		oldDiv.removeEventListener("dragover", this);
		oldDiv.removeEventListener("drop", this);
		oldDiv.removeEventListener("mouseover", this);
		oldDiv.removeEventListener("mouseout", this);

		div.classList.add("inventory-slot");
		this.#divItemSlot = div;

		this.initialize();
		this.#render();
	}

	public set item(item: Item | null) {
		this.#item = item;

		if (item !== null) {
			item.row = this.row;
			item.col = this.col;
		}

		this.#render();
	}

	public get item(): Item | null {
		return this.#item;
	}

	public clearItemSlots(): void {
		this.#item = null;
		this.#render();

		if (draggedItem === this) {
			draggedItem = null;
		}
	}

	public initialize(): void {
		const div = this.#divItemSlot;

		div.addEventListener("dragstart", this);
		div.addEventListener("dragend", this);
		div.addEventListener("dragover", this);
		div.addEventListener("drop", this);
		div.addEventListener("mouseover", this);
		div.addEventListener("mouseout", this);
	}

	public dispose(): void {
		const div = this.#divItemSlot;

		div.removeEventListener("dragstart", this);
		div.removeEventListener("dragend", this);
		div.removeEventListener("dragover", this);
		div.removeEventListener("drop", this);
		div.removeEventListener("mouseover", this);
		div.removeEventListener("mouseout", this);

		if (draggedItem === this) {
			draggedItem = null;
		}

		if (PlayerInventory.currentlyHoveredSlot === this) {
			PlayerInventory.currentlyHoveredSlot = null;
			PlayerHud.hideItemTooltip();
		}
	}

	public handleEvent(event: Event): void {
		switch (event.type) {
			case "dragstart":
				draggedItem = this;
				return;

			case "dragend":
				if (draggedItem === this) {
					draggedItem = null;
				}
				return;

			case "dragover":
				event.preventDefault();
				return;

			case "drop": {
				event.preventDefault();

				const source = draggedItem;
				draggedItem = null;

				if (source === null || source === this) {
					return;
				}

				if (this.#destroysDroppedItems) {
					// Creative palette: dropping an item here destroys it.
					source.clearItemSlots();
					source.onDraggedOut?.(source);
					return;
				}

				this.swapSlots(source);
				source.onDraggedOut?.(source);

				return;
			}

			case "mouseover": {
				PlayerInventory.currentlyHoveredSlot = this;

				const item = this.#item;
				if (item !== null) {
					PlayerHud.showItemTooltip(item.name, event as MouseEvent);
				}

				return;
			}

			case "mouseout":
				if (PlayerInventory.currentlyHoveredSlot === this) {
					PlayerInventory.currentlyHoveredSlot = null;
				}

				PlayerHud.hideItemTooltip();
				return;
		}
	}

	#render(): void {
		const item = this.#item;
		const div = this.#divItemSlot;

		if (item === null) {
			div.replaceChildren();
		} else {
			div.replaceChildren(item.div);
		}
	}
}
