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
      overwrite?: boolean,
    ) => void,
    seedAsInt: number,
  ): void;
};

export interface Biome {
  name: string;
  topBlock: number;
  undergroundBlock: number;
  stoneBlock: number;
  canSpawnTrees: boolean;
  treeDensity: number;
  beachBlock: number;
  seafloorBlock: number;
  terrainHeightBase?: number;
  terrainHeightAmplitude?: number;
  terrainScale?: number;
  octaves?: number;
  persistence?: number;
  lacunarity?: number;
  heightExponent?: number;
  getTreeForBlock(blockId: number): TreeDefinition | null;
}
