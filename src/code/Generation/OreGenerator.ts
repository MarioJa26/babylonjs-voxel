import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { getPRNGBySeed } from "./NoiseAndParameters/Squirrel13";
import { BIOME_ID, type Biome } from "./Biome/BiomeTypes";

type OreDefinition = {
	id: number;
	name: string;
	maxY: number;
	veinRadius: number;
	blocksPerVein: number;
	spawnChance: number; // out of 100 per attempt
	attempts: number; // vein attempts per chunk (Minecraft-like density)
	biomeIds?: ReadonlySet<BIOME_ID>;
};

const HOT_BIOMES = new Set<BIOME_ID>([
	BIOME_ID.DESERT,
	BIOME_ID.SAVANNAH,
	BIOME_ID.VOLCANIC_WASTELAND,
	BIOME_ID.BASALT_DELTAS,
	BIOME_ID.BADLANDS,
	BIOME_ID.RED_ROCK_CANYON,
	BIOME_ID.OASIS,
	BIOME_ID.SALT_FLATS,
	BIOME_ID.DUNE_SEA,
	BIOME_ID.SCORCHED_SAVANNAH,
	BIOME_ID.CRACKED_EARTH,
	BIOME_ID.DUST_BOWL,
	BIOME_ID.MESA_PLATEAU,
	BIOME_ID.VOLCANIC_CALDERA,
	BIOME_ID.GEOTHERMAL_FIELD,
	BIOME_ID.ASHEN_WASTELAND,
]);

const WATER_BIOMES = new Set<BIOME_ID>([
	BIOME_ID.OCEAN,
	BIOME_ID.RIVER,
	BIOME_ID.SANDY_SHORE,
	BIOME_ID.ROCKY_SHORE,
	BIOME_ID.FROZEN_OCEAN,
	BIOME_ID.SWAMP,
	BIOME_ID.GLACIER,
	BIOME_ID.CORAL_REEF,
	BIOME_ID.KELP_FOREST,
	BIOME_ID.TIDAL_FLATS,
	BIOME_ID.ARCHIPELAGO,
	BIOME_ID.DEEP_OCEAN_TRENCH,
	BIOME_ID.BIOLUMINESCENT_BAY,
	BIOME_ID.WETLANDS,
	BIOME_ID.FERN_GULLY,
	BIOME_ID.MANGROVE,
]);

const JUNGLE_BIOMES = new Set<BIOME_ID>([
	BIOME_ID.JUNGLE,
	BIOME_ID.MANGROVE,
	BIOME_ID.BAMBOO_FOREST,
	BIOME_ID.TROPICAL_ISLAND,
	BIOME_ID.CLOUD_FOREST,
	BIOME_ID.GROVE,
	BIOME_ID.TEMPERATE_RAINFOREST,
]);

const ORE_TYPES: OreDefinition[] = [
	{
		id: 96,
		name: "Coal",
		maxY: 128,
		veinRadius: 5,
		blocksPerVein: 60,
		spawnChance: 70,
		attempts: 8,
	},
	{
		id: 99,
		name: "Iron",
		maxY: 64,
		veinRadius: 4,
		blocksPerVein: 35,
		spawnChance: 65,
		attempts: 6,
	},
	{
		id: 97,
		name: "Copper",
		maxY: 96,
		veinRadius: 4,
		blocksPerVein: 28,
		spawnChance: 60,
		attempts: 6,
	},
	{
		id: 98,
		name: "Gold",
		maxY: 32,
		veinRadius: 3,
		blocksPerVein: 16,
		spawnChance: 55,
		attempts: 4,
	},
	{
		id: 101,
		name: "Ruby",
		maxY: 48,
		veinRadius: 2,
		blocksPerVein: 10,
		spawnChance: 40,
		attempts: 3,
		biomeIds: HOT_BIOMES,
	},
	{
		id: 102,
		name: "Sapphire",
		maxY: 40,
		veinRadius: 2,
		blocksPerVein: 10,
		spawnChance: 40,
		attempts: 3,
		biomeIds: WATER_BIOMES,
	},
	{
		id: 103,
		name: "Emerald",
		maxY: 32,
		veinRadius: 2,
		blocksPerVein: 10,
		spawnChance: 40,
		attempts: 3,
		biomeIds: JUNGLE_BIOMES,
	},
	{
		id: 16,
		name: "Redstone",
		maxY: -64,
		veinRadius: 3,
		blocksPerVein: 20,
		spawnChance: 55,
		attempts: 5,
	},
	{
		id: 80,
		name: "Diamond",
		maxY: -256,
		veinRadius: 2,
		blocksPerVein: 8,
		spawnChance: 50,
		attempts: 3,
	},
	{
		id: 21,
		name: "Lapis",
		maxY: 32,
		veinRadius: 3,
		blocksPerVein: 16,
		spawnChance: 45,
		attempts: 3,
	},
	{
		id: 79,
		name: "Aetherite",
		maxY: -512,
		veinRadius: 1,
		blocksPerVein: 4,
		spawnChance: 35,
		attempts: 1,
	},
];

