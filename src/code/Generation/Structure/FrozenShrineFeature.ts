import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const COLD_BIOMES = new Set([
	BIOME_ID.ICE_SPIKES,
	BIOME_ID.GLACIER,
	BIOME_ID.TUNDRA_MOUNTAINS,
	BIOME_ID.FROZEN_OCEAN,
	BIOME_ID.AURORA_TUNDRA,
]);

export class FrozenShrineFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 20;

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
			regionSize: 14,
			magicA: 5078901234,
			magicB: 445566778,
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

		for (let dx = -3; dx <= 3; dx++) {
			for (let dz = -3; dz <= 3; dz++) {
				placeBlock(sx + dx, groundHeight, sz + dz, BlockType.GlacierIce, true);
			}
		}

		const pillarPositions: [number, number][] = [
			[-2, -2],
			[2, -2],
			[-2, 2],
			[2, 2],
		];
		for (const [px, pz] of pillarPositions) {
			const h =
				4 + (Math.abs(Squirrel3.get((sx + px) * 13 + (sz + pz) * 7, seed)) % 3);
			for (let y = 1; y <= h; y++) {
				placeBlock(
					sx + px,
					groundHeight + y,
					sz + pz,
					BlockType.CrystalBlock,
					true,
				);
			}
			placeBlock(
				sx + px,
				groundHeight + h + 1,
				sz + pz,
				BlockType.ExposedCrystalBlock,
				true,
			);
		}

		placeBlock(sx, groundHeight + 1, sz, BlockType.ExposedCrystalBlock, true);
		placeBlock(sx, groundHeight + 2, sz, BlockType.CrystalBlock, true);

		for (let i = 0; i < 6; i++) {
			const angle = (i / 6) * Math.PI * 2;
			const ix = Math.floor(sx + Math.cos(angle) * 5);
			const iz = Math.floor(sz + Math.sin(angle) * 5);
			const icicleHeight =
				2 + (Math.abs(Squirrel3.get(ix * 11 + iz * 23, seed)) % 3);
			for (let y = 0; y < icicleHeight; y++) {
				placeBlock(ix, groundHeight + y, iz, BlockType.IceBlock, true);
			}
		}
	}
}
