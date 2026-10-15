import { PlayerHud } from "../Hud/PlayerHud";
import { Item } from "./Item";
import { PlayerInventory } from "./PlayerInventory";

/**
 * The source slot of the current native HTML drag operation.
 *
 * Only one native drag can be active at a time, so module-level state avoids
 * attaching additional metadata to the DataTransfer payload.
 */
let draggedItem: ItemSlot | null = null;

export class ItemSlot implements EventListenerObject {
	#item: Item | null = null;
	#divItemSlot: HTMLDivElement;
	#destroysDroppedItems = false;
	#initialized = false;

	/**
	 * Called after a drop where this slot was the drag source.
	 *
	 * The creative palette uses this callback to refill its infinite source
	 * item after the drop operation.
	 */
	onDraggedOut?: (slot: ItemSlot) => void;

	/**
	 * Called whenever this slot's contents change through a set, clear, swap,
	 * or in-place stack merge.
	 *
	 * The crate UI uses this callback to publish live inventory deltas.
	 */
	onChanged?: (slot: ItemSlot) => void;

	row: number;
	col: number;

	/**
	 * Equipment slots live outside the normal inventory-grid address space.
	 *
	 * They also must not become PlayerInventory.currentlyHoveredSlot because
	 * that static value is used by shift-move and Q-drop handling.
	 */
	isEquipmentSlot = false;

	/**
	 * Optional constraint controlling which items this slot accepts.
	 *
	 * Null means every item is accepted.
	 */
	acceptsItem: ((item: Item) => boolean) | null = null;

	/**
	 * Stable identifier for equipment slots such as "head" or "ring7".
	 *
	 * Normal inventory-grid slots leave this as null.
	 */
	equipmentSlotId: string | null = null;

	constructor(row: number, col: number) {
		this.row = row;
		this.col = col;

		const div = document.createElement("div");
		div.classList.add("inventory-slot");

		this.#divItemSlot = div;
		this.initialize();
	}

	/**
	 * Returns whether the supplied item may be placed in this slot.
	 */
	public canAccept(item: Item | null): boolean {
		return item === null || this.acceptsItem === null || this.acceptsItem(item);
	}

	/**
	 * Swaps or merges this slot with another slot.
	 *
	 * The operation is atomic with respect to slot constraints. If either
	 * slot rejects the item it would receive, neither slot is modified.
	 */
	public swapSlots(slot: ItemSlot): void {
		if (slot === this) return;

		const targetItem = this.#item;
		const sourceItem = slot.#item;

		if (!this.canAccept(sourceItem) || !slot.canAccept(targetItem)) {
			return;
		}

		if (
			targetItem !== null &&
			sourceItem !== null &&
			targetItem.itemId === sourceItem.itemId
		) {
			const remainder = Item.stackItemAtoB(sourceItem, targetItem);

			if (remainder <= 0) {
				slot.#item = null;
			}

			/*
			 * stackItemAtoB mutates Item instances in place. Re-render both
			 * slots even when their Item references remain unchanged so stack
			 * counts cannot remain visually stale.
			 */
			this.#render();
			slot.#render();

			this.#notifyChanged();
			slot.#notifyChanged();

			return;
		}

		this.#item = sourceItem;
		slot.#item = targetItem;

		this.#syncItemCoordinates();
		slot.#syncItemCoordinates();

		this.#render();
		slot.#render();

		this.#notifyChanged();
		slot.#notifyChanged();
	}

	public get divItemSlot(): HTMLDivElement {
		return this.#divItemSlot;
	}

	/**
	 * When true, an item dropped onto this slot is destroyed.
	 */
	public get destroysDroppedItems(): boolean {
		return this.#destroysDroppedItems;
	}

	public set destroysDroppedItems(value: boolean) {
		this.#destroysDroppedItems = value;
	}

	/**
	 * Replaces the slot's DOM container while preserving its contents and
	 * event behavior.
	 */
	public set divItemSlot(div: HTMLDivElement) {
		if (div === this.#divItemSlot) {
			return;
		}

		this.#removeEventListeners();

		div.classList.add("inventory-slot");
		this.#divItemSlot = div;

		this.initialize();
		this.#render();
	}

	/**
	 * Replaces this slot's item and publishes the change.
	 *
	 * Assigning the same Item reference still refreshes the slot because the
	 * Item may have been mutated in place.
	 */
	public set item(item: Item | null) {
		this.#item = item;

		this.#syncItemCoordinates();
		this.#render();
		this.#notifyChanged();
	}

	public get item(): Item | null {
		return this.#item;
	}

	/**
	 * Clears the slot and publishes the change.
	 */
	public clearItemSlots(): void {
		this.#item = null;

		this.#render();
		this.#notifyChanged();

		if (draggedItem === this) {
			draggedItem = null;
		}

		if (PlayerInventory.currentlyHoveredSlot === this) {
			PlayerInventory.currentlyHoveredSlot = null;
			PlayerHud.hideItemTooltip();
		}
	}

