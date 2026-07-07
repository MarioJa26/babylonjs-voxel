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
	BIOME_ID.MANGROVE,
]);

export class DockFeature implements IWorldFeature {
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
		if (!COASTAL_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 3056789012,
			magicB: 223344556,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: dockX, centerZ: dockZ } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		const dockLength =
			12 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 10);
		const direction = Math.abs(Squirrel3.get(region.regionHash + 5, seed)) % 4;

		const cosD = direction === 0 || direction === 2 ? 1 : 0;
		const sinD = direction === 1 || direction === 3 ? 1 : 0;
		const signD = direction >= 2 ? -1 : 1;

		const totalWidth = 3;
		if (
			!aabbOverlaps(
				dockX - dockLength,
				dockX + dockLength,
				dockZ - totalWidth,
				dockZ + totalWidth,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(dockX, dockZ);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(dockX, dockZ);
		}

		const waterLevel = 30;

		for (let lx = 0; lx < dockLength; lx++) {
			for (let lz = -1; lz <= 1; lz++) {
				const wx = Math.floor(dockX + cosD * lx + signD * sinD * lz);
				const wz = Math.floor(dockZ - sinD * lx + cosD * lz);

				const shoreFactor = lx / dockLength;
				const plankY = Math.floor(
					groundHeight + (waterLevel - groundHeight) * shoreFactor * 0.8,
				);

				if (lz === 0) {
					placeBlock(wx, plankY, wz, BlockType.WoodPlanks, true);
				} else {
					placeBlock(wx, plankY, wz, BlockType.OldPlanks02, true);
					placeBlock(wx, plankY - 1, wz, BlockType.RoughWood, true);
				}
			}
		}

		const postSpacing = 4;
		for (let lx = 0; lx < dockLength; lx += postSpacing) {
			const wx = Math.floor(dockX + cosD * lx);
			const wz = Math.floor(dockZ - sinD * lx);
			const shoreFactor = lx / dockLength;
			const plankY = Math.floor(
				groundHeight + (waterLevel - groundHeight) * shoreFactor * 0.8,
			);

			for (let py = plankY - 4; py <= plankY; py++) {
				placeBlock(wx, py, wz, BlockType.RoughWood, true);
			}
		}
	}
}
