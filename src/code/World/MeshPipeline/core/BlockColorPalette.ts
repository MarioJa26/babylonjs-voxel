import { BlockType } from "../../Texture/BlockType";

const PALETTE_SIZE = 256;
const CHANNELS = 3;

export const COLOR_PALETTE = new Float32Array(PALETTE_SIZE * CHANNELS);

const BLOCK_TO_COLOR_INDEX = new Uint8Array(65536);

const DEFAULT_COLOR_INDEX = 1;

function setPaletteColor(index: number, r: number, g: number, b: number): void {
	const offset = index * CHANNELS;
	COLOR_PALETTE[offset] = r;
	COLOR_PALETTE[offset + 1] = g;
	COLOR_PALETTE[offset + 2] = b;
}

function assignBlocks(index: number, ...blockIds: number[]): void {
	for (let i = 0; i < blockIds.length; i++) {
		BLOCK_TO_COLOR_INDEX[blockIds[i]] = index;
	}
}

function init(): void {
	BLOCK_TO_COLOR_INDEX.fill(DEFAULT_COLOR_INDEX);

	setPaletteColor(0, 0.0, 0.0, 0.0);
	setPaletteColor(1, 0.50, 0.50, 0.50);
	setPaletteColor(2, 0.36, 0.55, 0.24);
	setPaletteColor(3, 0.55, 0.45, 0.33);
	setPaletteColor(4, 0.55, 0.41, 0.08);
	setPaletteColor(5, 0.42, 0.26, 0.15);
	setPaletteColor(6, 0.18, 0.42, 0.12);
	setPaletteColor(7, 0.20, 0.40, 0.80);
	setPaletteColor(8, 0.67, 0.86, 1.00);
	setPaletteColor(9, 0.80, 0.90, 1.00);
	setPaletteColor(10, 0.72, 0.58, 0.35);
	setPaletteColor(11, 0.44, 0.44, 0.44);
	setPaletteColor(12, 0.55, 0.27, 0.07);
	setPaletteColor(13, 0.31, 0.31, 0.31);
	setPaletteColor(14, 0.55, 0.49, 0.24);
	setPaletteColor(15, 0.77, 0.45, 0.24);
	setPaletteColor(16, 0.63, 0.50, 0.31);
	setPaletteColor(17, 0.29, 0.48, 0.18);
	setPaletteColor(18, 0.10, 0.10, 0.18);
	setPaletteColor(19, 0.42, 0.36, 0.31);
	setPaletteColor(20, 0.83, 0.77, 0.19);
	setPaletteColor(21, 0.24, 0.17, 0.12);
	setPaletteColor(22, 0.42, 0.48, 0.37);
	setPaletteColor(23, 0.35, 0.35, 0.35);
	setPaletteColor(24, 0.91, 0.86, 0.78);
	setPaletteColor(25, 0.80, 0.20, 0.20);
	setPaletteColor(26, 0.53, 0.40, 0.80);
	setPaletteColor(27, 0.23, 0.23, 0.23);
	setPaletteColor(28, 0.77, 0.45, 0.32);
	setPaletteColor(29, 0.91, 0.91, 0.91);
	setPaletteColor(30, 0.42, 0.62, 0.31);

	assignBlocks(2, BlockType.RockyTerrain02);
	assignBlocks(3, BlockType.GravellySand, BlockType.GrayRocks);
	assignBlocks(4,
		BlockType.Cobble,
		BlockType.FactoryWall,
		BlockType.BrickWall10,
		BlockType.CastleBrickRed,
		BlockType.ConcreteTileFacade,
		BlockType.StoneTileWall,
		BlockType.MudCrackedDry03,
		BlockType.RocksGround02,
		BlockType.CoastLandRocks01,
		BlockType.AerialBeach01,
	);
	assignBlocks(5,
		BlockType.BarkWillow02,
		BlockType.PineBark,
		BlockType.BarkBrown02,
		BlockType.BarkBrown01,
		BlockType.MetasequoiaBark,
		BlockType.MossWood,
		BlockType.BirchBark,
	);
	assignBlocks(6,
		BlockType.Grass001,
		BlockType.ForestLeaves02,
		BlockType.LeavesForestGround,
		BlockType.BirchLeaves,
	);
	assignBlocks(7, BlockType.Water);
	assignBlocks(8, BlockType.Glass01, BlockType.Glass02);
	assignBlocks(9, BlockType.IceBlock, BlockType.GlacierIce);
	assignBlocks(10,
		BlockType.DiagonalParquet,
		BlockType.OldWoodFloor,
		BlockType.WoodTable,
		BlockType.WoodPlanks,
		BlockType.OldPlanks02,
		BlockType.PlankFlooring02,
		BlockType.WoodPlankWall,
		BlockType.WoodTrunkWall,
	);
	assignBlocks(11,
		BlockType.CheckeredPavementTiles,
		BlockType.WoodInlaidStoneWall,
		BlockType.StoneTiles02,
		BlockType.CrackedConcrete,
		BlockType.RockWall12,
		BlockType.JapaneseStoneWall,
		BlockType.SlabTiles,
		BlockType.PatternedSlateTiles,
		BlockType.ConcretePanels,
		BlockType.BeamWall01,
		BlockType.Cobblestone03,
		BlockType.AntiSlipConcrete,
		BlockType.ConcreteBlockWall02,
		BlockType.ConcreteMoss,
		BlockType.FloorTiles09,
		BlockType.ConcreteTiles,
		BlockType.GraniteWall,
		BlockType.PatternedBrickWall03,
		BlockType.PatternedConcretePavers02,
		BlockType.QuarryWall,
		BlockType.RectangularFacadeTiles02,
	);
	assignBlocks(12, BlockType.Metal01, BlockType.MetalGrateRusty);
	assignBlocks(13, BlockType.SlateFloor, BlockType.RoofSlates02);
	assignBlocks(14, BlockType.RoughWood, BlockType.ThatchRoofAngled);
	assignBlocks(15, BlockType.RedSandstoneWall);
	assignBlocks(16, BlockType.CraftingTable, BlockType.BoatCreator);
	assignBlocks(17,
		BlockType.GrassCross,
		BlockType.SavannahGrass,
		BlockType.SavannahGrassCross,
	);
	assignBlocks(18, BlockType.Obsidian);
	assignBlocks(19, BlockType.Mycelium);
	assignBlocks(20, BlockType.Sulphur);
	assignBlocks(21, BlockType.Peat);
	assignBlocks(22, BlockType.MossyCobble);
	assignBlocks(23, BlockType.AncientCrackedStone);
	assignBlocks(24, BlockType.MushroomStem);
	assignBlocks(25, BlockType.MushroomAmanitacap);
	assignBlocks(26, BlockType.ExposedCrystalBlock, BlockType.CrystalBlock);
	assignBlocks(27, BlockType.BasaltBlock);
	assignBlocks(28, BlockType.TerracottaBlock);
	assignBlocks(29, BlockType.SaltBlock);
}

init();

export function getBlockColorIndex(blockId: number): number {
	if (blockId < 0 || blockId >= BLOCK_TO_COLOR_INDEX.length) return DEFAULT_COLOR_INDEX;
	return BLOCK_TO_COLOR_INDEX[blockId];
}
