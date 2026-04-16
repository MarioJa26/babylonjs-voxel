export enum BlockType {
	Air = 0,
	Cobble = 1,
	FactoryWall = 2,
	GravellySand = 3,
	BrickWall10 = 4,
	CastleBrickRed = 5,
	Metal01 = 6,
	ConcreteTileFacade = 7,
	GrayRocks = 8,
	StoneTileWall = 9,
	BarkWillow02 = 10,
	DiagonalParquet = 11,
	OldWoodFloor = 12,
	WoodTable = 13,
	RockyTerrain02 = 14,
	Grass001 = 15,
	CheckeredPavementTiles = 16,
	WoodInlaidStoneWall = 17,
	StoneTiles02 = 18,
	CrackedConcrete = 19,
	RockWall12 = 20,
	JapaneseStoneWall = 21,
	PineBark = 22,
	MudCrackedDry03 = 23,
	MetalGrateRusty = 24,
	SlabTiles = 25,
	PatternedSlateTiles = 26,
	ConcretePanels = 27,
	BarkBrown02 = 28,
	SlateFloor = 29,
	Water = 30,
	BarkBrown01 = 31,
	BeamWall01 = 32,
	MetasequoiaBark = 33,
	MossWood = 34,
	WoodPlanks = 35,
	OldPlanks02 = 36,
	PlankFlooring02 = 37,
	RoofSlates02 = 38,
	RoughWood = 39,
	ThatchRoofAngled = 40,
	WoodPlankWall = 41,
	WoodTrunkWall = 42,
	ForestLeaves02 = 43,
	LeavesForestGround = 44,
	RocksGround02 = 45,
	CoastLandRocks01 = 46,
	AerialBeach01 = 47,
	Cobblestone03 = 48,
	AntiSlipConcrete = 49,
	ConcreteBlockWall02 = 50,
	ConcreteMoss = 51,
	FloorTiles09 = 52,
	ConcreteTiles = 53,
	GraniteWall = 54,
	PatternedBrickWall03 = 55,
	PatternedConcretePavers02 = 56,
	QuarryWall = 57,
	RectangularFacadeTiles02 = 58,
	RedSandstoneWall = 59,
	Glass01 = 60,
	Glass02 = 61,
	CraftingTable = 62,
	BoatCreator = 63,
	GrassCross = 64,
}

export const Hardness = {
	GLASS: 0.1,
	LEAVES: 0.2,
	//
	DIRT: 0.6,
	WOOD: 1.3,
	STONE: 1.5,
	BRICK: 2.0,

	METAL: 3.0,

	UNBREAKABLE: Infinity,
};

export function isPassThroughBlock(blockId: number): boolean {
	return (
		blockId === BlockType.Air ||
		blockId === BlockType.Water ||
		blockId === BlockType.GrassCross
	);
}

export function isCollidableBlock(blockId: number): boolean {
	return !isPassThroughBlock(blockId);
}
