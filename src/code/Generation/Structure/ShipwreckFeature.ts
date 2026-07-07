import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const COASTAL_BIOMES = new Set([
	BIOME_ID.SANDY_SHORE,
	BIOME_ID.ROCKY_SHORE,
	BIOME_ID.TIDAL_FLATS,
	BIOME_ID.ARCHIPELAGO,
	BIOME_ID.CORAL_REEF,
	BIOME_ID.KELP_FOREST,
	BIOME_ID.BIOLUMINESCENT_BAY,
]);

export class ShipwreckFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -20, maxWorldY: 200 };

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
		if (!COASTAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 1023456789,
			magicB: 987654321,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: shipX, centerZ: shipZ } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		const shipLength =
			16 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 12);
		const shipWidth =
			5 + (Math.abs(Squirrel3.get(region.regionHash + 10, seed)) % 4);
		const rotation = Math.abs(Squirrel3.get(region.regionHash + 20, seed)) % 4;

		const cosR = rotation === 0 || rotation === 2 ? 1 : 0;
		const sinR = rotation === 1 || rotation === 3 ? 1 : 0;
		const signR = rotation >= 2 ? -1 : 1;

		if (
			!aabbOverlaps(
				shipX - shipWidth,
				shipX + shipLength,
				shipZ - shipWidth,
				shipZ + shipLength,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(shipX, shipZ);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(shipX, shipZ);
		}

		const tilt =
			(Math.abs(Squirrel3.get(region.regionHash + 30, seed)) % 8) - 4;

		for (let lx = 0; lx < shipLength; lx++) {
			for (let lz = 0; lz < shipWidth; lz++) {
				const wx = shipX + (cosR * lx + signR * sinR * lz);
				const wz = shipZ + (-sinR * lx + cosR * lz);

				const sideDist = Math.abs(lz - shipWidth / 2) / (shipWidth / 2);
				const bowFactor = lx / shipLength;
				const hullHeight = Math.floor(
					4 * (1 - sideDist) * (1 - bowFactor * 0.3),
				);
				const yOff = Math.floor((tilt * lx) / shipLength);

				for (let y = 0; y <= hullHeight; y++) {
					const blockId =
						y === 0
							? BlockType.RoughWood
							: y === hullHeight
								? BlockType.OldPlanks02
								: BlockType.WoodPlanks;
					placeBlock(
						Math.floor(wx),
						groundHeight + y + yOff,
						Math.floor(wz),
						blockId,
						true,
					);
				}
			}
		}

		for (let lx = 2; lx < shipLength - 2; lx += 4) {
			const wx = shipX + cosR * lx;
			const wz = shipZ - sinR * lx;
			const yOff = Math.floor((tilt * lx) / shipLength);
			const mastHeight = 6 + (Math.abs(Squirrel3.get(lx * 7, seed)) % 4);
			for (let y = 0; y < mastHeight; y++) {
				placeBlock(
					Math.floor(wx),
					groundHeight + 4 + y + yOff,
					Math.floor(wz),
					BlockType.RoughWood,
					true,
				);
			}
		}
	}
}
