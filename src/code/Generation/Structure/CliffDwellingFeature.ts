import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const MOUNTAIN_BIOMES = new Set([
	BIOME_ID.ROCKY_HIGHLANDS,
	BIOME_ID.RED_ROCK_CANYON,
	BIOME_ID.MESA_PLATEAU,
	BIOME_ID.BADLANDS,
	BIOME_ID.VOLCANIC_CALDERA,
]);

export class CliffDwellingFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 300 };
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
		if (!MOUNTAIN_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 14,
			magicA: 1212345678,
			magicB: 989900112,
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
				cx - 6,
				cx + 6,
				cz - 6,
				cz + 6,
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

		const cliffHeight =
			8 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 6);
		const wallBlock =
			biome.id === BIOME_ID.RED_ROCK_CANYON ||
			biome.id === BIOME_ID.MESA_PLATEAU
				? BlockType.RedSandstoneWall
				: BlockType.Cobblestone03;

		for (let dy = 0; dy < cliffHeight; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const depth = Math.floor(3 * (1 - Math.abs(dx) / 4));
				for (let dz = 0; dz < depth; dz++) {
					placeBlock(cx + dx, groundHeight + dy, cz - dz, wallBlock, true);
				}
			}
		}

		const numRooms =
			2 + (Math.abs(Squirrel3.get(region.regionHash + 5, seed)) % 3);
		for (let i = 0; i < numRooms; i++) {
			const roomX = cx + (Math.abs(Squirrel3.get(i * 17, seed)) % 5) - 2;
			const roomY =
				groundHeight +
				2 +
				(Math.abs(Squirrel3.get(i * 29, seed)) % (cliffHeight - 4));
			const roomW = 2 + (Math.abs(Squirrel3.get(i * 41, seed)) % 2);

			for (let dx = 0; dx < roomW; dx++) {
				for (let dy = 0; dy < 3; dy++) {
					placeBlock(roomX + dx, roomY + dy, cz, BlockType.Air, true);
				}
			}
			placeBlock(roomX, roomY, cz, BlockType.WoodPlanks, true);
			placeBlock(
				roomX + roomW - 1,
				roomY,
				cz + roomW - 1,
				BlockType.WoodPlanks,
				true,
			);
		}
	}
}
