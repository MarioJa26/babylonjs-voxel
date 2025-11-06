import Alea from "alea";
import { Chunk } from "../Chunk/Chunk";
import { World } from "../World";
import { createNoise2D, NoiseFunction2D } from "simplex-noise";
export class TerrainGenerator {
  private static simplex: NoiseFunction2D;

  // --- Terrain Generation Parameters ---
  private static readonly SEED = "my-secret-seed"; // Change this for a new world
  private static readonly TERRAIN_SCALE = 0.005; // How zoomed in the noise is. Smaller = larger features.
  private static readonly TERRAIN_HEIGHT_BASE = 16; // Base sea level
  private static readonly TERRAIN_HEIGHT_AMPLITUDE = 70; // Max height variation from base
  private static readonly SEA_LEVEL = 40;

  // --- Noise Octaves (for detail) ---
  // Each octave adds a layer of noise at a different frequency and amplitude.
  private static readonly OCTAVES = 8; // Number of noise layers
  private static readonly PERSISTENCE = 0.5; // How much each octave contributes (amplitude)
  private static readonly LACUNARITY = 2.0; // How much detail each octave adds (frequency)

  /**
   * Initializes the terrain generator with a seed.
   */
  public static initialize() {
    const prng = Alea(this.SEED);
    this.simplex = createNoise2D(prng);
  }

  /**
   * Generates the block data for a single vertical column in a chunk.
   * @param chunk The chunk to generate the column in.
   * @param localX The local X coordinate within the chunk (0-63).
   * @param localZ The local Z coordinate within the chunk (0-63).
   */
  public static generateChunkColumn(
    chunk: Chunk,
    localX: number,
    localZ: number
  ) {
    const worldX = chunk.chunkX * Chunk.SIZE + localX;
    const worldZ = chunk.chunkZ * Chunk.SIZE + localZ;

    const terrainHeight = Math.floor(this.getOctaveNoise(worldX, worldZ));

    // Loop from y=0 up to the max terrain height for this column
    for (let worldY = 0; worldY <= terrainHeight; worldY++) {
      const chunkY = World.worldToChunkCoord(worldY);
      const targetChunk = World.getChunk(chunk.chunkX, chunkY, chunk.chunkZ);

      // If the chunk doesn't exist (e.g., terrain is higher than pre-generated chunks), skip.
      if (!targetChunk) {
        continue;
      }

      const localY = World.worldToBlockCoord(worldY);

      // --- Block Placement Logic ---
      if (worldY === terrainHeight) {
        // Top layer
        if (worldY >= this.SEA_LEVEL + 3) {
          targetChunk.setBlock(localX, localY, localZ, 15); // Grass
        } else {
          targetChunk.setBlock(localX, localY, localZ, 3); // Sand
        }
      } else if (worldY > terrainHeight - 4) {
        // 3 blocks below the top layer
        targetChunk.setBlock(localX, localY, localZ, 1); // Dirt
      } else {
        // Everything else below
        targetChunk.setBlock(localX, localY, localZ, 5); // Stone
      }
    }

    // Place water above the terrain if below sea level
    for (let worldY = terrainHeight + 1; worldY <= this.SEA_LEVEL; worldY++) {
      const chunkY = World.worldToChunkCoord(worldY);
      const targetChunk = World.getChunk(chunk.chunkX, chunkY, chunk.chunkZ);
      if (!targetChunk) continue;
      const localY = World.worldToBlockCoord(worldY);
      targetChunk.setBlock(localX, localY, localZ, 0); // Water
    }
  }

  /**
   * Calculates multi-layered simplex noise for more natural terrain.
   */
  private static getOctaveNoise(x: number, z: number): number {
    let total = 0;
    let frequency = this.TERRAIN_SCALE;
    let amplitude = 1;
    let maxValue = 0; // Used for normalizing the result to 0-1

    for (let i = 0; i < this.OCTAVES; i++) {
      total += this.simplex(x * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= this.PERSISTENCE;
      frequency *= this.LACUNARITY;
    }

    // Normalize the noise to be between 0 and 1, then scale to our desired height range
    const normalizedHeight = (total / maxValue + 1) / 2; // Map from [-1, 1] to [0, 1]
    return (
      this.TERRAIN_HEIGHT_BASE +
      normalizedHeight * this.TERRAIN_HEIGHT_AMPLITUDE
    );
  }
}
