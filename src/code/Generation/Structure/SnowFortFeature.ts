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
]);

export class SnowFortFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 12;

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
			regionSize: 12,
			magicA: 6089012345,
			magicB: 556677889,
			spawnChance: 6,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: fx, centerZ: fz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		const wallRadius = 6;

		if (
			!aabbOverlaps(
				fx - wallRadius,
				fx + wallRadius,
				fz - wallRadius,
				fz + wallRadius,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(fx, fz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(fx, fz);
		}

		const wallHeight =
			4 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 3);
		const radiusSq = wallRadius * wallRadius;
		const innerRadius = wallRadius - 2;
		const innerRadiusSq = innerRadius * innerRadius;

		for (let dx = -wallRadius; dx <= wallRadius; dx++) {
			for (let dz = -wallRadius; dz <= wallRadius; dz++) {
				const distSq = dx * dx + dz * dz;
				if (distSq > radiusSq || distSq < innerRadiusSq) continue;

				const wallY = wallHeight - Math.floor(distSq / (radiusSq * 0.3));
				for (let y = 0; y <= Math.max(1, wallY); y++) {
					placeBlock(
						fx + dx,
						groundHeight + y,
						fz + dz,
						BlockType.SaltBlock,
						true,
					);
				}
			}
		}

		const hasGate =
			Math.abs(Squirrel3.get(region.regionHash + 10, seed)) % 2 === 0;
		if (hasGate) {
			const gateDir = Math.abs(Squirrel3.get(region.regionHash + 20, seed)) % 4;
			const gx = gateDir === 0 ? wallRadius : gateDir === 2 ? -wallRadius : 0;
			const gz = gateDir === 1 ? wallRadius : gateDir === 3 ? -wallRadius : 0;
			for (let y = 0; y <= 3; y++) {
				placeBlock(fx + gx, groundHeight + y, fz + gz, BlockType.Air, true);
			}
		}

		placeBlock(fx, groundHeight + 1, fz, BlockType.SaltBlock, true);
		placeBlock(fx, groundHeight + 2, fz, BlockType.SaltBlock, true);
	}
}
