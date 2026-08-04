import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import { getBiome } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { StructureBuilder } from "./StructureBuilder";

// Biomes where open water ponds would look out of place (oceans, deserts,
// salt flats, volcanic/exotic ashlands). Everything else is "land" and may
// host a pond.
const POND_UNSUITABLE = new Set<number>([
	// Aquatic / coastal
	BIOME_ID.OCEAN,
	BIOME_ID.RIVER,
	BIOME_ID.SANDY_SHORE,
	BIOME_ID.ROCKY_SHORE,
	BIOME_ID.FROZEN_OCEAN,
	BIOME_ID.CORAL_REEF,
	BIOME_ID.KELP_FOREST,
	BIOME_ID.TIDAL_FLATS,
	BIOME_ID.ARCHIPELAGO,
	BIOME_ID.DEEP_OCEAN_TRENCH,
	BIOME_ID.BIOLUMINESCENT_BAY,
	// Arid / dry
	BIOME_ID.DESERT,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.SALT_FLATS,
	BIOME_ID.OASIS,
	BIOME_ID.CRACKED_EARTH,
	BIOME_ID.DUST_BOWL,
	BIOME_ID.SCORCHED_SAVANNAH,
	BIOME_ID.PETRIFIED_FOREST,
	// Volcanic / exotic
	BIOME_ID.VOLCANIC_WASTELAND,
	BIOME_ID.BASALT_DELTAS,
	BIOME_ID.VOLCANIC_CALDERA,
	BIOME_ID.GEOTHERMAL_FIELD,
	BIOME_ID.OBSIDIAN_FLATS,
	BIOME_ID.ASHEN_WASTELAND,
	// Ice sheets (no open water)
	BIOME_ID.GLACIER,
	BIOME_ID.ICE_SPIKES,
]);

export class PondFeature implements IWorldFeature {
	// Depressions are dug just a few blocks below the surface (2..5 deep), so
	// the absolute Y bounds can be tight around the terrain height range.
	public readonly verticalBounds = { minWorldY: -40, maxWorldY: 400 };
	public readonly maxAboveSurface = 2;

	public generate(
		chunkX: number,
		_chunkY: number,
		chunkZ: number,
		_biome: Biome,
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
		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 1,
			magicA: 778899331,
			magicB: 445566227,
			spawnChance: 100,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: cx, centerZ: cz, regionHash } = region;

		const centerBiome = getBiome(cx, cz);
		if (POND_UNSUITABLE.has(centerBiome.id)) return;

		const radius = 4 + (Math.abs(getPRNGBySeed(regionHash, seed)) % 5);
		// 3..5 deep so the centre always has at least 1 block of water below
		// the fixed rim depth.
		const maxDepth = 3 + (Math.abs(getPRNGBySeed(regionHash + 1, seed)) % 3);

		const MAX_RADIUS = radius + 3;
		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				cx - MAX_RADIUS,
				cx + MAX_RADIUS,
				cz - MAX_RADIUS,
				cz + MAX_RADIUS,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const b = new StructureBuilder(placeBlock, columnPrepassResolver, seed);

		// The pond should sit on reasonably flat ground — skip steep slopes so
		// we don't carve a draining hole into a hillside.
		const { min, max } = b.footprintGround(cx, cz, radius + 1, radius + 1);
		if (max - min > 7) return;

		const centerGround = b.ground(cx, cz);
		const sea = GenerationParams.SEA_LEVEL;
		// Keep ponds away from the ocean waterline so they don't just merge
		// into the sea.
		if (centerGround <= sea + 2) return;

		this.generatePond(
			cx,
			centerGround,
			cz,
			radius,
			maxDepth,
			centerBiome.beachBlock,
			placeBlock,
		);
	}

	/**
	 * Carves a clean bowl into the terrain and fills it with water.
	 *
	 * The pond is a cone dug down from `rimY` (the top of the shore, placed
	 * flush with the ground at the centre) to `rimY - depth`. A solid shore
	 * shell occupies the whole cone so the rim height is constant everywhere,
	 * then water fills from the floor up to a single flat level
	 * (`rimY - RIM_DEPTH`). This guarantees a perfectly flat water surface and
	 * a consistent, circular shoreline regardless of the underlying terrain.
	 */
	private generatePond(
		centerX: number,
		rimY: number,
		centerZ: number,
		poolRadius: number,
		maxDepth: number,
		shoreBlockId: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
	) {
		const RIM_DEPTH = 2;
		const waterTop = rimY - RIM_DEPTH;
		if (waterTop >= rimY) return;

		// Solid shore shell: full cone from the floor up to the flat rim.
		const shellRadius = poolRadius + 1;
		const shellRadiusSq = shellRadius * shellRadius;
		for (let dx = -shellRadius; dx <= shellRadius; dx++) {
			for (let dz = -shellRadius; dz <= shellRadius; dz++) {
				const distSq = dx * dx + dz * dz;
				if (distSq >= shellRadiusSq) continue;

				const dist = Math.sqrt(distSq);
				const depth = Math.floor(maxDepth * (1 - dist / shellRadius));
				const floorY = rimY - depth;

				for (let y = floorY; y <= rimY; y++) {
					placeBlock(centerX + dx, y, centerZ + dz, shoreBlockId, true);
				}
			}
		}

		// Water fills the same cone but stops at the flat water level below the
		// rim, so the shore wall stays above it and the surface is level.
		const radiusSq = poolRadius * poolRadius;
		for (let dx = -poolRadius; dx <= poolRadius; dx++) {
			for (let dz = -poolRadius; dz <= poolRadius; dz++) {
				const distSq = dx * dx + dz * dz;
				if (distSq >= radiusSq) continue;

				const dist = Math.sqrt(distSq);
				const depth = Math.floor(maxDepth * (1 - dist / poolRadius));
				const floorY = rimY - depth;
				const topY = Math.min(rimY, waterTop);
				if (topY < floorY) continue;

				for (let y = floorY; y <= topY; y++) {
					placeBlock(centerX + dx, y, centerZ + dz, BlockType.Water, true);
				}
			}
		}
	}
}
