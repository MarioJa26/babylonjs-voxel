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

  { all: [0, 0] }, // 1: cobble
  { all: [1, 0] }, // 2: factory_wall
  { all: [2, 0] }, // 3: gravelly_sand
  { all: [3, 0] }, // 4: brick_wall_10
  { all: [4, 0] }, // 5: castle_brick_red
  { all: [5, 0] }, // 6: metal01
  { all: [6, 0] }, // 7: concrete_tile_facade
  { all: [7, 0] }, // 8: gray_rocks
  { all: [8, 0] }, // 9: stone_tile_wall
  { all: [9, 0] }, // 10: bark_willow_02
  { all: [10, 0] }, // 11: diagonal_parquet
  { all: [11, 0] }, // 12: old_wood_floor
  { all: [12, 0] }, // 13: wood_table
  { all: [13, 0] }, // 14: rocky_terrain_02
  { all: [14, 0] }, // 15: grass001
  { all: [15, 0] }, // 16: checkered_pavement_tiles
  { all: [0, 1] }, // 17: wood_inlaid_stone_wall
  { all: [1, 1] }, // 18: stone_tiles_02
  { all: [2, 1] }, // 19: cracked_concrete
  { all: [3, 1] }, // 20: rock_wall_12
  { all: [4, 1] }, // 21: japanese_stone_wall
  { all: [5, 1] }, // 22: pine_bark
  { all: [6, 1] }, // 23: mud_cracked_dry_03
  { all: [7, 1] }, // 24: metal_grate_rusty
  { all: [8, 1] }, // 25: slab_tiles
  { all: [9, 1] }, // 26: patterned_slate_tiles
  { all: [10, 1] }, // 27: concrete_panels
  {
    west: [1, 0],
    east: [2, 0],
    north: [3, 0],
    south: [4, 0],
    up: [5, 0],
    down: [6, 0],
    all: [11, 1],
  }, // 28: bark_brown_02
  { all: [12, 1] }, // 29: slate_floor
  { all: [13, 1] }, // 30: water_01
];
