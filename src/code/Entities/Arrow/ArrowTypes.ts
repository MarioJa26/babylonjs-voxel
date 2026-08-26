import { Color3 } from "@/code/Lib/Math";

/**
 * Arrow material types.
 *
 * Each type has its own inventory icon (from public/texture/items/item/arrow/)
 * and combat stats: direct hit damage, how long it stays embedded in a mob
 * (stick time), and how much bleed damage it deals per second while stuck.
 * The in-flight mesh remains a colored box (tint = color) — icons use textures.
 */
export type ArrowTypeName =
	| "wood"
	| "iron"
	| "gold"
	| "coal"
	| "copper"
	| "glass";

export interface ArrowTypeDef {
	/** Stable identifier (also the item's arrowType key). */
	type: ArrowTypeName;
	/** Item id of the matching ammunition item. */
	itemId: number;
	/** Tint applied to the box arrow mesh. */
	color: Color3;
	/** Inventory icon path (under /public). */
	icon: string;
	/** Texture path for potential future textured mesh (under /public). */
	texture: string;
	/** Damage dealt on a direct hit. */
	damage: number;
	/** Seconds the arrow remains embedded in a mob before dropping. */
	stickTime: number;
	/** Damage per second applied to a mob while the arrow is stuck. */
	bleedPerSecond: number;
}

export const ARROW_TYPES: readonly ArrowTypeDef[] = [
	{
		type: "wood",
		itemId: 1023,
		color: new Color3(0.45, 0.32, 0.18),
		icon: "/texture/items/item/arrow/woodarrow.png",
		texture: "/texture/items/item/arrow/woodarrow.png",
		damage: 0.4,
		stickTime: 5,
		bleedPerSecond: 0.2,
	},
	{
		type: "iron",
		itemId: 1040,
		color: new Color3(0.75, 0.78, 0.82),
		icon: "/texture/items/item/arrow/ironarrow.png",
		texture: "/texture/items/item/arrow/ironarrow.png",
		damage: 4.0,
		stickTime: 12,
		bleedPerSecond: 1.0,
	},
	{
		type: "gold",
		itemId: 1041,
		color: new Color3(0.95, 0.8, 0.2),
		icon: "/texture/items/item/arrow/goldarrow.png",
		texture: "/texture/items/item/arrow/goldarrow.png",
		damage: 3.0,
		stickTime: 15,
		bleedPerSecond: 1.0,
	},
	{
		type: "coal",
		itemId: 1042,
		color: new Color3(0.15, 0.15, 0.18),
		icon: "/texture/items/item/arrow/coalarrow.png",
		texture: "/texture/items/item/arrow/coalarrow.png",
		damage: 2.0,
		stickTime: 5,
		bleedPerSecond: 1.5,
	},
	{
		type: "copper",
		itemId: 1043,
		color: new Color3(0.72, 0.45, 0.25),
		icon: "/texture/items/item/arrow/copperarrow.png",
		texture: "/texture/items/item/arrow/copperarrow.png",
		damage: 3.0,
		stickTime: 14,
		bleedPerSecond: 1.0,
	},
	{
		type: "glass",
		itemId: 1044,
		color: new Color3(0.55, 0.85, 0.9),
		icon: "/texture/items/item/arrow/glassarrow.png",
		texture: "/texture/items/item/arrow/glassarrow.png",
		damage: 4,
		stickTime: 4,
		bleedPerSecond: 2.5,
	},
];

export const ARROW_TYPE_COUNT = ARROW_TYPES.length;

const ITEM_ID_TO_TYPE_INDEX = new Map<number, number>();

for (let i = 0; i < ARROW_TYPES.length; i++) {
	ITEM_ID_TO_TYPE_INDEX.set(ARROW_TYPES[i]!.itemId, i);
}

/** Map an ammunition item id to its arrow-type index (defaults to wood). */
export function getArrowTypeIndexByItemId(itemId: number): number {
	const index = ITEM_ID_TO_TYPE_INDEX.get(itemId);
	return index === undefined ? 0 : index;
}

export function getArrowTypeDef(typeIndex: number): ArrowTypeDef {
	return ARROW_TYPES[typeIndex] ?? ARROW_TYPES[0]!;
}

/** Multi-line stat block for an arrow's item tooltip, or null if not an arrow. */
export function getArrowTooltipStats(itemId: number): string | null {
	const index = ITEM_ID_TO_TYPE_INDEX.get(itemId);
	if (index === undefined) return null;

	const def = ARROW_TYPES[index]!;
	return [
		`Damage: ${def.damage}`,
		`Stick time: ${def.stickTime}s`,
		`Bleed: ${def.bleedPerSecond}/s`,
	].join("\n");
}
