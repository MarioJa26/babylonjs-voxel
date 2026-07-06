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

	let hasRelevantFeature = false;
	for (let i = 0; i < features.length; i++) {
		const b = features[i].verticalBounds;
		if (
			b === undefined ||
			!(chunkMaxY < b.minWorldY || chunkMinY > b.maxWorldY)
		) {
			hasRelevantFeature = true;
			break;
		}
	}
	if (!hasRelevantFeature) return;

	for (
		let cx = chunkX - STRUCTURE_SEARCH_RADIUS;
		cx <= chunkX + STRUCTURE_SEARCH_RADIUS;
		cx++
	) {
		for (
			let cz = chunkZ - STRUCTURE_SEARCH_RADIUS;
			cz <= chunkZ + STRUCTURE_SEARCH_RADIUS;
			cz++
		) {
			for (let i = 0; i < features.length; i++) {
				const feature = features[i];
				const bounds = feature.verticalBounds;
				if (bounds !== undefined) {
					if (chunkMaxY < bounds.minWorldY) continue;
					if (chunkMinY > bounds.maxWorldY) continue;
				}
				feature.generate(
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
