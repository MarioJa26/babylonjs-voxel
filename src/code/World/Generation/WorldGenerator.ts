import Alea from "alea";
import { createNoise2D } from "simplex-noise";
import { GenerationParamsType } from "./GenerationParams";
import { Squirrel3 } from "./Squirrel13";

export class WorldGenerator {
  private params: GenerationParamsType;
  private prng: ReturnType<typeof Alea>;
  private seedAsInt: number;
  private simplex: ReturnType<typeof createNoise2D>;

  constructor(params: GenerationParamsType) {
    this.params = params;
    this.prng = Alea(this.params.SEED);
    // Convert string seed to a number for hashing
    this.seedAsInt = Squirrel3.get(0, this.prng() * 0xffffffff);
    this.simplex = createNoise2D(this.prng);
  }

  public generateChunkData(chunkX: number, chunkY: number, chunkZ: number) {
    const { CHUNK_SIZE } = this.params;
    const blocks = new Uint8Array(CHUNK_SIZE ** 3);

    this.generateTerrain(chunkX, chunkY, chunkZ, blocks);
    this.generateFlora(chunkX, chunkY, chunkZ, blocks);

    return { blocks };
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

        const terrainHeight = Math.floor(this.#getOctaveNoise(worldX, worldZ));

        for (let worldY = 0; worldY <= terrainHeight; worldY++) {
          const localY = worldY - chunkY * SIZE;
          if (localY < 0 || localY >= SIZE) continue;

          let blockId = 20; // stone
          if (worldY === terrainHeight) {
            blockId = worldY >= SEA_LEVEL + 3 ? 15 : 3; // grass or sand
          } else if (worldY > terrainHeight - 5) {
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
    blocks: Uint8Array
  ) {
    const { CHUNK_SIZE } = this.params;
    const SIZE = CHUNK_SIZE;
    const TREE_CHANCE = 0.025; // Chance for a tree to spawn at a given (worldX, worldZ)
    const TREE_RADIUS = 4; // Max horizontal extent of a tree from its stem

    for (let localX = -TREE_RADIUS; localX < SIZE + TREE_RADIUS; localX++) {
      for (let localZ = -TREE_RADIUS; localZ < SIZE + TREE_RADIUS; localZ++) {
        const worldX = chunkX * SIZE + localX;
        const worldZ = chunkZ * SIZE + localZ;

        // Use hashing for fast, deterministic randomness.
        // Combine worldX and worldZ into a unique position integer.
        const position = worldX * 374761393 + worldZ * 668265263;
        const hash = Squirrel3.get(position, this.seedAsInt);

        // Check if a tree should spawn
        const treeChanceRoll = (hash & 0x7fffffff) / 0x7fffffff; // Get a float [0, 1)
        if (treeChanceRoll > TREE_CHANCE) continue;

        const terrainHeight = Math.floor(this.#getOctaveNoise(worldX, worldZ));

        // Check if the block at the tree's base is grass, by re-deriving its type
        const blockAtBase = this.#getBlockTypeAtWorldCoord(
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
            hash // Pass the generated hash to determine tree properties
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
    hash: number
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
        const idx = localX + localY * SIZE + localZ * SIZE2;
        const existing = blocks[idx];
        // Only place leaves in air blocks to avoid overwriting the trunk or other features.
        // The trunk (logs) can overwrite anything.
        if (blockId === 28 || existing === 0) {
          blocks[idx] = blockId;
        }
      }
    };

    // Use the hash to determine tree height.
    // We can "re-hash" the hash to get a new pseudo-random number.
    const heightHash = Squirrel3.get(hash, this.seedAsInt);
    const height = 5 + (Math.abs(heightHash) % 3); // Get a height of 5, 6, or 7

    // Place trunk
    for (let i = 0; i < height; i++) {
      placeBlock(worldX, worldY + i, worldZ, 28); // Log
    }

    // A more authentic Minecraft oak tree canopy
    const leafYStart = worldY + height - 3;

    // Main canopy layers (two 5x5 layers with corners removed)
    let radius = 2;
    for (let y = leafYStart; y < leafYStart + 4; y++) {
      if (y < leafYStart + 2) radius = 2;
      else radius = 1;
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          placeBlock(worldX + x, y, worldZ + z, 2); // Leaves
        }
      }
    }
  }

  #getOctaveNoise(x: number, z: number): number {
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
  #getBlockTypeAtWorldCoord(
    worldX: number,
    worldY: number,
    worldZ: number
  ): number {
    const { SEA_LEVEL } = this.params;
    const terrainHeight = Math.floor(this.#getOctaveNoise(worldX, worldZ));

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
