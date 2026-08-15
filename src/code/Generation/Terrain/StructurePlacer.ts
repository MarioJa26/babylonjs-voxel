import type { Biome } from "../Biome/BiomeTypes";
import type {
	ColumnPrepassResolver,
	IWorldFeature,
} from "../Structure/IWorldFeature";

const STRUCTURE_SEARCH_RADIUS = 2;

export function generateStructures(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	chunkSize: number,
	biome: Biome,
	features: IWorldFeature[],
	seedAsInt: number,
	placeBlock: (
		x: number,
		y: number,
		z: number,
		id: number,
		ow: boolean,
	) => void,
	columnPrepassResolver?: ColumnPrepassResolver,
): void {
	const chunkMinY = chunkY * chunkSize;
	const chunkMaxY = chunkMinY + chunkSize - 1;

	const featureCount = features.length;
	if (featureCount === 0) return;

	const relevantFeatures: IWorldFeature[] = [];

	for (let i = 0; i < featureCount; i++) {
		const feature = features[i];
		const bounds = feature.verticalBounds;

		if (
			bounds === undefined ||
			(chunkMaxY >= bounds.minWorldY && chunkMinY <= bounds.maxWorldY)
		) {
			relevantFeatures.push(feature);
		}
	}

	const relevantFeatureCount = relevantFeatures.length;
	if (relevantFeatureCount === 0) return;

	const minSearchChunkX = chunkX - STRUCTURE_SEARCH_RADIUS;
	const maxSearchChunkX = chunkX + STRUCTURE_SEARCH_RADIUS;
	const minSearchChunkZ = chunkZ - STRUCTURE_SEARCH_RADIUS;
	const maxSearchChunkZ = chunkZ + STRUCTURE_SEARCH_RADIUS;

	for (let cx = minSearchChunkX; cx <= maxSearchChunkX; cx++) {
		for (let cz = minSearchChunkZ; cz <= maxSearchChunkZ; cz++) {
			for (let i = 0; i < relevantFeatureCount; i++) {
				relevantFeatures[i].generate(
					cx,
					chunkY,
					cz,
					biome,
					placeBlock,
					seedAsInt,
					chunkSize,
					chunkX,
					chunkZ,
					columnPrepassResolver,
				);
			}
		}
	}
}
