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
  null, // 0: air

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
  { all: [11, 1] }, // 28: bark_brown_02
  { all: [12, 1] }, // 29: slate_floor
  { all: [13, 1] }, // 30: water
  { all: [14, 1] }, // 31: bark_brown_01
  { all: [15, 1] }, // 32: beam_wall_01

  { all: [0, 2] }, // 33: metasequoia_bark
  { all: [1, 2] }, // 34: moss_wood
  { all: [2, 2] }, // 35: wood_planks
  { all: [3, 2] }, // 36: old_planks_02
  { all: [4, 2] }, // 37: plank_flooring_02
  { all: [5, 2] }, // 38: roof_slates_02
  { all: [6, 2] }, // 39: rough_wood
  { all: [7, 2] }, // 40: thatch_roof_angled
  { all: [8, 2] }, // 41: wood_plank_wall
  { all: [9, 2] }, // 42: wood_trunk_wall
  { all: [10, 2] }, // 43: forest_leaves_02
  { all: [11, 2] }, // 44: leaves_forest_ground
  { all: [12, 2] }, // 45: rocks_ground_02
  { all: [13, 2] }, // 46: coast_land_rocks_01
  { all: [14, 2] }, // 47: aerial_beach_01
  { all: [15, 2] }, // 48: cobblestone_03

  { all: [0, 3] }, // 49: anti_slip_concrete
  { all: [1, 3] }, // 50: concrete_block_wall_02
  { all: [2, 3] }, // 51: concrete_moss
  { all: [3, 3] }, // 52: concrete_tile_facade (duplicate name but new texture)
  { all: [4, 3] }, // 53: concrete_tiles_
  { all: [5, 3] }, // 54: granite_wall
  { all: [6, 3] }, // 55: patterned_brick_wall_03
  { all: [7, 3] }, // 56: patterned_concrete_pavers_02
  { all: [8, 3] }, // 57: quarry_wall
  { all: [9, 3] }, // 58: rectangular_facade_tiles_02
  { all: [10, 3] }, // 59: red_sandstone_wall
  { all: [11, 3] }, // 60: glass_01
  { all: [12, 3] }, // 61: glass_02
  { all: [13, 3] }, // 62: crafting_table
];
