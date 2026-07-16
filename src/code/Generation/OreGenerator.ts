import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { getPRNGBySeed } from "./NoiseAndParameters/Squirrel13";

type OreDefinition = {
	id: number;
	name: string;
	maxY: number;
	veinRadius: number;
	blocksPerVein: number;
	spawnChance: number; // out of 100 per chunk
};

const ORE_TYPES: OreDefinition[] = [
	{
		id: 19,
		name: "Coal",
		maxY: 128,
		veinRadius: 5,
		blocksPerVein: 60,
		spawnChance: 25,
	},
	{
		id: 14,
		name: "Iron",
		maxY: 64,
		veinRadius: 4,
		blocksPerVein: 35,
		spawnChance: 20,
	},
	{
		id: 25,
		name: "Copper",
		maxY: 96,
		veinRadius: 4,
		blocksPerVein: 28,
		spawnChance: 17,
	},
	{
		id: 26,
		name: "Gold",
		maxY: 32,
		veinRadius: 3,
		blocksPerVein: 16,
		spawnChance: 12,
	},
	{
		id: 16,
		name: "Redstone",
		maxY: -64,
		veinRadius: 3,
		blocksPerVein: 20,
		spawnChance: 14,
	},
	{
		id: 18,
		name: "Diamond",
		maxY: -256,
		veinRadius: 2,
		blocksPerVein: 8,
		spawnChance: 8,
	},
	{
		id: 21,
		name: "Lapis",
		maxY: 32,
		veinRadius: 3,
		blocksPerVein: 16,
		spawnChance: 10,
	},
	{
		id: 79,
		name: "Aetherite",
		maxY: -512,
		veinRadius: 1,
		blocksPerVein: 4,
		spawnChance: 5,
	},
];

// PERF (#5): direct id comparison instead of Set.has() in the per-voxel vein loop.
const isStoneBlock = (id: number): boolean => id === 1 || id === 29;

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
	) {
		const { CHUNK_SIZE } = this.params;
		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldY = chunkY * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const chunkSizeSq = CHUNK_SIZE * CHUNK_SIZE;

		for (const ore of ORE_TYPES) {
			const chunkCenterY = chunkWorldY + CHUNK_SIZE / 2;
			if (chunkCenterY > ore.maxY) continue;

			const hash = getPRNGBySeed(
				chunkX * 374761393 + chunkY * 668265263 + chunkZ * 955191817 + ore.id,
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
			let placed = 0;

			for (let dx = -radius; dx <= radius && placed < ore.blocksPerVein; dx++) {
				for (
					let dy = -radius;
					dy <= radius && placed < ore.blocksPerVein;
					dy++
				) {
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
						if (!isStoneBlock(blocks[idx]!)) continue;

						// Shape the vein with 3D noise
						const density = this.oreNoise(wx * 0.1, wy * 0.1, wz * 0.1);
						const threshold = 0.3 + (distSq / radiusSq) * 0.4;

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
