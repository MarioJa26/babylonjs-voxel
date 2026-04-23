import Alea from "alea";
import { LightGenerator, type LightSeedState } from "./LightGenerator";
import {
	createFastNoise2D,
	createFastNoise3D,
} from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import { SurfaceGenerator } from "./SurfaceGenerator";
import { TerrainHeightMap } from "./TerrainHeightMap";
import { UndergroundGenerator } from "./UndergroundGenerator";

type GenerateChunkOptions = {
	deferLighting?: boolean;
};

type GenerateChunkResult = {
	blocks: Uint8Array;
	light: Uint8Array;
	lightSeedState?: LightSeedState;
};

export class WorldGenerator {
	private static readonly FLOOR_Y = 1;
	private static readonly FLOOR_BLOCK_ID = 1;

	private params: GenerationParamsType;
	private prng: ReturnType<typeof Alea>;

	private seedAsInt: number;
	private chunkSizeSq: number;
	private chunk_size: number;
	private chunkVolume: number;

	private surfaceGenerator: SurfaceGenerator;
	private undergroundGenerator: UndergroundGenerator;
	private lightGenerator: LightGenerator;

	constructor(params: GenerationParamsType) {
		this.params = params;
		this.prng = Alea(this.params.SEED);
		this.seedAsInt = Squirrel3.get(0, (this.prng() * 0xffffffff) | 0);

		this.chunk_size = this.params.CHUNK_SIZE;
		this.chunkSizeSq = this.chunk_size * this.chunk_size;
		this.chunkVolume = this.chunk_size * this.chunkSizeSq;

		const treeNoise = createFastNoise2D({
			seed: Squirrel3.get(21, this.seedAsInt),
			frequency: 1,
		});

		const caveNoise = createFastNoise3D({
			seed: Squirrel3.get(2, this.seedAsInt),
			frequency: 0.02,
		});

		// Density noise frequency is baked in here so FastNoise handles scaling internally.
		const densityNoise = createFastNoise3D({
			seed: Squirrel3.get(23, this.seedAsInt),
			frequency: 0.3333,
		});

		this.surfaceGenerator = new SurfaceGenerator(
			params,
			treeNoise,
			densityNoise,
			this.seedAsInt,
		);
		this.undergroundGenerator = new UndergroundGenerator(params, caveNoise);
		this.lightGenerator = new LightGenerator(params);
	}

	private createBuffer(size: number): Uint8Array {
		// Worker-generated chunk payloads must be transferable back to the main thread.
		// SharedArrayBuffer cannot be put into the worker postMessage transfer list.
		// The main thread already upgrades incoming arrays to SharedArrayBuffer if needed.
		return new Uint8Array(new ArrayBuffer(size));
	}

	private enforceGlobalFloor(
		chunkWorldY: number,
		blocks: Uint8Array,
		chunkSize: number,
		chunkSizeSq: number,
	): void {
		const localY = WorldGenerator.FLOOR_Y - chunkWorldY;
		if (localY < 0) {
			return;
		}

		const yOffset = localY * chunkSize;
		for (let localZ = 0; localZ < chunkSize; localZ++) {
			const zOffset = localZ * chunkSizeSq;
			for (let localX = 0; localX < chunkSize; localX++) {
				const idx = localX + yOffset + zOffset;
				blocks[idx] = WorldGenerator.FLOOR_BLOCK_ID;
			}
		}
	}

	/**
	 * Backward compatible:
	 * - generateChunkData(x, y, z) => full terrain + full lighting
	 * - generateChunkData(x, y, z, { deferLighting: true }) => terrain now, light later
	 */
	public generateChunkData(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		options: GenerateChunkOptions = {},
	): GenerateChunkResult {
		const deferLighting = options.deferLighting === true;

		const chunkSize = this.chunk_size;
		const chunkSizeSq = this.chunkSizeSq;
		const chunkVolume = this.chunkVolume;

		const chunkWorldX = chunkX * chunkSize;
		const chunkWorldY = chunkY * chunkSize;
		const chunkWorldZ = chunkZ * chunkSize;

		const blocks = this.createBuffer(chunkVolume);

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
			) {
				return;
			}

			const idx = localX + localY * chunkSize + localZ * chunkSizeSq;

			// Don't let air replace water
			if (blockId === 0 && blocks[idx] === 30) {
				return;
			}

			if (blocks[idx] === 0 || overwrite) {
				blocks[idx] = blockId;
			}
		};

		const biome = this.#getBiome(chunkWorldX, chunkWorldZ);

		const surfaceGeneration = this.surfaceGenerator.generate(
			chunkX,
			chunkY,
			chunkZ,
			biome,
			placeBlock,
		);

		if (chunkY < 0) {
			this.undergroundGenerator.generate(chunkX, chunkY, chunkZ, placeBlock);
		} else if (chunkY === 0)
			this.enforceGlobalFloor(chunkWorldY, blocks, chunkSize, chunkSizeSq);

		const light = this.createBuffer(chunkVolume);

		if (!deferLighting) {
			this.lightGenerator.generate(
				chunkX,
				chunkY,
				chunkZ,
				biome,
				blocks,
				light,
				surfaceGeneration.topSunlightMask,
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
		);

		return {
			blocks,
			light,
			lightSeedState,
		};
	}

	#getBiome(x: number, z: number) {
		return TerrainHeightMap.getBiome(x, z);
	}
}
