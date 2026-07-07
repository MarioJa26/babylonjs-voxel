import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const COASTAL_BIOMES = new Set([
	BIOME_ID.SANDY_SHORE,
	BIOME_ID.ROCKY_SHORE,
	BIOME_ID.TIDAL_FLATS,
	BIOME_ID.ARCHIPELAGO,
]);

export class LighthouseFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 300 };
	public readonly maxAboveSurface = 80;

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
		if (!COASTAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 2045678901,
			magicB: 112233445,
			spawnChance: 4,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: lx, centerZ: lz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const radius = 4;

		if (
			!aabbOverlaps(
				lx - radius,
				lx + radius,
				lz - radius,
				lz + radius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(lx, lz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(lx, lz);
		}

		const towerHeight =
			30 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 15);
		const radiusSq = radius * radius;

		for (let dy = 0; dy < towerHeight; dy++) {
			const layerBlock =
				dy === 0
					? BlockType.Cobblestone03
					: dy % 6 === 0
						? BlockType.Glass01
						: BlockType.Cobblestone03;

			for (let dx = -radius; dx <= radius; dx++) {
				for (let dz = -radius; dz <= radius; dz++) {
					if (dx * dx + dz * dz > radiusSq) continue;
					placeBlock(lx + dx, groundHeight + dy, lz + dz, layerBlock, true);
				}
			}
		}

		const lanternY = groundHeight + towerHeight;
		placeBlock(lx, lanternY, lz, BlockType.Glass01, true);
		placeBlock(lx + 1, lanternY, lz, BlockType.Cobblestone03, true);
		placeBlock(lx - 1, lanternY, lz, BlockType.Cobblestone03, true);
		placeBlock(lx, lanternY, lz + 1, BlockType.Cobblestone03, true);
		placeBlock(lx, lanternY, lz - 1, BlockType.Cobblestone03, true);
		placeBlock(lx, lanternY + 1, lz, BlockType.Cobblestone03, true);
	}
}
