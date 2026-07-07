import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const HOT_BIOMES = new Set([
	BIOME_ID.DESERT,
	BIOME_ID.BADLANDS,
	BIOME_ID.RED_ROCK_CANYON,
	BIOME_ID.SAVANNAH,
	BIOME_ID.SCORCHED_SAVANNAH,
	BIOME_ID.DUNE_SEA,
]);

export class WatchtowerFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 300 };
	public readonly maxAboveSurface = 25;

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
			magicA: 4656789012,
			magicB: 323334353,
			spawnChance: 6,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: tx, centerZ: tz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const towerRadius = 3;

		if (
			!aabbOverlaps(
				tx - towerRadius,
				tx + towerRadius,
				tz - towerRadius,
				tz + towerRadius,
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

		const towerHeight =
			20 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 12);
		const radiusSq = towerRadius * towerRadius;

		for (let dy = 0; dy < towerHeight; dy++) {
			const blockId =
				dy < 3 ? BlockType.RedSandstoneWall : BlockType.Cobblestone03;
			for (let dx = -towerRadius; dx <= towerRadius; dx++) {
				for (let dz = -towerRadius; dz <= towerRadius; dz++) {
					if (dx * dx + dz * dz > radiusSq) continue;
					placeBlock(tx + dx, groundHeight + dy, tz + dz, blockId, true);
				}
			}
		}

		const platformRadius = towerRadius + 1;
		const platformRs = platformRadius * platformRadius;
		for (let dx = -platformRadius; dx <= platformRadius; dx++) {
			for (let dz = -platformRadius; dz <= platformRadius; dz++) {
				if (dx * dx + dz * dz > platformRs) continue;
				placeBlock(
					tx + dx,
					groundHeight + towerHeight,
					tz + dz,
					BlockType.Cobblestone03,
					true,
				);
			}
		}

		for (let dx = -platformRadius; dx <= platformRadius; dx++) {
			for (let dz = -platformRadius; dz <= platformRadius; dz++) {
				if (dx * dx + dz * dz > platformRs) continue;
				if (
					Math.abs(dx) === platformRadius ||
					Math.abs(dz) === platformRadius
				) {
					placeBlock(
						tx + dx,
						groundHeight + towerHeight + 1,
						tz + dz,
						BlockType.Cobblestone03,
						true,
					);
				}
			}
		}
	}
}
