import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "../TerrainHeightMap";
import { BlockTextures } from "../../Texture/BlockTextures";

export class DistantTerrainGenerator {
  private static readonly DEFAULT_TILE_X = 14;
  private static readonly DEFAULT_TILE_Y = 0;

  public static generate(
    centerChunkX: number,
    centerChunkZ: number,
    radius: number,
    renderDistance: number,
    gridStep: number,
    oldData?: {
      positions: Int16Array;
      normals: Int8Array;
      surfaceTiles: Uint8Array;
    },
    oldCenterChunkX?: number,
    oldCenterChunkZ?: number,
  ) {
    const chunkSize = GenerationParams.CHUNK_SIZE;
    const segments = Math.floor((radius * 2) / gridStep);
    const vertexCount = (segments + 1) * (segments + 1);

    const positions = new Int16Array(vertexCount * 3);
    const normals = new Int8Array(vertexCount * 3);
    const surfaceTiles = new Uint8Array(vertexCount * 2);

    // Snap the center to the grid step to ensure consistent sampling
    const gridCenterChunkX = Math.floor(centerChunkX / gridStep) * gridStep;
    const gridCenterChunkZ = Math.floor(centerChunkZ / gridStep) * gridStep;

    const startX = (gridCenterChunkX - radius) * chunkSize;
    const startZ = (gridCenterChunkZ - radius) * chunkSize;

    // Calculate offsets for local position to keep vertices fixed in world space
    // relative to the mesh's moving origin
    const offsetX = centerChunkX - gridCenterChunkX;
    const offsetZ = centerChunkZ - gridCenterChunkZ;

    // Calculate grid shift if old data is available
    let shiftX = 0;
    let shiftZ = 0;
    let canReuse = false;

    if (
      oldData &&
      oldCenterChunkX !== undefined &&
      oldCenterChunkZ !== undefined
    ) {
      const oldGridCenterChunkX =
        Math.floor(oldCenterChunkX / gridStep) * gridStep;
      const oldGridCenterChunkZ =
        Math.floor(oldCenterChunkZ / gridStep) * gridStep;

      const diffX = gridCenterChunkX - oldGridCenterChunkX;
      const diffZ = gridCenterChunkZ - oldGridCenterChunkZ;

      // Only reuse if the shift aligns with the grid step
      if (diffX % gridStep === 0 && diffZ % gridStep === 0) {
        shiftX = diffX / gridStep;
        shiftZ = diffZ / gridStep;
        canReuse = true;
      }
    }

    const rowSize = segments + 1;

    let vIndex = 0;
    for (let z = 0; z <= segments; z++) {
      const worldZ = startZ + z * chunkSize * gridStep;
      const oldZ = z + shiftZ;
      const localChunkZ = z * gridStep - radius - offsetZ;
      let y = 0;

      const localZ = localChunkZ * chunkSize;
      for (let x = 0; x <= segments; x++) {
        const worldX = startX + x * chunkSize * gridStep;
        const oldX = x + shiftX;
        const localChunkX = x * gridStep - radius - offsetX;
        const isInsideRealTerrain =
          localChunkX > -renderDistance &&
          localChunkX <= renderDistance &&
          localChunkZ > -renderDistance &&
          localChunkZ <= renderDistance;

        // Try to reuse data from old arrays
        if (
          canReuse &&
          oldData &&
          oldX >= 0 &&
          oldX <= segments &&
          oldZ >= 0 &&
          oldZ <= segments
        ) {
          const oldIndex = oldZ * rowSize + oldX;
          y = oldData.positions[oldIndex * 3 + 1];

          normals[vIndex * 3] = oldData.normals[oldIndex * 3];
          normals[vIndex * 3 + 1] = oldData.normals[oldIndex * 3 + 1];
          normals[vIndex * 3 + 2] = oldData.normals[oldIndex * 3 + 2];
        } else {
          y = isInsideRealTerrain
            ? -200
            : TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);

          if (isInsideRealTerrain) {
            normals[vIndex * 3] = 0;
            normals[vIndex * 3 + 1] = 127;
            normals[vIndex * 3 + 2] = 0;
          } else {
            const hRight = TerrainHeightMap.getFinalTerrainHeight(
              worldX + 1,
              worldZ,
            );
            const hDown = TerrainHeightMap.getFinalTerrainHeight(
              worldX,
              worldZ + 1,
            );
            const dy1 = hRight - y;
            const dy2 = hDown - y;
            const len = Math.sqrt(dy1 * dy1 + 1 + dy2 * dy2);
            normals[vIndex * 3] = (-dy1 / len) * 127;
            normals[vIndex * 3 + 1] = (1 / len) * 127;
            normals[vIndex * 3 + 2] = (-dy2 / len) * 127;
          }
        }

        if (isInsideRealTerrain) {
          surfaceTiles[vIndex * 2] = this.DEFAULT_TILE_X;
          surfaceTiles[vIndex * 2 + 1] = this.DEFAULT_TILE_Y;
        } else {
          const topBlockId = TerrainHeightMap.getBiome(worldX, worldZ).topBlock;
          const [tileX, tileY] = this.getTopTileForBlock(topBlockId);
          surfaceTiles[vIndex * 2] = tileX;
          surfaceTiles[vIndex * 2 + 1] = tileY;
        }

        // Local position relative to the mesh center
        const localX = localChunkX * chunkSize;

        positions[vIndex * 3] = localX;
        positions[vIndex * 3 + 1] = y;
        positions[vIndex * 3 + 2] = localZ;

        vIndex++;
      }
    }
    return { positions, normals, surfaceTiles };
  }

  private static getTopTileForBlock(blockId: number): [number, number] {
    const tex = BlockTextures[blockId];
    if (!tex) {
      return [this.DEFAULT_TILE_X, this.DEFAULT_TILE_Y];
    }
    const tile = tex.top ?? tex.all;
    if (!tile) {
      return [this.DEFAULT_TILE_X, this.DEFAULT_TILE_Y];
    }
    return [tile[0], tile[1]];
  }
}
