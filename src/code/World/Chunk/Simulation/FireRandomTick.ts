import { BlockType } from "../../Texture/BlockType";

/** Fire is removed on a random fire tick, not on a synchronized countdown. */
export const FIRE_RANDOM_EXTINGUISH_CHANCE = 0.5;

export function shouldExtinguishFireOnRandomTick(
	blockId: number,
	random: () => number = Math.random,
): boolean {
	return blockId === BlockType.Fire && random() < FIRE_RANDOM_EXTINGUISH_CHANCE;
}