// PERF (#5): direct id comparison instead of Set.has() in the per-voxel vein loop.
const isStoneBlock = (id: number, hostBlockId: number): boolean =>
	id === 1 || id === 29 || id === hostBlockId;

export class OreGenerator {
	private params: GenerationParamsType;
	private oreNoise: (x: number, y: number, z: number) => number;
	private seedAsInt: number;

	constructor(
		params: GenerationParamsType,
		oreNoise: (x: number, y: number, z: number) => number,
		seedAsInt: number,
	) {
		this.params = params;
		this.oreNoise = oreNoise;
		this.seedAsInt = seedAsInt;
	}

	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array,
		biome: Biome,
	) {
		const { CHUNK_SIZE } = this.params;
		const hostBlockId = biome.stoneBlock;
		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldY = chunkY * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const chunkSizeSq = CHUNK_SIZE * CHUNK_SIZE;

		// PERF: skip air/water-only chunks entirely — a single linear scan
		// with early exit on first stone is far cheaper than 36 vein
		// attempts × sphere loops × scalar noise FFI each.
		let hasStone = false;
		for (let i = 0; i < blocks.length; i++) {
			if (isStoneBlock(blocks[i]!, hostBlockId)) {
				hasStone = true;
				break;
			}
		}
		if (!hasStone) return;

		for (const ore of ORE_TYPES) {
			if (ore.biomeIds !== undefined && !ore.biomeIds.has(biome.id)) {
				continue;
			}

			const chunkCenterY = chunkWorldY + CHUNK_SIZE / 2;
			if (chunkCenterY > ore.maxY) continue;

			// Minecraft-style: several independent vein attempts per chunk instead
			// of a single one, so ore density scales with chunk rather than being
			// an all-or-nothing per-ore roll.
			for (let attempt = 0; attempt < ore.attempts; attempt++) {
				const hash = getPRNGBySeed(
					chunkX * 374761393 +
						chunkY * 668265263 +
						chunkZ * 955191817 +
						ore.id * 374761 +
						attempt * 668265263,
					this.seedAsInt,
				);

				if (Math.abs(hash) % 100 >= ore.spawnChance) continue;

				const veinCenterX =
					chunkWorldX +
					(Math.abs(getPRNGBySeed(hash, this.seedAsInt)) % CHUNK_SIZE);
				const veinCenterY =
					chunkWorldY +
					(Math.abs(getPRNGBySeed(hash + 1, this.seedAsInt)) % CHUNK_SIZE);
				const veinCenterZ =
					chunkWorldZ +
					(Math.abs(getPRNGBySeed(hash + 2, this.seedAsInt)) % CHUNK_SIZE);
				const radius = ore.veinRadius;
				const radiusSq = radius * radius;
				const thresholdScale = 0.4 / radiusSq;
				let placed = 0;

				for (
					let dx = -radius;
					dx <= radius && placed < ore.blocksPerVein;
					dx++
				) {
					// wx depends only on dx — hoist the noise X coordinate.
					const sx = (veinCenterX + dx) * 0.1;
					for (
						let dy = -radius;
						dy <= radius && placed < ore.blocksPerVein;
						dy++
					) {
						const sy = (veinCenterY + dy) * 0.1;
						for (
							let dz = -radius;
							dz <= radius && placed < ore.blocksPerVein;
							dz++
						) {
							const distSq = dx * dx + dy * dy + dz * dz;
							if (distSq > radiusSq) continue;

							const wx = veinCenterX + dx;
							const wy = veinCenterY + dy;
							const wz = veinCenterZ + dz;

							const lx = wx - chunkWorldX;
							const ly = wy - chunkWorldY;
							const lz = wz - chunkWorldZ;

							if (
								lx < 0 ||
								lx >= CHUNK_SIZE ||
								ly < 0 ||
								ly >= CHUNK_SIZE ||
								lz < 0 ||
								lz >= CHUNK_SIZE
							)
								continue;

							const idx = lx + ly * CHUNK_SIZE + lz * chunkSizeSq;
							if (!isStoneBlock(blocks[idx]!, hostBlockId)) continue;

							// Shape the vein with 3D noise
							const density = this.oreNoise(sx, sy, (veinCenterZ + dz) * 0.1);
							const threshold = 0.3 + distSq * thresholdScale;

							if (density > threshold) {
								blocks[idx] = ore.id;
								placed++;
							}
						}
					}
				}
			}
		}
	}
}
