type BlockTextureDef = {
  top?: number[];
  bottom?: number[];
  side?: number[];
  all?: number[];
  [key: string]: number[] | undefined;
};

// This array maps Block ID (index) to the UV coordinates [tx, ty] within the texture atlas.
// The coordinates correspond to the order in which textures are loaded via textureFolders.
export const BlockTextures: (BlockTextureDef | null)[] = [
  null, // 0: air (must be null)
  { all: [0, 0] },
  {
    // Block ID 1: Based on original configuration (Grass)
    // top: [0, 0] -> cobble
    // bottom: [2, 0] -> gravelly_sand (dirt/sand look)
    // side: [1, 0] -> factory_wall (or a generic side texture)
    top: [1, 0],
    all: [1, 0],
  },
  {
    // Block ID 2: Dirt (uses gravelly_sand at [2, 0])
    all: [2, 0],
  },
  {
    // Block ID 3: Stone (uses brick_wall_10 at [3, 0])
    all: [3, 0],
  },
  {
    // Block ID 4: Castle Brick Red (from textureFolders index 4)
    all: [4, 0],
  },
  {
    // Block ID 5: Metal 01 (from textureFolders index 5)
    all: [5, 0],
  },
  {
    // Block ID 6: Concrete Tile Facade (from textureFolders index 6)
    all: [6, 0],
  },
  {
    // Block ID 7: Gray Rocks (from textureFolders index 7)
    all: [7, 0],
  },
  {
    // Block ID 8: Stone Tile Wall (from textureFolders index 8)
    all: [8, 0],
  },
  {
    // Block ID 9: Bark Willow 02 (from textureFolders index 9)
    all: [9, 0],
  },
  {
    // Block ID 10: Diagonal Parquet (from textureFolders index 10)
    all: [10, 0],
  },
  {
    // Block ID 11: Old Wood Floor (from textureFolders index 11)
    all: [11, 0],
  },
  {
    // Block ID 12: Wood Table (from textureFolders index 12)
    all: [12, 0],
  },
  {
    // Block ID 13: Rocky Terrain 02 (from textureFolders index 13)
    all: [13, 0],
  },

  {
    // Block ID 14: Grass001 (from textureFolders index 14)
    all: [14, 0],
  },
  // Add more blocks here if you add more textures to textureFolders.
];
