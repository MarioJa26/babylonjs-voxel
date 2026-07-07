import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class PetrifiedShrineFeature implements IWorldFeature {
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
		if (biome.id !== BIOME_ID.PETRIFIED_FOREST) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 6767890123,
			magicB: 444546474,
			spawnChance: 8,
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
					BlockType.AncientCrackedStone,
					true,
				);
			}
		}

		const pillarPositions: [number, number][] = [
			[-2, -2],
			[2, -2],
			[-2, 2],
			[2, 2],
			[0, -2],
			[0, 2],
			[-2, 0],
			[2, 0],
		];
		for (const [px, pz] of pillarPositions) {
			if (
				Math.abs(Squirrel3.get((sx + px) * 11 + (sz + pz) * 13, seed)) % 3 ===
				0
			)
				continue;
			const h =
				2 +
				(Math.abs(Squirrel3.get((sx + px) * 17 + (sz + pz) * 19, seed)) % 3);
			for (let y = 0; y < h; y++) {
				placeBlock(
					sx + px,
					groundHeight + y + 1,
					sz + pz,
					BlockType.AncientCrackedStone,
					true,
				);
			}
		}

		placeBlock(sx, groundHeight + 1, sz, BlockType.ExposedCrystalBlock, true);
		placeBlock(sx, groundHeight + 2, sz, BlockType.AncientCrackedStone, true);

		for (let i = 0; i < 3; i++) {
			const angle = (i / 3) * Math.PI * 2;
			const px = Math.floor(sx + Math.cos(angle) * 4);
			const pz = Math.floor(sz + Math.sin(angle) * 4);
			placeBlock(px, groundHeight, pz, BlockType.SaltBlock, true);
			placeBlock(px, groundHeight + 1, pz, BlockType.SaltBlock, true);
		}
	}
}
