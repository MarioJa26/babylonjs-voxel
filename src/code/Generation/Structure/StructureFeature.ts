import type { Biome } from "../Biome/BiomeTypes";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";
import { Structure, type StructureData } from "./Structure";

export class StructureSpawnerFeature implements IWorldFeature {
	// Opulent House is 4 tall, placed at surface. Keep margin for neighbor surface range.
	public readonly verticalBounds = {
		minWorldY: -200,
		maxWorldY: 500,
	};

	private static structures: Map<string, Structure> = new Map();
	// PERF: Cached keys array — avoids Array.from() allocation on every generate() call.
	private static structureNames: string[] = [];

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
		StructureSpawnerFeature.structureNames = Array.from(
			StructureSpawnerFeature.structures.keys(),
		);
	}

	public generate(
		chunkX: number,
		_chunkY: number,
		chunkZ: number,
		_biome: Biome,
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
		columnPrepassResolver?: ColumnPrepassResolver,
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
		const structureNames = StructureSpawnerFeature.structureNames;
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

		let groundHeight: number;
		if (columnPrepassResolver) {
			const resolved = columnPrepassResolver(
				structureOriginX,
				structureOriginZ,
			);
			groundHeight =
				resolved.entry.terrainHeightMap[resolved.localX + resolved.localZ * 32];
		} else {
			groundHeight = getFinalTerrainHeight(structureOriginX, structureOriginZ);
		}

		structure.place(
			structureOriginX,
			groundHeight,
			structureOriginZ,
			placeBlock,
		);
	}
}
