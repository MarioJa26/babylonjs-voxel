import { Map1 } from "@/code/Maps/Map1";
import { dropWorldItem } from "@/code/Player/Inventory/dropWorldItem";
import { Item } from "@/code/Player/Inventory/Item";
import type { Player } from "@/code/Player/Player";

/** Food item IDs (see public/data/items.json). Icons live in public/texture/items/food/. */
export const FOOD_RAW_CHICKEN = 1104;
export const FOOD_RAW_MUTTON = 1105;
export const FOOD_RAW_BEEF = 1106;
export const FOOD_RAW_FISH = 1107;
export const FOOD_CALAMARI = 1108;
export const FOOD_KRAKEN_MEAT = 1109;

/** Per-mob food drop ranges, agreed with design: chicken/sheep/fish/squid 1-2, cow 1-3, kraken 3-5. */
export const MOB_FOOD_DROPS: Readonly<
	Record<string, { itemId: number; min: number; max: number }>
> = {
	chicken: { itemId: FOOD_RAW_CHICKEN, min: 1, max: 2 },
	sheep: { itemId: FOOD_RAW_MUTTON, min: 1, max: 2 },
	cow: { itemId: FOOD_RAW_BEEF, min: 1, max: 3 },
	fish: { itemId: FOOD_RAW_FISH, min: 1, max: 2 },
	squid: { itemId: FOOD_CALAMARI, min: 1, max: 2 },
	kraken: { itemId: FOOD_KRAKEN_MEAT, min: 3, max: 5 },
};

/** Inclusive random integer in [min, max]. */
export function rollDropCount(min: number, max: number): number {
	const lo = Math.floor(min);
	const hi = Math.floor(max);
	if (hi <= lo) return lo;
	return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Drop a food stack at a mob death position.
 *
 * Single call site for all mob food drops so counts, scatter and the
 * multiplayer route (via Map1.mainPlayer -> net.sendItemDrop) stay
 * consistent. A small random scatter + upward pop keeps drops from
 * stacking inside the death position (same pattern as Arrow.dropAsItem).
 */
export function dropMobFood(
	x: number,
	y: number,
	z: number,
	itemId: number,
	min: number,
	max: number,
	player?: Player,
): void {
	// Never let a drop failure break the caller's onDeath/dispose: a mob
	// that throws here would stay in the world at 0 hp with no drops.
	try {
		const item = Item.createById(itemId);
		item.stackSize = rollDropCount(min, max);
		dropWorldItem(
			item,
			x,
			y + 0.5,
			z,
			(Math.random() - 0.5) * 1.5,
			2,
			(Math.random() - 0.5) * 1.5,
			player ?? Map1.mainPlayer ?? undefined,
		);
	} catch (error) {
		console.warn(`MobDrops: failed to drop item ${itemId}:`, error);
	}
}

/** Convenience: drop the configured food for a mobType at a position. No-op for unknown types. */
export function dropMobFoodForType(
	mobType: string,
	x: number,
	y: number,
	z: number,
	player?: Player,
): void {
	const entry = MOB_FOOD_DROPS[mobType];
	if (!entry) return;
	dropMobFood(x, y, z, entry.itemId, entry.min, entry.max, player);
}
