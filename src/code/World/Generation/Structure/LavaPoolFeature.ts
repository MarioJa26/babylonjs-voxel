import { Biome } from "../Biome/Biomes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { IWorldFeature } from "./IWorldFeature";

export class LavaPoolFeature implements IWorldFeature {
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
      ow: boolean
    ) => void,
    seed: number,
    chunkSize: number
  ) {
    const POOL_REGION_SIZE = 9;
    const POOL_SPAWN_CHANCE = 100;

    const regionX = Math.floor(chunkX / POOL_REGION_SIZE);
    const regionZ = Math.floor(chunkZ / POOL_REGION_SIZE);

    const regionHash = Squirrel3.get(
      regionX * 873461393 + regionZ * 178246653,
      seed
    );

    if (Math.abs(regionHash) % 100 < POOL_SPAWN_CHANCE) {
      const baseHash = Squirrel3.get(regionHash, seed);
      const offsetX =
        Math.abs(Squirrel3.get(baseHash, seed)) %
        (POOL_REGION_SIZE * chunkSize);
      const offsetZ =
        Math.abs(Squirrel3.get(baseHash + 1, seed)) %
        (POOL_REGION_SIZE * chunkSize);
      const offsetY =
        -64 - (Math.abs(Squirrel3.get(baseHash + 2, seed)) % (1024 - 64));

      const poolCenterX = regionX * POOL_REGION_SIZE * chunkSize + offsetX;
      const poolSurfaceY = offsetY;
      const poolCenterZ = regionZ * POOL_REGION_SIZE * chunkSize + offsetZ;

      this.generateLavaPool(
        chunkX,
        chunkY,
        chunkZ,
        poolCenterX,
        poolSurfaceY,
        poolCenterZ,
        placeBlock,
        seed
      );
    }
  }

  private generateLavaPool(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    poolCenterX: number,
    poolCenterY: number,
    poolCenterZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      id: number,
      ow: boolean
    ) => void,
    seed: number
  ) {
    const poolRadius = 25 + (Squirrel3.get(poolCenterX, seed) % 5);
    const maxDepth = 15 + (Squirrel3.get(poolCenterZ, seed) % 3);
    const radiusSq = poolRadius * poolRadius;
    const lavaBlockId = 24;
    const shoreBlockId = 25;

    const shellRadius = poolRadius + 1;
    const shellRadiusSq = shellRadius * shellRadius;
    for (let dx = -shellRadius; dx <= shellRadius; dx++) {
      for (let dz = -shellRadius; dz <= shellRadius; dz++) {
        const distSq = dx * dx + dz * dz;
        if (distSq >= shellRadiusSq) continue;

        const worldX = poolCenterX + dx;
        const worldZ = poolCenterZ + dz;
        const depthFactor = Math.sqrt(distSq) / shellRadius;
        const depth = Math.floor((maxDepth + 1) * (1 - depthFactor));
        const floorY = poolCenterY - depth;

        for (let y = floorY; y <= poolCenterY; y++) {
          placeBlock(worldX, y, worldZ, shoreBlockId, true);
        }
      }
    }

    for (let dx = -poolRadius; dx <= poolRadius; dx++) {
      for (let dz = -poolRadius; dz <= poolRadius; dz++) {
        const distSq = dx * dx + dz * dz;
        if (distSq >= radiusSq) continue;

        const depth = Math.floor(maxDepth * (1 - distSq / radiusSq));
        const floorY = poolCenterY - depth;
        for (let y = floorY; y <= poolCenterY; y++) {
          placeBlock(poolCenterX + dx, y, poolCenterZ + dz, lavaBlockId, true);
        }
      }
    }
  }
}
