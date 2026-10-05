// ─── Durability ───
//
// Durability never destroys an item. When it runs out the item stops working —
// a spent pickaxe mines at bare-hand pace and cannot harvest gated blocks, a
// spent sword hits like a fist — but it stays in the inventory and can be
// repaired. Losing your tools to a mis-click would be worse than losing their
// effectiveness, and "useless until repaired" gives repair a reason to exist
// without ever creating an unwinnable state.
//
// The whole model rests on one rule: **a depleted item presents itself to every
// id-based lookup as id 0 (bare hands).** See `Item.getToolLookupId()`. That is
// why mining, melee reach and melee damage all degrade correctly without a
// single extra branch at their call sites — they are already handling "no tool".

/** Durability spent per block successfully broken with a correctly-paired tool. */
export const HARVEST_DURABILITY_COST = 1;

/** Durability spent per melee hit landed. */
export const MELEE_DURABILITY_COST = 1;

/**
 * Armour value multiplier while a piece is spent. Armour is passive — the player
 * never chooses to "use" it — so zeroing its value would be pure punishment.
 * Half still creates urgency to repair without feeling arbitrary.
 */
export const DEPLETED_ARMOR_MULTIPLIER = 0.5;

/**
 * Whether an item has durability and has spent all of it.
 * Items with `maxDurability <= 0` are indestructible and never deplete.
 */
export function isDepleted(durability: number, maxDurability: number): boolean {
	return maxDurability > 0 && durability <= 0;
}

/**
 * The id a tool should report to id-based lookups.
 *
 * A spent tool reports 0, which `getToolMiningLevel`, `getToolSpeedMultiplier`,
 * `getToolKind`, `getMeleeDamage` and `getMeleeRange` already all treat as bare
 * hands. That single substitution is what makes a depleted pickaxe mine at hand
 * pace and stop harvesting gated blocks, and a depleted sword hit like a fist,
 * with no branching at any of those call sites.
 */
export function toolLookupId(
	itemId: number,
	durability: number,
	maxDurability: number,
): number {
	return isDepleted(durability, maxDurability) ? 0 : itemId;
}

/**
 * Whether two stacks of the same item may be folded together.
 *
 * Two items of one type can carry different durability, so merging them would
 * silently discard one of the two budgets — a free repair, or worse, a free
 * downgrade. Durable items are authored `maxStack: 1` so this never fires in
 * practice; it exists so a mis-authored definition cannot corrupt state.
 */
export function canStackTogether(
	a: { itemId: number; durability: number },
	b: { itemId: number; durability: number },
): boolean {
	if (a.itemId !== b.itemId) return false;
	return a.durability === b.durability;
}

/**
 * Restore durability, clamped to the item's budget.
 * Returns the amount actually restored.
 */
export function repairAmount(
	current: number,
	max: number,
	amount: number,
): number {
	if (max <= 0 || amount <= 0) return 0;
	const restored = Math.min(current + amount, max) - current;
	return restored > 0 ? restored : 0;
}
