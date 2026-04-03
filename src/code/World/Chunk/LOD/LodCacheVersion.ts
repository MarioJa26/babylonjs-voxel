import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";

// Bump this whenever LOD mesh format/simplification/shading semantics change.
const LOD_CACHE_SCHEMA_VERSION = "lod-cache-v1";

export function getCurrentLodCacheVersion(): string {
  return [
    LOD_CACHE_SCHEMA_VERSION,
    `seed:${GenerationParams.SEED}`,
    `chunk:${GenerationParams.CHUNK_SIZE}`,
    "mesher:lod2x2-waterlight",
    "shader:lod-fog-v1",
  ].join("|");
}
