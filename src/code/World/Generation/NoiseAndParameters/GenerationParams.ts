export const GenerationParams = {
  SEED: "my-secret-seed",
  CHUNK_SIZE: 16,
  TERRAIN_SCALE: 0.001,
  OCTAVES: 6,
  PERSISTENCE: 0.31,
  LACUNARITY: 3,
  TERRAIN_HEIGHT_BASE: 20,
  TERRAIN_HEIGHT_AMPLITUDE: 333,
  SEA_LEVEL: 42,
  RIVER_SCALE: 1 / 333,
  BIOME_NOISE_SCALE: 1 / 3333,
};

export type GenerationParamsType = typeof GenerationParams;
