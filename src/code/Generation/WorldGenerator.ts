import { BlockType } from "@/code/World/Texture/BlockType";
import { isLiquidBlockId } from "../World/Liquid/LiquidRegistry";
import { LightGenerator, type LightSeedState } from "./LightGenerator";
import {
	createFastNoise,
	createFastNoise2D,
	createFastNoise3D,
	createFastNoise3DWithInstance,
} from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { GenerationParams } from "./NoiseAndParameters/GenerationParams";
import { getPRNGBySeed } from "./NoiseAndParameters/Squirrel13";
import { OreGenerator } from "./OreGenerator";
import { SurfaceGenerator } from "./SurfaceGenerator";
import { getBiome } from "./TerrainHeightMap";
import { UndergroundBiomeSelector } from "./UndergroundBiomes";
import { UndergroundGenerator } from "./UndergroundGenerator";
import { computeSeedAsInt } from "./WorldSeed";

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
for (const id of [
	16,
	21,
	79,
	80,
	96,
	97,
	98,
	99,
	101,
	102,
	103,
	BlockType.TinOre,
]) {
	IS_ORE[id] = 1;
}

// Module scratch for the per-column underground band-noise rows (one sample
// per localZ). Generation runs synchronously per worker thread, so sharing
// one buffer across calls is safe.
const _undergroundRowNoiseScratch = new Float32Array(
	GenerationParams.CHUNK_SIZE,
);

// ---------------------------------------------------------------------------
// Smoothing constants — mirror the same values as UndergroundGenerator.
// ---------------------------------------------------------------------------

export class WorldGenerator {
	private static readonly DEFAULT_UNDERGROUND_STONE = 29;
	private static readonly LIGHTING_MIN_WORLD_Y = -128;

	private static readonly HAS_SHARED_ARRAY_BUFFER =
		typeof SharedArrayBuffer !== "undefined";

	private readonly params: GenerationParamsType;
	private readonly seedAsInt: number;

	private readonly chunk_size: number;
	private readonly chunkSizeSq: number;
	private readonly chunkVolume: number;

	private readonly surfaceGenerator: SurfaceGenerator;
	private readonly undergroundGenerator: UndergroundGenerator;
	private readonly oreGenerator: OreGenerator;
	private readonly undergroundBiomeSelector: UndergroundBiomeSelector;
	private readonly lightGenerator: LightGenerator;

	private readonly cheeseNoise: (x: number, y: number, z: number) => number;

	private readonly tunnelNoise: (x: number, y: number, z: number) => number;

	private readonly detailNoise: (x: number, y: number, z: number) => number;

	/*
	 * Synchronous generation context used by the stable writer callbacks
	 * below. This avoids allocating four closures for every generated chunk.
	 *
	 * SurfaceGenerator and UndergroundGenerator consume these callbacks
	 * synchronously, so the context remains valid for the entire call.
	 */
	private activeBlocks: Uint8Array | null = null;
	private activeChunkWorldX = 0;
	private activeChunkWorldY = 0;
	private activeChunkWorldZ = 0;

	/*
	 * Stable callback identities. These are allocated once per WorldGenerator
	 * instead of once per generated chunk.
	 */
	private readonly placeBlockCallback = (
		x: number,
		y: number,
		z: number,
		blockId: number,
		overwrite = false,
	): void => {
		const localX = x - this.activeChunkWorldX;
		const localY = y - this.activeChunkWorldY;
		const localZ = z - this.activeChunkWorldZ;

		const chunkSize = this.chunk_size;

		/*
		 * Explicit comparisons preserve correct behavior for coordinates
		 * outside the signed 32-bit range. Avoid bitwise coordinate checks
		 * because large worlds may exceed that range.
		 */
		if (
			localX < 0 ||
			localX >= chunkSize ||
			localY < 0 ||
			localY >= chunkSize ||
			localZ < 0 ||
			localZ >= chunkSize
		) {
			return;
		}

		const blocks = this.activeBlocks!;

		const index = localX + localY * chunkSize + localZ * this.chunkSizeSq;

		const existing = blocks[index];

		if (blockId === 0) {
			if (!isLiquidBlockId(existing) && (existing === 0 || overwrite)) {
				blocks[index] = 0;
			}
			return;
		}

		if (existing === 0 || overwrite) {
			blocks[index] = blockId;
		}
	};

