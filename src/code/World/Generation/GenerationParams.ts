export const GenerationParams = {
  SEED: "my-secret-seed",
  TERRAIN_SCALE: 0.001,
  OCTAVES: 7,
  PERSISTENCE: 0.33,
  LACUNARITY: 3.141592653589793,
  TERRAIN_HEIGHT_BASE: 16,
  TERRAIN_HEIGHT_AMPLITUDE: 72,
  SEA_LEVEL: 40,
};

export type GenerationParamsType = typeof GenerationParams & {
  CHUNK_SIZE: number;
};
