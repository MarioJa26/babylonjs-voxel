export const GenerationParams = {
  SEED: "my-secret-seed",
  CHUNK_SIZE: 16,
  TERRAIN_SCALE: 0.002,
  OCTAVES: 5,
  PERSISTENCE: 0.3,
  LACUNARITY: 3.187,
  TERRAIN_HEIGHT_BASE: 0,
  TERRAIN_HEIGHT_AMPLITUDE: 300,
  SEA_LEVEL: 42,
  RIVER_SCALE: 1 / 3333,
  BIOME_NOISE_SCALE: 1 / 3333,
};

export type GenerationParamsType = typeof GenerationParams;
