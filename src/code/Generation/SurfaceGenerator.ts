import { BlockType } from "../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "./Biome/BiomeTypes";
import {
	NO_SURFACE_Y as CAVE_NO_SURFACE_Y,
	evaluateCaveCarve,
	getSurfaceCarveBlend,
} from "./CaveCarver";
import { CaveNoiseGrid } from "./CaveNoiseGrid";
import type { NoiseInstance } from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
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
import { PondFeature } from "./Structure/PondFeature";
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
	fillTerrainNoiseGrid,
	getBiome,
	getCachedRiverNoise,
	getFinalTerrainHeight,
	getFinalTerrainHeightFromGrid,
	prefetchChunkCorners,
	type TerrainNoiseGrid,
} from "./TerrainHeightMap";

export type SurfaceGenerationResult = {
	topSunlightMask: Uint8Array;
	topSurfaceYMap: Int16Array;
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
	// Per-column cliff noise (surface-level 3D density sample). Computed once
	// in the prepass and reused by every chunkY layer's slow path, which
	// otherwise re-samples it per layer.
	cliffNoiseMap: Float32Array;
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

// Module-level scratch for the batch 2D column prepass. Sized for a 32-wide
// chunk + 1-block halo on each side (34 columns) so PASS 2's border neighbor
// lookups (worldX±1 / worldZ±1) also hit the grid. Shared across all prepass
// builds — generateChunkData is synchronous per thread.
const _GRID_HALO = 1;
const _GRID_EDGE = 32 + _GRID_HALO * 2;
const _gridArea = _GRID_EDGE * _GRID_EDGE;
const _gridRiver = new Float32Array(_gridArea);
const _gridErosion = new Float32Array(_gridArea);
const _gridPv = new Float32Array(_gridArea);
const _gridContinental = new Float32Array(_gridArea);
const _terrainNoiseGrid: TerrainNoiseGrid = {
	river: _gridRiver,
	erosion: _gridErosion,
	pv: _gridPv,
	continentalness: _gridContinental,
	width: _GRID_EDGE,
	height: _GRID_EDGE,
	offsetX: 0,
	offsetZ: 0,
};

// PERF: Module-level scratch for generateTerrain's per-chunk result arrays.
// All downstream consumers (underground pass, flora, light seeding) read them
// synchronously within the same generateChunkData call, so a shared buffer
// eliminates the ~8KB of typed-array garbage per chunk.
const _scratchArea = GenerationParams.CHUNK_SIZE * GenerationParams.CHUNK_SIZE;
const _scratchSunlightMask = new Uint8Array(_scratchArea);
const _scratchTopSurfaceYMap = new Int16Array(_scratchArea);
_scratchTopSurfaceYMap.fill(CAVE_NO_SURFACE_Y);

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

	// Batch backend for the density-band evals used by findTopSurfaceY and the
	// per-column density fill (see SurfaceDensity on NoiseInstance).
	private readonly densityInstance: NoiseInstance;

	// Scratch buffer reused per column band call to avoid allocating.
	// One chunk column (32 voxels) + the probe above the chunk.
	private readonly densityColumnBand = new Float32Array(33);

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

	// PERF: Cap cache sizes to prevent unbounded memory growth during long
	// play sessions. Each columnCache entry holds ~15KB of typed arrays;
	// floraCache entries are small but grow with explored terrain. FIFO
	// eviction preserves the bulk-generation locality that makes caching
	// effective while bounding peak memory.
	private static readonly COLUMN_CACHE_MAX = 4096;
	private static readonly FLORA_CACHE_MAX = 8192;

	private static evictCacheIfFull(
		cache: Map<number, unknown>,
		maxSize: number,
	): void {
		if (cache.size < maxSize) return;
		// FIFO eviction: delete oldest 25% of entries. Map iteration order
		// is insertion order, so this evicts the oldest entries first.
		const targetEvict = maxSize >> 2;
		let evicted = 0;
		for (const key of cache.keys()) {
			cache.delete(key);
			evicted++;
			if (evicted >= targetEvict) break;
		}
	}

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
		densityInstance: NoiseInstance,
		seedAsInt: number,
		cheeseNoise: (x: number, y: number, z: number) => number,
		tunnelNoise: (x: number, y: number, z: number) => number,
		detailNoise: (x: number, y: number, z: number) => number,
		cheeseInstance?: NoiseInstance,
		tunnelInstance?: NoiseInstance,
		detailInstance?: NoiseInstance,
	) {
		this.params = params;
		SurfaceGenerator.treeNoise = treeNoise;
		SurfaceGenerator.densityNoise = densityNoise;
		this.densityInstance = densityInstance;
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
			cheeseInstance,
			tunnelInstance,
			detailInstance,
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
			new PondFeature(),
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

		// Batch-prepopulate the 2D height fields (river/erosion/pv/continentalness)
		// for the whole chunk + 1-block halo in a single FillNoise2D call each,
		// so PASS 1 below reads terrain heights from the grid instead of making
		// 4 scalar noise crossings per column (1024 crossings saved per chunk).
		// The biome-scaled height noise stays per-column scalar (its scale blends
		// per column inside computeFinalTerrainHeight), as do density/cliff 3D.
		const useNoiseGrid = CHUNK_SIZE <= _GRID_EDGE - _GRID_HALO * 2;
		if (useNoiseGrid) {
			fillTerrainNoiseGrid(
				chunkWorldX,
				chunkWorldZ,
				_GRID_HALO,
				CHUNK_SIZE,
				_terrainNoiseGrid,
			);
		}

		const terrainHeightMap = new Int32Array(area);
		const riverNoiseMap = new Float32Array(area);
		const topSurfaceYMap = new Int16Array(area);
		const isBeachMap = new Uint8Array(area);
		const cliffNoiseMap = new Float32Array(area);
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

				const terrainHeight = useNoiseGrid
					? getFinalTerrainHeightFromGrid(worldX, worldZ, _terrainNoiseGrid)
					: getFinalTerrainHeight(worldX, worldZ);
				const riverNoise = getCachedRiverNoise(worldX, worldZ);

				// Cliff noise is a pure function of the column (sampled once at
				// surface level) — computed here and reused by findTopSurfaceY and
				// every chunkY layer's slow path below.
				const cliffNoise = this.sampleCliffNoise(worldX, terrainHeight, worldZ);

				const topSurfaceY = this.findTopSurfaceY(
					worldX,
					worldZ,
					terrainHeight,
					yFreqMap,
					cliffNoise,
				);

				terrainHeightMap[columnIndex] = terrainHeight;
				riverNoiseMap[columnIndex] = riverNoise;
				cliffNoiseMap[columnIndex] = cliffNoise;
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
						: useNoiseGrid
							? getFinalTerrainHeightFromGrid(
									worldX - 1,
									worldZ,
									_terrainNoiseGrid,
								)
							: getFinalTerrainHeight(worldX - 1, worldZ);

				const right =
					localX < CHUNK_SIZE - 1
						? terrainHeightMap[columnIndex + 1]
						: useNoiseGrid
							? getFinalTerrainHeightFromGrid(
									worldX + 1,
									worldZ,
									_terrainNoiseGrid,
								)
							: getFinalTerrainHeight(worldX + 1, worldZ);

				const down =
					localZ > 0
						? terrainHeightMap[columnIndex - CHUNK_SIZE]
						: useNoiseGrid
							? getFinalTerrainHeightFromGrid(
									worldX,
									worldZ - 1,
									_terrainNoiseGrid,
								)
							: getFinalTerrainHeight(worldX, worldZ - 1);

				const up =
					localZ < CHUNK_SIZE - 1
						? terrainHeightMap[columnIndex + CHUNK_SIZE]
						: useNoiseGrid
							? getFinalTerrainHeightFromGrid(
									worldX,
									worldZ + 1,
									_terrainNoiseGrid,
								)
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
			cliffNoiseMap,
			minSurfaceY,
			maxSurfaceY,
		};

		SurfaceGenerator.columnCache.set(key, built);
		SurfaceGenerator.evictCacheIfFull(
			SurfaceGenerator.columnCache,
			SurfaceGenerator.COLUMN_CACHE_MAX,
		);

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
		SurfaceGenerator.evictCacheIfFull(
			SurfaceGenerator.floraCache,
			SurfaceGenerator.FLORA_CACHE_MAX,
		);

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

		columnBaseLocal: (lx: number, lz: number) => number,
		placeColumnLocal: (
			columnBase: number,
			ly: number,
			id: number,
			ow?: boolean,
		) => void,
	): SurfaceGenerationResult {
		const generationResult = this.generateTerrain(
			chunkX,
			chunkY,
			chunkZ,
			biome,
			columnBaseLocal,
			placeColumnLocal,
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
			this.generateFlora(chunkX, chunkY, chunkZ, biome, placeBlock);
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

		columnBaseLocal: (lx: number, lz: number) => number,
		placeColumnLocal: (
			columnBase: number,
			ly: number,
			id: number,
			ow?: boolean,
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

		const topSunlightMask = _scratchSunlightMask;
		const topSurfaceYMap = _scratchTopSurfaceYMap;
		topSurfaceYMap.fill(NO_SURFACE_Y);

		const volcanicLiquidId =
			currentBiome.id === BIOME_ID.VOLCANIC_WASTELAND ? 24 : 30;

		// Fast-path: if entire chunk is well below any possible surface, skip expensive prepass
		// Minimum surface Y: SEA_LEVEL + continentalnessSpline(-1.0) - INFLUENCE ≈ -90
		// Use -128 for a safe margin — only affects very deep chunks
		if (topWorldY < -128) {
			for (let localX = 0; localX < CHUNK_SIZE; localX++) {
				for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
					const columnBase = columnBaseLocal(localX, localZ);
					for (let localY = 0; localY < CHUNK_SIZE; localY++) {
						const worldY = chunkWorldY + localY;
						const blockId = worldY < 0 ? 29 : currentBiome.stoneBlock;
						placeColumnLocal(columnBase, localY, blockId, true);
					}
				}
			}
			return {
				topSunlightMask,
				topSurfaceYMap,
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
				// PERF: localX/localZ fixed for this column — hoist the index
				// term once instead of per-voxel inside the Y loops below.
				const columnBase = columnBaseLocal(localX, localZ);

				const terrainHeight = columnPrepass.terrainHeightMap[columnIndex];
				const riverNoise = columnPrepass.riverNoiseMap[columnIndex];

				const topSurfaceY = columnPrepass.topSurfaceYMap[columnIndex];

				const hasSurface = topSurfaceY !== NO_SURFACE_Y;
				const columnTopSurfaceY = hasSurface ? topSurfaceY : NO_SURFACE_Y;

				if (hasSurface) {
					topSurfaceYMap[columnIndex] = topSurfaceY;
				}

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
						placeColumnLocal(columnBase, localY, volcanicLiquidId, false);
					}
					continue;
				}

				// ------------------------------------------------------------
				// FAST PATH 1C: Entire chunk band is above influence, and the whole
				// chunk lies below 0 => guaranteed block 29 fill.
				// ------------------------------------------------------------
				if (chunkEntirelyAboveInfluence && topWorldY < 0) {
					for (let localY = 0; localY < CHUNK_SIZE; localY++) {
						placeColumnLocal(columnBase, localY, 29, false);
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
								placeColumnLocal(columnBase, localY, volcanicLiquidId, false);
							} else {
								placeColumnLocal(columnBase, localY, 29, false);
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
						placeColumnLocal(columnBase, localY, currentBiome.stoneBlock, true);
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
								placeColumnLocal(
									columnBase,
									localY,
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
						placeColumnLocal(columnBase, localY, blockId, true);
						airGapSinceLastSolid = 0;
					}

					continue;
				}

				// SLOW PATH — cliffNoise sampled once per column in the prepass
				// (reused across every chunkY layer). y * 0.004 shifts by only
				// 0.256 across the entire 64-block influence range so this is
				// visually identical to per-voxel sampling.
				const cliffNoise = columnPrepass.cliffNoiseMap[columnIndex];

				// Batch the whole density column (CHUNK_SIZE voxels + the probe
				// one block above the chunk) in a single SurfaceDensity call. The
				// band matches this.getDensity exactly, including the |rel| >
				// influence early-out, and is reused for the probe + voxel reads.
				const densityColumn = this.densityColumnBand;
				this.densityInstance.SurfaceDensity(
					densityColumn,
					CHUNK_SIZE + 1,
					chunkWorldY,
					1,
					worldX * 0.002,
					worldZ * 0.01,
					worldX * 0.008,
					worldZ * 0.008,
					terrainHeight,
					yFreq,
					cliffNoise * SurfaceGenerator.DENSITY_CLIFF_AMPLITUDE,
					SurfaceGenerator.DENSITY_BASE_AMPLITUDE,
					SurfaceGenerator.DENSITY_OVERHANG_AMPLITUDE,
					SurfaceGenerator.DENSITY_INFLUENCE_RANGE,
				);

				let depthAnchorY = columnTopSurfaceY;

				const densityAboveChunk = densityColumn[CHUNK_SIZE];
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
							placeColumnLocal(
								columnBase,
								localY,
								worldY <= SEA_LEVEL ? 30 : 0,
								true,
							);
							airGapSinceLastSolid++;
							continue;
						}
					}

					const density = densityColumn[localY];
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
						placeColumnLocal(columnBase, localY, blockId, true);
						airGapSinceLastSolid = 0;
					} else {
						if (worldY <= SEA_LEVEL) {
							if (worldY >= 0) {
								placeColumnLocal(columnBase, localY, volcanicLiquidId, false);
							} else {
								placeColumnLocal(columnBase, localY, 29, false);
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
	): void {
		const SCAN_RADIUS = 6;
		const chunkSize = this.chunk_size;
		const chunkWorldX = chunkX * chunkSize;
		const chunkWorldZ = chunkZ * chunkSize;
		const seaLevel = this.params.SEA_LEVEL;
		const NO_SURFACE_Y = CAVE_NO_SURFACE_Y;

		// generateTerrain already built this entry.
		const centerPrepass = this.getOrBuildColumnPrepass(chunkX, chunkZ);

		// Flora scan radius is smaller than a chunk, so this scan can only touch
		// the current chunk plus its 8 direct neighbors. Pre-resolve those once.
		const prepasses = new Array<ColumnPrepassCacheEntry>(9);

		for (let oz = -1; oz <= 1; oz++) {
			for (let ox = -1; ox <= 1; ox++) {
				const prepassIndex = ox + 1 + (oz + 1) * 3;
				prepasses[prepassIndex] =
					ox === 0 && oz === 0
						? centerPrepass
						: this.getOrBuildColumnPrepass(chunkX + ox, chunkZ + oz);
			}
		}

		const scanMin = -SCAN_RADIUS;
		const scanMax = chunkSize + SCAN_RADIUS;

		for (let localX = scanMin; localX < scanMax; localX++) {
			const worldX = chunkWorldX + localX;

			// Since SCAN_RADIUS < chunkSize, ownership can be resolved with two
			// comparisons instead of Math.floor(worldX / chunkSize).
			const ownerOffsetX = localX < 0 ? -1 : localX >= chunkSize ? 1 : 0;
			const ownerIndexX = ownerOffsetX + 1;
			const colLocalX = localX - ownerOffsetX * chunkSize;
			const insideX = ownerOffsetX === 0;

			for (let localZ = scanMin; localZ < scanMax; localZ++) {
				const worldZ = chunkWorldZ + localZ;

				const ownerOffsetZ = localZ < 0 ? -1 : localZ >= chunkSize ? 1 : 0;
				const ownerIndexZ = ownerOffsetZ + 1;
				const colLocalZ = localZ - ownerOffsetZ * chunkSize;
				const isInsideChunkColumn = insideX && ownerOffsetZ === 0;

				const prepassEntry = prepasses[ownerIndexX + ownerIndexZ * 3];

				const columnIndex = colLocalX + colLocalZ * chunkSize;
				const surfaceYFromPrepass = prepassEntry.topSurfaceYMap[columnIndex];

				if (
					surfaceYFromPrepass === NO_SURFACE_Y ||
					surfaceYFromPrepass < seaLevel
				) {
					continue;
				}

				const column = this.getOrBuildFloraColumnInfo(
					worldX,
					worldZ,
					surfaceYFromPrepass,
				);

				const colBiome = column.biome;
				const surfaceY = column.topSurfaceY;

				if (surfaceY === NO_SURFACE_Y || surfaceY < seaLevel) {
					continue;
				}

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

				// Beach flag comes from the owning chunk prepass.
				const isBeach = prepassEntry.isBeachMap[columnIndex] === 1;

				const topBlockId =
					isBeach && surfaceY >= seaLevel - 2 && surfaceY <= seaLevel + 2
						? colBiome.beachBlock
						: colBiome.topBlock;

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

						// Preserve original behavior: tree columns skip grass/findlinge.
						continue;
					}
				}

				// Grass and findlinge only spawn from columns inside this chunk,
				// while trees may be scanned outside the chunk to avoid border cuts.
				if (!isInsideChunkColumn) {
					continue;
				}

				if (column.treeNoiseValue < _biome.grassDensity) {
					if (
						topBlockId === BlockType.Grass001 ||
						topBlockId === BlockType.RockyTerrain02 ||
						topBlockId === BlockType.ConcreteMoss
					) {
						placeBlock(worldX, surfaceY + 1, worldZ, BlockType.Grass006Cross);
					} else if (topBlockId === 65) {
						placeBlock(worldX, surfaceY + 1, worldZ, 66);
					}
				}

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
		cliffNoise?: number,
	): number {
		const range = SurfaceGenerator.DENSITY_VERTICAL_SCAN_RANGE;
		const maxY = baseHeight + range;
		const minY = baseHeight - range;

		const cliff =
			cliffNoise ?? this.sampleCliffNoise(worldX, baseHeight, worldZ);

		const baseAmp = SurfaceGenerator.DENSITY_BASE_AMPLITUDE;
		const overhangAmp = SurfaceGenerator.DENSITY_OVERHANG_AMPLITUDE;
		const cliffContribution = cliff * SurfaceGenerator.DENSITY_CLIFF_AMPLITUDE;

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
	 *
	 * NOTE: findTopSurfaceY deliberately keeps this scalar path instead of
	 * batching through SurfaceDensity — the coarse scan early-outs at the
	 * first solid from the top (~9-10 evals typical), while a band call
	 * always evaluates all 17+4 samples. Benchmarked: band version regressed
	 * the JS pass 326→522ms and the wasm pass 112→117ms.
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
