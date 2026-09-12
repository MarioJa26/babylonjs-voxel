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

/**
 * Per-hostile item drops (mirrors the client's MOB_ITEM_DROPS):
 * zombies drop rotten flesh (1110), skeletons drop bones (1115) plus
 * 0-2 wooden arrows (1023) so bow users restock at night.
 */
export const MOB_ITEM_DROPS: Readonly<Record<number, MobFoodDrop[]>> = {
	[MobTypeId.Zombie]: [{ itemId: 1110, min: 1, max: 2 }],
	[MobTypeId.Skeleton]: [
		{ itemId: 1115, min: 1, max: 2 },
		{ itemId: 1023, min: 0, max: 2 },
	],
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

/** Roll every item drop for a hostile mob type. Empty for unknown types. */
export function rollMobItemDrops(typeId: number): RolledFoodDrop[] {
	const entries = MOB_ITEM_DROPS[typeId];
	if (!entries) return [];

	const drops: RolledFoodDrop[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const lo = Math.floor(entry.min);
		const hi = Math.floor(entry.max);
		const stackSize =
			hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
		if (stackSize > 0) drops.push({ itemId: entry.itemId, stackSize });
	}
	return drops;
}
