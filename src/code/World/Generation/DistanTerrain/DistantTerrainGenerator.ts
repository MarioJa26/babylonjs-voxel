import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "../TerrainHeightMap";
import { BlockTextures } from "../../Texture/BlockTextures";

export class DistantTerrainGenerator {
  private static readonly DEFAULT_TILE_X = 14;
  private static readonly DEFAULT_TILE_Y = 0;

  // Matches your current "hole over real terrain"
  private static readonly INSIDE_CLIP_Y = -200;

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
    // --- Derived sizes ---
    const chunkSize = GenerationParams.CHUNK_SIZE;
    const stepSize = chunkSize * gridStep; // world-space spacing between samples
    const segments = Math.floor((radius * 2) / gridStep);
    const rowSize = segments + 1;
    const vertexCount = rowSize * rowSize;

    // Output buffers (types preserved)
    const positions = new Int16Array(vertexCount * 3);
    const normals = new Int8Array(vertexCount * 3);
    const surfaceTiles = new Uint8Array(vertexCount * 2);

    // --- Grid snapping ---
    const gridCenterChunkX = Math.floor(centerChunkX / gridStep) * gridStep;
    const gridCenterChunkZ = Math.floor(centerChunkZ / gridStep) * gridStep;

    const startX = (gridCenterChunkX - radius) * chunkSize;
    const startZ = (gridCenterChunkZ - radius) * chunkSize;

    // Keep vertices fixed while the mesh origin moves
    const offsetX = centerChunkX - gridCenterChunkX;
    const offsetZ = centerChunkZ - gridCenterChunkZ;

    // --- Reuse window (align with grid step) ---
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

      if (diffX % gridStep === 0 && diffZ % gridStep === 0) {
        shiftX = diffX / gridStep;
        shiftZ = diffZ / gridStep;
        canReuse = true;
      }
    }

    // --- Main build loop (parity normals) ---
    let i3 = 0; // positions/normals pointer = vIndex * 3
    let i2 = 0; // tiles pointer = vIndex * 2

    let worldZ = startZ;
    for (let z = 0; z <= segments; z++, worldZ += stepSize) {
      const localChunkZ = z * gridStep - radius - offsetZ;
      const localZ = localChunkZ * chunkSize;
      const oldZ = z + shiftZ;

      let worldX = startX;
      for (
        let x = 0;
        x <= segments;
        x++, i3 += 3, i2 += 2, worldX += stepSize
      ) {
        const localChunkX = x * gridStep - radius - offsetX;
        const localX = localChunkX * chunkSize;
        const oldX = x + shiftX;

        const isInsideRealTerrain =
          localChunkX > -renderDistance &&
          localChunkX <= renderDistance &&
          localChunkZ > -renderDistance &&
          localChunkZ <= renderDistance;

        let y: number;

        // Try to reuse previous data if the grid moved by full steps
        if (
          canReuse &&
          oldData &&
          oldX >= 0 &&
          oldX <= segments &&
          oldZ >= 0 &&
          oldZ <= segments
        ) {
          const oldIndex = oldZ * rowSize + oldX;
          const oldIndex3 = oldIndex * 3;

          // Reuse Y and normals directly (parity behavior)
          y = oldData.positions[oldIndex3 + 1];

          normals[i3] = oldData.normals[oldIndex3];
          normals[i3 + 1] = oldData.normals[oldIndex3 + 1];
          normals[i3 + 2] = oldData.normals[oldIndex3 + 2];
        } else {
          if (isInsideRealTerrain) {
            y = this.INSIDE_CLIP_Y;
            // Up normal inside the punched-out area
            normals[i3] = 0;
            normals[i3 + 1] = 127;
            normals[i3 + 2] = 0;
          } else {
            // Parity height and normals (exactly like your original)
            y = TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);

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

            const len = Math.sqrt(dy1 * dy1 + 1 + dy2 * dy2) || 1;
            // Assign directly; Int8Array will coerce on write (same as original)
            normals[i3] = (-dy1 / len) * 127;
            normals[i3 + 1] = (1 / len) * 127;
            normals[i3 + 2] = (-dy2 / len) * 127;
          }
        }

        // Surface tiles
        if (isInsideRealTerrain) {
          surfaceTiles[i2] = this.DEFAULT_TILE_X;
          surfaceTiles[i2 + 1] = this.DEFAULT_TILE_Y;
        } else {
          const topBlockId = TerrainHeightMap.getBiome(worldX, worldZ).topBlock;
          const [tileX, tileY] = this.getTopTileForBlock(topBlockId);
          surfaceTiles[i2] = tileX;
          surfaceTiles[i2 + 1] = tileY;
        }

        // Positions
        positions[i3] = localX;
        positions[i3 + 1] = y;
        positions[i3 + 2] = localZ;
      }
    }

    return { positions, normals, surfaceTiles };
  }

  private static getTopTileForBlock(blockId: number): [number, number] {
    const tex = (
      BlockTextures as Record<
        number,
        { top?: [number, number]; all?: [number, number] }
      >
    )[blockId];
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
``;
