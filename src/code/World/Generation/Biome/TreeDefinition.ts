import { Squirrel3 } from "../Squirrel13";

export type TreeDefinition = {
  woodId: number;
  leavesId: number;
  baseHeight: number;
  heightVariance: number;
  /**
   * Generates the blocks for this tree type at the given world coordinates.
   * @param worldX The world X coordinate of the tree's base.
   * @param worldY The world Y coordinate of the tree's base (usually terrainHeight + 1).
   * @param worldZ The world Z coordinate of the tree's base.
   * @param placeBlock A callback function to place a block in the current chunk's block array.
   * @param seedAsInt The integer seed for deterministic height calculation.
   */
  generate(
    worldX: number,
    worldY: number,
    worldZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      blockId: number,
      overwrite?: boolean
    ) => void,
    seedAsInt: number
  ): void;
};

export const OAK_TREE: TreeDefinition = {
  woodId: 28,
  leavesId: 2,
  baseHeight: 5,
  heightVariance: 2,
  generate(
    worldX: number,
    worldY: number,
    worldZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      blockId: number,
      overwrite?: boolean
    ) => void,
    seedAsInt: number
  ): void {
    const heightHash = Squirrel3.get(
      worldX * 374761393 + worldZ * 678446653,
      seedAsInt
    );
    const height =
      this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));

    // Place trunk
    for (let i = 0; i < height; i++) {
      placeBlock(worldX, worldY + i, worldZ, this.woodId, true); // Log
    }

    // A more authentic Minecraft oak tree canopy
    const leafYStart = worldY + height - 3;

    // Main canopy layers (two 5x5 layers with corners removed)
    let radius = 2;
    for (let y = leafYStart; y < leafYStart + 4; y++) {
      if (y < leafYStart + 2) radius = 2;
      else radius = 1;
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          placeBlock(worldX + x, y, worldZ + z, this.leavesId, false); // Leaves
        }
      }
    }
  },
};

export const PLAINS_TREE: TreeDefinition = {
  woodId: 31,
  leavesId: 43,
  baseHeight: 6,
  heightVariance: 2,
  generate(
    worldX: number,
    worldY: number,
    worldZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      blockId: number,
      overwrite?: boolean
    ) => void,
    seedAsInt: number
  ): void {
    const heightHash = Squirrel3.get(
      worldX * 374761393 + worldZ * 678446653,
      seedAsInt
    );
    const height =
      this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));

    // Place trunk
    for (let i = 0; i < height; i++) {
      placeBlock(worldX, worldY + i, worldZ, this.woodId, true); // Log
    }

    // A more authentic Minecraft oak tree canopy
    const leafYStart = worldY + height - 3;

    // Main canopy layers (two 5x5 layers with corners removed)
    let radius = 2;
    for (let y = leafYStart; y < leafYStart + 4; y++) {
      if (y < leafYStart + 2) radius = 2;
      else radius = 1;
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          placeBlock(worldX + x, y, worldZ + z, this.leavesId, false); // Leaves
        }
      }
    }
  },
};

export const JUNGLE_TREE: TreeDefinition = {
  woodId: 33,
  leavesId: 34,
  baseHeight: 20,
  heightVariance: 20,
  generate(
    worldX: number,
    worldY: number,
    worldZ: number,
    placeBlock: (
      x: number,
      y: number,
      z: number,
      blockId: number,
      overwrite?: boolean
    ) => void,
    seedAsInt: number
  ): void {
    const heightHash = Squirrel3.get(
      worldX * 374761393 + worldZ * 678446653,
      seedAsInt
    );
    const height =
      this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));

    // Place trunk
    for (let i = 0; i < height; i++) {
      placeBlock(worldX, worldY + i, worldZ, this.woodId, true);
    }

    // Simple canopy for now, similar to oak but larger

    const canopyRadius = 4; // Larger radius

    for (let conopie = 1; conopie <= 2; conopie++) {
      const leafYStart = worldY + height - 5 * conopie - (conopie - 1) * 3;
      for (let y = leafYStart; y < leafYStart + 8; y++) {
        // Taller canopy
        const currentRadius = canopyRadius - Math.floor((y - leafYStart) / 2);
        for (let x = -currentRadius; x <= currentRadius; x++) {
          for (let z = -currentRadius; z <= currentRadius; z++) {
            if (x * x + z * z <= currentRadius * currentRadius + 1) {
              // More spherical
              placeBlock(worldX + x, y, worldZ + z, this.leavesId, false);
            }
          }
        }
      }
    }
  },
};

export const CACTUS: TreeDefinition = {
  woodId: 34,
  leavesId: 0, // No leaves on a cactus
  baseHeight: 3,
  heightVariance: 2,
  generate(
    worldX: number,
    worldY: number,
    worldZ: number,
    placeBlock: (x: number, y: number, z: number, blockId: number) => void,
    seedAsInt: number
  ): void {
    const heightHash = Squirrel3.get(
      worldX * 374761393 + worldZ * 678446653,
      seedAsInt
    );
    const height =
      this.baseHeight + (Math.abs(heightHash) % (this.heightVariance + 1));

    // Place cactus blocks (woodId is used for cactus block)
    for (let i = 0; i < height; i++) {
      placeBlock(worldX, worldY + i, worldZ, this.woodId);
    }
    // No leaves for cactus
  },
};
