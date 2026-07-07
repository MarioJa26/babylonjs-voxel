import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const HOT_BIOMES = new Set([
	BIOME_ID.DESERT,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.OASIS,
	BIOME_ID.SCORCHED_SAVANNAH,
	BIOME_ID.DUST_BOWL,
]);

export class DesertOasisFeature implements IWorldFeature {
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
		if (!HOT_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 3545678901,
			magicB: 212223242,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: ox, centerZ: oz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const poolRadius =
			5 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 3);

		if (
			!aabbOverlaps(
				ox - poolRadius - 4,
				ox + poolRadius + 4,
				oz - poolRadius - 4,
				oz + poolRadius + 4,
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

		const radiusSq = poolRadius * poolRadius;
		for (let dx = -poolRadius; dx <= poolRadius; dx++) {
			for (let dz = -poolRadius; dz <= poolRadius; dz++) {
				if (dx * dx + dz * dz > radiusSq) continue;
				placeBlock(ox + dx, groundHeight - 1, oz + dz, BlockType.Water, true);
			}
		}

		const numPalms =
			3 + (Math.abs(Squirrel3.get(region.regionHash + 5, seed)) % 3);
		for (let i = 0; i < numPalms; i++) {
			const angle = (i / numPalms) * Math.PI * 2 + 0.5;
			const dist = poolRadius + 1 + (Math.abs(Squirrel3.get(i * 41, seed)) % 2);
			const palmX = Math.floor(ox + Math.cos(angle) * dist);
			const palmZ = Math.floor(oz + Math.sin(angle) * dist);
			const trunkHeight = 5 + (Math.abs(Squirrel3.get(i * 67, seed)) % 4);

			for (let y = 0; y < trunkHeight; y++) {
				placeBlock(palmX, groundHeight + y, palmZ, BlockType.PalmTrunk, true);
			}

			for (let dx = -2; dx <= 2; dx++) {
				for (let dz = -2; dz <= 2; dz++) {
					if (dx * dx + dz * dz > 5) continue;
					placeBlock(
						palmX + dx,
						groundHeight + trunkHeight,
						palmZ + dz,
						BlockType.PalmLeaves,
						true,
					);
				}
			}
		}
	}
}
