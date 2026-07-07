import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const HOT_BIOMES = new Set([
	BIOME_ID.DESERT,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.SALT_FLATS,
	BIOME_ID.CRACKED_EARTH,
	BIOME_ID.DUST_BOWL,
	BIOME_ID.BADLANDS,
	BIOME_ID.RED_ROCK_CANYON,
]);

export class PyramidFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 300 };
	public readonly maxAboveSurface = 40;

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
		if (!HOT_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 18,
			magicA: 2434567890,
			magicB: 101112131,
			spawnChance: 3,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: px, centerZ: pz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const baseRadius =
			10 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 6);

		if (
			!aabbOverlaps(
				px - baseRadius,
				px + baseRadius,
				pz - baseRadius,
				pz + baseRadius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(px, pz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(px, pz);
		}

		const pyramidHeight =
			15 + (Math.abs(Squirrel3.get(region.regionHash + 5, seed)) % 10);
		const hasChamber =
			Math.abs(Squirrel3.get(region.regionHash + 10, seed)) % 3 === 0;

		for (let dy = 0; dy < pyramidHeight; dy++) {
			const layerRadius = Math.floor(baseRadius * (1 - dy / pyramidHeight));
			const layerBlock =
				dy % 4 === 0 ? BlockType.RedSandstoneWall : BlockType.Cobblestone03;

			for (let dx = -layerRadius; dx <= layerRadius; dx++) {
				for (let dz = -layerRadius; dz <= layerRadius; dz++) {
					if (dx * dx + dz * dz > layerRadius * layerRadius) continue;

					const isEdge =
						dx * dx + dz * dz > (layerRadius - 1) * (layerRadius - 1);
					const isHollow =
						hasChamber &&
						dy > 3 &&
						dy < pyramidHeight - 3 &&
						Math.abs(dx) < layerRadius - 2 &&
						Math.abs(dz) < layerRadius - 2;

					if (isHollow && !isEdge) continue;
					placeBlock(px + dx, groundHeight + dy, pz + dz, layerBlock, true);
				}
			}
		}

		placeBlock(px, groundHeight + pyramidHeight, pz, BlockType.Glass01, true);
	}
}
