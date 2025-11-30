export const GenerationParams = {
  SEED: "my-secret-seed",
  CHUNK_SIZE: 32,
  TERRAIN_SCALE: 0.0021,
  OCTAVES: 5,
  PERSISTENCE: 0.31,
  LACUNARITY: 3.141592653589793,
  TERRAIN_HEIGHT_BASE: 0,
  TERRAIN_HEIGHT_AMPLITUDE: 300,
  SEA_LEVEL: 42,
  RIVER_SCALE: 1 / 3333,
  BIOME_NOISE_SCALE: 1 / 3333,
};

export type GenerationParamsType = typeof GenerationParams;
