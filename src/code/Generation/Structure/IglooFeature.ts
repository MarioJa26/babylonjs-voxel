import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const COLD_BIOMES = new Set([
	BIOME_ID.SNOWY_PLAINS,
	BIOME_ID.TUNDRA,
	BIOME_ID.FROZEN_TUNDRA_PLAINS,
	BIOME_ID.AURORA_TUNDRA,
	BIOME_ID.PERMAFROST_BOG,
]);

export class IglooFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };

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
		if (!COLD_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 10,
			magicA: 4067890123,
			magicB: 334455667,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: ix, centerZ: iz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const radius = 5;

		if (
			!aabbOverlaps(
				ix - radius,
				ix + radius,
				iz - radius,
				iz + radius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(ix, iz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(ix, iz);
		}

		const hasEntry =
			Math.abs(Squirrel3.get(region.regionHash + 5, seed)) % 3 === 0;

		for (let dx = -radius; dx <= radius; dx++) {
			for (let dz = -radius; dz <= radius; dz++) {
				const distSq = dx * dx + dz * dz;
				if (distSq > radius * radius) continue;

				const height = Math.floor(4 * (1 - distSq / (radius * radius)));
				for (let y = 0; y <= height; y++) {
					const blockId =
						y === height ? BlockType.IceBlock : BlockType.GlacierIce;
					placeBlock(ix + dx, groundHeight + y, iz + dz, blockId, true);
				}
			}
		}

		if (hasEntry) {
			for (let y = 1; y <= 3; y++) {
				placeBlock(ix + radius, groundHeight + y, iz, BlockType.Air, true);
				placeBlock(ix + radius - 1, groundHeight + y, iz, BlockType.Air, true);
			}
			placeBlock(ix + radius, groundHeight + 3, iz, BlockType.IceBlock, true);
			placeBlock(
				ix + radius - 1,
				groundHeight + 3,
				iz,
				BlockType.IceBlock,
				true,
			);
		}

		for (let dx = -2; dx <= 2; dx++) {
			for (let dz = -2; dz <= 2; dz++) {
				if (dx * dx + dz * dz > 5) continue;
				placeBlock(ix + dx, groundHeight, iz + dz, BlockType.IceBlock, true);
			}
		}
	}
}
