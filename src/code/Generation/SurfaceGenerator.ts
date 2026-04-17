import type { Biome } from "./Biome/BiomeTypes";
import {
	GenerationParams,
	type GenerationParamsType,
} from "./NoiseAndParameters/GenerationParams";
import { RiverGenerator } from "./RiverGeneration";
import { DungeonFeature } from "./Structure/DungeonFeature";
import type { IWorldFeature } from "./Structure/IWorldFeature";
import { LavaPoolFeature } from "./Structure/LavaPoolFeature";
import { StructureSpawnerFeature } from "./Structure/StructureFeature";
import { TowerFeature } from "./Structure/TowerFeature";
import { TerrainHeightMap } from "./TerrainHeightMap";

export type SurfaceGenerationResult = {
	topSunlightMask: Uint8Array;
	topSurfaceYMap: Int16Array;
	minSurfaceY: number;
	maxSurfaceY: number;
};

type ColumnPrepassCacheEntry = {
	terrainHeightMap: Int32Array;
	riverNoiseMap: Float32Array;
	yFreqMap: Float32Array;
	topSurfaceYMap: Int16Array;
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

	private static readonly DENSITY_BASE_AMPLITUDE = 32;
	private static readonly DENSITY_OVERHANG_AMPLITUDE = 32;
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
	private static readonly NO_SURFACE_Y = -32768;

	/**
	 * Conservative vertical budgets used to decide whether a chunkY slice
	 * can possibly contain any flora / structure blocks.
	 *
	 * You can tighten these later once you know the exact max extents of
	 * your tallest trees / largest structures.
	 */
	private static readonly MAX_TREE_HEIGHT = 24;
	private static readonly MAX_STRUCTURE_ABOVE_SURFACE = 48;
	private static readonly MAX_STRUCTURE_BELOW_SURFACE = 24;

	private static seedAsInt: number;

	/**
	 * Bounded cache of expensive horizontal column prepass data.
	 *
	 * Keyed by (chunkX, chunkZ) packed into a bigint.
	 */
	private static readonly MAX_COLUMN_PREPASS_CACHE = 128;
	private static readonly columnPrepassCache = new Map<
		bigint,
		ColumnPrepassCacheEntry
	>();
	private static readonly columnPrepassFifo: bigint[] = [];

	/**
	 * Bounded flora-column cache for overlapping flora scans.
	 *
	 * Keyed by (worldX, worldZ) packed into a bigint.
	 */
	private static readonly MAX_FLORA_COLUMN_CACHE = 16384;
	private static readonly floraColumnCache = new Map<
		bigint,
		FloraColumnCacheEntry
	>();
	private static readonly floraColumnCacheFifo: bigint[] = [];

	private chunk_size: number;
	private riverGenerator: RiverGenerator;
	private features: IWorldFeature[];
	private readonly getFinalTerrainHeightBound: (
		worldX: number,
		worldZ: number,
	) => number;

	constructor(
		params: GenerationParamsType,
		treeNoise: (x: number, z: number) => number,
		densityNoise: (x: number, y: number, z: number) => number,
		seedAsInt: number,
	) {
		this.params = params;
		SurfaceGenerator.treeNoise = treeNoise;
		SurfaceGenerator.densityNoise = densityNoise;
		SurfaceGenerator.seedAsInt = seedAsInt;

		this.chunk_size = this.params.CHUNK_SIZE;
		this.riverGenerator = new RiverGenerator(params);

		this.features = [
			new TowerFeature(),
			new LavaPoolFeature(),
			new StructureSpawnerFeature(),
			new DungeonFeature(),
		];

		this.getFinalTerrainHeightBound = this.getFinalTerrainHeight.bind(this);
	}

	private packXZKey(x: number, z: number): bigint {
		return (BigInt(x) << 32n) ^ (BigInt(z) & 0xffffffffn);
	}

	private getColumnPrepassKey(chunkX: number, chunkZ: number): bigint {
		return this.packXZKey(chunkX, chunkZ);
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
		const cached = SurfaceGenerator.columnPrepassCache.get(key);
		if (cached) {
			return cached;
		}

		const CHUNK_SIZE = this.params.CHUNK_SIZE;
		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const area = CHUNK_SIZE * CHUNK_SIZE;
		const NO_SURFACE_Y = SurfaceGenerator.NO_SURFACE_Y;

		const terrainHeightMap = new Int32Array(area);
		const riverNoiseMap = new Float32Array(area);
		const yFreqMap = new Float32Array(area);
		const topSurfaceYMap = new Int16Array(area);
		topSurfaceYMap.fill(NO_SURFACE_Y);

		let minSurfaceY = Number.POSITIVE_INFINITY;
		let maxSurfaceY = Number.NEGATIVE_INFINITY;

		for (let localX = 0; localX < CHUNK_SIZE; localX++) {
			const worldX = chunkWorldX + localX;

			for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
				const worldZ = chunkWorldZ + localZ;
				const columnIndex = localX + localZ * CHUNK_SIZE;

				const sample = TerrainHeightMap.getTerrainSample(worldX, worldZ);
				const terrainHeight = sample.height;
				const riverNoise = sample.riverNoise;

				const treeMod = SurfaceGenerator.treeNoise(
					worldX * 0.00001,
					worldZ * 0.00001,
				);
				const yFreq = 0.04 + treeMod * 0.02;

				const topSurfaceY = this.findTopSurfaceY(
					worldX,
					worldZ,
					terrainHeight,
					yFreq,
				);

				terrainHeightMap[columnIndex] = terrainHeight;
				riverNoiseMap[columnIndex] = riverNoise;
				yFreqMap[columnIndex] = yFreq;
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

		const built: ColumnPrepassCacheEntry = {
			terrainHeightMap,
			riverNoiseMap,
			yFreqMap,
			topSurfaceYMap,
			minSurfaceY,
			maxSurfaceY,
		};

		SurfaceGenerator.columnPrepassCache.set(key, built);
		SurfaceGenerator.columnPrepassFifo.push(key);

		while (
			SurfaceGenerator.columnPrepassFifo.length >
			SurfaceGenerator.MAX_COLUMN_PREPASS_CACHE
		) {
			const evictKey = SurfaceGenerator.columnPrepassFifo.shift();
			if (evictKey !== undefined) {
				SurfaceGenerator.columnPrepassCache.delete(evictKey);
			}
		}

		return built;
	}

	private getFloraColumnKey(worldX: number, worldZ: number): bigint {
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
		const cached = SurfaceGenerator.floraColumnCache.get(key);
		if (cached) {
			return cached;
		}

		const sample = TerrainHeightMap.getTerrainSample(worldX, worldZ);
		const biome = sample.biome;
		const riverNoise = sample.riverNoise;

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

			topSurfaceY = this.findTopSurfaceY(worldX, worldZ, sample.height, yFreq);
		}

		const built: FloraColumnCacheEntry = {
			biome,
			riverNoise,
			topSurfaceY,
			treeNoiseValue,
		};

		SurfaceGenerator.floraColumnCache.set(key, built);
		SurfaceGenerator.floraColumnCacheFifo.push(key);

		while (
			SurfaceGenerator.floraColumnCacheFifo.length >
			SurfaceGenerator.MAX_FLORA_COLUMN_CACHE
		) {
			const evictKey = SurfaceGenerator.floraColumnCacheFifo.shift();
			if (evictKey !== undefined) {
				SurfaceGenerator.floraColumnCache.delete(evictKey);
			}
		}

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
			placeBlock as (
				x: number,
				y: number,
				z: number,
				id: number,
				ow: boolean,
			) => void,
		);

		const chunkMinY = chunkY * this.chunk_size;
		const chunkMaxY = chunkMinY + this.chunk_size - 1;
		const hasAnySurface =
			generationResult.maxSurfaceY !== SurfaceGenerator.NO_SURFACE_Y;

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
				placeBlock as (x: number, y: number, z: number, id: number) => void,
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
			this.generateStructures(
				chunkX,
				chunkY,
				chunkZ,
				biome,
				placeBlock as (
					x: number,
					y: number,
					z: number,
					id: number,
					ow: boolean,
				) => void,
			);
		}

		return generationResult;
	}

	private resolveSolidBlockId(
		currentBiome: Biome,
		worldX: number,
		worldZ: number,
		worldY: number,
		depthBelowSurface: number,
	): number {
		const SEA_LEVEL = this.params.SEA_LEVEL;

		let blockId = currentBiome.stoneBlock;

		if (depthBelowSurface === 0) {
			const isBeach = this.isBeachLocation(worldX, worldZ, worldY);

			if (worldY < SEA_LEVEL - 1) {
				blockId = currentBiome.seafloorBlock;
			} else if (isBeach) {
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
		const NO_SURFACE_Y = SurfaceGenerator.NO_SURFACE_Y;
		const INFLUENCE = SurfaceGenerator.DENSITY_INFLUENCE_RANGE;

		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldY = chunkY * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const topWorldY = chunkWorldY + CHUNK_SIZE - 1;

		const topSunlightMask = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
		const topSurfaceYMap = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
		topSurfaceYMap.fill(NO_SURFACE_Y);

		const volcanicLiquidId =
			currentBiome.name === "Volcanic_Wasteland" ? 24 : 30;

		// Reuse expensive per-column data for all chunkY in the same (chunkX, chunkZ)
		const columnPrepass = this.getOrBuildColumnPrepass(chunkX, chunkZ);
		const minSurfaceY = columnPrepass.minSurfaceY;
		const maxSurfaceY = columnPrepass.maxSurfaceY;

		for (let localX = 0; localX < CHUNK_SIZE; localX++) {
			const worldX = chunkWorldX + localX;

			for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
				const worldZ = chunkWorldZ + localZ;
				const columnIndex = localX + localZ * CHUNK_SIZE;

				const terrainHeight = columnPrepass.terrainHeightMap[columnIndex];
				const riverNoise = columnPrepass.riverNoiseMap[columnIndex];
				const yFreq = columnPrepass.yFreqMap[columnIndex];
				const topSurfaceY = columnPrepass.topSurfaceYMap[columnIndex];

				const hasSurface = topSurfaceY !== NO_SURFACE_Y;
				const columnTopSurfaceY = hasSurface ? topSurfaceY : NO_SURFACE_Y;

				if (hasSurface) {
					topSurfaceYMap[columnIndex] = topSurfaceY;
				}

				topSunlightMask[columnIndex] =
					!hasSurface || topSurfaceY <= topWorldY ? 1 : 0;

				/**
				 * ChunkY band classification:
				 * getDensity(...) already returns plain relativeHeight outside
				 * +/- DENSITY_INFLUENCE_RANGE from terrainHeight, so the whole band
				 * can be classified without per-voxel density noise in those cases.
				 */
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
							worldX,
							worldZ,
							worldY,
							depthBelowSurface,
						);

						placeBlock(worldX, worldY, worldZ, blockId, true);
						airGapSinceLastSolid = 0;
					}

					continue;
				}

				// ------------------------------------------------------------
				// SLOW PATH: chunk band intersects the density influence region
				// => keep the original density-driven per-voxel evaluation
				// ------------------------------------------------------------
				let depthAnchorY = columnTopSurfaceY;

				const densityAboveChunk = this.getDensity(
					worldX,
					topWorldY + 1,
					worldZ,
					terrainHeight,
					yFreq,
				);

				const isTunnelAboveChunk =
					topWorldY + 1 < GenerationParams.SEA_LEVEL + 16 &&
					this.riverGenerator.isRiver(
						worldX,
						topWorldY + 1,
						worldZ,
						riverNoise,
					);

				let airGapSinceLastSolid =
					!isTunnelAboveChunk && densityAboveChunk > 0 ? 0 : 1;

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
					);

					if (density > 0) {
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
							worldX,
							worldZ,
							worldY,
							depthBelowSurface,
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
		const SCAN_RADIUS = 8;
		const chunkSize = this.chunk_size;
		const chunkWorldX = chunkX * chunkSize;
		const chunkWorldZ = chunkZ * chunkSize;
		const NO_SURFACE_Y = SurfaceGenerator.NO_SURFACE_Y;

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

				const knownTopSurfaceY = isInsideChunkColumn
					? topSurfaceYMap[localX + localZ * chunkSize]
					: undefined;

				const column = this.getOrBuildFloraColumnInfo(
					worldX,
					worldZ,
					knownTopSurfaceY,
				);

				const colBiome = column.biome;
				if (!colBiome.canSpawnTrees) continue;

				if (column.treeNoiseValue > colBiome.treeDensity) continue;

				const surfaceY = column.topSurfaceY;
				if (surfaceY === NO_SURFACE_Y) continue;

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

				if (surfaceY < this.params.SEA_LEVEL) continue;

				const isBeach = this.isBeachLocation(worldX, worldZ, surfaceY);
				const topBlockId = isBeach ? colBiome.beachBlock : colBiome.topBlock;

				colBiome
					.getTreeForBlock(topBlockId)
					?.generate(
						worldX,
						surfaceY + 1,
						worldZ,
						placeBlock,
						SurfaceGenerator.seedAsInt,
					);
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
					features[i].generate(
						cx,
						chunkY,
						cz,
						biome,
						placeBlock,
						SurfaceGenerator.seedAsInt,
						this.chunk_size,
						this.getFinalTerrainHeightBound,
						chunkX,
						chunkZ,
					);
				}
			}
		}
	}

	private getFinalTerrainHeight(worldX: number, worldZ: number): number {
		return TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);
	}

	private isBeachLocation(
		worldX: number,
		worldZ: number,
		terrainHeight: number,
	): boolean {
		const SEA_LEVEL = this.params.SEA_LEVEL;

		if (!(terrainHeight >= SEA_LEVEL - 2 && terrainHeight <= SEA_LEVEL + 2)) {
			return false;
		}

		return (
			this.isNearWater(worldX + 1, worldZ) ||
			this.isNearWater(worldX - 1, worldZ) ||
			this.isNearWater(worldX, worldZ + 1) ||
			this.isNearWater(worldX, worldZ - 1)
		);
	}

	private isNearWater(x: number, z: number): boolean {
		return (
			TerrainHeightMap.getFinalTerrainHeight(x, z) <= this.params.SEA_LEVEL
		);
	}

	private getDensity(
		x: number,
		y: number,
		z: number,
		baseHeight: number,
		yFreq: number,
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

		const cliffNoise = SurfaceGenerator.densityNoise(
			x * 0.0035,
			y * 0.004,
			z * 0.0035,
		);

		return (
			relativeHeight +
			baseNoise * SurfaceGenerator.DENSITY_BASE_AMPLITUDE +
			overhangNoise * SurfaceGenerator.DENSITY_OVERHANG_AMPLITUDE +
			cliffNoise * SurfaceGenerator.DENSITY_CLIFF_AMPLITUDE
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

		let densityAbove = this.getDensity(
			worldX,
			maxY + 1,
			worldZ,
			baseHeight,
			yFreq,
		);

		let highestSolid = SurfaceGenerator.NO_SURFACE_Y;

		for (let y = maxY; y >= minY; y--) {
			const densityHere = this.getDensity(worldX, y, worldZ, baseHeight, yFreq);

			// First solid block directly below air = top surface
			if (densityHere > 0 && densityAbove <= 0) {
				return y;
			}

			// Fallback if no sharp transition was found
			if (densityHere > 0 && highestSolid === SurfaceGenerator.NO_SURFACE_Y) {
				highestSolid = y;
			}

			densityAbove = densityHere;
		}

		return highestSolid;
	}
}
