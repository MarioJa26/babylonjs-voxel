import Alea from "alea";
import { Chunk } from "../Chunk/Chunk";
import { World } from "../World";
import { createNoise2D, NoiseFunction2D } from "simplex-noise";
export class TerrainGenerator {
  private static simplex: NoiseFunction2D;

  // --- Terrain Generation Parameters ---
  private static readonly SEED = "my-secret-seed"; // Change this for a new world
  private static readonly TERRAIN_SCALE = 0.05; // How zoomed in the noise is. Smaller = larger features.
  private static readonly TERRAIN_HEIGHT_BASE = 16; // Base sea level
  private static readonly TERRAIN_HEIGHT_AMPLITUDE = 72; // Max height variation from base
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
   * Generates terrain data for a chunk, including a 1-block border around it
   * to ensure correct meshing with neighbors.
   * @param chunk The chunk for which to generate terrain data.
   */
  public static generateChunkData(chunk: Chunk) {
    // Loop from -1 to SIZE to include the border blocks for meshing.
    for (let x = -1; x < Chunk.SIZE; x++) {
      for (let z = -1; z < Chunk.SIZE; z++) {
        this.generateChunkColumn(chunk, x, z);
      }
    }
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
    const worldX = chunk.chunkX * Chunk.SIZE + localX; // This will be correct even for x/z = -1 or 64
    const worldZ = chunk.chunkZ * Chunk.SIZE + localZ; // This will be correct even for x/z = -1 or 64

    const terrainHeight = Math.floor(this.getOctaveNoise(worldX, worldZ));

    // Loop from y=0 up to the max terrain height for this column
    for (let worldY = 0; worldY <= terrainHeight; worldY++) {
      // Determine which chunk this block belongs to based on world coordinates
      const targetChunkX = World.worldToChunkCoord(worldX);
      const targetChunkZ = World.worldToChunkCoord(worldZ);
      const targetChunkY = World.worldToChunkCoord(worldY);
      const targetChunk = World.getChunk(
        targetChunkX,
        targetChunkY,
        targetChunkZ
      );

      // If the chunk doesn't exist (e.g., terrain is higher than pre-generated chunks), skip.
      if (!targetChunk) {
        continue;
      }

      const targetLocalX = World.worldToBlockCoord(worldX);
      const targetLocalY = World.worldToBlockCoord(worldY);
      const targetLocalZ = World.worldToBlockCoord(worldZ);

      // --- Block Placement Logic ---
      if (worldY === terrainHeight) {
        // Top layer
        if (worldY >= this.SEA_LEVEL + 3) {
          targetChunk.setBlock(targetLocalX, targetLocalY, targetLocalZ, 15); // Grass
        } else {
          targetChunk.setBlock(targetLocalX, targetLocalY, targetLocalZ, 3); // Sand
        }
      } else if (worldY > terrainHeight - 4) {
        // 3 blocks below the top layer
        targetChunk.setBlock(targetLocalX, targetLocalY, targetLocalZ, 1); // Dirt
      } else {
        // Everything else below
        targetChunk.setBlock(targetLocalX, targetLocalY, targetLocalZ, 20); // Stone
      }
    }

    // Place water above the terrain if below sea level
    for (let worldY = terrainHeight + 1; worldY <= this.SEA_LEVEL; worldY++) {
      const targetChunkX = World.worldToChunkCoord(worldX);
      const targetChunkZ = World.worldToChunkCoord(worldZ);
      const targetChunkY = World.worldToChunkCoord(worldY);
      const targetChunk = World.getChunk(
        targetChunkX,
        targetChunkY,
        targetChunkZ
      );
      if (!targetChunk) continue;
      const targetLocalX = World.worldToBlockCoord(worldX);
      const targetLocalY = World.worldToBlockCoord(worldY);
      const targetLocalZ = World.worldToBlockCoord(worldZ);
      targetChunk.setBlock(targetLocalX, targetLocalY, targetLocalZ, 30); // Water
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
