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
};
export type SavedInventoryItem = {
	itemId: number;
	stackSize: number;
};

export type SavedInventoryState = {
	width: number;
	height: number;
	slots: (SavedInventoryItem | null)[][];
};
