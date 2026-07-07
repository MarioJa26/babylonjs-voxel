import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const TROPICAL_BIOMES = new Set([
	BIOME_ID.JUNGLE,
	BIOME_ID.TROPICAL_ISLAND,
	BIOME_ID.MANGROVE,
	BIOME_ID.CLOUD_FOREST,
]);

export class TropicalTempleFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 250 };
	public readonly maxAboveSurface = 20;

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
		if (!TROPICAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 6878901234,
			magicB: 545556575,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: tx, centerZ: tz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const templeRadius = 7;

		if (
			!aabbOverlaps(
				tx - templeRadius,
				tx + templeRadius,
				tz - templeRadius,
				tz + templeRadius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(tx, tz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(tx, tz);
		}

		const templeHeight =
			10 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 6);
		const radiusSq = templeRadius * templeRadius;

		for (let dy = 0; dy < templeHeight; dy++) {
			const layerRadius = Math.floor(
				templeRadius * (1 - dy / (templeHeight * 1.5)),
			);
			const layerBlock =
				dy % 3 === 0 ? BlockType.MossyCobble : BlockType.AncientCrackedStone;

			for (let dx = -layerRadius; dx <= layerRadius; dx++) {
				for (let dz = -layerRadius; dz <= layerRadius; dz++) {
					if (dx * dx + dz * dz > layerRadius * layerRadius) continue;

					const isWall =
						Math.abs(dx) === layerRadius || Math.abs(dz) === layerRadius;
					const isHollow =
						dy > 1 &&
						dy < templeHeight - 2 &&
						Math.abs(dx) < layerRadius - 1 &&
						Math.abs(dz) < layerRadius - 1;

					if (isHollow && !isWall) continue;
					placeBlock(tx + dx, groundHeight + dy, tz + dz, layerBlock, true);
				}
			}
		}

		placeBlock(
			tx,
			groundHeight + templeHeight,
			tz,
			BlockType.ExposedCrystalBlock,
			true,
		);

		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				if (dx * dx + dz * dz > 1) continue;
				placeBlock(tx + dx, groundHeight, tz + dz, BlockType.MossyCobble, true);
			}
		}
	}
}
