import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const GEOLOGICAL_BIOMES = new Set([
	BIOME_ID.CRYSTAL_CAVES,
	BIOME_ID.OBSIDIAN_FLATS,
	BIOME_ID.GEOTHERMAL_FIELD,
	BIOME_ID.MUSHROOM_FIELDS,
]);

export class CrystalShrineFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
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
		if (!GEOLOGICAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 3434567890,
			magicB: 111213141,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: sx, centerZ: sz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				sx - 6,
				sx + 6,
				sz - 6,
				sz + 6,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(sx, sz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(sx, sz);
		}

		for (let dx = -2; dx <= 2; dx++) {
			for (let dz = -2; dz <= 2; dz++) {
				placeBlock(
					sx + dx,
					groundHeight,
					sz + dz,
					BlockType.CrystalBlock,
					true,
				);
			}
		}

		const numSpikes =
			5 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 4);
		for (let i = 0; i < numSpikes; i++) {
			const angle = (i / numSpikes) * Math.PI * 2;
			const dist = 1 + (Math.abs(Squirrel3.get(i * 19, seed)) % 3);
			const spikeX = Math.floor(sx + Math.cos(angle) * dist);
			const spikeZ = Math.floor(sz + Math.sin(angle) * dist);
			const spikeHeight = 3 + (Math.abs(Squirrel3.get(i * 37, seed)) % 4);
			const crystalBlock =
				Math.abs(Squirrel3.get(i * 53, seed)) % 2 === 0
					? BlockType.CrystalBlock
					: BlockType.ExposedCrystalBlock;

			for (let y = 0; y < spikeHeight; y++) {
				placeBlock(spikeX, groundHeight + y + 1, spikeZ, crystalBlock, true);
			}
		}

		placeBlock(sx, groundHeight + 1, sz, BlockType.ExposedCrystalBlock, true);
		placeBlock(sx, groundHeight + 2, sz, BlockType.CrystalBlock, true);
		placeBlock(sx, groundHeight + 3, sz, BlockType.ExposedCrystalBlock, true);
	}
}
