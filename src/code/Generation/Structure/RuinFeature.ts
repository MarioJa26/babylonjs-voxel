import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const EXOTIC_BIOMES = new Set([
	BIOME_ID.ANCIENT_RUINS_BIOME,
	BIOME_ID.ASHEN_WASTELAND,
	BIOME_ID.BADLANDS,
	BIOME_ID.DUST_BOWL,
	BIOME_ID.CRACKED_EARTH,
]);

export class RuinFeature implements IWorldFeature {
	public readonly verticalBounds = { minWorldY: -10, maxWorldY: 200 };
	public readonly maxAboveSurface = 15;

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
		if (!EXOTIC_BIOMES.has(biome.id)) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 12,
			magicA: 5656789012,
			magicB: 333435363,
			spawnChance: 12,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: rx, centerZ: rz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				rx - 8,
				rx + 8,
				rz - 8,
				rz + 8,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(rx, rz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(rx, rz);
		}

		const numPillars =
			4 + (Math.abs(Squirrel3.get(region.regionHash, seed)) % 5);
		const ruinBlock =
			Math.abs(Squirrel3.get(region.regionHash + 10, seed)) % 2 === 0
				? BlockType.AncientCrackedStone
				: BlockType.MossyCobble;

		for (let i = 0; i < numPillars; i++) {
			const px = rx + (Math.abs(Squirrel3.get(i * 13, seed)) % 11) - 5;
			const pz = rz + (Math.abs(Squirrel3.get(i * 17, seed)) % 11) - 5;
			const pillarHeight = 2 + (Math.abs(Squirrel3.get(i * 23, seed)) % 5);

			for (let y = 0; y < pillarHeight; y++) {
				placeBlock(px, groundHeight + y, pz, ruinBlock, true);
			}
		}

		const numWalls =
			2 + (Math.abs(Squirrel3.get(region.regionHash + 20, seed)) % 3);
		for (let w = 0; w < numWalls; w++) {
			const wx = rx + (Math.abs(Squirrel3.get(w * 31, seed)) % 8) - 4;
			const wz = rz + (Math.abs(Squirrel3.get(w * 37, seed)) % 8) - 4;
			const wallLen = 3 + (Math.abs(Squirrel3.get(w * 41, seed)) % 4);
			const wallH = 2 + (Math.abs(Squirrel3.get(w * 43, seed)) % 3);
			const dir = Math.abs(Squirrel3.get(w * 47, seed)) % 2;

			for (let l = 0; l < wallLen; l++) {
				for (let y = 0; y < wallH; y++) {
					const blockId =
						Math.abs(Squirrel3.get(l * 59 + y * 61, seed)) % 3 === 0
							? 0
							: ruinBlock;
					if (blockId !== 0) {
						placeBlock(
							wx + (dir === 0 ? l : 0),
							groundHeight + y,
							wz + (dir === 1 ? l : 0),
							blockId,
							true,
						);
					}
				}
			}
		}
	}
}
