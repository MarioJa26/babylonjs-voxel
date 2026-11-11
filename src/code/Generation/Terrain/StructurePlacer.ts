import type { Biome } from "../Biome/BiomeTypes";
import type {
	ColumnPrepassResolver,
	IWorldFeature,
	StructureEmitContext,
} from "../Structure/IWorldFeature";
import type { PlaceBlockFn } from "../SurfaceGenerator";

const STRUCTURE_SEARCH_RADIUS = 2;

export function generateStructures(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	chunkSize: number,
	biome: Biome,
	features: IWorldFeature[],
	seedAsInt: number,
	placeBlock: PlaceBlockFn,
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

	/*
	 * One claim set per feature, scoped to this chunk.
	 *
	 * The search window below calls every feature once per chunk position in
	 * it. A feature whose structure is placed per region resolves the same
	 * region from every position inside that region, so without a claim the
	 * same structure is emitted into the same chunk once per position. The
	 * claim turns that into one emission per region, which is both what the
	 * generator means and what the cost model assumes.
	 */
	const claimsByFeature = new Map<IWorldFeature, Set<string>>();

	const emitContext: StructureEmitContext = {
		tryClaim(feature, key): boolean {
			let claims = claimsByFeature.get(feature);

			if (claims === undefined) {
				claims = new Set<string>();
				claimsByFeature.set(feature, claims);
			}

			if (claims.has(key)) return false;

			claims.add(key);

			return true;
		},
	};

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
					emitContext,
				);
			}
		}
	}
}
