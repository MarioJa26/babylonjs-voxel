import Alea from "alea";
import { WATER_BLOCK_ID } from "../World/Chunk/Worker/ChunkMesherConstants";
import { LightGenerator, type LightSeedState } from "./LightGenerator";
import {
	createFastNoise,
	createFastNoise2D,
	createFastNoise3D,
} from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { getPRNGBySeed } from "./NoiseAndParameters/Squirrel13";
import { OreGenerator } from "./OreGenerator";
import { SurfaceGenerator } from "./SurfaceGenerator";
import { getBiome } from "./TerrainHeightMap";
import { UndergroundBiomeSelector } from "./UndergroundBiomes";
import { UndergroundGenerator } from "./UndergroundGenerator";

type GenerateChunkOptions = {
	deferLighting?: boolean;
	skipDecorations?: boolean;
};

type GenerateChunkResult = {
	blocks: Uint8Array;
	light: Uint8Array;
	lightSeedState?: LightSeedState;
};

const IS_ORE = new Uint8Array(128);
for (const id of [14, 16, 18, 19, 21, 25, 26, 79]) {
	IS_ORE[id] = 1;
}

// ---------------------------------------------------------------------------
// Smoothing constants — mirror the same values as UndergroundGenerator.
// ---------------------------------------------------------------------------

export class WorldGenerator {
	private params: GenerationParamsType;
	private prng: ReturnType<typeof Alea>;
	private seedAsInt: number;
	private chunkSizeSq: number;
	private chunk_size: number;
	private chunkVolume: number;

	private surfaceGenerator: SurfaceGenerator;
	private undergroundGenerator: UndergroundGenerator;
	private oreGenerator: OreGenerator;
	private undergroundBiomeSelector: UndergroundBiomeSelector;
	private lightGenerator: LightGenerator;

	private cheeseNoise: (x: number, y: number, z: number) => number;
	private tunnelNoise: (x: number, y: number, z: number) => number;
	private detailNoise: (x: number, y: number, z: number) => number;

	constructor(params: GenerationParamsType) {
		this.params = params;
		this.prng = Alea(this.params.SEED);
		this.seedAsInt = getPRNGBySeed(0, (this.prng() * 0xffffffff) | 0);

		this.chunk_size = this.params.CHUNK_SIZE;
		this.chunkSizeSq = this.chunk_size * this.chunk_size;
		this.chunkVolume = this.chunk_size * this.chunkSizeSq;

		const treeNoise = createFastNoise2D({
			seed: getPRNGBySeed(21, this.seedAsInt),
			frequency: 1,
		});

		const cheeseInstance = createFastNoise({
			seed: getPRNGBySeed(2, this.seedAsInt),
			frequency: this.params.CAVE_CHEESE_FREQ,
		});
		cheeseInstance.SetFractalOctaves(2);
		this.cheeseNoise = (x, y, z) => cheeseInstance.GetNoise3D(x, y, z);

		const tunnelInstance = createFastNoise({
			seed: getPRNGBySeed(22, this.seedAsInt),
			frequency: this.params.CAVE_TUNNEL_FREQ,
		});
		tunnelInstance.SetFractalOctaves(2);
		this.tunnelNoise = (x, y, z) => tunnelInstance.GetNoise3D(x, y, z);

		const detailInstance = createFastNoise({
			seed: getPRNGBySeed(24, this.seedAsInt),
			frequency: this.params.CAVE_DETAIL_FREQ,
		});
		detailInstance.SetFractalOctaves(2);
		this.detailNoise = (x, y, z) => detailInstance.GetNoise3D(x, y, z);

		const densityNoise = createFastNoise3D({
			seed: getPRNGBySeed(23, this.seedAsInt),
			frequency: 0.33333,
		});

		this.surfaceGenerator = new SurfaceGenerator(
			params,
			treeNoise,
			densityNoise,
			this.seedAsInt,
			this.cheeseNoise,
			this.tunnelNoise,
			this.detailNoise,
		);
		this.undergroundGenerator = new UndergroundGenerator(
			params,
			this.cheeseNoise,
			this.tunnelNoise,
			this.detailNoise,
		);

		const oreNoise = createFastNoise3D({
			seed: getPRNGBySeed(25, this.seedAsInt),
			frequency: 1,
		});
		this.oreGenerator = new OreGenerator(params, oreNoise, this.seedAsInt);

		const undergroundBiomeNoise = createFastNoise2D({
			seed: getPRNGBySeed(26, this.seedAsInt),
			frequency: 0.001,
		});
		this.undergroundBiomeSelector = new UndergroundBiomeSelector(
			undergroundBiomeNoise,
			this.seedAsInt,
		);

		this.lightGenerator = new LightGenerator(params);
	}