	private readonly placeBlockLocalCallback = (
		localX: number,
		localY: number,
		localZ: number,
		blockId: number,
		overwrite = false,
	): void => {
		const blocks = this.activeBlocks!;

		const index = localX + localY * this.chunk_size + localZ * this.chunkSizeSq;

		const existing = blocks[index];

		if (blockId === 0) {
			if (!isLiquidBlockId(existing) && (existing === 0 || overwrite)) {
				blocks[index] = 0;
			}
			return;
		}

		if (existing === 0 || overwrite) {
			blocks[index] = blockId;
		}
	};

	private readonly columnBaseLocalCallback = (
		localX: number,
		localZ: number,
	): number => localX + localZ * this.chunkSizeSq;

	private readonly placeColumnLocalCallback = (
		columnBase: number,
		localY: number,
		blockId: number,
		overwrite = false,
	): void => {
		const blocks = this.activeBlocks!;
		const index = columnBase + localY * this.chunk_size;
		const existing = blocks[index];

		if (blockId === 0) {
			if (!isLiquidBlockId(existing) && (existing === 0 || overwrite)) {
				blocks[index] = 0;
			}
			return;
		}

		if (existing === 0 || overwrite) {
			blocks[index] = blockId;
		}
	};

	public constructor(params: GenerationParamsType) {
		this.params = params;
		this.seedAsInt = computeSeedAsInt(params.SEED);

		const chunkSize = params.CHUNK_SIZE;

		this.chunk_size = chunkSize;
		this.chunkSizeSq = chunkSize * chunkSize;
		this.chunkVolume = chunkSize * chunkSize * chunkSize;

		const treeNoise = createFastNoise2D({
			seed: getPRNGBySeed(52253100808, this.seedAsInt),
			frequency: 1,
		});

		const cheeseInstance = createFastNoise({
			seed: getPRNGBySeed(4912491002, this.seedAsInt),
			frequency: params.CAVE_CHEESE_FREQ,
		});
		cheeseInstance.SetFractalOctaves(2);

		const tunnelInstance = createFastNoise({
			seed: getPRNGBySeed(251251516119, this.seedAsInt),
			frequency: params.CAVE_TUNNEL_FREQ,
		});
		tunnelInstance.SetFractalOctaves(2);

		const detailInstance = createFastNoise({
			seed: getPRNGBySeed(242319705330, this.seedAsInt),
			frequency: params.CAVE_DETAIL_FREQ,
		});
		detailInstance.SetFractalOctaves(2);

		/*
		 * These wrappers are created once. SurfaceGenerator and
		 * UndergroundGenerator also receive the underlying instances for
		 * their batched/grid paths.
		 */
		this.cheeseNoise = cheeseInstance.GetNoise3D.bind(cheeseInstance);
		this.tunnelNoise = tunnelInstance.GetNoise3D.bind(tunnelInstance);
		this.detailNoise = detailInstance.GetNoise3D.bind(detailInstance);

		const { fn: densityNoise, instance: densityInstance } =
			createFastNoise3DWithInstance({
				seed: getPRNGBySeed(100002313119477, this.seedAsInt),
				frequency: 0.33333,
			});

		this.surfaceGenerator = new SurfaceGenerator(
			params,
			treeNoise,
			densityNoise,
			densityInstance,
			this.seedAsInt,
			this.cheeseNoise,
			this.tunnelNoise,
			this.detailNoise,
			cheeseInstance,
			tunnelInstance,
			detailInstance,
		);

		this.undergroundGenerator = new UndergroundGenerator(
			params,
			this.cheeseNoise,
			this.tunnelNoise,
			this.detailNoise,
			cheeseInstance,
			tunnelInstance,
			detailInstance,
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
		if (WorldGenerator.HAS_SHARED_ARRAY_BUFFER) {
			return new Uint8Array(new SharedArrayBuffer(size));
		}

		return new Uint8Array(size);
	}

	private setActiveGenerationContext(
		blocks: Uint8Array,
		chunkWorldX: number,
		chunkWorldY: number,
		chunkWorldZ: number,
	): void {
		this.activeBlocks = blocks;
		this.activeChunkWorldX = chunkWorldX;
		this.activeChunkWorldY = chunkWorldY;
		this.activeChunkWorldZ = chunkWorldZ;
	}

	private clearActiveGenerationContext(): void {
		this.activeBlocks = null;
	}

	private applyUndergroundBiomes(
		blocks: Uint8Array,
		chunkWorldX: number,
		chunkWorldY: number,
		chunkWorldZ: number,
		chunkSize: number,
		chunkSizeSq: number,
	): void {
		/*
		 * Only world Y below zero is processed. A chunk starting at or above
		 * Y=16 cannot contain affected underground blocks.
		 */
		if (chunkWorldY >= 16) {
			return;
		}

		const maxLocalYExclusive =
			chunkWorldY < 0 ? Math.min(chunkSize, -chunkWorldY) : 0;

		if (maxLocalYExclusive <= 0) {
			return;
		}

		const selector = this.undergroundBiomeSelector;
		const defaultStoneBlock = WorldGenerator.DEFAULT_UNDERGROUND_STONE;

		/*
		 * Conservative 3x3 sample before running the full replacement pass.
		 */
		const lastLocal = chunkSize - 1;
		const midLocal = chunkSize >> 1;

		const sampleWorldY = Math.min(chunkWorldY + (maxLocalYExclusive >> 1), -1);

		const x0 = chunkWorldX;
		const x1 = chunkWorldX + midLocal;
		const x2 = chunkWorldX + lastLocal;

		const z0 = chunkWorldZ;
		const z1 = chunkWorldZ + midLocal;
		const z2 = chunkWorldZ + lastLocal;

		if (
			selector.getBiome(x0, sampleWorldY, z0).stoneBlock ===
				defaultStoneBlock &&
			selector.getBiome(x1, sampleWorldY, z0).stoneBlock ===
				defaultStoneBlock &&
			selector.getBiome(x2, sampleWorldY, z0).stoneBlock ===
				defaultStoneBlock &&
			selector.getBiome(x0, sampleWorldY, z1).stoneBlock ===
				defaultStoneBlock &&
			selector.getBiome(x1, sampleWorldY, z1).stoneBlock ===
				defaultStoneBlock &&
			selector.getBiome(x2, sampleWorldY, z1).stoneBlock ===
				defaultStoneBlock &&
			selector.getBiome(x0, sampleWorldY, z2).stoneBlock ===
				defaultStoneBlock &&
			selector.getBiome(x1, sampleWorldY, z2).stoneBlock ===
				defaultStoneBlock &&
			selector.getBiome(x2, sampleWorldY, z2).stoneBlock === defaultStoneBlock
		) {
			return;
		}

		/*
		 * Biome-band noise is independent of Y. Compute one value per Z row
		 * instead of crossing the noise backend for every Y/Z combination.
		 */
		const rowNoise = _undergroundRowNoiseScratch;

		for (let localZ = 0; localZ < chunkSize; localZ++) {
			rowNoise[localZ] = selector.sampleBiomeNoise(
				chunkWorldX,
				chunkWorldZ + localZ,
			);
		}

		let yOffset = 0;

		for (
			let localY = 0;
			localY < maxLocalYExclusive;
			localY++, yOffset += chunkSize
		) {
			const worldY = chunkWorldY + localY;
			let zOffset = yOffset;

			for (
				let localZ = 0;
				localZ < chunkSize;
				localZ++, zOffset += chunkSizeSq
			) {
				const biome = selector.getBiomeWithNoise(
					chunkWorldX,
					worldY,
					chunkWorldZ + localZ,
					rowNoise[localZ],
				);

				const replacementStone = biome.stoneBlock;
				const rowEnd = zOffset + chunkSize;

				if (replacementStone === defaultStoneBlock) {
					/*
					 * Default-stone biomes still require replacement for
					 * non-default replaceable blocks, but the overwhelmingly
					 * common default stone can be skipped immediately.
					 */
					for (let index = zOffset; index < rowEnd; index++) {
						const blockId = blocks[index];

						if (
							blockId === 0 ||
							blockId === defaultStoneBlock ||
							blockId >= IS_ORE.length ||
							IS_ORE[blockId] !== 0
						) {
							continue;
						}

						blocks[index] = selector.getStoneReplacement(blockId, biome);
					}

					continue;
				}

				for (let index = zOffset; index < rowEnd; index++) {
					const blockId = blocks[index];

					if (
						blockId === 0 ||
						blockId >= IS_ORE.length ||
						IS_ORE[blockId] !== 0
					) {
						continue;
					}

					blocks[index] =
						blockId === defaultStoneBlock
							? replacementStone
							: selector.getStoneReplacement(blockId, biome);
				}
			}
		}
	}

	public refineBlocks(
		blocks: Uint8Array,
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): void {
		const chunkSize = this.chunk_size;

		this.applyUndergroundBiomes(
			blocks,
			chunkX * chunkSize,
			chunkY * chunkSize,
			chunkZ * chunkSize,
			chunkSize,
			this.chunkSizeSq,
		);
	}

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
		const chunkTopWorldY = chunkWorldY + chunkSize - 1;

		const blocks = this.createBuffer(chunkVolume);

		this.setActiveGenerationContext(
			blocks,
			chunkWorldX,
			chunkWorldY,
			chunkWorldZ,
		);

		let surfaceGeneration: ReturnType<SurfaceGenerator["generate"]>;
		let hadStructureSeal: boolean;

		try {
			const biome = getBiome(chunkWorldX, chunkWorldZ);

			surfaceGeneration = this.surfaceGenerator.generate(
				chunkX,
				chunkY,
				chunkZ,
				biome,
				this.placeBlockCallback,
				this.columnBaseLocalCallback,
				this.placeColumnLocalCallback,
			);

			this.oreGenerator.generate(chunkX, chunkY, chunkZ, blocks, biome);

			hadStructureSeal = this.undergroundGenerator.generate(
				chunkX,
				chunkY,
				chunkZ,
				surfaceGeneration.topSurfaceYMap,
				this.placeBlockLocalCallback,
				blocks,
				this.seedAsInt,
			);

			if (!skipDecorations) {
				/*
				 * Call the implementation directly because all world-space
				 * coordinates and dimensions are already available here.
				 */
				this.applyUndergroundBiomes(
					blocks,
					chunkWorldX,
					chunkWorldY,
					chunkWorldZ,
					chunkSize,
					chunkSizeSq,
				);
			}

			const emissionMinWorldY = hadStructureSeal
				? LightGenerator.SEALED_EMISSION_MIN_WORLD_Y
				: LightGenerator.EMISSION_MIN_WORLD_Y;

			const light = this.createBuffer(chunkVolume);

			/*
			 * Deep chunks remain unlit. The newly allocated light array is
			 * already zero-filled.
			 */
			if (chunkTopWorldY < WorldGenerator.LIGHTING_MIN_WORLD_Y) {
				return { blocks, light };
			}

			if (!deferLighting) {
				this.lightGenerator.seedAndPropagateLightImmediate(
					chunkX,
					chunkY,
					chunkZ,
					blocks,
					light,
					surfaceGeneration.topSunlightMask,
					emissionMinWorldY,
				);

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
				emissionMinWorldY,
			);

			return {
				blocks,
				light,
				lightSeedState,
			};
		} finally {
			/*
			 * Prevent the generator from retaining the latest chunk's SAB
			 * after generation. This also leaves the instance in a clean state
			 * if a downstream generator throws.
			 */
			this.clearActiveGenerationContext();
		}
	}

	public relightChunk(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		topSunlightMask?: Uint8Array,
		neighborLight?: ReadonlyArray<Uint8Array | null>,
	): Uint8Array {
		const light = this.createBuffer(this.chunkVolume);

		const chunkWorldY = chunkY * this.chunk_size;
		const chunkTopWorldY = chunkWorldY + this.chunk_size - 1;

		if (chunkTopWorldY < WorldGenerator.LIGHTING_MIN_WORLD_Y) {
			return light;
		}

		if (neighborLight !== undefined) {
			this.lightGenerator.seedAndPropagateLightWithNeighbors(
				chunkX,
				chunkY,
				chunkZ,
				blocks,
				light,
				topSunlightMask,
				neighborLight,
			);

			return light;
		}

		this.lightGenerator.seedAndPropagateLightImmediate(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
		);

		return light;
	}
}
