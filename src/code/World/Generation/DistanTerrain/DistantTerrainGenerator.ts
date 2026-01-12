import { GenerationParams } from "../NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "../TerrainHeightMap";

export class DistantTerrainGenerator {
  public static generate(
    centerChunkX: number,
    centerChunkZ: number,
    radius: number,
    renderDistance: number,
    gridStep: number,
    oldData?: {
      positions: Int16Array;
      colors: Uint8Array;
      normals: Uint8Array;
    },
    oldCenterChunkX?: number,
    oldCenterChunkZ?: number
  ) {
    const chunkSize = GenerationParams.CHUNK_SIZE;
    const segments = Math.floor((radius * 2) / gridStep);
    const vertexCount = (segments + 1) * (segments + 1);

    const positions = new Int16Array(vertexCount * 3);
    const colors = new Uint8Array(vertexCount * 3);
    const normals = new Uint8Array(vertexCount * 3);

    const startX = (centerChunkX - radius) * chunkSize;
    const startZ = (centerChunkZ - radius) * chunkSize;

    // Calculate grid shift if old data is available
    let shiftX = 0;
    let shiftZ = 0;
    let canReuse = false;

    if (
      oldData &&
      oldCenterChunkX !== undefined &&
      oldCenterChunkZ !== undefined
    ) {
      const diffX = centerChunkX - oldCenterChunkX;
      const diffZ = centerChunkZ - oldCenterChunkZ;

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
      const localChunkZ = z * gridStep - radius;
      let y = 0;
      let r = 128,
        g = 128,
        b = 128;
      let normalYComponent = 255;

      const localZ = localChunkZ * chunkSize;
      for (let x = 0; x <= segments; x++) {
        const worldX = startX + x * chunkSize * gridStep;
        const oldX = x + shiftX;
        const localChunkX = x * gridStep - radius;

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
          r = oldData.colors[oldIndex * 3];
          g = oldData.colors[oldIndex * 3 + 1];
          b = oldData.colors[oldIndex * 3 + 2];
          normalYComponent = oldData.normals[oldIndex * 3 + 1];
        } else {
          const isInsideRealTerrain =
            localChunkX > -renderDistance &&
            localChunkX <= renderDistance &&
            localChunkZ > -renderDistance &&
            localChunkZ <= renderDistance;
          y = isInsideRealTerrain
            ? -200
            : TerrainHeightMap.getFinalTerrainHeight(worldX, worldZ);
          const biome = isInsideRealTerrain
            ? null
            : TerrainHeightMap.getBiome(worldX, worldZ);

          switch (biome?.name) {
            case "Forest":
              r = 34;
              g = 139;
              b = 34;
              break;
            case "Tundra":
              r = 200;
              g = 200;
              b = 200;
              break;
            case "Tundra_Mountains":
              r = 128;
              g = 128;
              b = 200;
              break;
            case "Desert":
              r = 237;
              g = 213;
              b = 164;
              break;
            case "Jungle":
              r = 55;
              g = 180;
              b = 41;
              break;
            case "Plains":
              r = 120;
              g = 100;
              b = 70;
              break;
            case "Swamp":
              r = 47;
              g = 79;
              b = 79;
              break;
            case "Ocean":
              r = 0;
              g = 0;
              b = 222;
              break;
            case "Sandy_Shore":
              r = 255;
              g = 255;
              b = 0;
              break;
            case "Rocky_Shore":
              r = 128;
              g = 128;
              b = 128;
              break;
            case "Grove":
              r = 120;
              g = 180;
              b = 70;
              break;
            default:
              r = 64;
              g = 0;
              b = 0;
              break;
          }

          if (y < 40) {
            r *= 0.6;
            g *= 0.6;
            b *= 0.8;
          }
        }

        // Local position relative to the mesh center
        const localX = localChunkX * chunkSize;

        positions[vIndex * 3] = localX;
        positions[vIndex * 3 + 1] = y;
        positions[vIndex * 3 + 2] = localZ;

        // Simple up normal for now
        normals[vIndex * 3] = 0;
        normals[vIndex * 3 + 1] = normalYComponent;
        normals[vIndex * 3 + 2] = 0;

        colors[vIndex * 3] = r;
        colors[vIndex * 3 + 1] = g;
        colors[vIndex * 3 + 2] = b;

        vIndex++;
      }
    }
    return { positions, colors, normals };
  }
}
