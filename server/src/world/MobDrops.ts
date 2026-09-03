/**
 * MobDrops — server-authoritative food drops for mob deaths.
 *
 * Deliberately Babylon-free (like MobSimulation): plain data + Math.random
 * only. Mirrors the client's singleplayer table
 * (src/code/Entities/Mobs/MobDrops.ts) so SP and MP drop the same foods in
 * the same quantities — item IDs come from public/data/items.json and their
 * icons live in public/texture/items/food/.
 */

import { MobTypeId } from "@/code/Entities/MobConfig";

export interface MobFoodDrop {
	itemId: number;
	min: number;
	max: number;
}

/** Per-mob food drop ranges: chicken/sheep/fish/squid 1-2, cow 1-3, kraken 3-5. */
export const MOB_FOOD_DROPS: Readonly<Record<number, MobFoodDrop>> = {
	[MobTypeId.Chicken]: { itemId: 1104, min: 1, max: 2 },
	[MobTypeId.Sheep]: { itemId: 1105, min: 1, max: 2 },
	[MobTypeId.Cow]: { itemId: 1106, min: 1, max: 3 },
	[MobTypeId.Fish]: { itemId: 1107, min: 1, max: 2 },
	[MobTypeId.Squid]: { itemId: 1108, min: 1, max: 2 },
	[MobTypeId.Kraken]: { itemId: 1109, min: 3, max: 5 },
};

export interface RolledFoodDrop {
	itemId: number;
	stackSize: number;
}

/** Roll the food drop for a mob type. Returns null for unknown types. */
export function rollMobFoodDrop(typeId: number): RolledFoodDrop | null {
	const entry = MOB_FOOD_DROPS[typeId];
	if (!entry) return null;

	const lo = Math.floor(entry.min);
	const hi = Math.floor(entry.max);
	const stackSize =
		hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));

	return { itemId: entry.itemId, stackSize };
}
