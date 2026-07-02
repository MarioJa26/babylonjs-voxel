import type { Biome } from "../Biome/BiomeTypes";

export const SUBSURFACE_LAYER_DEPTH = 5;
export const SURFACE_RESET_AIR_GAP = 6;

export function resolveSolidBlockId(
	currentBiome: Biome,
	worldY: number,
	depthBelowSurface: number,
	isBeach: boolean,
	seaLevel: number,
): number {
	let blockId = currentBiome.stoneBlock;

	if (depthBelowSurface === 0) {
		if (worldY < seaLevel - 1) {
			blockId = currentBiome.seafloorBlock;
		} else if (isBeach && worldY >= seaLevel - 2 && worldY <= seaLevel + 2) {
			blockId = currentBiome.beachBlock;
		} else {
			blockId = currentBiome.topBlock;
		}
	} else if (
		depthBelowSurface > 0 &&
		depthBelowSurface <= SUBSURFACE_LAYER_DEPTH
	) {
		blockId = currentBiome.undergroundBlock;
	}

	return blockId;
}
