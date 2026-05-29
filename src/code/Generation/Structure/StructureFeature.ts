import type { Biome } from "../Biome/BiomeTypes";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { IWorldFeature } from "./IWorldFeature";
import { Structure, type StructureData } from "./Structure";
import { computeRegion, chunkWorldBounds, aabbOverlaps } from "./RegionFeature";

export class StructureSpawnerFeature implements IWorldFeature {
	private static structures: Map<string, Structure> = new Map();

	constructor() {
		this.loadStructures();
	}

	private loadStructures() {
		const opulentHouseData: StructureData = {
			name: "Opulent House",
			width: 5,
			height: 4,
			depth: 5,
			palette: {
				"0": 0,
				"1": 43,
				"2": 41,
				"3": 19,
				"4": 42,
			},
			blocks: [
				1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
				1, 2, 1, 1, 1, 2, 1, 2, 2, 2, 1, 1, 2, 0, 2, 1, 1, 2, 2, 2, 1, 2, 1, 1,
				1, 2, 2, 1, 1, 1, 2, 1, 3, 0, 3, 1, 1, 0, 0, 0, 1, 1, 3, 0, 3, 1, 2, 1,
				1, 1, 2, 1, 4, 4, 4, 1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 1,
				4, 4, 4, 1,
			],
		};

		StructureSpawnerFeature.structures.set(
			"Opulent House",
			new Structure(opulentHouseData),
		);
	}

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
		generatingChunkX: number,
		generatingChunkZ: number,
	) {
		if (StructureSpawnerFeature.structures.size === 0) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 16,
			magicA: 584661329,
			magicB: 957346603,
			spawnChance: 10,
			earlyReturn: false,
		});
		if (!region) return;

		const { regionHash } = region;
		const structureNames = Array.from(
			StructureSpawnerFeature.structures.keys(),
		);
		const structureName =
			structureNames[Math.abs(regionHash) % structureNames.length];
		const structure = StructureSpawnerFeature.structures.get(structureName);
		if (!structure) return;

		const structureOriginX = region.centerX;
		const structureOriginZ = region.centerZ;

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);
		if (
			!aabbOverlaps(
				structureOriginX,
				structureOriginX + structure.width,
				structureOriginZ,
				structureOriginZ + structure.depth,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const groundHeight = getFinalTerrainHeight(
			structureOriginX,
			structureOriginZ,
		);

		structure.place(
			structureOriginX,
			groundHeight,
			structureOriginZ,
			placeBlock,
		);
	}
}
