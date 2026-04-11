import { Chunk } from "../Chunk";

export interface ChunkReadinessAdapter {
  isChunkLoaded?(chunk: Chunk): boolean;
  isChunkLod0Ready?(chunk: Chunk): boolean;
}

export class ChunkReadiness {
  public constructor(private readonly adapter: ChunkReadinessAdapter = {}) {}

  public areChunksLoadedAround(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    horizontalRadius: number = 1,
    verticalRadius: number = 0,
  ): boolean {
    for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
      for (let dz = -horizontalRadius; dz <= horizontalRadius; dz++) {
        for (let dx = -horizontalRadius; dx <= horizontalRadius; dx++) {
          const chunk = Chunk.getChunk(chunkX + dx, chunkY + dy, chunkZ + dz);
          if (!chunk) return false;
          if (!this.isLoaded(chunk)) return false;
        }
      }
    }

    return true;
  }

  public areChunksLod0ReadyAround(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    horizontalRadius: number = 1,
    verticalRadius: number = 0,
  ): boolean {
    for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
      for (let dz = -horizontalRadius; dz <= horizontalRadius; dz++) {
        for (let dx = -horizontalRadius; dx <= horizontalRadius; dx++) {
          const chunk = Chunk.getChunk(chunkX + dx, chunkY + dy, chunkZ + dz);
          if (!chunk) return false;
          if (!this.isLod0Ready(chunk)) return false;
        }
      }
    }

    return true;
  }

  private isLoaded(chunk: Chunk): boolean {
    if (this.adapter.isChunkLoaded) {
      return this.adapter.isChunkLoaded(chunk);
    }

    return chunk.isLoaded;
  }

  private isLod0Ready(chunk: Chunk): boolean {
    if (this.adapter.isChunkLod0Ready) {
      return this.adapter.isChunkLod0Ready(chunk);
    }

    if (!chunk.isLoaded) return false;
    if (chunk.lodLevel !== 0) return false;

    const hasRuntimeMesh =
      chunk.mesh !== null ||
      chunk.transparentMesh !== null ||
      chunk.opaqueMeshData !== null ||
      chunk.transparentMeshData !== null;

    return hasRuntimeMesh;
  }
}
