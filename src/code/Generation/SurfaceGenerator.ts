import { BlockType } from "../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "./Biome/BiomeTypes";
import {
	NO_SURFACE_Y as CAVE_NO_SURFACE_Y,
	evaluateCaveCarve,
	getSurfaceCarveBlend,
} from "./CaveCarver";
import {
	GenerationParams,
	type GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { RiverGenerator } from "./RiverGeneration";
import { DungeonFeature } from "./Structure/DungeonFeature";
import { GeodeFeature } from "./Structure/GeodeFeature";
import { InfernalPitFeature } from "./Structure/InfernalPitFeature";
import type { IWorldFeature } from "./Structure/IWorldFeature";
import { LavaPoolFeature } from "./Structure/LavaPoolFeature";
import { MineshaftFeature } from "./Structure/MineshaftFeature";
import { RavineFeature } from "./Structure/RavineFeature";
import { StructureSpawnerFeature } from "./Structure/StructureFeature";
import { TowerFeature } from "./Structure/TowerFeature";
import {
	getBiome,
	getCachedRiverNoise,
	getFinalTerrainHeight,
	prefetchChunkCorners,
} from "./TerrainHeightMap";

export type SurfaceGenerationResult = {
	topSunlightMask: Uint8Array;
	topSurfaceYMap: Int16Array;
	minSurfaceY: number;
	maxSurfaceY: number;
};

type ColumnPrepassCacheEntry = {
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

	private static readonly SUBSURFACE_LAYER_DEPTH = 5;
	private static readonly SURFACE_RESET_AIR_GAP = 6;
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

	private static seedAsInt: number;

	/**
	 * Direct-mapped cache of expensive horizontal column prepass data.
	 *
	 * Keyed by (chunkX, chunkZ) packed into a number.
	 */
	private static readonly COLUMN_CACHE_SIZE = 512;
	private static readonly COLUMN_CACHE_MASK =
		SurfaceGenerator.COLUMN_CACHE_SIZE - 1;
	private static readonly columnCacheKeys = new Uint32Array(
		SurfaceGenerator.COLUMN_CACHE_SIZE,
	);
	private static readonly columnCacheEntries: (ColumnPrepassCacheEntry | null)[] =
		new Array(SurfaceGenerator.COLUMN_CACHE_SIZE).fill(null);

	/**
	 * Direct-mapped flora-column cache for overlapping flora scans.
	 *
	 * Keyed by (worldX, worldZ) packed into a number.
	 */
	private static readonly FLORA_CACHE_SIZE = 16384;
	private static readonly FLORA_CACHE_MASK =
		SurfaceGenerator.FLORA_CACHE_SIZE - 1;
	private static readonly floraCacheKeys = new Uint32Array(
		SurfaceGenerator.FLORA_CACHE_SIZE,
	);
	private static readonly floraCacheEntries: (FloraColumnCacheEntry | null)[] =
		new Array(SurfaceGenerator.FLORA_CACHE_SIZE).fill(null);

	private chunk_size: number;
	private riverGenerator: RiverGenerator;
	private features: IWorldFeature[];

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

		this.features = [
			new TowerFeature(),
			new LavaPoolFeature(),
			new StructureSpawnerFeature(),
			new DungeonFeature(),
			new RavineFeature(),
			new GeodeFeature(),
			new MineshaftFeature(),
			new InfernalPitFeature(),
		];
	}

	// Number-only key — eliminates BigInt heap allocation on every cache probe.
	// For columnCache (chunkX/Z, small integers): shift-pack is
	// collision-free within ±32768 chunk range.
	// For floraCache (worldX/Z, larger range): multiply-xor spreads bits.
	private packXZKey(x: number, z: number): number {
		return ((x * 73856093) ^ (z * 19349663)) | 0;
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
		const slot = key & SurfaceGenerator.COLUMN_CACHE_MASK;
		const cached = SurfaceGenerator.columnCacheEntries[slot];
		if (cached && SurfaceGenerator.columnCacheKeys[slot] === key) {
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

		SurfaceGenerator.columnCacheKeys[slot] = key;
		SurfaceGenerator.columnCacheEntries[slot] = built;

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
		const slot = key & SurfaceGenerator.FLORA_CACHE_MASK;
		const cached = SurfaceGenerator.floraCacheEntries[slot];
		if (cached && SurfaceGenerator.floraCacheKeys[slot] === key) {
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

		SurfaceGenerator.floraCacheKeys[slot] = key;
		SurfaceGenerator.floraCacheEntries[slot] = built;

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
				generationResult.maxSurfaceY +
					SurfaceGenerator.MAX_STRUCTURE_ABOVE_SURFACE,
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
		const SEA_LEVEL = this.params.SEA_LEVEL;

		let blockId = currentBiome.stoneBlock;

		if (depthBelowSurface === 0) {
			if (worldY < SEA_LEVEL - 1) {
				blockId = currentBiome.seafloorBlock;
			} else if (
				isBeach &&
				worldY >= SEA_LEVEL - 2 &&
				worldY <= SEA_LEVEL + 2
			) {
				blockId = currentBiome.beachBlock;
			} else {
				blockId = currentBiome.topBlock;
			}
		} else if (
			depthBelowSurface > 0 &&
			depthBelowSurface <= SurfaceGenerator.SUBSURFACE_LAYER_DEPTH
		) {
			blockId = currentBiome.undergroundBlock;
		}

		return blockId;
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

		const topSunlightMask = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
		const topSurfaceYMap = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
		topSurfaceYMap.fill(NO_SURFACE_Y);

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

						if (
							airGapSinceLastSolid >= SurfaceGenerator.SURFACE_RESET_AIR_GAP
						) {
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
						if (
							airGapSinceLastSolid >= SurfaceGenerator.SURFACE_RESET_AIR_GAP
						) {
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
			minSurfaceY,
			maxSurfaceY,
		};
	}

	private generateFlora(
		chunkX: number,
		chunkY: number,
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
							topBlockId === BlockType.ConcreteMoss
						) {
							placeBlock(worldX, surfaceY + 1, worldZ, 64);
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

		const wxArr = new Float32Array(dxCount);
		for (let i = 0; i < dxCount; i++) {
			const dx = i - dxRange;
			wxArr[i] = SurfaceGenerator.densityNoise(
				(cx + dx) * 0.18,
				cy * 0.22,
				cz * 0.18,
			);
		}

		const wzArr = new Float32Array(dzCount);
		for (let i = 0; i < dzCount; i++) {
			const dz = i - dzRange;
			wzArr[i] = SurfaceGenerator.densityNoise(
				cx * 0.22,
				cy * 0.18,
				(cz + dz) * 0.22 + 17.3,
			);
		}

		const wyArr = new Float32Array(dyCount);
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

			for (let dx = -dxRange; dx <= dxRange; dx++) {
				const nx = dx * invW;
				const wnx = nx + wxArr[dx + dxRange] * warpW + tiltX * ny;
				const wnx2 = wnx * wnx;
				if (wnx2 + wny2 + flatBase >= 1.0) continue;

				for (let dz = -dzRange; dz <= dzRange; dz++) {
					const nz = dz * invD;
					const wnz = nz + wzArr[dz + dzRange] * warpD + tiltZ * ny;
					if (wnx2 + wny2 + wnz * wnz + flatBase < 1.0) {
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
	) {
		const STRUCTURE_SEARCH_RADIUS = 2;
		const features = this.features;
		const chunkSize = this.chunk_size;
		const chunkMinY = chunkY * chunkSize;
		const chunkMaxY = chunkMinY + chunkSize - 1;

		let hasRelevantFeature = false;
		for (let i = 0; i < features.length; i++) {
			const b = features[i].verticalBounds;
			if (
				b === undefined ||
				!(chunkMaxY < b.minWorldY || chunkMinY > b.maxWorldY)
			) {
				hasRelevantFeature = true;
				break;
			}
		}
		if (!hasRelevantFeature) return;

		for (
			let cx = chunkX - STRUCTURE_SEARCH_RADIUS;
			cx <= chunkX + STRUCTURE_SEARCH_RADIUS;
			cx++
		) {
			for (
				let cz = chunkZ - STRUCTURE_SEARCH_RADIUS;
				cz <= chunkZ + STRUCTURE_SEARCH_RADIUS;
				cz++
			) {
				for (let i = 0; i < features.length; i++) {
					const feature = features[i];
					const bounds = feature.verticalBounds;
					if (bounds !== undefined) {
						if (chunkMaxY < bounds.minWorldY) continue;
						if (chunkMinY > bounds.maxWorldY) continue;
					}
					feature.generate(
						cx,
						chunkY,
						cz,
						biome,
						placeBlock,
						SurfaceGenerator.seedAsInt,
						chunkSize,
						chunkX,
						chunkZ,
					);
				}
			}
		}
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
		const cave = evaluateCaveCarve(
			this.params,
			y,
			surfaceY,
			this.cheeseNoise(x, y, z),
			this.tunnelNoise(x, y, z),
			this.detailNoise(x, y, z),
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

		const evalDensity = (y: number): number => {
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
		};

		// Pass 1: coarse scan at step=4 to find a bracket
		let coarseHigh = CAVE_NO_SURFACE_Y;
		for (let y = maxY; y >= minY; y -= 4) {
			if (evalDensity(y) > 0) {
				coarseHigh = y;
				break;
			}
		}
		if (coarseHigh === CAVE_NO_SURFACE_Y) return CAVE_NO_SURFACE_Y;

		// Pass 2: fine scan within the coarse bracket
		let densityAbove = -1;
		let highestSolid = CAVE_NO_SURFACE_Y;
		const fineMin = Math.max(coarseHigh - 4, minY);
		for (let y = coarseHigh; y >= fineMin; y--) {
			const d = evalDensity(y);
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

	private hashColumn(x: number, z: number, seed: number): number {
		let h = (x * 374761393 + z * 668265263 + seed) | 0;
		h = ((h ^ (h >> 13)) * 1274126177) | 0;
		h = (h ^ (h >> 16)) >>> 0;
		return h / 4294967296;
	}
}
