import { BlockType } from "../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "./Biome/BiomeTypes";
import {
	NO_SURFACE_Y as CAVE_NO_SURFACE_Y,
	evaluateCaveCarve,
	getSurfaceCarveBlend,
} from "./CaveCarver";
import { CaveNoiseGrid } from "./CaveNoiseGrid";
import {
	GenerationParams,
	type GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { RiverGenerator } from "./RiverGeneration";
import { AbandonedCabinFeature } from "./Structure/AbandonedCabinFeature";
import { AbyssalTempleFeature } from "./Structure/AbyssalTempleFeature";
import { BadlandsSpireFeature } from "./Structure/BadlandsSpireFeature";
import { BambooShrineFeature } from "./Structure/BambooShrineFeature";
import { CaravanCampFeature } from "./Structure/CaravanCampFeature";
import { CliffDwellingFeature } from "./Structure/CliffDwellingFeature";
import { CrystalShrineFeature } from "./Structure/CrystalShrineFeature";
import { DesertOasisFeature } from "./Structure/DesertOasisFeature";
import { DockFeature } from "./Structure/DockFeature";
import { DungeonFeature } from "./Structure/DungeonFeature";
import { FossilBedFeature } from "./Structure/FossilBedFeature";
import { FrozenShrineFeature } from "./Structure/FrozenShrineFeature";
import { GeodeFeature } from "./Structure/GeodeFeature";
import { IglooFeature } from "./Structure/IglooFeature";
import { InfernalPitFeature } from "./Structure/InfernalPitFeature";
import type { IWorldFeature } from "./Structure/IWorldFeature";
import { LavaPoolFeature } from "./Structure/LavaPoolFeature";
import { LighthouseFeature } from "./Structure/LighthouseFeature";
import { MineshaftFeature } from "./Structure/MineshaftFeature";
import { MountainCabinFeature } from "./Structure/MountainCabinFeature";
import { MushroomHutFeature } from "./Structure/MushroomHutFeature";
import { ObservatoryFeature } from "./Structure/ObservatoryFeature";
import { PetrifiedShrineFeature } from "./Structure/PetrifiedShrineFeature";
import { PyramidFeature } from "./Structure/PyramidFeature";
import { RavineFeature } from "./Structure/RavineFeature";
import { RuinFeature } from "./Structure/RuinFeature";
import { ShipwreckFeature } from "./Structure/ShipwreckFeature";
import { SnowFortFeature } from "./Structure/SnowFortFeature";
import { StoneCircleFeature } from "./Structure/StoneCircleFeature";
import { StructureSpawnerFeature } from "./Structure/StructureFeature";
import { TowerFeature } from "./Structure/TowerFeature";
import { TreehouseFeature } from "./Structure/TreehouseFeature";
import { TropicalTempleFeature } from "./Structure/TropicalTempleFeature";
import { WatchtowerFeature } from "./Structure/WatchtowerFeature";
import { WellFeature } from "./Structure/WellFeature";
import { WindmillFeature } from "./Structure/WindmillFeature";
import { generateStructures } from "./Terrain/StructurePlacer";
import {
	resolveSolidBlockId,
	SURFACE_RESET_AIR_GAP,
} from "./Terrain/SurfaceBlockResolver";
import {
	getBiome,
	getCachedRiverNoise,
	getFinalTerrainHeight,
	prefetchChunkCorners,
} from "./TerrainHeightMap";

export type SurfaceGenerationResult = {
	topSunlightMask: Uint8Array;
	topSurfaceYMap: Int16Array;
	biomeMap: Uint8Array;
	riverNoiseMap: Float32Array;
	minSurfaceY: number;
	maxSurfaceY: number;
};

export type ColumnPrepassCacheEntry = {
	terrainHeightMap: Int32Array;
	riverNoiseMap: Float32Array;
	yFreqMap: number;
	topSurfaceYMap: Int16Array;
	// Bit-packed beach flag per column (1 = is beach) — computed once in the
	// prepass so resolveSolidBlockId never calls isBeachLocation per voxel.
	isBeachMap: Uint8Array;
	minSurfaceY: number;
	maxSurfaceY: number;
};

type FloraColumnCacheEntry = {
	biome: Biome;
	riverNoise: number;
	topSurfaceY: number;
	treeNoiseValue: number;
};

// Reusable scratch buffers for findlinge generation (max counts: 23/23/25).
const _findlingeWx = new Float32Array(23);
const _findlingeWz = new Float32Array(23);
const _findlingeWy = new Float32Array(25);

export class SurfaceGenerator {
	private params: GenerationParamsType;

	private static treeNoise: (x: number, z: number) => number;
	private static densityNoise: (x: number, y: number, z: number) => number;

	private cheeseNoise: (x: number, y: number, z: number) => number;
	private tunnelNoise: (x: number, y: number, z: number) => number;
	private detailNoise: (x: number, y: number, z: number) => number;

	private static readonly DENSITY_BASE_AMPLITUDE = 32;
	private static readonly DENSITY_OVERHANG_AMPLITUDE = 64;
	private static readonly DENSITY_CLIFF_AMPLITUDE = 32;
	private static readonly DENSITY_INFLUENCE_RANGE = 32;

	/**
	 * Important:
	 * getDensity(...) already early-returns plain relativeHeight whenever
	 * the sample is outside +/- DENSITY_INFLUENCE_RANGE from the base height.
	 *
	 * That means the actual density sign transition can only happen inside
	 * [baseHeight - DENSITY_INFLUENCE_RANGE, baseHeight + DENSITY_INFLUENCE_RANGE].
	 *
	 * So scanning farther than that in findTopSurfaceY(...) is wasted work.
	 */
	private static readonly DENSITY_VERTICAL_SCAN_RANGE =
		SurfaceGenerator.DENSITY_INFLUENCE_RANGE;

	/**
	 * Coarse scan stride used by findTopSurfaceY. The coarse pass steps down by
	 * this amount to bracket the surface; the fine pass then walks the upward
	 * gap [coarseHigh, coarseHigh + DENSITY_COARSE_STEP - 1] at step 1 to resolve
	 * the exact surface (the previous coarse sample was air, so the true top
	 * surface must lie in that gap).
	 */
	private static readonly DENSITY_COARSE_STEP = 4;

	/**
	 * Conservative vertical budgets used to decide whether a chunkY slice
	 * can possibly contain any flora / structure blocks.
	 *
	 * You can tighten these later once you know the exact max extents of
	 * your tallest trees / largest structures.
	 */
	private static readonly MAX_TREE_HEIGHT = GenerationParams.CHUNK_SIZE;
	private static readonly MAX_STRUCTURE_ABOVE_SURFACE =
		GenerationParams.CHUNK_SIZE * 2;
	private static readonly MAX_STRUCTURE_BELOW_SURFACE = 24;

	/**
	 * Per-construction cached maximum of all features' maxAboveSurface
	 * values.  Falls back to MAX_STRUCTURE_ABOVE_SURFACE for features
	 * that don't declare one.
	 */
	private readonly maxStructureAboveSurface: number;

	private static seedAsInt: number;

	/**
	 * Direct-mapped cache of expensive horizontal column prepass data.
	 *
	 * Keyed by (chunkX, chunkZ) packed into a number.
	 */
	// PERF: column prepasses are a pure function of (chunkX, chunkZ) and cost
	// ~2.8ms to build (findTopSurfaceY). Storing them in a persistent Map
	// (built at most once per footprint) eliminates LRU thrash during bulk
	// generation, where row-major order + flora's wide scan window previously
	// evicted and rebuilt the same prepasses many times.
	private static readonly columnCache = new Map<
		number,
		ColumnPrepassCacheEntry
	>();

	// PERF: flora-column data is a pure function of (worldX, worldZ). A
	// persistent Map (built once per column) avoids the direct-mapped cache's
	// hash-collision evictions that thrashed during bulk area generation.
	private static readonly floraCache = new Map<number, FloraColumnCacheEntry>();

	private chunk_size: number;
	private riverGenerator: RiverGenerator;
	private features: IWorldFeature[];

	// PERF (#1): Trilinear cave-noise grid reused by computeCaveModifier so the
	// surface density band no longer samples 3 raw simplex noises per voxel.
	// This mirrors UndergroundGenerator and keeps surface carving consistent
	// with the underground pass (both interpolate from the same coarse grid).
	private readonly caveGrid: CaveNoiseGrid;
	private caveGridReady = false;
	private caveGridChunkX = 0;
	private caveGridChunkY = 0;
	private caveGridChunkZ = 0;
	private curChunkWorldX = 0;
	private curChunkWorldY = 0;
	private curChunkWorldZ = 0;

	constructor(
		params: GenerationParamsType,
		treeNoise: (x: number, z: number) => number,
		densityNoise: (x: number, y: number, z: number) => number,
		seedAsInt: number,
		cheeseNoise: (x: number, y: number, z: number) => number,
		tunnelNoise: (x: number, y: number, z: number) => number,
		detailNoise: (x: number, y: number, z: number) => number,
	) {
		this.params = params;
		SurfaceGenerator.treeNoise = treeNoise;
		SurfaceGenerator.densityNoise = densityNoise;
		SurfaceGenerator.seedAsInt = seedAsInt;

		this.chunk_size = this.params.CHUNK_SIZE;
		this.riverGenerator = new RiverGenerator(params);

		this.cheeseNoise = cheeseNoise;
		this.tunnelNoise = tunnelNoise;
		this.detailNoise = detailNoise;

		this.caveGrid = new CaveNoiseGrid(
			0,
			0,
			0,
			this.chunk_size,
			4,
			this.cheeseNoise,
			this.tunnelNoise,
			this.detailNoise,
		);

		this.features = [
			new TowerFeature(),
			new LavaPoolFeature(),
			new StructureSpawnerFeature(),
			new DungeonFeature(),
			new RavineFeature(),
			new GeodeFeature(),
			new MineshaftFeature(),
			new InfernalPitFeature(),
			new BadlandsSpireFeature(),
			// Coastal
			new ShipwreckFeature(),
			new LighthouseFeature(),
			new DockFeature(),
			// Cold
			new IglooFeature(),
			new FrozenShrineFeature(),
			new SnowFortFeature(),
			// Temperate
			new AbandonedCabinFeature(),
			new WindmillFeature(),
			new StoneCircleFeature(),
			new WellFeature(),
			// Hot
			new PyramidFeature(),
			new DesertOasisFeature(),
			new WatchtowerFeature(),
			new CaravanCampFeature(),
			// Tropical
			new TropicalTempleFeature(),
			new TreehouseFeature(),
			new BambooShrineFeature(),
			// Mountain
			new MountainCabinFeature(),
			new CliffDwellingFeature(),
			new ObservatoryFeature(),
			// Geological
			new CrystalShrineFeature(),
			new MushroomHutFeature(),
			// Exotic
			new RuinFeature(),
			new PetrifiedShrineFeature(),
			// Underground
			new AbyssalTempleFeature(),
			new FossilBedFeature(),
		];

		this.maxStructureAboveSurface = Math.max(
			...this.features.map(
				(f) =>
					f.maxAboveSurface ?? SurfaceGenerator.MAX_STRUCTURE_ABOVE_SURFACE,
			),
		);
	}

	private packXZKey(x: number, z: number): number {
		let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
		h = Math.imul(h ^ (h >>> 13), 1274126177);
		return (h ^ (h >>> 16)) >>> 0;
	}

	private getColumnPrepassKey(chunkX: number, chunkZ: number): number {
		// Chunk coords are small; direct shift-pack is bijective within ±32768.
		return (((chunkX & 0xffff) << 16) | (chunkZ & 0xffff)) >>> 0;
	}

	/**
	 * Resolve the column prepass that contains the given world column, returning
	 * the prepass entry plus the column's local indices within it. The prepass
	 * is built on demand (it is also built by the terrain path), so the first
	 * caller pays the build cost and every subsequent caller hits the cache.
	 *
	 * Used by the flora loop to look up border-column data without recomputing
	 * `findTopSurfaceY` (which would otherwise duplicate the ~130 noise calls
	 * that the prepass already does once per (chunkX, chunkZ) globally).
	 */
	private resolveColumnPrepassForWorld(
		worldX: number,
		worldZ: number,
	): {
		entry: ColumnPrepassCacheEntry;
		localX: number;
		localZ: number;
	} {
		const CHUNK_SIZE = this.params.CHUNK_SIZE;
		const chunkX = Math.floor(worldX / CHUNK_SIZE);
		const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
		const entry = this.getOrBuildColumnPrepass(chunkX, chunkZ);
		const localX = worldX - chunkX * CHUNK_SIZE;
		const localZ = worldZ - chunkZ * CHUNK_SIZE;
		return { entry, localX, localZ };
	}

	/**
	 * Build or reuse the expensive horizontal column prepass for a given
	 * (chunkX, chunkZ) column.
	 */
	private getOrBuildColumnPrepass(
		chunkX: number,
		chunkZ: number,
	): ColumnPrepassCacheEntry {
		const key = this.getColumnPrepassKey(chunkX, chunkZ);

		const cached = SurfaceGenerator.columnCache.get(key);
		if (cached) {
			return cached;
		}

		const CHUNK_SIZE = this.params.CHUNK_SIZE;
		const SEA_LEVEL = this.params.SEA_LEVEL;
		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const area = CHUNK_SIZE * CHUNK_SIZE;
		const NO_SURFACE_Y = CAVE_NO_SURFACE_Y;

		// Pre-fill the biome-corner cache for this chunk so the per-column
		// loop never hits a cache miss on fillCorner.
		prefetchChunkCorners(chunkWorldX, chunkWorldZ);

		const terrainHeightMap = new Int32Array(area);
		const riverNoiseMap = new Float32Array(area);
		const topSurfaceYMap = new Int16Array(area);
		const isBeachMap = new Uint8Array(area);
		topSurfaceYMap.fill(NO_SURFACE_Y);

		let minSurfaceY = Number.POSITIVE_INFINITY;
		let maxSurfaceY = Number.NEGATIVE_INFINITY;

		const treeMod = SurfaceGenerator.treeNoise(
			chunkWorldX * 0.00001,
			chunkWorldZ * 0.00001,
		);
		const yFreqMap = 0.04 + treeMod * 0.02;

		// ------------------------------------------------------------------
		// PASS 1: build terrain/rivers/top-surface maps
		// ------------------------------------------------------------------
		for (let localX = 0; localX < CHUNK_SIZE; localX++) {
			const worldX = chunkWorldX + localX;

			for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
				const worldZ = chunkWorldZ + localZ;
				const columnIndex = localX + localZ * CHUNK_SIZE;

				const terrainHeight = getFinalTerrainHeight(worldX, worldZ);
				const riverNoise = getCachedRiverNoise(worldX, worldZ);

				const topSurfaceY = this.findTopSurfaceY(
					worldX,
					worldZ,
					terrainHeight,
					yFreqMap,
				);

				terrainHeightMap[columnIndex] = terrainHeight;
				riverNoiseMap[columnIndex] = riverNoise;
				topSurfaceYMap[columnIndex] = topSurfaceY;

				if (topSurfaceY !== NO_SURFACE_Y) {
					if (topSurfaceY < minSurfaceY) minSurfaceY = topSurfaceY;
					if (topSurfaceY > maxSurfaceY) maxSurfaceY = topSurfaceY;
				}
			}
		}

		if (minSurfaceY === Number.POSITIVE_INFINITY) {
			minSurfaceY = NO_SURFACE_Y;
			maxSurfaceY = NO_SURFACE_Y;
		}

		// ------------------------------------------------------------------
		// PASS 2: compute beach map
		//
		// This uses already-built terrainHeightMap for in-chunk neighbors,
		// and only falls back to getFinalTerrainHeight on chunk borders.
		// ------------------------------------------------------------------
		for (let localX = 0; localX < CHUNK_SIZE; localX++) {
			const worldX = chunkWorldX + localX;

			for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
				const worldZ = chunkWorldZ + localZ;
				const columnIndex = localX + localZ * CHUNK_SIZE;
				const topSurfaceY = topSurfaceYMap[columnIndex];

				// Beach check — only meaningful when the surface is near sea level.
				// Uses topSurfaceY (actual surface height from findTopSurfaceY),
				// not terrainHeight (base heightmap value), so columns whose
				// surface is eroded/raised to water height are correctly flagged.
				if (
					topSurfaceY === NO_SURFACE_Y ||
					topSurfaceY < SEA_LEVEL - 2 ||
					topSurfaceY > SEA_LEVEL + 2
				) {
					continue;
				}

				const left =
					localX > 0
						? terrainHeightMap[columnIndex - 1]
						: getFinalTerrainHeight(worldX - 1, worldZ);

				const right =
					localX < CHUNK_SIZE - 1
						? terrainHeightMap[columnIndex + 1]
						: getFinalTerrainHeight(worldX + 1, worldZ);

				const down =
					localZ > 0
						? terrainHeightMap[columnIndex - CHUNK_SIZE]
						: getFinalTerrainHeight(worldX, worldZ - 1);

				const up =
					localZ < CHUNK_SIZE - 1
						? terrainHeightMap[columnIndex + CHUNK_SIZE]
						: getFinalTerrainHeight(worldX, worldZ + 1);

				if (
					left <= SEA_LEVEL ||
					right <= SEA_LEVEL ||
					down <= SEA_LEVEL ||
					up <= SEA_LEVEL
				) {
					isBeachMap[columnIndex] = 1;
				}
			}
		}

		const built: ColumnPrepassCacheEntry = {
			terrainHeightMap,
			riverNoiseMap,
			yFreqMap,
			topSurfaceYMap,
			isBeachMap,
			minSurfaceY,
			maxSurfaceY,
		};

		SurfaceGenerator.columnCache.set(key, built);

		return built;
	}

	private getFloraColumnKey(worldX: number, worldZ: number): number {
		return this.packXZKey(worldX, worldZ);
	}

	/**
	 * Build or reuse per-column flora data.
	 */
	private getOrBuildFloraColumnInfo(
		worldX: number,
		worldZ: number,
		knownTopSurfaceY?: number,
	): FloraColumnCacheEntry {
		const key = this.getFloraColumnKey(worldX, worldZ);
		const cached = SurfaceGenerator.floraCache.get(key);
		if (cached) {
			return cached;
		}

		const biome = getBiome(worldX, worldZ);
		const riverNoise = getCachedRiverNoise(worldX, worldZ);

		const treeNoiseValue =
			(SurfaceGenerator.treeNoise(worldX, worldZ) + 1) * 0.5;

		let topSurfaceY: number;

		if (knownTopSurfaceY !== undefined) {
			topSurfaceY = knownTopSurfaceY;
		} else {
			const treeMod = SurfaceGenerator.treeNoise(
				worldX * 0.00001,
				worldZ * 0.00001,
			);
			const yFreq = 0.04 + treeMod * 0.02;

			topSurfaceY = this.findTopSurfaceY(
				worldX,
				worldZ,
				getFinalTerrainHeight(worldX, worldZ),
				yFreq,
			);
		}

		const built: FloraColumnCacheEntry = {
			biome,
			riverNoise,
			topSurfaceY,
			treeNoiseValue,
		};

		SurfaceGenerator.floraCache.set(key, built);

		return built;
	}

	private chunkIntersectsVerticalBand(
		chunkMinY: number,
		chunkMaxY: number,
		bandMinY: number,
		bandMaxY: number,
	): boolean {
		return !(chunkMaxY < bandMinY || chunkMinY > bandMaxY);
	}

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
			ow?: boolean,
		) => void,
	): SurfaceGenerationResult {
		const generationResult = this.generateTerrain(
			chunkX,
			chunkY,
			chunkZ,
			biome,
			placeBlock,
		);

		const chunkMinY = chunkY * this.chunk_size;
		const chunkMaxY = chunkMinY + this.chunk_size - 1;
		const hasAnySurface = generationResult.maxSurfaceY !== CAVE_NO_SURFACE_Y;

		const canContainFlora =
			hasAnySurface &&
			this.chunkIntersectsVerticalBand(
				chunkMinY,
				chunkMaxY,
				generationResult.minSurfaceY,
				generationResult.maxSurfaceY + SurfaceGenerator.MAX_TREE_HEIGHT,
			);

		if (canContainFlora) {
			this.generateFlora(
				chunkX,
				chunkY,
				chunkZ,
				biome,
				placeBlock,
				generationResult.topSurfaceYMap,
			);
		}

		const canContainStructures =
			hasAnySurface &&
			this.chunkIntersectsVerticalBand(
				chunkMinY,
				chunkMaxY,
				generationResult.minSurfaceY -
					SurfaceGenerator.MAX_STRUCTURE_BELOW_SURFACE,
				generationResult.maxSurfaceY + this.maxStructureAboveSurface,
			);

		if (canContainStructures) {
			this.generateStructures(chunkX, chunkY, chunkZ, biome, placeBlock);
		}

		return generationResult;
	}

	private resolveSolidBlockId(
		currentBiome: Biome,
		worldY: number,
		depthBelowSurface: number,
		isBeach: boolean,
	): number {
		return resolveSolidBlockId(
			currentBiome,
			worldY,
			depthBelowSurface,
			isBeach,
			this.params.SEA_LEVEL,
		);
	}

	private generateTerrain(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		currentBiome: Biome,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
	): SurfaceGenerationResult {
		const CHUNK_SIZE = this.params.CHUNK_SIZE;
		const SEA_LEVEL = this.params.SEA_LEVEL;
		const NO_SURFACE_Y = CAVE_NO_SURFACE_Y;
		const INFLUENCE = SurfaceGenerator.DENSITY_INFLUENCE_RANGE;

		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldY = chunkY * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const topWorldY = chunkWorldY + CHUNK_SIZE - 1;

		// PERF (#1): Prepare the cave-noise grid context for this chunk. The grid
		// is sampled lazily on the first computeCaveModifier call (slow path only),
		// so fast-path chunks never pay the sampling cost.
		this.caveGridChunkX = chunkX;
		this.caveGridChunkY = chunkY;
		this.caveGridChunkZ = chunkZ;
		this.curChunkWorldX = chunkWorldX;
		this.curChunkWorldY = chunkWorldY;
		this.curChunkWorldZ = chunkWorldZ;
		this.caveGridReady = false;

		const topSunlightMask = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
		const topSurfaceYMap = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
		const biomeMap = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
		const riverNoiseMap = new Float32Array(CHUNK_SIZE * CHUNK_SIZE);
		topSurfaceYMap.fill(NO_SURFACE_Y);
		// PERF (#4): The biome cache is chunk-granular (32-aligned) and the chunk
		// is 32 wide, so getBiome(worldX, worldZ) is constant across the whole
		// chunk and equals currentBiome. Fill once instead of 1024 lookups.
		biomeMap.fill(currentBiome.id);

		const volcanicLiquidId =
			currentBiome.id === BIOME_ID.VOLCANIC_WASTELAND ? 24 : 30;

		// Fast-path: if entire chunk is well below any possible surface, skip expensive prepass
		// Minimum surface Y: SEA_LEVEL + continentalnessSpline(-1.0) - INFLUENCE ≈ -90
		// Use -128 for a safe margin — only affects very deep chunks
		if (topWorldY < -128) {
			for (let localX = 0; localX < CHUNK_SIZE; localX++) {
				const worldX = chunkWorldX + localX;
				for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
					const worldZ = chunkWorldZ + localZ;
					for (let localY = 0; localY < CHUNK_SIZE; localY++) {
						const worldY = chunkWorldY + localY;
						const blockId = worldY < 0 ? 29 : currentBiome.stoneBlock;
						placeBlock(worldX, worldY, worldZ, blockId, true);
					}
				}
			}
			return {
				topSunlightMask,
				topSurfaceYMap,
				biomeMap,
				riverNoiseMap,
				minSurfaceY: NO_SURFACE_Y,
				maxSurfaceY: NO_SURFACE_Y,
			};
		}

		// Reuse expensive per-column data for all chunkY in the same (chunkX, chunkZ)
		const columnPrepass = this.getOrBuildColumnPrepass(chunkX, chunkZ);
		const minSurfaceY = columnPrepass.minSurfaceY;
		const maxSurfaceY = columnPrepass.maxSurfaceY;
		const isBeachMap = columnPrepass.isBeachMap;
		const yFreq = columnPrepass.yFreqMap;
		for (let localX = 0; localX < CHUNK_SIZE; localX++) {
			const worldX = chunkWorldX + localX;

			for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
				const worldZ = chunkWorldZ + localZ;
				const columnIndex = localX + localZ * CHUNK_SIZE;

				const terrainHeight = columnPrepass.terrainHeightMap[columnIndex];
				const riverNoise = columnPrepass.riverNoiseMap[columnIndex];

				const topSurfaceY = columnPrepass.topSurfaceYMap[columnIndex];

				const hasSurface = topSurfaceY !== NO_SURFACE_Y;
				const columnTopSurfaceY = hasSurface ? topSurfaceY : NO_SURFACE_Y;

				if (hasSurface) {
					topSurfaceYMap[columnIndex] = topSurfaceY;
				}

				riverNoiseMap[columnIndex] = riverNoise;

				topSunlightMask[columnIndex] =
					!hasSurface || topSurfaceY <= topWorldY ? 1 : 0;

				const chunkEntirelyAboveInfluence =
					chunkWorldY > terrainHeight + INFLUENCE;

				const chunkEntirelyBelowInfluence =
					topWorldY < terrainHeight - INFLUENCE;

				// ------------------------------------------------------------
				// FAST PATH 1A: Entire chunk band is above influence, and the whole
				// chunk is above sea level => guaranteed all air.
				// ------------------------------------------------------------
				if (chunkEntirelyAboveInfluence && chunkWorldY > SEA_LEVEL) {
					continue;
				}

				// ------------------------------------------------------------
				// FAST PATH 1B: Entire chunk band is above influence, and the whole
				// chunk lies inside [0, SEA_LEVEL] => guaranteed all liquid.
				// River-tunnel checks do not change the final result here because
				// below sea level tunnel cells also become water.
				// ------------------------------------------------------------
				if (
					chunkEntirelyAboveInfluence &&
					chunkWorldY >= 0 &&
					topWorldY <= SEA_LEVEL
				) {
					for (let localY = 0; localY < CHUNK_SIZE; localY++) {
						placeBlock(
							worldX,
							chunkWorldY + localY,
							worldZ,
							volcanicLiquidId,
							false,
						);
					}
					continue;
				}

				// ------------------------------------------------------------
				// FAST PATH 1C: Entire chunk band is above influence, and the whole
				// chunk lies below 0 => guaranteed block 29 fill.
				// ------------------------------------------------------------
				if (chunkEntirelyAboveInfluence && topWorldY < 0) {
					for (let localY = 0; localY < CHUNK_SIZE; localY++) {
						placeBlock(worldX, chunkWorldY + localY, worldZ, 29, false);
					}
					continue;
				}

				// ------------------------------------------------------------
				// FAST PATH 1D: Entire chunk band is above the density influence band
				// but spans mixed Y ranges. Keep the original water/bedrock logic.
				// ------------------------------------------------------------
				if (chunkEntirelyAboveInfluence) {
					for (let localY = CHUNK_SIZE - 1; localY >= 0; localY--) {
						const worldY = chunkWorldY + localY;
						if (worldY <= SEA_LEVEL) {
							if (worldY >= 0) {
								placeBlock(worldX, worldY, worldZ, volcanicLiquidId, false);
							} else {
								placeBlock(worldX, worldY, worldZ, 29, false);
							}
						}
					}
					continue;
				}

				// ------------------------------------------------------------
				// FAST PATH 2A: Entire chunk band is below the density influence band,
				// and entirely above the river-carving band => guaranteed uniform solid.
				// No tunnels, no air gaps, no depth-reset logic needed.
				// ------------------------------------------------------------
				if (chunkEntirelyBelowInfluence && chunkWorldY >= SEA_LEVEL + 16) {
					for (let localY = 0; localY < CHUNK_SIZE; localY++) {
						placeBlock(
							worldX,
							chunkWorldY + localY,
							worldZ,
							currentBiome.stoneBlock,
							true,
						);
					}
					continue;
				}

				// ------------------------------------------------------------
				// FAST PATH 2B: Entire chunk band is below the density influence band
				// => terrain density is positive everywhere in this chunk band,
				// except river tunnels can still carve through it.
				//
				// We preserve your original depthAnchor / surface reset logic so
				// top/subsurface material assignment still behaves correctly.
				// ------------------------------------------------------------
				if (chunkEntirelyBelowInfluence) {
					let depthAnchorY = columnTopSurfaceY;

					const aboveY = topWorldY + 1;
					const isTunnelAboveChunk =
						aboveY < GenerationParams.SEA_LEVEL + 16 &&
						this.riverGenerator.isRiver(worldX, aboveY, worldZ, riverNoise);

					let airGapSinceLastSolid = isTunnelAboveChunk ? 1 : 0;

					for (let localY = CHUNK_SIZE - 1; localY >= 0; localY--) {
						const worldY = chunkWorldY + localY;

						if (worldY < GenerationParams.SEA_LEVEL + 16) {
							const isTunnel = this.riverGenerator.isRiver(
								worldX,
								worldY,
								worldZ,
								riverNoise,
							);
							if (isTunnel) {
								placeBlock(
									worldX,
									worldY,
									worldZ,
									worldY <= SEA_LEVEL ? 30 : 0,
									true,
								);
								airGapSinceLastSolid++;
								continue;
							}
						}

						if (airGapSinceLastSolid >= SURFACE_RESET_AIR_GAP) {
							depthAnchorY = worldY;
						}

						const depthBelowSurface =
							depthAnchorY !== NO_SURFACE_Y
								? depthAnchorY - worldY
								: Number.POSITIVE_INFINITY;

						const blockId = this.resolveSolidBlockId(
							currentBiome,
							worldY,
							depthBelowSurface,
							isBeachMap[columnIndex] === 1,
						);
						placeBlock(worldX, worldY, worldZ, blockId, true);
						airGapSinceLastSolid = 0;
					}

					continue;
				}

				// SLOW PATH — sample cliffNoise once at surface level, reuse for all Y.
				// y * 0.004 shifts by only 0.256 across the entire 64-block influence range
				// so this is visually identical to per-voxel sampling.
				const cliffNoise = SurfaceGenerator.densityNoise(
					worldX * 0.0035,
					terrainHeight * 0.004,
					worldZ * 0.0035,
				);

				let depthAnchorY = columnTopSurfaceY;

				const densityAboveChunk = this.getDensity(
					worldX,
					topWorldY + 1,
					worldZ,
					terrainHeight,
					yFreq,
					cliffNoise,
				);
				const caveModAbove =
					densityAboveChunk > 0
						? this.computeCaveModifier(
								worldX,
								topWorldY + 1,
								worldZ,
								columnTopSurfaceY,
							)
						: 0;
				const effectiveDensityAbove = densityAboveChunk - caveModAbove;

				const isTunnelAboveChunk =
					topWorldY + 1 < GenerationParams.SEA_LEVEL + 16 &&
					this.riverGenerator.isRiver(
						worldX,
						topWorldY + 1,
						worldZ,
						riverNoise,
					);

				let airGapSinceLastSolid =
					!isTunnelAboveChunk && effectiveDensityAbove > 0 ? 0 : 1;

				for (let localY = CHUNK_SIZE - 1; localY >= 0; localY--) {
					const worldY = chunkWorldY + localY;

					if (worldY < GenerationParams.SEA_LEVEL + 16) {
						const isTunnel = this.riverGenerator.isRiver(
							worldX,
							worldY,
							worldZ,
							riverNoise,
						);
						if (isTunnel) {
							placeBlock(
								worldX,
								worldY,
								worldZ,
								worldY <= SEA_LEVEL ? 30 : 0,
								true,
							);
							airGapSinceLastSolid++;
							continue;
						}
					}

					const density = this.getDensity(
						worldX,
						worldY,
						worldZ,
						terrainHeight,
						yFreq,
						cliffNoise,
					);
					const caveMod =
						density > 0
							? this.computeCaveModifier(
									worldX,
									worldY,
									worldZ,
									columnTopSurfaceY,
								)
							: 0;
					const effectiveDensity = density - caveMod;

					if (effectiveDensity > 0) {
						if (airGapSinceLastSolid >= SURFACE_RESET_AIR_GAP) {
							depthAnchorY = worldY;
						}
						const depthBelowSurface =
							depthAnchorY !== NO_SURFACE_Y
								? depthAnchorY - worldY
								: Number.POSITIVE_INFINITY;

						const blockId = this.resolveSolidBlockId(
							currentBiome,
							worldY,
							depthBelowSurface,
							isBeachMap[columnIndex] === 1,
						);
						placeBlock(worldX, worldY, worldZ, blockId, true);
						airGapSinceLastSolid = 0;
					} else {
						if (worldY <= SEA_LEVEL) {
							if (worldY >= 0) {
								placeBlock(worldX, worldY, worldZ, volcanicLiquidId, false);
							} else {
								placeBlock(worldX, worldY, worldZ, 29, false);
							}
						}
						airGapSinceLastSolid++;
					}
				}
			}
		}

		return {
			topSunlightMask,
			topSurfaceYMap,
			biomeMap,
			riverNoiseMap,
			minSurfaceY,
			maxSurfaceY,
		};
	}

	private generateFlora(
		chunkX: number,
		_chunkY: number,
		chunkZ: number,
		_biome: Biome,
		placeBlock: (x: number, y: number, z: number, id: number) => void,
		topSurfaceYMap: Int16Array,
	) {
		const SCAN_RADIUS = 6;
		const chunkSize = this.chunk_size;
		const chunkWorldX = chunkX * chunkSize;
		const chunkWorldZ = chunkZ * chunkSize;
		const NO_SURFACE_Y = CAVE_NO_SURFACE_Y;
		// O(1) cache hit — generateTerrain already built this entry.
		const columnPrepass = this.getOrBuildColumnPrepass(chunkX, chunkZ);

		for (
			let localX = -SCAN_RADIUS;
			localX < chunkSize + SCAN_RADIUS;
			localX++
		) {
			const worldX = chunkWorldX + localX;

			for (
				let localZ = -SCAN_RADIUS;
				localZ < chunkSize + SCAN_RADIUS;
				localZ++
			) {
				const worldZ = chunkWorldZ + localZ;

				const isInsideChunkColumn =
					localX >= 0 &&
					localX < chunkSize &&
					localZ >= 0 &&
					localZ < chunkSize;

				// Border columns: topSurfaceY lives in the neighbouring chunk's
				// column prepass (which is shared globally and already built by
				// terrain generation or by an earlier flora pass). Reading from
				// the prepass avoids the slow `findTopSurfaceY` path inside
				// `getOrBuildFloraColumnInfo`, which would otherwise spend ~130
				// noise calls per border column.
				let knownTopSurfaceY: number | undefined;
				if (isInsideChunkColumn) {
					const sv = topSurfaceYMap[localX + localZ * chunkSize];
					if (sv === NO_SURFACE_Y || sv < this.params.SEA_LEVEL) continue;
					knownTopSurfaceY = sv;
				} else {
					const resolved = this.resolveColumnPrepassForWorld(worldX, worldZ);
					const sv =
						resolved.entry.topSurfaceYMap[
							resolved.localX + resolved.localZ * chunkSize
						];
					if (sv === NO_SURFACE_Y || sv < this.params.SEA_LEVEL) continue;
					knownTopSurfaceY = sv;
				}

				const column = this.getOrBuildFloraColumnInfo(
					worldX,
					worldZ,
					knownTopSurfaceY,
				);

				const colBiome = column.biome;

				const surfaceY = column.topSurfaceY;
				if (surfaceY === NO_SURFACE_Y) continue;

				if (surfaceY < this.params.SEA_LEVEL) continue;

				if (
					this.riverGenerator.isRiver(
						worldX,
						surfaceY,
						worldZ,
						column.riverNoise,
					)
				) {
					continue;
				}

				// Beach flag — read from prepass instead of calling isBeachLocation
				// (which fires 4 getFinalTerrainHeight lookups per column).
				let isBeach: boolean;
				if (isInsideChunkColumn) {
					isBeach = columnPrepass.isBeachMap[localX + localZ * chunkSize] === 1;
				} else {
					const resolved = this.resolveColumnPrepassForWorld(worldX, worldZ);
					isBeach =
						resolved.entry.isBeachMap[
							resolved.localX + resolved.localZ * chunkSize
						] === 1;
				}
				const topBlockId =
					isBeach &&
					surfaceY >= this.params.SEA_LEVEL - 2 &&
					surfaceY <= this.params.SEA_LEVEL + 2
						? colBiome.beachBlock
						: colBiome.topBlock;

				// Trees are gated by canSpawnTrees + noise density check
				if (colBiome.canSpawnTrees) {
					if (column.treeNoiseValue < colBiome.treeDensity) {
						const treeDefinition = colBiome.getTreeForBlock(
							topBlockId,
							column.treeNoiseValue,
						);
						treeDefinition?.generate(
							worldX,
							surfaceY + 1,
							worldZ,
							placeBlock,
							SurfaceGenerator.seedAsInt,
						);

						//Skip grass
						continue;
					}
				}

				// Grass (id 64) spawns on grass blocks (id 15) using noise density.
				// treeNoiseValue is [0,1]; threshold of 0.6 gives ~60% coverage.
				if (isInsideChunkColumn) {
					const GRASS_DENSITY = _biome.grassDensity;
					if (column.treeNoiseValue < GRASS_DENSITY) {
						if (
							topBlockId === BlockType.Grass001 ||
							topBlockId === BlockType.RockyTerrain02 ||
							topBlockId === BlockType.ConcreteMoss ||
							topBlockId === BlockType.RockyTerrain02
						) {
							placeBlock(worldX, surfaceY + 1, worldZ, BlockType.Grass006Cross);
						} else {
							if (topBlockId === 65)
								placeBlock(worldX, surfaceY + 1, worldZ, 66);
						}
					}

					// Findlinge (glacial erratics) — noise-displaced irregular boulders.
					const findlingeChance = colBiome.findlingChance ?? 0.00005;
					if (findlingeChance > 0) {
						this.generateFindlinge(
							worldX,
							worldZ,
							surfaceY,
							colBiome,
							placeBlock,
						);
					}
				}
			}
		}
	}

	private generateFindlinge(
		worldX: number,
		worldZ: number,
		surfaceY: number,
		colBiome: Biome,
		placeBlock: (x: number, y: number, z: number, id: number) => void,
	): void {
		const findlingeChance = colBiome.findlingChance ?? 0.00005;
		const h = this.hashColumn(worldX, worldZ, SurfaceGenerator.seedAsInt);
		if (h >= findlingeChance) return;

		const MAX_HALF = 6;
		const localX = worldX & 31;
		const localZ = worldZ & 31;
		if (
			localX < MAX_HALF ||
			localX > 31 - MAX_HALF ||
			localZ < MAX_HALF ||
			localZ > 31 - MAX_HALF
		)
			return;

		const wHash = this.hashColumn(
			worldX + 1000,
			worldZ,
			SurfaceGenerator.seedAsInt,
		);
		const dHash = this.hashColumn(
			worldX,
			worldZ + 1000,
			SurfaceGenerator.seedAsInt,
		);
		const hHash = this.hashColumn(
			worldX + 1000,
			worldZ + 1000,
			SurfaceGenerator.seedAsInt,
		);
		const tHash = this.hashColumn(
			worldX + 2000,
			worldZ + 2000,
			SurfaceGenerator.seedAsInt,
		);

		const halfW = 3 + Math.floor(wHash * 8);
		const halfD = 3 + Math.floor(dHash * 8);
		const halfH = 3 + Math.floor(hHash * 9);
		const tiltX = (tHash - 0.5) * 0.8;
		const tiltZ =
			(this.hashColumn(worldX + 3000, worldZ, SurfaceGenerator.seedAsInt) -
				0.5) *
			0.8;

		const burialDepth = Math.floor(halfH * 0.15);
		const cx = worldX;
		const cy = surfaceY - burialDepth;
		const cz = worldZ;

		const warpAmt = 1.2 + tHash * 0.8;
		const invW = 1 / halfW;
		const invD = 1 / halfD;
		const invH = 1 / halfH;

		const dxRange = halfW + 1;
		const dzRange = halfD + 1;
		const dyMin = -(halfH + 1);
		const dyMax = halfH + 1;

		const dxCount = 2 * dxRange + 1;
		const dzCount = 2 * dzRange + 1;
		const dyCount = dyMax - dyMin + 1;

		const warpW = warpAmt * invW;
		const warpD = warpAmt * invD;
		const warpH = warpAmt * 0.5 * invH;

		const wxArr = _findlingeWx;
		for (let i = 0; i < dxCount; i++) {
			const dx = i - dxRange;
			wxArr[i] = SurfaceGenerator.densityNoise(
				(cx + dx) * 0.18,
				cy * 0.22,
				cz * 0.18,
			);
		}

		const wzArr = _findlingeWz;
		for (let i = 0; i < dzCount; i++) {
			const dz = i - dzRange;
			wzArr[i] = SurfaceGenerator.densityNoise(
				cx * 0.22,
				cy * 0.18,
				(cz + dz) * 0.22 + 17.3,
			);
		}

		const wyArr = _findlingeWy;
		for (let i = 0; i < dyCount; i++) {
			const dy = dyMin + i;
			wyArr[i] = SurfaceGenerator.densityNoise(
				cx * 0.2 + 7.1,
				(cy + dy) * 0.2,
				cz * 0.2,
			);
		}

		const blockId = colBiome.findlingBlockId ?? 1;

		for (let dy = dyMin; dy <= dyMax; dy++) {
			const ny = dy * invH;
			const wny = ny + wyArr[dy - dyMin] * warpH;
			const wny2 = wny * wny;
			const flatBase = wny < 0 ? wny2 * 0.5 : 0;
			if (wny2 + flatBase >= 1.0) continue;
			// Remaining budget after Y — shared across all (dx, dz) in this dy slice.
			const budgetAfterY = 1.0 - (wny2 + flatBase);

			for (let dx = -dxRange; dx <= dxRange; dx++) {
				const nx = dx * invW;
				const wnx = nx + wxArr[dx + dxRange] * warpW + tiltX * ny;
				const wnx2 = wnx * wnx;
				// Early-out: X+Y contribution alone fills or exceeds the ellipsoid —
				// skip the entire dz row without entering the inner loop.
				if (wnx2 >= budgetAfterY) continue;
				// Remaining budget for the Z axis on this (dy, dx) pair.
				const budgetAfterXY = budgetAfterY - wnx2;

				for (let dz = -dzRange; dz <= dzRange; dz++) {
					const nz = dz * invD;
					const wnz = nz + wzArr[dz + dzRange] * warpD + tiltZ * ny;
					// Single multiply + compare — no addition needed since
					// budgetAfterXY already accounts for the X and Y terms.
					if (wnz * wnz < budgetAfterXY) {
						placeBlock(cx + dx, cy + dy, cz + dz, blockId);
					}
				}
			}
		}
	}

	private generateStructures(
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
	): void {
		generateStructures(
			chunkX,
			chunkY,
			chunkZ,
			this.chunk_size,
			biome,
			this.features,
			SurfaceGenerator.seedAsInt,
			placeBlock,
			(worldX: number, worldZ: number) =>
				this.resolveColumnPrepassForWorld(worldX, worldZ),
		);
	}

	private getDensity(
		x: number,
		y: number,
		z: number,
		baseHeight: number,
		yFreq: number,
		cachedCliffNoise: number,
	): number {
		const relativeHeight = baseHeight - y;

		if (relativeHeight > SurfaceGenerator.DENSITY_INFLUENCE_RANGE) {
			return relativeHeight;
		}
		if (relativeHeight < -SurfaceGenerator.DENSITY_INFLUENCE_RANGE) {
			return relativeHeight;
		}

		const baseNoise = SurfaceGenerator.densityNoise(
			x * 0.002,
			y * yFreq,
			z * 0.01,
		);

		const overhangNoise = SurfaceGenerator.densityNoise(
			(x + y * 0.55) * 0.008,
			y * 0.012,
			(z - y * 0.45) * 0.008,
		);

		return (
			relativeHeight +
			baseNoise * SurfaceGenerator.DENSITY_BASE_AMPLITUDE +
			overhangNoise * SurfaceGenerator.DENSITY_OVERHANG_AMPLITUDE +
			cachedCliffNoise * SurfaceGenerator.DENSITY_CLIFF_AMPLITUDE
		);
	}

	// ---------------------------------------------------------------------------
	// computeCaveModifier
	//
	// Evaluates the cave carving influence at a surface-terrain voxel using the
	// same world-space noise functions as UndergroundGenerator and
	// WorldGenerator.processCombinedUndergroundPass.
	//
	// CROSS-CHUNK CONTINUITY: x/y/z are world coordinates — the noise functions
	// are purely positional, so caves generated here are automatically continuous
	// with those generated in the underground pass of adjacent chunks.  No
	// extra seaming is needed.
	//
	// V8 NOTES:
	//   - All params are hoisted to locals to avoid repeated property-chain
	//     lookups inside the hot surface-terrain loop that calls this method.
	//   - The early-out on caveBlend ≤ 0 is kept to skip the three noise calls
	//     entirely for the majority of above-ground voxels.
	// ---------------------------------------------------------------------------

	// Cached primitive constants — set once in the ctor to avoid re-reading
	// `this.params` on every call inside the per-voxel hot loop.
	private computeCaveModifier(
		x: number,
		y: number,
		z: number,
		surfaceY: number,
	): number {
		const chunkSize = this.chunk_size;
		const lx = x - this.curChunkWorldX;
		const ly = y - this.curChunkWorldY;
		const lz = z - this.curChunkWorldZ;

		let cheese: number;
		let tunnel: number;
		let detail: number;

		// PERF (#1): Use the pre-sampled trilinear grid for voxels inside the
		// chunk (local Y in [0, 31]). The single per-column probe at topWorldY+1
		// (ly === chunkSize) falls outside the grid's valid range, so it keeps
		// sampling raw noise — negligible cost and behaviour-preserving.
		if (ly >= 0 && ly < chunkSize) {
			if (!this.caveGridReady) {
				this.caveGrid.reset(
					this.caveGridChunkX,
					this.caveGridChunkY,
					this.caveGridChunkZ,
					chunkSize,
				);
				this.caveGridReady = true;
			}
			cheese = this.caveGrid.getCheese(lx, ly, lz);
			tunnel = this.caveGrid.getTunnel(lx, ly, lz);
			detail = this.caveGrid.getDetail(lx, ly, lz);
		} else {
			cheese = this.cheeseNoise(x, y, z);
			tunnel = this.tunnelNoise(x, y, z);
			detail = this.detailNoise(x, y, z);
		}

		const cave = evaluateCaveCarve(
			this.params,
			y,
			surfaceY,
			cheese,
			tunnel,
			detail,
		);
		if (!cave.shouldCarve) return 0;

		return (
			cave.carveStrength * getSurfaceCarveBlend(cave.depthBelowSurface) * 40
		);
	}

	private sampleCliffNoise(x: number, baseHeight: number, z: number): number {
		return SurfaceGenerator.densityNoise(
			x * 0.0035,
			baseHeight * 0.004, // sampled at surface level, reused for all Y
			z * 0.0035,
		);
	}

	private findTopSurfaceY(
		worldX: number,
		worldZ: number,
		baseHeight: number,
		yFreq: number,
	): number {
		const range = SurfaceGenerator.DENSITY_VERTICAL_SCAN_RANGE;
		const maxY = baseHeight + range;
		const minY = baseHeight - range;

		const cliffNoise = this.sampleCliffNoise(worldX, baseHeight, worldZ);

		const baseAmp = SurfaceGenerator.DENSITY_BASE_AMPLITUDE;
		const overhangAmp = SurfaceGenerator.DENSITY_OVERHANG_AMPLITUDE;
		const cliffContribution =
			cliffNoise * SurfaceGenerator.DENSITY_CLIFF_AMPLITUDE;

		const baseNoiseX = worldX * 0.002;
		const baseNoiseZ = worldZ * 0.01;

		const overhangBaseX = worldX * 0.008;
		const overhangBaseZ = worldZ * 0.008;

		// Density evaluated via a static helper (no closure allocated per
		// column call).
		const evalSurfaceDensity = SurfaceGenerator.evalSurfaceDensity;

		// Pass 1: coarse scan at DENSITY_COARSE_STEP to find a bracket
		const coarseStep = SurfaceGenerator.DENSITY_COARSE_STEP;
		let coarseHigh = CAVE_NO_SURFACE_Y;
		for (let y = maxY; y >= minY; y -= coarseStep) {
			if (
				evalSurfaceDensity(
					y,
					baseNoiseX,
					yFreq,
					baseNoiseZ,
					baseHeight,
					baseAmp,
					overhangBaseX,
					overhangBaseZ,
					overhangAmp,
					cliffContribution,
				) > 0
			) {
				coarseHigh = y;
				break;
			}
		}
		if (coarseHigh === CAVE_NO_SURFACE_Y) return CAVE_NO_SURFACE_Y;

		// Pass 2: fine scan. The coarse pass steps down by DENSITY_COARSE_STEP
		// and stops at the first (highest) solid sample `coarseHigh`. The
		// previous coarse sample (coarseHigh + coarseStep) was air, so the true
		// top surface lies somewhere in [coarseHigh, coarseHigh + coarseStep - 1].
		// Walk that upward gap at step 1 to resolve the exact surface (a larger
		// coarse step therefore costs fewer noise calls without losing resolution).
		let densityAbove = -1;
		let highestSolid = CAVE_NO_SURFACE_Y;
		const fineTop = Math.min(coarseHigh + (coarseStep - 1), maxY);
		for (let y = fineTop; y >= coarseHigh; y--) {
			const d = evalSurfaceDensity(
				y,
				baseNoiseX,
				yFreq,
				baseNoiseZ,
				baseHeight,
				baseAmp,
				overhangBaseX,
				overhangBaseZ,
				overhangAmp,
				cliffContribution,
			);
			if (d > 0) {
				if (densityAbove <= 0) return y;
				if (highestSolid === CAVE_NO_SURFACE_Y) {
					highestSolid = y;
				}
			}
			densityAbove = d;
		}

		return highestSolid;
	}

	/**
	 * Surface-density sample at world Y `y`.  Declared static (no captured
	 * state) so callers avoid allocating a closure on every per-column call.
	 */
	private static evalSurfaceDensity(
		y: number,
		baseNoiseX: number,
		yFreq: number,
		baseNoiseZ: number,
		baseHeight: number,
		baseAmp: number,
		overhangBaseX: number,
		overhangBaseZ: number,
		overhangAmp: number,
		cliffContribution: number,
	): number {
		const baseNoise = SurfaceGenerator.densityNoise(
			baseNoiseX,
			y * yFreq,
			baseNoiseZ,
		);
		const overhangNoise = SurfaceGenerator.densityNoise(
			overhangBaseX + y * 0.0044,
			y * 0.012,
			overhangBaseZ - y * 0.0036,
		);
		return (
			baseHeight -
			y +
			baseNoise * baseAmp +
			overhangNoise * overhangAmp +
			cliffContribution
		);
	}

	private hashColumn(x: number, z: number, seed: number): number {
		let h = (x * 374761393 + z * 668265263 + seed) | 0;
		h = ((h ^ (h >> 13)) * 1274126177) | 0;
		h = (h ^ (h >> 16)) >>> 0;
		return h / 4294967296;
	}
}
