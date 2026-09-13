/**
 * Shared melee stats — single source of truth for player punches and
 * hostile-mob attacks (client and server import from here so SP and MP
 * agree).
 *
 * Design rule: attack REACH comes from the WEAPON, never from the mob.
 * Zombies and skeletons both melee in v1, but the skeleton's longer club
 * out-reaches zombie claws — swapping a mob's weapon retunes it with no
 * AI changes. Ranged weapons (bows) reuse the same lookup later: a mob
 * whose weapon has a projectile profile shoots instead of swinging.
 */

import { MobTypeId } from "./MobConfig";

/** Unarmed reach in blocks (player punches and fist-fighters). */
export const FISTS_RANGE = 2.6;
/** Unarmed damage (keeps the classic 1-hp punch). */
export const FISTS_DAMAGE = 1;

/**
 * Virtual weapon ids for mob natural weapons. Negative so they can never
 * collide with real item ids from items.json / ProceduralTools.
 */
export const MOB_WEAPON_ZOMBIE_CLAWS = -1001;
export const MOB_WEAPON_SKELETON_CLUB = -1002;

/** Mob type name -> equipped weapon item id (virtual ids allowed). */
export const MOB_WEAPONS: Readonly<Record<string, number>> = {
	zombie: MOB_WEAPON_ZOMBIE_CLAWS,
	skeleton: MOB_WEAPON_SKELETON_CLUB,
};

/** Sword damage by material tier (matches ProceduralTools ids). */
const SWORD_DAMAGE: Readonly<Record<number, number>> = {
	1001: 4, // Wooden Sword
	1006: 5, // Stone Sword
	1011: 6, // Iron Sword
	1028: 4, // Gold Sword (base 1027 + Sword offset 1)
	1033: 5, // Copper Sword (base 1032 + Sword offset 1)
};

/** Non-sword tool ids and their melee damage (wood/stone 2, metal 3). */
const TOOL_DAMAGE: Readonly<Record<number, number>> = {
	// Wood (1000-1004) / Stone (1005-1009), minus the swords above.
	1000: 2,
	1002: 2,
	1003: 2,
	1004: 2,
	1005: 2,
	1007: 3, // Stone Axe hits harder
	1008: 2,
	1009: 2,
	// Iron (1010-1014), minus the sword above.
	1010: 3,
	1012: 4, // Iron Axe hits harder
	1013: 3,
	1014: 3,
};

/** Sword reach in blocks by material (longer blades, longer reach). */
const SWORD_RANGE: Readonly<Record<number, number>> = {
	1001: 2.9,
	1006: 2.9,
	1011: 3.0,
	1028: 3.0,
	1033: 3.0,
};

/** Melee damage for a weapon item id. Undefined/null = bare fists. */
export function getMeleeDamage(itemId?: number | null): number {
	if (itemId === undefined || itemId === null) return FISTS_DAMAGE;
	if (itemId === MOB_WEAPON_ZOMBIE_CLAWS) return 3;
	if (itemId === MOB_WEAPON_SKELETON_CLUB) return 2;
	const sword = SWORD_DAMAGE[itemId];
	if (sword !== undefined) return sword;
	const tool = TOOL_DAMAGE[itemId];
	if (tool !== undefined) return tool;
	// Procedural metal tools (gold/copper sets) not enumerated above:
	// any other tool-shaped id in those ranges is a 3-damage implement.
	if (itemId >= 1027 && itemId <= 1036) {
		return itemId === 1028 || itemId === 1033 ? (SWORD_DAMAGE[itemId] ?? 3) : 3;
	}
	return FISTS_DAMAGE;
}

/** Melee reach in blocks for a weapon item id. Undefined/null = fists. */
export function getMeleeRange(itemId?: number | null): number {
	if (itemId === undefined || itemId === null) return FISTS_RANGE;
	if (itemId === MOB_WEAPON_ZOMBIE_CLAWS) return 2.6;
	// The skeleton's club visibly out-reaches zombie claws: reach lives
	// on the weapon, so both mobs share one attack routine.
	if (itemId === MOB_WEAPON_SKELETON_CLUB) return 3.4;
	const sword = SWORD_RANGE[itemId];
	if (sword !== undefined) return sword;
	if (TOOL_DAMAGE[itemId] !== undefined) return 2.7;
	if (itemId >= 1027 && itemId <= 1036) return 2.8;
	return FISTS_RANGE;
}

/** Equipped weapon item id for a mob type name (undefined = fists). */
export function getMobWeaponId(mobType: string): number | undefined {
	return MOB_WEAPONS[mobType];
}

/** Equipped weapon item id for a numeric MobTypeId (undefined = fists). */
export function getMobWeaponIdByTypeId(typeId: number): number | undefined {
	// Numeric mirror of MOB_WEAPONS for the multiplayer renderer, which
	// only carries type ids over the wire — no string round-trip needed.
	if (typeId === MobTypeId.Zombie) return MOB_WEAPON_ZOMBIE_CLAWS;
	if (typeId === MobTypeId.Skeleton) return MOB_WEAPON_SKELETON_CLUB;
	return undefined;
}