	private createBuffer(size: number): Uint8Array {
		// PERF: Allocate generation output in a SharedArrayBuffer so the block/
		// light buffers can be *shared* (not transferred) to the main thread and
		// then handed straight to the mesh worker. This avoids the redundant
		// main-thread SAB realloc+memcpy that Chunk.ensureSharedBacking used to
		// perform per generated chunk. The (cheap) OS shared-page setup happens
		// off the main thread, in this worker. Falls back to a plain ArrayBuffer
		// where SharedArrayBuffer is unavailable (main thread then copies as before).
		if (typeof SharedArrayBuffer !== "undefined") {
			return new Uint8Array(new SharedArrayBuffer(size));
		}
		return new Uint8Array(new ArrayBuffer(size));
	}

	// ---------------------------------------------------------------------------
	// Phase 3: Underground biome replacement (kept as a standalone pass for the
	// refineBlocks path).
	// ---------------------------------------------------------------------------
	private applyUndergroundBiomes(
		blocks: Uint8Array,
		chunkWorldX: number,
		chunkWorldY: number,
		chunkWorldZ: number,
		chunkSize: number,
		chunkSizeSq: number,
	): void {
		if (chunkWorldY >= 16) return;

		const midY = Math.min(chunkWorldY + (chunkSize >> 1), -1);
		let allDefault = true;
		for (let dx = 0; dx < chunkSize && allDefault; dx += chunkSize >> 1) {
			for (let dz = 0; dz < chunkSize && allDefault; dz += chunkSize >> 1) {
				if (
					this.undergroundBiomeSelector.getBiome(
						chunkWorldX + dx,
						midY,
						chunkWorldZ + dz,
					).stoneBlock !== 29
				) {
					allDefault = false;
				}
			}
		}
		if (allDefault) return;

		for (let localY = 0; localY < chunkSize; localY++) {
			const worldY = chunkWorldY + localY;
			if (worldY >= 0) continue;
			for (let localZ = 0; localZ < chunkSize; localZ++) {
				const worldZ = chunkWorldZ + localZ;
				const zOffset = localZ * chunkSizeSq;
				// PERF: Cache biome per column (worldY + worldZ are constant across X).
				const colBiome = this.undergroundBiomeSelector.getBiome(
					chunkWorldX,
					worldY,
					worldZ,
				);
				for (let localX = 0; localX < chunkSize; localX++) {
					const idx = localX + localY * chunkSize + zOffset;
					const blockId = blocks[idx];
					if (blockId === 0 || IS_ORE[blockId]) continue;
					// PERF: Use column-cached biome (X offset is negligible for biome selection).
					blocks[idx] = this.undergroundBiomeSelector.getStoneReplacement(
						blockId,
						colBiome,
					);
				}
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Phase 6+8: Combined underground pass — biome + cave + aquifer in one loop,
	// followed by a smoothing pass that eliminates isolated air pockets.
	//
	// CROSS-CHUNK CONTINUITY
	// ──────────────────────
	// All noise is sampled at world-space coordinates, so caves are naturally
	// continuous across chunk boundaries.  No extra seaming is required.
	//
	// SMOOTHING (pocket elimination)
	// ───────────────────────────────
	// After carving we run a single pass over the interior voxels (skipping the
	// 1-voxel border on all 6 faces) and fill back any carved voxel that has
	// MIN_SOLID_NEIGHBORS or more solid face-neighbours.  This eliminates tiny
	// isolated air pockets without touching chunk-boundary voxels (which must
	// remain consistent with adjacent chunks).
	// ---------------------------------------------------------------------------

	// ---------------------------------------------------------------------------
	// Phase 2: refineBlocks — called when skipDecorations was used on first pass.
	// ---------------------------------------------------------------------------
	public refineBlocks(
		blocks: Uint8Array,
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): void {
		const chunkSize = this.chunk_size;
		const chunkSizeSq = this.chunkSizeSq;
		const chunkWorldX = chunkX * chunkSize;
		const chunkWorldY = chunkY * chunkSize;
		const chunkWorldZ = chunkZ * chunkSize;

		this.applyUndergroundBiomes(
			blocks,
			chunkWorldX,
			chunkWorldY,
			chunkWorldZ,
			chunkSize,
			chunkSizeSq,
		);
	}

	/**
	 * Backward compatible:
	 * - generateChunkData(x, y, z) => full terrain + full lighting
	 * - generateChunkData(x, y, z, { deferLighting: true }) => terrain now, light later
	 * - generateChunkData(x, y, z, { skipDecorations: true }) => terrain + caves now, biomes + aquifers + light later
	 */
	public generateChunkData(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		options: GenerateChunkOptions = {},
	): GenerateChunkResult {
		const deferLighting = options.deferLighting === true;
		const skipDecorations = options.skipDecorations === true;

		const chunkSize = this.chunk_size;
		const chunkSizeSq = this.chunkSizeSq;
		const chunkVolume = this.chunkVolume;

		const chunkWorldX = chunkX * chunkSize;
		const chunkWorldY = chunkY * chunkSize;
		const chunkWorldZ = chunkZ * chunkSize;

		const blocks = this.createBuffer(chunkVolume);

		// ── placeBlock closure ────────────────────────────────────────────
		const placeBlock = (
			x: number,
			y: number,
			z: number,
			blockId: number,
			overwrite = false,
		) => {
			const localX = x - chunkWorldX;
			const localY = y - chunkWorldY;
			const localZ = z - chunkWorldZ;

			if (
				localX < 0 ||
				localX >= chunkSize ||
				localY < 0 ||
				localY >= chunkSize ||
				localZ < 0 ||
				localZ >= chunkSize
			)
				return;

			const idx = localX + localY * chunkSize + localZ * chunkSizeSq;
			if (blockId === 0 && blocks[idx] === WATER_BLOCK_ID) return;
			if (blocks[idx] === 0 || overwrite) blocks[idx] = blockId;
		};

		const biome = getBiome(chunkWorldX, chunkWorldZ);

		const surfaceGeneration = this.surfaceGenerator.generate(
			chunkX,
			chunkY,
			chunkZ,
			biome,
			placeBlock,
		);

		this.oreGenerator.generate(chunkX, chunkY, chunkZ, blocks);

		this.undergroundGenerator.generate(
			chunkX,
			chunkY,
			chunkZ,
			surfaceGeneration.topSurfaceYMap,
			placeBlock,
			blocks,
		);
		if (!skipDecorations) {
			this.refineBlocks(blocks, chunkX, chunkY, chunkZ);
		}

		const light = this.createBuffer(chunkVolume);

		if (chunkWorldY + chunkSize - 1 < -128) {
			return { blocks, light };
		}

		if (!deferLighting) {
			const lightSeedState = this.lightGenerator.seedInitialLight(
				chunkX,
				chunkY,
				chunkZ,
				biome,
				blocks,
				light,
				surfaceGeneration.topSunlightMask,
			);
			this.lightGenerator.propagateLight(blocks, light, lightSeedState);
			return { blocks, light };
		}

		const lightSeedState = this.lightGenerator.seedInitialLight(
			chunkX,
			chunkY,
			chunkZ,
			biome,
			blocks,
			light,
			surfaceGeneration.topSunlightMask,
		);
		return { blocks, light, lightSeedState };
	}
}
