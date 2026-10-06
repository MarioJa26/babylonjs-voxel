import {
	ARMOR_MITIGATION_CAP,
	effectiveArmorValue,
	mitigationForArmorValue,
} from "./Armor";
import { DEPLETED_ARMOR_MULTIPLIER } from "./Durability";
import {
	ARMOR_SLOT_IDS,
	EQUIPMENT_SLOT_COUNT,
	type EquipmentGroup,
	getEquipmentSlotIds,
	groupForSlotId,
} from "./EquipmentLayout";
import { Item } from "./Item";
import { getRegisteredItemById } from "./ItemRegistry";
import { ItemSlot } from "./ItemSlot";
import type { SavedEquipmentState } from "./Types/InventoryTypes";

/**
 * Armour and accessory slots.
 *
 * The layout is the one `ArmorPanel` already drew: 4 outer armour slots, 4
 * under-armour (chain) slots beneath them, 3 necklace slots and 20 ring slots.
 * Ids live in `EquipmentLayout` so the panel can render the same slots without
 * importing this class.
 *
 * Two things make these slots behave differently from inventory-grid slots:
 *
 *  - their (row, col) is a disjoint address in the range the grid never uses,
 *    because the grid's space is 0..y-1 / 0..x-1 and a collision would let
 *    `#deleteItemNoNotify` clear a real inventory slot;
 *  - `PlayerInventory.currentlyHoveredSlot` is never set from them, because that
 *    static drives shift-move and Q-drop.
 *
 * `PlayerInventory.registerEquipmentSlots()` wires both of those up, and is
 * required before dropping an equipped item works correctly.
 *
 * Progression split across the two slot groups, per plans/progression.md:
 * outer armour follows the material tier, while the necklace and ring slots
 * follow the rune axis. That keeps the total item count at ~61 instead of the
 * ~310 a per-tier ring would imply.
 */

/**
 * First grid row for equipment addresses. The grid is 10 wide, so anything at
 * row >= 100 can never collide with it.
 */
const EQUIPMENT_ROW_BASE = 100;

export type { EquipmentGroup };
export { EQUIPMENT_SLOT_COUNT, getEquipmentSlotIds, groupForSlotId };

export class Equipment {
	readonly slots: ItemSlot[] = [];
	#byId = new Map<string, ItemSlot>();

	/** Group membership per slot, so the panel can lay out without re-deriving. */
	readonly groupById = new Map<string, EquipmentGroup>();

	#onChanged?: (slot: ItemSlot) => void;

	constructor() {
		const ids = getEquipmentSlotIds();

		for (let i = 0; i < ids.length; i++) {
			const id = ids[i]!;
			// Disjoint address: row 100+ is never a valid grid row.
			const slot = new ItemSlot(EQUIPMENT_ROW_BASE + i, 0);
			slot.equipmentSlotId = id;
			slot.isEquipmentSlot = true;
			slot.acceptsItem = (item) => canEquipIn(id, item);

			this.slots.push(slot);
			this.#byId.set(id, slot);
			this.groupById.set(id, groupForSlotId(id));

			slot.onChanged = (changed) => this.#onChanged?.(changed);
		}
	}

	/** Wire change notifications (armour value must follow every swap). */
	public set onChanged(handler: (slot: ItemSlot) => void) {
		this.#onChanged = handler;
	}

	public getSlot(id: string): ItemSlot | undefined {
		return this.#byId.get(id);
	}

	public getItem(id: string): Item | null {
		return this.#byId.get(id)?.item ?? null;
	}

	/** Place an item directly. Returns false if the slot rejects it. */
	public setItem(id: string, item: Item | null): boolean {
		const slot = this.#byId.get(id);
		if (slot === undefined) return false;
		if (!slot.canAccept(item)) return false;
		slot.item = item;
		return true;
	}

	// ─── Aggregate ───

