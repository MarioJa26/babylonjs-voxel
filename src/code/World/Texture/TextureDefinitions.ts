import { BlockType, Hardness } from "../BlockType";

export interface TextureDefinition {
  id: BlockType;
  name: string;
  path: string;
  hardness?: number;
}

export const TextureDefinitions: TextureDefinition[] = [
  {
    id: BlockType.Cobble,
    name: "cobble",
    path: "/texture/cobble/cobble05_1k",
    hardness: 1.5,
  },
  {
    id: BlockType.FactoryWall,
    name: "factory_wall",
    path: "/texture/metal/factory_wall_1k",
    hardness: 0.25,
  },
  {
    id: BlockType.GravellySand,
    name: "gravelly_sand",
    path: "/texture/sand/gravelly_sand_1k",
    hardness: 0.6,
  },
  {
    id: BlockType.BrickWall10,
    name: "brick_wall_10",
    path: "/texture/brick/brick_wall_10_1k",
  },
  {
    id: BlockType.CastleBrickRed,
    name: "castle_brick_red",
    path: "/texture/brick/castle_brick_02_red_1k",
    hardness: 2.0,
  },
  {
    id: BlockType.Metal01,
    name: "metal01",
    path: "/texture/metal/metal01_1k",
  },
  {
    id: BlockType.ConcreteTileFacade,
    name: "concrete_tile_facade",
    path: "/texture/stone/concrete_tile_facade_1k",
  },
  {
    id: BlockType.GrayRocks,
    name: "gray_rocks",
    path: "/texture/stone/gray_rocks_1k",
  },
  {
    id: BlockType.StoneTileWall,
    name: "stone_tile_wall",
    path: "/texture/stone/stone_tile_wall_1k",
  },
  {
    id: BlockType.BarkWillow02,
    name: "bark_willow_02",
    path: "/texture/wood/bark_willow_02_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.DiagonalParquet,
    name: "diagonal_parquet",
    path: "/texture/wood/diagonal_parquet_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.OldWoodFloor,
    name: "old_wood_floor",
    path: "/texture/wood/old_wood_floor_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.WoodTable,
    name: "wood_table",
    path: "/texture/wood/wood_table_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.RockyTerrain02,
    name: "rocky_terrain_02",
    path: "/texture/dirt/rocky_terrain_02_1k",
  },
  {
    id: BlockType.Grass001,
    name: "grass001",
    path: "/texture/dirt/Grass001_1K",
  },
  {
    id: BlockType.CheckeredPavementTiles,
    name: "checkered_pavement_tiles",
    path: "/texture/stone/checkered_pavement_tiles_1k",
  },
  {
    id: BlockType.WoodInlaidStoneWall,
    name: "wood_inlaid_stone_wall",
    path: "/texture/wood/wood_inlaid_stone_wall_1k",
  },
  {
    id: BlockType.StoneTiles02,
    name: "stone_tiles_02",
    path: "/texture/stone/stone_tiles_02_1k",
  },
  {
    id: BlockType.CrackedConcrete,
    name: "cracked_concrete",
    path: "/texture/stone/cracked_concrete_1k",
  },
  {
    id: BlockType.RockWall12,
    name: "rock_wall_12",
    path: "/texture/stone/rock_wall_12_1k",
  },
  {
    id: BlockType.JapaneseStoneWall,
    name: "japanese_stone_wall",
    path: "/texture/stone/japanese_stone_wall_1k",
  },
  {
    id: BlockType.PineBark,
    name: "pine_bark",
    path: "/texture/wood/pine_bark_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.MudCrackedDry03,
    name: "mud_cracked_dry_03",
    path: "/texture/dirt/mud_cracked_dry_03_1k",
  },
  {
    id: BlockType.MetalGrateRusty,
    name: "metal_grate_rusty",
    path: "/texture/metal/metal_grate_rusty_1k",
  },
  {
    id: BlockType.SlabTiles,
    name: "slab_tiles",
    path: "/texture/stone/slab_tiles_1k",
  },
  {
    id: BlockType.PatternedSlateTiles,
    name: "patterned_slate_tiles",
    path: "/texture/stone/patterned_slate_tiles_1k",
  },
  {
    id: BlockType.ConcretePanels,
    name: "concrete_panels",
    path: "/texture/stone/concrete_panels_1k",
  },
  {
    id: BlockType.BarkBrown02,
    name: "bark_brown_02",
    path: "/texture/wood/bark_brown_02_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.SlateFloor,
    name: "slate_floor",
    path: "/texture/stone/slate_floor_1k",
  },
  {
    id: BlockType.Water,
    name: "water",
    path: "/texture/water/water_01_1k",
    hardness: 1.0,
  },
  {
    id: BlockType.BarkBrown01,
    name: "bark_brown_01",
    path: "/texture/wood/bark_brown_01_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.BeamWall01,
    name: "beam_wall_01",
    path: "/texture/wood/beam_wall_01_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.MetasequoiaBark,
    name: "metasequoia_bark",
    path: "/texture/wood/metasequoia_bark_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.MossWood,
    name: "moss_wood",
    path: "/texture/wood/moss_wood_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.WoodPlanks,
    name: "wood_planks",
    path: "/texture/wood/wood_planks_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.OldPlanks02,
    name: "old_planks_02",
    path: "/texture/wood/old_planks_02_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.PlankFlooring02,
    name: "plank_flooring_02",
    path: "/texture/wood/plank_flooring_02_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.RoofSlates02,
    name: "roof_slates_02",
    path: "/texture/wood/roof_slates_02_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.RoughWood,
    name: "rough_wood",
    path: "/texture/wood/rough_wood_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.ThatchRoofAngled,
    name: "thatch_roof_angled",
    path: "/texture/wood/thatch_roof_angled_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.WoodPlankWall,
    name: "wood_plank_wall",
    path: "/texture/wood/wood_plank_wall_1k",
    hardness: Hardness.WOOD,
  },
  {
    id: BlockType.WoodTrunkWall,
    name: "wood_trunk_wall",
    path: "/texture/wood/wood_trunk_wall_1k",
    hardness: Hardness.WOOD,
  },

  {
    id: BlockType.ForestLeaves02,
    name: "forest_leaves_02",
    path: "/texture/dirt/forest_leaves_02_1k",
  },

  {
    id: BlockType.LeavesForestGround,
    name: "leaves_forest_ground",
    path: "/texture/dirt/leaves_forest_ground_1k",
  },

  {
    id: BlockType.RocksGround02,
    name: "rocks_ground_02",
    path: "/texture/dirt/rocks_ground_02_1k",
  },

  {
    id: BlockType.CoastLandRocks01,
    name: "coast_land_rocks_01",
    path: "/texture/dirt/coast_land_rocks_01_1k",
  },

  {
    id: BlockType.AerialBeach01,
    name: "aerial_beach_01",
    path: "/texture/dirt/aerial_beach_01_1k",
  },

  {
    id: BlockType.Cobblestone03,
    name: "cobblestone_03",
    path: "/texture/cobble/cobblestone_03_1k",
  },

  {
    id: BlockType.AntiSlipConcrete,
    name: "anti_slip_concrete",
    path: "/texture/stone/anti_slip_concrete_1k",
  },

  {
    id: BlockType.ConcreteBlockWall02,
    name: "concrete_block_wall_02",
    path: "/texture/stone/concrete_block_wall_02_1k",
  },

  {
    id: BlockType.ConcreteMoss,
    name: "concrete_moss",
    path: "/texture/stone/concrete_moss_1k",
  },

  {
    id: BlockType.FloorTiles09,
    name: "floor_tiles_09",
    path: "/texture/stone/floor_tiles_09_1k",
  },

  {
    id: BlockType.ConcreteTiles,
    name: "concrete_tiles",
    path: "/texture/stone/concrete_tiles_1k",
  },

  {
    id: BlockType.GraniteWall,
    name: "granite_wall",
    path: "/texture/stone/granite_wall_1k",
  },

  {
    id: BlockType.PatternedBrickWall03,
    name: "patterned_brick_wall_03",
    path: "/texture/stone/patterned_brick_wall_03_1k",
  },

  {
    id: BlockType.PatternedConcretePavers02,
    name: "patterned_concrete_pavers_02",
    path: "/texture/stone/patterned_concrete_pavers_02_1k",
  },

  {
    id: BlockType.QuarryWall,
    name: "quarry_wall",
    path: "/texture/stone/quarry_wall_1k",
  },

  {
    id: BlockType.RectangularFacadeTiles02,
    name: "rectangular_facade_tiles_02",
    path: "/texture/stone/rectangular_facade_tiles_02_1k",
  },

  {
    id: BlockType.RedSandstoneWall,
    name: "red_sandstone_wall",
    path: "/texture/stone/red_sandstone_wall_1k",
  },
  {
    id: BlockType.Glass01,
    name: "glass_01",
    path: "/texture/transparent/glass_01_1k",
    hardness: 0.1,
  },
  {
    id: BlockType.Glass02,
    name: "glass_02",
    path: "/texture/transparent/glass_02_1k",
    hardness: 0.1,
  },
  {
    id: BlockType.CraftingTable,
    name: "crafting_table",
    path: "/texture/wood/crafting_table_1k",
  },
];

export function getBlockBreakTime(id: number, toolItemId?: number): number {
  const def = getBlockInfo(id);
  const hardness = def?.hardness ?? 0.5;

  if (hardness === Infinity) return Infinity;

  let speedMultiplier = 1;
  if (toolItemId) {
    speedMultiplier = 1.5;
  }

  return (hardness * 1.5) / speedMultiplier;
}

export function getBlockInfo(id: number): TextureDefinition | undefined {
  return TextureDefinitions.find((d) => d.id === id);
}
