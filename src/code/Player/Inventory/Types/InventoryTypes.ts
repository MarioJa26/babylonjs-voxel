export interface CubeIconOptions {
	radius?: number;
	ry?: number;
	heightRatio?: number;
	size?: number;
	topShade?: number;
	leftShade?: number;
	rightShade?: number;
}
export type ItemDefinition = {
	id: number;
	name: string;
	description?: string;
	icon?: string;
	maxStack?: number;
	useAction?: string;
	blockId?: number;
	blockState?: number;
	shape?: string;
	/** Spawn eggs: the mobType (MobSpawnConfig key) to spawn on use. */
	spawnMobType?: string;
	/** Food: hunger points restored when eaten via the use_food action. */
	hunger?: number;
	/**
	 * Durability budget for this item type. Omitted or 0 means indestructible.
	 * When omitted, the tool material's budget is used instead, so hand-authored
	 * tool definitions do not have to repeat it.
	 */
	maxDurability?: number;
	/**
	 * Equipment slot this item belongs to. Omitted means the item is not
	 * equippable. Outer armour and chain name their exact slot; accessories name
	 * their group, since any ring fits any ring slot.
	 */
	armorSlot?: ArmorSlot;
	/** Damage reduction points contributed while worn. */
	armorValue?: number;
};

export type SavedInventoryItem = {
	itemId: number;
	stackSize: number;
	/**
	 * Remaining durability. Omitted when the item is pristine or indestructible,
	 * which keeps the save payload small — this serialises to localStorage on
	 * every inventory mutation.
	 */
	durability?: number;
};

export type SavedInventoryState = {
	width: number;
	height: number;
	slots: (SavedInventoryItem | null)[][];
};

/**
 * Which equipment group an item belongs to. Outer armour and the chain
 * under-layer name their exact slot; accessories name their group, because any
 * ring fits any ring slot.
 *
 * `"chain"` is the special case: one chain item fits any of the four underarmour
 * slots, rather than needing four near-identical pieces per material.
 */
export type ArmorSlot =
	| ArmorSlotId
	| "underhead"
	| "underchest"
	| "underlegs"
	| "underfeet"
	| "chain"
	| "necklace"
	| "ring";

export type ArmorSlotId = "head" | "chest" | "legs" | "feet";

export type SavedEquipmentState = {
	/** Only occupied slots are stored; an absent id means "empty". */
	slots: { id: string; itemId: number; durability?: number }[];
};
