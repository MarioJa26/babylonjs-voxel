import { Biome } from "../Biome/Biomes";

export interface IWorldFeature {
  generate(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    _chunkBiome: Biome,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void,
    seed: number,
    chunkSize: number,
    getTerrainHeight: (x: number, z: number, biome: Biome) => number
  ): void;
}
