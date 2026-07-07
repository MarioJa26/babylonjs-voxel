import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const MOUNTAIN_BIOMES = new Set([
	BIOME_ID.CLOUD_PEAKS,
	BIOME_ID.ALPINE_MEADOW,
	BIOME_ID.TUNDRA_MOUNTAINS,
	BIOME_ID.VOLCANIC_CALDERA,
]);

export class ObservatoryFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 350 };
	public readonly maxAboveSurface = 15;

	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		biome: Biome,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
		columnPrepassResolver?: ColumnPrepassResolver,
	) {
		if (!MOUNTAIN_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 18,
			magicA: 2323456789,
			magicB: 101011121,
			spawnChance: 3,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: ox, centerZ: oz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const radius = 5;

		if (
			!aabbOverlaps(
				ox - radius,
				ox + radius,
				oz - radius,
				oz + radius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(ox, oz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(ox, oz);
		}

		const buildingHeight =
			6 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 3);
		const radiusSq = radius * radius;

		for (let dy = 0; dy < buildingHeight; dy++) {
			for (let dx = -radius; dx <= radius; dx++) {
				for (let dz = -radius; dz <= radius; dz++) {
					if (dx * dx + dz * dz > radiusSq) continue;
					const blockId =
						dy === 0 ? BlockType.Cobblestone03 : BlockType.ConcretePanels;
					placeBlock(ox + dx, groundHeight + dy, oz + dz, blockId, true);
				}
			}
		}

		const domeRadius = 3;
		const domeRs = domeRadius * domeRadius;
		const domeY = groundHeight + buildingHeight;
		for (let dx = -domeRadius; dx <= domeRadius; dx++) {
			for (let dz = -domeRadius; dz <= domeRadius; dz++) {
				const distSq = dx * dx + dz * dz;
				if (distSq > domeRs) continue;
				const domeHeight = Math.floor(
					domeRadius * (1 - distSq / (domeRs * 1.2)),
				);
				for (let dy = 0; dy <= domeHeight; dy++) {
					const blockId =
						dy === domeHeight ? BlockType.Glass01 : BlockType.ConcretePanels;
					placeBlock(ox + dx, domeY + dy, oz + dz, blockId, true);
				}
			}
		}

		placeBlock(ox, domeY + domeRadius + 1, oz, BlockType.Glass01, true);
	}
}
