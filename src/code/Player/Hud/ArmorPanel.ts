import {
	getArmorColumnPairs,
	getEquipmentSlotIds,
	groupForSlotId,
	labelForSlotId,
} from "../Inventory/EquipmentLayout";
import type { ItemSlot } from "../Inventory/ItemSlot";

/**
 * Renders the equipment slots beneath the player preview in the inventory
 * screen.
 *
 * The DOM skeleton here predates any gameplay and only ever wrote
 * `data-slot`, which nothing read. It now adopts real `ItemSlot` elements owned
 * by `Equipment` — this class stays purely presentational and reads the layout
 * from `EquipmentLayout`, a data-only module, so the
 * `PlayerHud -> ArmorPanel` edge never reaches back into `Equipment`.
 *
 * Slot contents and the armour aggregate both live in `Equipment`; this panel
 * only places the nodes.
 */
export class ArmorPanel {
	readonly container: HTMLDivElement;

	constructor() {
		this.container = document.createElement("div");
		this.container.className = "armor-panel";

		const armorGrid = document.createElement("div");
		armorGrid.className = "armor-grid";

		// Four columns, each an outer slot stacked over its chain slot.
		const pairs = getArmorColumnPairs();
		for (let column = 0; column < pairs.length; column++) {
			const pair = pairs[column]!;

			const columnEl = document.createElement("div");
			columnEl.className = "armor-column";
			columnEl.dataset.column = String(column);

			columnEl.appendChild(ArmorPanel.#createEquipSlot(pair.armor));
			columnEl.appendChild(ArmorPanel.#createEquipSlot(pair.underarmor));

			armorGrid.appendChild(columnEl);
		}

		const ids = getEquipmentSlotIds();

		const necklaces = document.createElement("div");
		necklaces.className = "necklace-slots";
		for (const id of ids) {
			if (groupForSlotId(id) === "necklace") {
				necklaces.appendChild(ArmorPanel.#createEquipSlot(id));
			}
		}

		const rings = document.createElement("div");
		rings.className = "ring-slots";
		for (const id of ids) {
			if (groupForSlotId(id) === "ring") {
				rings.appendChild(ArmorPanel.#createEquipSlot(id));
			}
		}

		this.container.appendChild(armorGrid);
		this.container.appendChild(necklaces);
		this.container.appendChild(rings);
	}

	/**
	 * Adopt the live slots. The `.equip-slot` divs created here are only
	 * placeholders: assigning `divItemSlot` re-points each `ItemSlot` at its own
	 * DOM node, adds the `inventory-slot` class the item styling expects, and
	 * wires up drag/drop and tooltips.
	 */
	public adoptSlots(slots: readonly ItemSlot[]): void {
		for (const slot of slots) {
			const id = slot.equipmentSlotId;
			if (id === null) continue;

			const host = this.container.querySelector<HTMLDivElement>(
				`.equip-slot[data-slot="${CSS.escape(id)}"]`,
			);
			if (host === null) continue;

			slot.divItemSlot = host;
		}
	}

	static #createEquipSlot(id: string): HTMLDivElement {
		const label = labelForSlotId(id);
		const slot = document.createElement("div");
		slot.className = "equip-slot";
		slot.dataset.slot = id;
		// Full label for the tooltip, and a single initial for the CSS
		// ::after marker, which reads data-label directly.
		slot.dataset.label = label[0] ?? "";
		slot.title = label;
		return slot;
	}

	dispose(): void {
		this.container.remove();
	}
}
