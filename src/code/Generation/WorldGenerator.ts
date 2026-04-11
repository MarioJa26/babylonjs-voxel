import Alea from "alea";
import { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { Squirrel3 } from "./NoiseAndParameters/Squirrel13";
import {
  createFastNoise2D,
  createFastNoise3D,
} from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import { TerrainHeightMap } from "./TerrainHeightMap";
import { SurfaceGenerator } from "./SurfaceGenerator";
import { UndergroundGenerator } from "./UndergroundGenerator";
import { LightGenerator } from "./LightGenerator";

export class WorldGenerator {
  private params: GenerationParamsType;
  private prng: ReturnType<typeof Alea>;

  private seedAsInt: number;
  private chunkSizeSq: number;
  private chunk_size: number;

  private surfaceGenerator: SurfaceGenerator;
  private undergroundGenerator: UndergroundGenerator;
  private lightGenerator: LightGenerator;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    this.seedAsInt = Squirrel3.get(0, (this.prng() * 0xffffffff) | 0);
    this.chunk_size = this.params.CHUNK_SIZE;
    this.chunkSizeSq = this.chunk_size ** 2;

    const treeNoise = createFastNoise2D({
      seed: Squirrel3.get(21, (this.prng() * 0xffffffff) | 0),
      frequency: 1,
    });
    const caveNoise = createFastNoise3D({
      seed: Squirrel3.get(2, (this.prng() * 0xffffffff) | 0),
      frequency: 0.02,
    });

    // OPTIMIZATION: density noise frequency is baked in here at 1.0 so the noise
    // function itself handles frequency scaling internally (FastNoise is optimized for this).
    // SurfaceGenerator already multiplies coordinates by the appropriate scales before calling.
    const densityNoise = createFastNoise3D({
      seed: Squirrel3.get(999, (this.prng() * 0xffffffff) | 0),
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
    if (typeof SharedArrayBuffer !== "undefined") {
      return new Uint8Array(new SharedArrayBuffer(size));
    }
    console.warn("buffer not created!");
    return new Uint8Array(size);
  }

  public generateChunkData(chunkX: number, chunkY: number, chunkZ: number) {
    const blocks = this.createBuffer(this.chunk_size ** 3);
    const light = this.createBuffer(this.chunk_size ** 3);

    const placeBlock = (
      x: number,
      y: number,
      z: number,
      blockId: number,
      overwrite = false,
    ) => {
      const localX = x - chunkX * this.chunk_size;
      const localY = y - chunkY * this.chunk_size;
      const localZ = z - chunkZ * this.chunk_size;

      if (
        localX >= 0 &&
        localX < this.chunk_size &&
        localY >= 0 &&
        localY < this.chunk_size &&
        localZ >= 0 &&
        localZ < this.chunk_size
      ) {
        const idx =
          localX + localY * this.chunk_size + localZ * this.chunkSizeSq;

        // Don't let air replace water
        if (blockId === 0 && blocks[idx] === 30) {
          return;
        }

        if (blocks[idx] === 0 || overwrite) {
          blocks[idx] = blockId;
        }
      }
    };

    const biome = this.#getBiome(
      chunkX * this.chunk_size,
      chunkZ * this.chunk_size,
    );

    const surfaceGeneration = this.surfaceGenerator.generate(
      chunkX,
      chunkY,
      chunkZ,
      biome,
      placeBlock,
    );

    if (chunkY < 0) {
      this.undergroundGenerator.generate(chunkX, chunkY, chunkZ, placeBlock);
    }

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

  #getBiome(x: number, z: number) {
    return TerrainHeightMap.getBiome(x, z);
  }
}