	/**
	 * Total armour value from the outer armour slots.
	 *
	 * A spent piece counts at half, not zero: armour is passive, so the player
	 * never chooses to "use" it, and zeroing its value would be pure punishment.
	 * The under-armour slots contribute nothing on their own — they are the
	 * chain layer and are reserved for Phase 3.
	 */
	public get armorValue(): number {
		let total = 0;

		for (const id of ARMOR_SLOT_IDS) {
			const item = this.#byId.get(id)?.item;
			if (item === null || item === undefined) continue;

			const value = getRegisteredItemById(item.itemId)?.armorValue ?? 0;
			total += effectiveArmorValue(
				value,
				item.isSpent,
				DEPLETED_ARMOR_MULTIPLIER,
			);
		}

		return total;
	}

	/**
	 * Fraction of incoming damage this equipment absorbs.
	 *
	 * The curve and its cap live in `Armor.ts` so they can be tested without the
	 * DOM; see the note there on why it asymptotes rather than reaching the cap.
	 */
	public get mitigation(): number {
		return mitigationForArmorValue(this.armorValue);
	}

	// ─── Persistence ───

	/**
	 * Serialise. Emits only occupied slots — an empty 31-slot record would be 31
	 * nulls on every save, and this serialises on every inventory mutation.
	 */
	public getSavedState(): SavedEquipmentState {
		const slots: { id: string; itemId: number; durability?: number }[] = [];

		for (const id of getEquipmentSlotIds()) {
			const item = this.#byId.get(id)?.item;
			if (item === null || item === undefined) continue;

			const entry: { id: string; itemId: number; durability?: number } = {
				id,
				itemId: item.itemId,
			};

			if (item.maxDurability > 0 && item.durability < item.maxDurability) {
				entry.durability = item.durability;
			}

			slots.push(entry);
		}

		return { slots };
	}

	/**
	 * Restore from a save.
	 *
	 * Tolerant by design: an unknown slot id, unknown item id or a piece that no
	 * longer fits its slot is skipped rather than aborting, because the whole
	 * point of a save is that it loads.
	 */
	public restoreSavedState(saved: unknown): boolean {
		if (saved === null || typeof saved !== "object") return false;
		const candidate = saved as Partial<SavedEquipmentState>;
		if (!Array.isArray(candidate.slots)) return false;

		for (const slot of this.slots) {
			slot.item = null;
		}

		for (const entry of candidate.slots) {
			if (entry === null || typeof entry !== "object") continue;

			const slot =
				typeof entry.id === "string" ? this.#byId.get(entry.id) : undefined;
			if (slot === undefined) continue;

			if (!Number.isInteger(entry.itemId) || entry.itemId <= 0) continue;

			let item: Item;
			try {
				item = Item.createById(entry.itemId);
			} catch {
				continue;
			}

			// A piece that no longer belongs here (data changed between versions)
			// is dropped on the floor rather than forced into the wrong slot.
			if (!slot.canAccept(item)) continue;

			if (
				entry.durability !== undefined &&
				Number.isFinite(entry.durability) &&
				item.maxDurability > 0
			) {
				item.durability = Math.min(
					Math.max(0, Math.floor(entry.durability)),
					item.maxDurability,
				);
			}

			slot.item = item;
		}

		return true;
	}
}

/** Mitigation curve, exposed for testing. */
export { ARMOR_MITIGATION_CAP, mitigationForArmorValue };

/** Whether `item` may be equipped in `slotId`. */
export function canEquipIn(slotId: string, item: Item): boolean {
	const group = groupForSlotId(slotId);
	const def = getRegisteredItemById(item.itemId);
	const slot = def?.armorSlot;

	// No declared slot means the item is not equipment at all.
	if (slot === undefined) return false;

	if (group === "armor") {
		// "head" only ever matches gear that declares "head".
		return slot === slotId;
	}

	if (group === "underarmor") {
		// Chain is the under-layer's shared piece: one item fits any of the four
		// underarmour slots, so the ladder needs four chain items per material
		// rather than sixteen.
		return slot === slotId || slot === "chain";
	}

	// Necklaces and rings accept any item declaring a matching group.
	return slot === group;
}

/** True if the item declares an equipment slot at all. */
export function isEquipment(item: Item): boolean {
	return getRegisteredItemById(item.itemId)?.armorSlot !== undefined;
}
