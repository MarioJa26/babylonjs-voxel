import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { getPRNGBySeed } from "../NoiseAndParameters/Squirrel13";
import { SUBSURFACE_LAYER_DEPTH } from "../Terrain/SurfaceBlockResolver";
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

		const radius = 5 + (Math.abs(getPRNGBySeed(regionHash, seed)) % 5);
		// 3..5 deep so the centre always has at least 1 block of water below
		// the fixed rim depth.
		const maxDepth = 3 + (Math.abs(getPRNGBySeed(regionHash + 1, seed)) % 3);
		// Stretch the pond into an ellipse so width (X) and depth/length (Z)
		// differ rather than always being a perfect circle.
		const stretch =
			0.85 + (Math.abs(getPRNGBySeed(regionHash + 2, seed)) % 13) / 10;
		const rx = Math.max(3, radius);
		const rz = Math.max(3, radius * stretch);

		const MAX_RADIUS = Math.max(rx, rz) + 3;
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

		const sea = GenerationParams.SEA_LEVEL;
		const centerGround = b.ground(cx, cz);
		if (centerGround <= sea - 8) return;

		// Pick a single flat water level from the *surrounding* shoreline, not
		// the centre, so the pond sits flush with the local terrain. Use the
		// lowest sampled point rather than an average - a real pond settles
		// at the local low point of the terrain, not somewhere above it. On
		// sloped ground, averaging would put the water level above the
		// downhill side, forcing the (now-guaranteed) rim to build a raised
		// pedestal to reach it instead of sitting flush.
		const rims = 8;
		let minRim = Infinity;
		for (let k = 0; k < rims; k++) {
			const a = (k / rims) * Math.PI * 2;
			const h = b.ground(
				Math.round(cx + Math.cos(a) * (rx - 0.5)),
				Math.round(cz + Math.sin(a) * (rz - 0.5)),
			);
			if (h < minRim) minRim = h;
		}
		const waterTop = minRim - 1;
		if (waterTop <= sea - 8) return;

		this.generatePond(
			cx,
			cz,
			waterTop,
			rx,
			rz,
			maxDepth,
			centerBiome.topBlock,
			centerBiome.undergroundBlock,
			centerBiome.stoneBlock,
			centerBiome.beachBlock,
			(x, z) => b.ground(x, z),
			placeBlock,
		);
	}

	/**
	 * Carves a smooth pond that blends into the local terrain.
	 *
	 * The water surface is a single flat height (`waterTop`). The basin has a
	 * flat floor in the deep core (`floorY`) and a smooth ramp from the shore
	 * down to that floor, so there are no vertical walls. Surrounding the
	 * basin is a rim ring (nCore..1 is the basin ramp, 1..nRim is the rim)
	 * that is *always* built up to at least `waterTop` - guaranteeing the
	 * pond is fully encased regardless of how the surrounding terrain slopes
	 * - while still blending smoothly up to natural ground height where the
	 * terrain is already taller, so the pond grafts in cleanly instead of
	 * leaving a hard shelf. Carved/built faces are filled with the biome's
	 * own geology (top / underground / stone blocks, exactly like the
	 * surrounding terrain) so the pond reads as a natural depression rather
	 * than a sand tub, with no floating blocks.
	 */
	private generatePond(
		centerX: number,
		centerZ: number,
		waterTop: number,
		radiusX: number,
		radiusZ: number,
		maxDepth: number,
		topBlockId: number,
		undergroundBlockId: number,
		stoneBlockId: number,
		beachBlockId: number,
		groundAt: (x: number, z: number) => number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
	) {
		const floorY = waterTop - maxDepth;
		if (waterTop <= floorY) return;

		// Normalized elliptical space: n == 1 is the shoreline. `nCore` bounds
		// the flat floor, the band (nCore, 1) is the smooth rim ramp, and the
		// band (1, nRim] is the guaranteed encasing rim.
		const ext = Math.max(radiusX, radiusZ);
		const nCore = 1 - 2.5 / ext;
		const nRim = 1 + 1.2 / ext;
		const loop = Math.ceil(ext) + 2;

		for (let dx = -loop; dx <= loop; dx++) {
			for (let dz = -loop; dz <= loop; dz++) {
				const nx = dx / radiusX;
				const nz = dz / radiusZ;
				const n = Math.sqrt(nx * nx + nz * nz);
				const wx = centerX + dx;
				const wz = centerZ + dz;

				if (n <= 1) {
					// Basin: flat floor in the core, ramp toward the shore.
					const t = Math.min(1, Math.max(0, (n - nCore) / (1 - nCore)));
					const solidTop = floorY + Math.round(maxDepth * t);

					// Rebuild the carved soil/stone below the water line using
					// the biome's natural blocks (depth-mapped like terrain).
					// The floor itself is sand (it's underwater), not the
					// biome's grass/top block.
					const base = solidTop - (SUBSURFACE_LAYER_DEPTH + 2);
					for (let y = base; y <= solidTop; y++) {
						const depthBelow = solidTop - y;
						const id =
							depthBelow === 0
								? beachBlockId
								: depthBelow <= SUBSURFACE_LAYER_DEPTH
									? undergroundBlockId
									: stoneBlockId;
						placeBlock(wx, y, wz, id, true);
					}
					// Water up to the single flat surface level.
					for (let y = solidTop + 1; y <= waterTop; y++) {
						placeBlock(wx, y, wz, BlockType.Water, true);
					}
					// Open the top: any natural ground above the water level is
					// carved away so the surface is exposed and level.
					const g = groundAt(wx, wz);
					for (let y = waterTop + 1; y <= g; y++) {
						placeBlock(wx, y, wz, 0, true);
					}
					continue;
				}

				if (n > nRim) continue;

				// Guaranteed rim: exactly `waterTop` tall, never higher.
				// Only build anything where natural ground is at or below the
				// water line - that's the only case where it could leak.
				// Where natural ground already clears the water, it already
				// forms the wall (a hillside, a bank, whatever it is), so
				// leave it untouched and just cap the waterline block with
				// sand for a beach edge - never rebuild it up to hill height.
				const g = groundAt(wx, wz);
				const rimTop = waterTop;

				if (g <= rimTop) {
					// Backfill with the biome's own strata up to the water
					// line - same depth-mapped fill as the basin, capped with
					// sand at the very top so it reads as a beach lip.
					const base = rimTop - (SUBSURFACE_LAYER_DEPTH + 2);
					for (let y = base; y <= rimTop; y++) {
						const depthBelow = rimTop - y;
						const id =
							depthBelow === 0
								? beachBlockId
								: depthBelow <= SUBSURFACE_LAYER_DEPTH
									? undergroundBlockId
									: stoneBlockId;
						placeBlock(wx, y, wz, id, true);
					}
				} else {
					// Natural ground already clears the water line, so leave
					// the hillside/bank itself untouched. Still guarantee a
					// dirt layer directly under the sand cap - don't rely on
					// whatever the natural terrain happened to have there.
					placeBlock(wx, rimTop - 3, wz, undergroundBlockId, false);
					placeBlock(wx, rimTop - 2, wz, undergroundBlockId, false);
					placeBlock(wx, rimTop - 1, wz, undergroundBlockId, false);
					placeBlock(wx, rimTop, wz, undergroundBlockId, true);
					placeBlock(wx, rimTop + 1, wz, beachBlockId, true);
				}
			}
		}
	}
}
