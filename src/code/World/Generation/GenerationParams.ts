export const GenerationParams = {
  SEED: "my-secret-seed",
  CHUNK_SIZE: 16,
  TERRAIN_SCALE: 0.00187,
  OCTAVES: 7,
  PERSISTENCE: 0.33,
  LACUNARITY: 3.141592653589793,
  TERRAIN_HEIGHT_BASE: 0,
  TERRAIN_HEIGHT_AMPLITUDE: 314.1592653589793,
  SEA_LEVEL: 40,
};

export type GenerationParamsType = typeof GenerationParams;
