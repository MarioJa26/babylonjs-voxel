import { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { IWorldFeature } from "./IWorldFeature";

export class DungeonFeature implements IWorldFeature {
  public generate(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    biome: Biome,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean,
    ) => void,
    seed: number,
    chunkSize: number,
    getTerrainHeight: (x: number, z: number, biome: Biome) => number,
    generatingChunkX: number,
    generatingChunkZ: number,
  ) {
    const DUNGEON_CHANCE = 1; // 4% chance per chunk to be the center of a dungeon
    const regionHash = Squirrel3.get(chunkX * 892374 + chunkZ * 234897, seed);

    if (Math.abs(regionHash) % 100 >= DUNGEON_CHANCE) return;

    // Dungeon parameters
    // Generate deep underground (Y=15 to Y=35)
    const dungeonY = 15 + (Math.abs(Squirrel3.get(regionHash, seed)) % 20);
    const numRooms = 3 + (Math.abs(Squirrel3.get(regionHash + 1, seed)) % 4); // 3 to 6 rooms

    const centerX = chunkX * chunkSize + chunkSize / 2;
    const centerZ = chunkZ * chunkSize + chunkSize / 2;

    const rooms: { x: number; z: number; w: number; d: number }[] = [];
    let currentSeed = regionHash + 2;

    // 1. Generate Room Layout
    for (let i = 0; i < numRooms; i++) {
      const w = 7 + (Math.abs(Squirrel3.get(currentSeed++, seed)) % 6); // Width 7-12
      const d = 7 + (Math.abs(Squirrel3.get(currentSeed++, seed)) % 6); // Depth 7-12

      // Spread rooms out relative to the center
      const dx = (Math.abs(Squirrel3.get(currentSeed++, seed)) % 32) - 16;
      const dz = (Math.abs(Squirrel3.get(currentSeed++, seed)) % 32) - 16;

      rooms.push({
        x: centerX + dx,
        z: centerZ + dz,
        w,
        d,
      });
    }

    // 2. Optimization: Global Bounding Box Check
    // If the entire dungeon area doesn't touch the chunk we are building, skip everything.
    const dungeonMinX = centerX - 40;
    const dungeonMaxX = centerX + 40;
    const dungeonMinZ = centerZ - 40;
    const dungeonMaxZ = centerZ + 40;

    const genMinX = generatingChunkX * chunkSize;
    const genMaxX = (generatingChunkX + 1) * chunkSize;
    const genMinZ = generatingChunkZ * chunkSize;
    const genMaxZ = (generatingChunkZ + 1) * chunkSize;

    if (
      dungeonMaxX <= genMinX ||
      dungeonMinX >= genMaxX ||
      dungeonMaxZ <= genMinZ ||
      dungeonMinZ >= genMaxZ
    ) {
      return;
    }

    const FLOOR_BLOCK = 4; // Cobblestone
    const WALL_BLOCK = 48; // Mossy Cobblestone
    const AIR = 0;

    // 3. Carve Rooms
    for (const room of rooms) {
      // Individual Room Bounding Box Check
      if (
        room.x + room.w <= genMinX ||
        room.x >= genMaxX ||
        room.z + room.d <= genMinZ ||
        room.z >= genMaxZ
      )
        continue;

      for (let x = room.x; x < room.x + room.w; x++) {
        for (let z = room.z; z < room.z + room.d; z++) {
          for (let y = dungeonY; y < dungeonY + 6; y++) {
            let blockId = AIR;
            if (y === dungeonY) blockId = FLOOR_BLOCK;
            else if (y === dungeonY + 5)
              blockId = WALL_BLOCK; // Ceiling
            else if (
              x === room.x ||
              x === room.x + room.w - 1 ||
              z === room.z ||
              z === room.z + room.d - 1
            ) {
              blockId = WALL_BLOCK;
            }

            // overwrite=true ensures we carve out existing stone/dirt
            placeBlock(x, y, z, blockId, true);
          }
        }
      }
    }

    // 4. Carve Corridors connecting rooms sequentially
    for (let i = 0; i < rooms.length - 1; i++) {
      const r1 = rooms[i];
      const r2 = rooms[i + 1];

      const c1x = Math.floor(r1.x + r1.w / 2);
      const c1z = Math.floor(r1.z + r1.d / 2);
      const c2x = Math.floor(r2.x + r2.w / 2);
      const c2z = Math.floor(r2.z + r2.d / 2);

      // Draw L-shaped corridor
      // Segment 1: X-axis
      const xStart = Math.min(c1x, c2x);
      const xEnd = Math.max(c1x, c2x);
      this.carveCorridor(
        xStart,
        xEnd,
        c1z,
        c1z,
        dungeonY,
        placeBlock,
        FLOOR_BLOCK,
        genMinX,
        genMaxX,
        genMinZ,
        genMaxZ,
      );

      // Segment 2: Z-axis
      const zStart = Math.min(c1z, c2z);
      const zEnd = Math.max(c1z, c2z);
      this.carveCorridor(
        c2x,
        c2x,
        zStart,
        zEnd,
        dungeonY,
        placeBlock,
        FLOOR_BLOCK,
        genMinX,
        genMaxX,
        genMinZ,
        genMaxZ,
      );
    }
  }

  private carveCorridor(
    x1: number,
    x2: number,
    z1: number,
    z2: number,
    yBase: number,
    placeBlock: any,
    floorBlock: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ) {
    // Simple bounding box check for the corridor segment
    // Expand by 1 for width
    if (
      Math.max(x1, x2) + 2 <= minX ||
      Math.min(x1, x2) - 1 >= maxX ||
      Math.max(z1, z2) + 2 <= minZ ||
      Math.min(z1, z2) - 1 >= maxZ
    ) {
      return;
    }

    // Iterate with a small buffer to create width
    for (let x = x1 - 1; x <= x2 + 1; x++) {
      for (let z = z1 - 1; z <= z2 + 1; z++) {
        // Floor
        placeBlock(x, yBase, z, floorBlock, true);
        // Air (Corridor height 3)
        placeBlock(x, yBase + 1, z, 0, true);
        placeBlock(x, yBase + 2, z, 0, true);
        placeBlock(x, yBase + 3, z, 0, true);
        // Ceiling
        placeBlock(x, yBase + 4, z, floorBlock, true);
      }
    }
  }
}
