import { getPRNGBySeed } from "./NoiseAndParameters/Squirrel13";

export type UndergroundBiome = {
	id: number;
	name: string;
	stoneBlock: number;
	decorations: {
		floorBlock: number;
		ceilingBlock: number;
		wallDecoration: { blockId: number; chance: number }[];
	};
};

export const UNDERGROUND_BIOMES: UndergroundBiome[] = [
	{
		id: 0,
		name: "Deep_Slate",
		stoneBlock: 29,
		decorations: { floorBlock: 29, ceilingBlock: 29, wallDecoration: [] },
	},
	{
		id: 1,
		name: "Lush_Cave",
		stoneBlock: 51,
		decorations: {
			floorBlock: 15,
			ceilingBlock: 51,
			wallDecoration: [
				{ blockId: 44, chance: 0.15 },
				{ blockId: 43, chance: 0.08 },
			],
		},
	},
	{
		id: 2,
		name: "Dripstone_Cave",
		stoneBlock: 1,
		decorations: {
			floorBlock: 25,
			ceilingBlock: 1,
			wallDecoration: [{ blockId: 25, chance: 0.1 }],
		},
	},
	{
		id: 3,
		name: "Deep_Dark",
		stoneBlock: 67,
		decorations: {
			floorBlock: 67,
			ceilingBlock: 67,
			wallDecoration: [{ blockId: 68, chance: 0.2 }],
		},
	},
	{
		id: 4,
		name: "Magma_Chamber",
		stoneBlock: 81,
		decorations: {
			floorBlock: 24,
			ceilingBlock: 81,
			wallDecoration: [{ blockId: 24, chance: 0.05 }],
		},
	},
	{
		id: 5,
		name: "Ice_Cave",
		stoneBlock: 75,
		decorations: { floorBlock: 75, ceilingBlock: 75, wallDecoration: [] },
	},
	{
		id: 6,
		name: "Crystal_Cave",
		stoneBlock: 80,
		decorations: {
			floorBlock: 79,
			ceilingBlock: 80,
			wallDecoration: [{ blockId: 79, chance: 0.12 }],
		},
	},
];

const DEFAULT_BIOME = UNDERGROUND_BIOMES[0];

// Depth bands (world Y)
const UPPER_MIN = -256;
const DEEP_MIN = -512;

// ---------------------------------------------------------------------------
// Flat biome band tables — avoids per-call array allocation.
// Each "band" is just a slice of a shared typed array (two uint8 IDs max).
// We encode choices as pairs in a Uint8Array: [id0, id1, id0, id1, ...]
// A length-1 band stores the same id twice so `hash % 2` always resolves.
// ---------------------------------------------------------------------------
const BAND_DATA = new Uint8Array([
	// shallow, noise > 0.3  → [1, 2]  indices 0-1
	1, 2,
	// shallow, else         → [0, 0]  indices 2-3
	0, 0,
	// mid, noise > 0.4      → [3, 5]  indices 4-5
	3, 5,
	// mid, noise > 0.1      → [2, 6]  indices 6-7
	2, 6,
	// mid, else             → [0, 0]  indices 8-9
	0, 0,
	// deep, noise > 0.2     → [4, 4]  indices 10-11
	4, 4,
	// deep, else            → [3, 3]  indices 12-13
	3, 3,
]);

export class UndergroundBiomeSelector {
	// Flatten to primitives — V8 stores as Smi/double slots.
	private readonly biomeNoise: (x: number, z: number) => number;
	private readonly seedAsInt: number;

	constructor(biomeNoise: (x: number, z: number) => number, seedAsInt: number) {
		this.biomeNoise = biomeNoise;
		this.seedAsInt = seedAsInt;
	}

	public getBiome(
		worldX: number,
		worldY: number,
		worldZ: number,
	): UndergroundBiome {
		if (worldY >= 0) return DEFAULT_BIOME;

		const noiseVal = this.biomeNoise(worldX, worldZ);

		// Resolve the offset into BAND_DATA without allocating an array.
		let offset: number;
		if (worldY > UPPER_MIN) {
			offset = noiseVal > 0.3 ? 0 : 2;
		} else if (worldY > DEEP_MIN) {
			offset = noiseVal > 0.4 ? 4 : noiseVal > 0.1 ? 6 : 8;
		} else {
			offset = noiseVal > 0.2 ? 10 : 12;
		}

		// Squirrel3 hash — same logic as before, no change in output.
		const hash = Math.abs(
			getPRNGBySeed(
				(worldX * 374761393 + worldY * 668265263 + worldZ * 955191817) | 0,
				this.seedAsInt,
			),
		);

		const biomeIndex = BAND_DATA[offset + (hash & 1)]!;
		return UNDERGROUND_BIOMES[biomeIndex] ?? DEFAULT_BIOME;
	}

	// Inlined: only two possible source block IDs, so a branch is cheapest.
	public getStoneReplacement(blockId: number, biome: UndergroundBiome): number {
		return blockId === 1 || blockId === 29 ? biome.stoneBlock : blockId;
	}
}
