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

	/**
	 * Fired whenever this slot's contents change (swap, set, clear, or an
	 * in-place stack merge). The crate UI uses it to push live deltas to the
	 * server; singleplayer leaves it unset (zero overhead when undefined).
	 */
	onChanged?: (slot: ItemSlot) => void;

	row: number;
	col: number;

	/**
	 * Equipment slots live outside the inventory grid and must behave
	 * differently in two ways:
	 *
	 *  - their (row, col) is a disjoint address, because the grid's address
	 *    space is 0..y-1 / 0..x-1 and reusing a pair would let
	 *    `PlayerInventory.#deleteItemNoNotify` clear a real inventory slot;
	 *  - they must not become `PlayerInventory.currentlyHoveredSlot`, because
	 *    that static is the target of shift-move and Q-drop, which would yank a
	 *    equipped helmet into the hotbar or throw it on the floor.
	 */
	isEquipmentSlot = false;

	/**
	 * Optional constraint on what this slot will accept. Equipment uses it to
	 * stop a chestplate landing in the helmet slot. Null means "anything".
	 */
	acceptsItem: ((item: Item) => boolean) | null = null;

	/** Stable id for equipment slots (e.g. "head", "ring7"). Ignored by the grid. */
	equipmentSlotId: string | null = null;

	constructor(row: number, col: number) {
		this.row = row;
		this.col = col;

		const div = document.createElement("div");
		div.classList.add("inventory-slot");

		this.#divItemSlot = div;
		this.initialize();
	}

	/** Whether `item` may be placed in this slot. Always true for the grid. */
	public canAccept(item: Item | null): boolean {
		if (item === null) return true;
		if (this.acceptsItem === null) return true;
		return this.acceptsItem(item);
	}

	public swapSlots(slot: ItemSlot): void {
		if (slot === this) return;

		const targetItem = this.#item;
		const sourceItem = slot.#item;

		// Refuse rather than silently refuse-and-hide: dropping the wrong piece
		// on a slot should leave both items where they were.
		if (!this.canAccept(sourceItem)) return;
		if (!slot.canAccept(targetItem)) return;

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

			this.onChanged?.(this);
			slot.onChanged?.(slot);
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
		this.onChanged?.(this);
		slot.onChanged?.(slot);
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
		this.onChanged?.(this);
	}

	public get item(): Item | null {
		return this.#item;
	}

	public clearItemSlots(): void {
		this.#item = null;
		this.#render();
		this.onChanged?.(this);

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
				// Equipment slots still show a tooltip but must not become the
				// hovered slot: that static drives shift-move and Q-drop, which
				// would pull equipped gear into the hotbar or onto the floor.
				PlayerInventory.currentlyHoveredSlot = this.isEquipmentSlot
					? null
					: this;

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
