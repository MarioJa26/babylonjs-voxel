import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

export class MushroomHutFeature implements IWorldFeature {
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
		if (biome.id !== BIOME_ID.MUSHROOM_FIELDS) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 10,
			magicA: 4545678901,
			magicB: 222324252,
			spawnChance: 10,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: hx, centerZ: hz } = region;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		if (
			!aabbOverlaps(
				hx - 5,
				hx + 5,
				hz - 5,
				hz + 5,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(hx, hz);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(hx, hz);
		}

		const hutRadius = 3;
		const hutHeight = 4;
		const radiusSq = hutRadius * hutRadius;

		for (let dx = -hutRadius; dx <= hutRadius; dx++) {
			for (let dz = -hutRadius; dz <= hutRadius; dz++) {
				if (dx * dx + dz * dz > radiusSq) continue;
				placeBlock(hx + dx, groundHeight, hz + dz, BlockType.Mycelium, true);
			}
		}

		for (let y = 1; y <= hutHeight; y++) {
			for (let dx = -hutRadius; dx <= hutRadius; dx++) {
				for (let dz = -hutRadius; dz <= hutRadius; dz++) {
					if (dx * dx + dz * dz > radiusSq) continue;
					const isWall =
						Math.abs(dx) === hutRadius || Math.abs(dz) === hutRadius;
					const isHollow =
						y < hutHeight &&
						Math.abs(dx) < hutRadius &&
						Math.abs(dz) < hutRadius;
					if (isHollow) continue;
					placeBlock(
						hx + dx,
						groundHeight + y,
						hz + dz,
						BlockType.MushroomStem,
						true,
					);
				}
			}
		}

		const capRadius = hutRadius + 1;
		const capRs = capRadius * capRadius;
		for (let dx = -capRadius; dx <= capRadius; dx++) {
			for (let dz = -capRadius; dz <= capRadius; dz++) {
				if (dx * dx + dz * dz > capRs) continue;
				placeBlock(
					hx + dx,
					groundHeight + hutHeight + 1,
					hz + dz,
					BlockType.MushroomAmanitacap,
					true,
				);
			}
		}

		placeBlock(hx + 1, groundHeight + 1, hz, BlockType.Air, true);
		placeBlock(hx, groundHeight + 1, hz, BlockType.Air, true);
		placeBlock(hx - 1, groundHeight + 1, hz, BlockType.Air, true);
	}
}
