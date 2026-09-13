const ARMOR_SLOT_LABELS: readonly (readonly [id: string, label: string])[] = [
	["head", "Helmet"],
	["chest", "Chestplate"],
	["legs", "Leggings"],
	["feet", "Boots"],
];

const UNDERARMOR_SLOT_LABELS: readonly (readonly [
	id: string,
	label: string,
])[] = [
	["underhead", "Chainmail"],
	["underchest", "Chainmail"],
	["underlegs", "Chainmail"],
	["underfeet", "Chainmail"],
];

const NECKLACE_SLOT_LABELS: readonly (readonly [id: string, label: string])[] =
	[
		["necklace1", "Necklace"],
		["necklace2", "Necklace"],
		["necklace3", "Necklace"],
	];

const RING_SLOT_LABELS: readonly (readonly [id: string, label: string])[] = [
	["ring1", "Ring"],
	["ring2", "Ring"],
	["ring3", "Ring"],
	["ring4", "Ring"],
	["ring5", "Ring"],
	["ring6", "Ring"],
	["ring7", "Ring"],
	["ring8", "Ring"],
	["ring9", "Ring"],
	["ring10", "Ring"],
	["ring11", "Ring"],
	["ring12", "Ring"],
	["ring13", "Ring"],
	["ring14", "Ring"],
	["ring15", "Ring"],
	["ring16", "Ring"],
	["ring17", "Ring"],
	["ring18", "Ring"],
	["ring19", "Ring"],
	["ring20", "Ring"],
];

/**
 * Standalone equipment panel showing armor and accessory slots. Renders below
 * the player preview in the inventory screen and stretches to match the
 * inventory panel height.
 */
export class ArmorPanel {
	readonly container: HTMLDivElement;

	constructor() {
		this.container = document.createElement("div");
		this.container.className = "armor-panel";

		const armorGrid = document.createElement("div");
		armorGrid.className = "armor-grid";

		for (let i = 0; i < ARMOR_SLOT_LABELS.length; i++) {
			const [armorId, armorLabel] = ARMOR_SLOT_LABELS[i];
			const [underId, underLabel] = UNDERARMOR_SLOT_LABELS[i];

			const column = document.createElement("div");
			column.className = "armor-column";
			column.appendChild(ArmorPanel.#createEquipSlot(armorId, armorLabel));
			column.appendChild(ArmorPanel.#createEquipSlot(underId, underLabel));

			armorGrid.appendChild(column);
		}

		this.container.appendChild(armorGrid);

		const necklaces = document.createElement("div");
		necklaces.className = "necklace-slots";
		ArmorPanel.#appendEquipSlots(necklaces, NECKLACE_SLOT_LABELS);
		this.container.appendChild(necklaces);

		const rings = document.createElement("div");
		rings.className = "ring-slots";
		ArmorPanel.#appendEquipSlots(rings, RING_SLOT_LABELS);
		this.container.appendChild(rings);
	}

	static #appendEquipSlots(
		parent: HTMLElement,
		slots: readonly (readonly [id: string, label: string])[],
	): void {
		const fragment = document.createDocumentFragment();

		for (let i = 0; i < slots.length; i++) {
			const [id, label] = slots[i];
			fragment.appendChild(ArmorPanel.#createEquipSlot(id, label));
		}

		parent.appendChild(fragment);
	}

	static #createEquipSlot(id: string, label: string): HTMLDivElement {
		const slot = document.createElement("div");
		slot.className = "equip-slot";
		slot.dataset.slot = id;
		slot.dataset.label = label[0] ?? "";
		slot.title = label;
		return slot;
	}

	dispose(): void {
		this.container.remove();
	}
}
