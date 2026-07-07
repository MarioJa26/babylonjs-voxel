import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const HOT_BIOMES = new Set([
	BIOME_ID.DESERT,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.SAVANNAH,
	BIOME_ID.SCORCHED_SAVANNAH,
	BIOME_ID.BADLANDS,
	BIOME_ID.DUST_BOWL,
]);

export class CaravanCampFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 6;

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
			regionSize: 12,
			magicA: 5767890123,
			magicB: 434445464,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				cx - 8,
				cx + 8,
				cz - 8,
				cz + 8,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(cx, cz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(cx, cz);
		}

		const numTents = 2 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 3);
		for (let i = 0; i < numTents; i++) {
			const angle = (i / numTents) * Math.PI * 2;
			const dist = 3 + (Math.abs(Squirrel3.get(i * 23, seed)) % 3);
			const tentX = Math.floor(cx + Math.cos(angle) * dist);
			const tentZ = Math.floor(cz + Math.sin(angle) * dist);
			const tentW = 3 + (Math.abs(Squirrel3.get(i * 31, seed)) % 2);
			const tentD = 3 + (Math.abs(Squirrel3.get(i * 43, seed)) % 2);

			for (let dx = 0; dx < tentW; dx++) {
				for (let dz = 0; dz < tentD; dz++) {
					placeBlock(
						tentX + dx,
						groundHeight,
						tentZ + dz,
						BlockType.OldPlanks02,
						true,
					);
					placeBlock(
						tentX + dx,
						groundHeight + 1,
						tentZ + dz,
						BlockType.ThatchRoofAngled,
						true,
					);
				}
			}

			placeBlock(
				tentX + Math.floor(tentW / 2),
				groundHeight + 2,
				tentZ + Math.floor(tentD / 2),
				BlockType.ThatchRoofAngled,
				true,
			);
		}

		placeBlock(cx, groundHeight, cz, BlockType.Air, true);
		placeBlock(cx, groundHeight + 1, cz, BlockType.Air, true);
	}
}
