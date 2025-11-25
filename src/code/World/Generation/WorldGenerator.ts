import Alea from "alea";
import { createNoise2D } from "simplex-noise";

interface GenerationParams {
  SEED: string;
  TERRAIN_SCALE: number;
  OCTAVES: number;
  PERSISTENCE: number;
  LACUNARITY: number;
  TERRAIN_HEIGHT_BASE: number;
  TERRAIN_HEIGHT_AMPLITUDE: number;
  SEA_LEVEL: number;
  CHUNK_SIZE: number;
}

export class WorldGenerator {
  private params: GenerationParams;
  private prng: ReturnType<typeof Alea>;
  private simplex: ReturnType<typeof createNoise2D>;
  private treePrng: ReturnType<typeof Alea>;

  constructor(params: GenerationParams) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    this.simplex = createNoise2D(this.prng);
    this.treePrng = Alea(this.params.SEED + "trees");
  }

  public generateChunkData(chunkX: number, chunkY: number, chunkZ: number) {
    const { CHUNK_SIZE } = this.params;
    const SIZE = CHUNK_SIZE;
    const SIZE2 = SIZE * SIZE;
    const SIZE3 = SIZE * SIZE2;
    const blocks = new Uint8Array(SIZE3);
    const decorations: { x: number; y: number; z: number; blockId: number }[] =
      [];

    this.generateTerrain(chunkX, chunkY, chunkZ, blocks);
    this.generateFlora(chunkX, chunkY, chunkZ, blocks, decorations);

    return { blocks, decorations };
  }

  private generateTerrain(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array
  ) {
    const { CHUNK_SIZE, SEA_LEVEL } = this.params;
    const SIZE = CHUNK_SIZE;
    const SIZE2 = SIZE * SIZE;

    for (let localX = 0; localX < SIZE; localX++) {
      for (let localZ = 0; localZ < SIZE; localZ++) {
        const worldX = chunkX * SIZE + localX;
        const worldZ = chunkZ * SIZE + localZ;

        const terrainHeight = Math.floor(this.getOctaveNoise(worldX, worldZ));

        for (let worldY = 0; worldY <= terrainHeight; worldY++) {
          const localY = worldY - chunkY * SIZE;
          if (localY < 0 || localY >= SIZE) continue;

          let blockId = 20; // stone
          if (worldY === terrainHeight) {
            blockId = worldY >= SEA_LEVEL + 3 ? 15 : 3; // grass or sand
          } else if (worldY > terrainHeight - 4) {
            blockId = 1; // dirt
          }

          blocks[localX + localY * SIZE + localZ * SIZE2] = blockId;
        }

        for (let worldY = terrainHeight + 1; worldY <= SEA_LEVEL; worldY++) {
          const localY = worldY - chunkY * SIZE;
          if (localY < 0 || localY >= SIZE) continue;
          blocks[localX + localY * SIZE + localZ * SIZE2] = 30; // water
        }
      }
    }
  }

  private generateFlora(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    blocks: Uint8Array,
    decorations: { x: number; y: number; z: number; blockId: number }[]
  ) {
    const { CHUNK_SIZE } = this.params;
    const SIZE = CHUNK_SIZE;
    const SIZE2 = SIZE * SIZE;
    const TREE_CHANCE = 0.002; // Chance for a tree to spawn at a given (worldX, worldZ)
    const TREE_RADIUS = 3; // Max horizontal extent of a tree from its stem

    for (let localX = -TREE_RADIUS; localX < SIZE + TREE_RADIUS; localX++) {
      for (let localZ = -TREE_RADIUS; localZ < SIZE + TREE_RADIUS; localZ++) {
        if (this.treePrng() > TREE_CHANCE) continue;

        const worldX = chunkX * SIZE + localX;
        const worldZ = chunkZ * SIZE + localZ;
        const terrainHeight = Math.floor(this.getOctaveNoise(worldX, worldZ));
        if (terrainHeight < 17) continue;

        // Check if the block at the tree's base is grass, by re-deriving its type
        const blockAtBase = this._getBlockTypeAtWorldCoord(
          worldX,
          terrainHeight,
          worldZ
        );
        if (blockAtBase === 15) {
          // Is grass
          this._generateTreeBlocksForChunk(
            worldX,
            terrainHeight + 1,
            worldZ, // Tree origin (stem base)
            chunkX,
            chunkY,
            chunkZ, // Current chunk being generated
            blocks,
            decorations
          );
        }
      }
    }
  }

  private _generateTreeBlocksForChunk(
    worldX: number,
    worldY: number,
    worldZ: number,
    currentChunkX: number,
    currentChunkY: number,
    currentChunkZ: number,
    blocks: Uint8Array,
    decorations: { x: number; y: number; z: number; blockId: number }[]
  ) {
    const placeBlock = (x: number, y: number, z: number, blockId: number) => {
      const { CHUNK_SIZE } = this.params;
      const SIZE = CHUNK_SIZE;
      const SIZE2 = SIZE * SIZE;
      const localX = x - currentChunkX * SIZE;
      const localY = y - currentChunkY * SIZE;
      const localZ = z - currentChunkZ * SIZE;

      if (
        localX >= 0 &&
        localX < SIZE &&
        localY >= 0 &&
        localY < SIZE &&
        localZ >= 0 &&
        localZ < SIZE
      ) {
        blocks[localX + localY * SIZE + localZ * SIZE2] = blockId;
      } else {
        decorations.push({ x, y, z, blockId });
      }
    };

    const height = 5 + Math.floor(this.treePrng() * 3);
    for (let i = 0; i < height; i++) {
      placeBlock(worldX, worldY + i, worldZ, 28); // Log
    }

    const radius = 3;
    for (let y = height - 2; y < height + 2; y++) {
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          const d = Math.sqrt(x * x + (y - height) * (y - height) * 2 + z * z);
          if (d <= radius + this.treePrng() - 0.5) {
            placeBlock(worldX + x, worldY + y, worldZ + z, 2); // Leaves
          }
        }
      }
    }
  }

  private getOctaveNoise(x: number, z: number): number {
    const {
      TERRAIN_SCALE,
      OCTAVES,
      PERSISTENCE,
      LACUNARITY,
      TERRAIN_HEIGHT_BASE,
      TERRAIN_HEIGHT_AMPLITUDE,
    } = this.params;

    let total = 0;
    let frequency = TERRAIN_SCALE;
    let amplitude = 1;
    let maxValue = 0;
    for (let i = 0; i < OCTAVES; i++) {
      total += this.simplex(x * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= PERSISTENCE;
      frequency *= LACUNARITY;
    }
    const normalizedHeight = (total / maxValue + 1) / 2;
    return TERRAIN_HEIGHT_BASE + normalizedHeight * TERRAIN_HEIGHT_AMPLITUDE;
  }

  /**
   * Deterministically gets the block type at a given world coordinate,
   * by re-evaluating the terrain generation logic for that specific point.
   */
  private _getBlockTypeAtWorldCoord(
    worldX: number,
    worldY: number,
    worldZ: number
  ): number {
    const { SEA_LEVEL } = this.params;
    const terrainHeight = Math.floor(this.getOctaveNoise(worldX, worldZ));

    if (worldY > terrainHeight) {
      // Above terrain, check for water
      return worldY <= SEA_LEVEL ? 30 : 0; // Water or Air
    } else if (worldY === terrainHeight) {
      // Top layer of terrain
      return worldY >= SEA_LEVEL + 3 ? 15 : 3; // Grass or Sand
    } else if (worldY > terrainHeight - 4) {
      // 3 blocks below the top layer
      return 1; // Dirt
    } else {
      return 20; // Stone
    }
  }
}
