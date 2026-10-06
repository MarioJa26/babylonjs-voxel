/**
 * Equipment slot layout — pure data, no runtime dependencies.
 *
 * Lives apart from `Equipment` so `ArmorPanel` can render the same 31 slots
 * without importing the module that owns them. `Equipment -> ItemSlot ->
 * PlayerHud -> ArmorPanel` is already a chain; adding `ArmorPanel -> Equipment`
 * would close it into a cycle. Keeping the ids here means both sides read one
 * list and the graph stays a tree.
 */

export type EquipmentGroup = "armor" | "underarmor" | "necklace" | "ring";

export const ARMOR_SLOT_IDS = ["head", "chest", "legs", "feet"] as const;
export const UNDERARMOR_SLOT_IDS = [
	"underhead",
	"underchest",
	"underlegs",
	"underfeet",
] as const;
export const NECKLACE_SLOT_COUNT = 3;
export const RING_SLOT_COUNT = 20;

export type ArmorSlotId = (typeof ARMOR_SLOT_IDS)[number];

export const EQUIPMENT_SLOT_COUNT =
	ARMOR_SLOT_IDS.length +
	UNDERARMOR_SLOT_IDS.length +
	NECKLACE_SLOT_COUNT +
	RING_SLOT_COUNT;

/** Display name for each fixed slot. Accessories fall back to their group name. */
const SLOT_LABELS: Readonly<Record<string, string>> = {
	head: "Helmet",
	chest: "Chestplate",
	legs: "Leggings",
	feet: "Boots",
	underhead: "Chain Coif",
	underchest: "Chain Shirt",
	underlegs: "Chain Leggings",
	underfeet: "Chain Boots",
};

export function groupForSlotId(id: string): EquipmentGroup {
	if ((ARMOR_SLOT_IDS as readonly string[]).includes(id)) return "armor";
	if ((UNDERARMOR_SLOT_IDS as readonly string[]).includes(id)) {
		return "underarmor";
	}
	if (id.startsWith("necklace")) return "necklace";
	return "ring";
}

export function labelForSlotId(id: string): string {
	return (
		SLOT_LABELS[id] ?? (groupForSlotId(id) === "ring" ? "Ring" : "Necklace")
	);
}

/** Every equipment slot id, in render order. */
export function getEquipmentSlotIds(): string[] {
	const ids: string[] = [];
	for (const id of ARMOR_SLOT_IDS) ids.push(id);
	for (const id of UNDERARMOR_SLOT_IDS) ids.push(id);
	for (let i = 1; i <= NECKLACE_SLOT_COUNT; i++) ids.push(`necklace${i}`);
	for (let i = 1; i <= RING_SLOT_COUNT; i++) ids.push(`ring${i}`);
	return ids;
}

/**
 * The four outer slots paired with their chain slots, for the 4-column layout.
 * Zipping by index is intentional: the two id lists are declared in matching
 * order.
 */
export function getArmorColumnPairs(): { armor: string; underarmor: string }[] {
	return ARMOR_SLOT_IDS.map((id, i) => ({
		armor: id,
		underarmor: UNDERARMOR_SLOT_IDS[i]!,
	}));
}
