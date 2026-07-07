import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const TEMPERATE_BIOMES = new Set([
	BIOME_ID.PLAINS,
	BIOME_ID.GRASS_LAND,
	BIOME_ID.MEADOW,
	BIOME_ID.HEDGEROW,
	BIOME_ID.SAVANNAH,
]);

export class WindmillFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 250 };
	public readonly maxAboveSurface = 30;

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
		if (!TEMPERATE_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 8101234567,
			magicB: 778899001,
			spawnChance: 6,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: wx, centerZ: wz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const radius = 5;

		if (
			!aabbOverlaps(
				wx - radius,
				wx + radius,
				wz - radius,
				wz + radius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(wx, wz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(wx, wz);
		}

		const towerHeight =
			18 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 8);

		for (let dy = 0; dy < towerHeight; dy++) {
			const taper = Math.max(2, radius - Math.floor(dy / 6));
			const taperSq = taper * taper;
			for (let dx = -taper; dx <= taper; dx++) {
				for (let dz = -taper; dz <= taper; dz++) {
					if (dx * dx + dz * dz > taperSq) continue;
					const blockId =
						dy < 2 ? BlockType.Cobblestone03 : BlockType.WoodPlankWall;
					placeBlock(wx + dx, groundHeight + dy, wz + dz, blockId, true);
				}
			}
		}

		const platformY = groundHeight + towerHeight;
		for (let dx = -radius; dx <= radius; dx++) {
			for (let dz = -radius; dz <= radius; dz++) {
				if (dx * dx + dz * dz > radius * radius) continue;
				placeBlock(wx + dx, platformY, wz + dz, BlockType.WoodPlanks, true);
			}
		}

		for (let dy = 0; dy < 5; dy++) {
			placeBlock(wx, platformY + dy + 1, wz, BlockType.RoughWood, true);
		}

		const bladeLen = 6;
		const bladeY = platformY + 4;
		for (let i = 1; i <= bladeLen; i++) {
			placeBlock(wx + i, bladeY, wz, BlockType.WoodPlanks, true);
			placeBlock(wx - i, bladeY, wz, BlockType.WoodPlanks, true);
			placeBlock(wx, bladeY, wz + i, BlockType.WoodPlanks, true);
			placeBlock(wx, bladeY, wz - i, BlockType.WoodPlanks, true);
		}
	}
}