	/**
	 * Attaches this slot's event listeners.
	 *
	 * The initialization guard prevents duplicate listener registration when
	 * initialize() is called repeatedly for the same element.
	 */
	public initialize(): void {
		if (this.#initialized) return;

		const div = this.#divItemSlot;

		div.addEventListener("dragstart", this);
		div.addEventListener("dragend", this);
		div.addEventListener("dragover", this);
		div.addEventListener("drop", this);
		div.addEventListener("mouseover", this);
		div.addEventListener("mouseout", this);

		this.#initialized = true;
	}

	/**
	 * Removes this slot's DOM listeners and releases global references to it.
	 */
	public dispose(): void {
		this.#removeEventListeners();

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
				this.#handleDragStart(event as DragEvent);
				return;

			case "dragend":
				this.#handleDragEnd();
				return;

			case "dragover":
				this.#handleDragOver(event as DragEvent);
				return;

			case "drop":
				this.#handleDrop(event as DragEvent);
				return;

			case "mouseover":
				this.#handleMouseOver(event as MouseEvent);
				return;

			case "mouseout":
				this.#handleMouseOut(event as MouseEvent);
				return;
		}
	}

	#handleDragStart(event: DragEvent): void {
		/*
		 * Empty slots cannot be meaningful drag sources. Preventing the drag
		 * also clears any stale source reference left by an interrupted native
		 * drag operation.
		 */
		if (this.#item === null) {
			draggedItem = null;
			event.preventDefault();
			return;
		}

		draggedItem = this;

		const dataTransfer = event.dataTransfer;

		if (dataTransfer !== null) {
			/*
			 * Firefox may require data to be present before it starts a native
			 * drag operation. The value is not used for inventory transfer.
			 */
			dataTransfer.setData("text/plain", "inventory-item");

			dataTransfer.effectAllowed = "move";
		}
	}

	#handleDragEnd(): void {
		if (draggedItem === this) {
			draggedItem = null;
		}
	}

	#handleDragOver(event: DragEvent): void {
		const source = draggedItem;

		if (source === null || source === this) {
			return;
		}

		/*
		 * Trash slots accept any active source item. Normal slots advertise a
		 * valid drop only when both sides satisfy their slot constraints.
		 */
		const validDrop =
			this.#destroysDroppedItems ||
			(this.canAccept(source.#item) && source.canAccept(this.#item));

		if (!validDrop) return;

		event.preventDefault();

		if (event.dataTransfer !== null) {
			event.dataTransfer.dropEffect = "move";
		}
	}

	#handleDrop(event: DragEvent): void {
		const source = draggedItem;

		/*
		 * Clear global drag state before performing mutations or callbacks.
		 * Callbacks may synchronously clear, replace, or dispose either slot.
		 */
		draggedItem = null;

		if (source === null || source === this) {
			return;
		}

		if (this.#destroysDroppedItems) {
			event.preventDefault();

			source.clearItemSlots();
			source.onDraggedOut?.(source);

			return;
		}

		if (!this.canAccept(source.#item) || !source.canAccept(this.#item)) {
			return;
		}

		event.preventDefault();

		this.swapSlots(source);
		source.onDraggedOut?.(source);
	}

	#handleMouseOver(event: MouseEvent): void {
		/*
		 * mouseover bubbles when the pointer moves between descendants. Ignore
		 * those events so entering an item's child elements does not repeatedly
		 * recreate the tooltip.
		 */
		if (this.#isInternalPointerTransition(event.relatedTarget)) {
			return;
		}

		PlayerInventory.currentlyHoveredSlot = this.isEquipmentSlot ? null : this;

		const item = this.#item;

		if (item === null) {
			PlayerHud.hideItemTooltip();
			return;
		}

		PlayerHud.showItemTooltip(item.name, event);
	}

	#handleMouseOut(event: MouseEvent): void {
		/*
		 * Ignore movement between the slot and its descendants. The pointer is
		 * still inside the same logical slot, so the tooltip should remain.
		 */
		if (this.#isInternalPointerTransition(event.relatedTarget)) {
			return;
		}

		if (PlayerInventory.currentlyHoveredSlot === this) {
			PlayerInventory.currentlyHoveredSlot = null;
		}

		PlayerHud.hideItemTooltip();
	}

	/**
	 * Returns true when a pointer transition remains inside this slot.
	 */
	#isInternalPointerTransition(relatedTarget: EventTarget | null): boolean {
		return (
			relatedTarget instanceof Node && this.#divItemSlot.contains(relatedTarget)
		);
	}

	/**
	 * Updates the contained item's inventory coordinates.
	 */
	#syncItemCoordinates(): void {
		const item = this.#item;

		if (item === null) return;

		item.row = this.row;
		item.col = this.col;
	}

	#notifyChanged(): void {
		this.onChanged?.(this);
	}

	#removeEventListeners(): void {
		if (!this.#initialized) return;

		const div = this.#divItemSlot;

		div.removeEventListener("dragstart", this);
		div.removeEventListener("dragend", this);
		div.removeEventListener("dragover", this);
		div.removeEventListener("drop", this);
		div.removeEventListener("mouseover", this);
		div.removeEventListener("mouseout", this);

		this.#initialized = false;
	}

	#render(): void {
		const item = this.#item;
		const div = this.#divItemSlot;

		if (item === null) {
			if (div.firstChild !== null) {
				div.replaceChildren();
			}

			return;
		}

		/*
		 * Avoid detaching and reattaching the same Item element. Item is
		 * responsible for updating the presentation inside its own element
		 * when its stack quantity changes.
		 */
		if (div.childNodes.length === 1 && div.firstChild === item.div) {
			return;
		}

		div.replaceChildren(item.div);
	}
}
