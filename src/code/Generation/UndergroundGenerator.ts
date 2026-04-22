import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";

export class UndergroundGenerator {
	private params: GenerationParamsType;
	private caveNoise: (x: number, y: number, z: number) => number;

	constructor(
		params: GenerationParamsType,
		caveNoise: (x: number, y: number, z: number) => number,
	) {
		this.params = params;
		this.caveNoise = caveNoise;
	}

	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow?: boolean,
		) => void,
	) {
		const { CHUNK_SIZE } = this.params;
		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const chunkWorldY = chunkY * CHUNK_SIZE;

		const MIN_CAVE_DENSITY = 0.000001;
		const MAX_CAVE_DENSITY = 1.0;

		const DENSITY_TRANSITION_DEPTH = -32;
		const LAVA_LEVEL = -16 * 100;

		for (let localY = 0; localY < CHUNK_SIZE; localY++) {
			const worldY = chunkWorldY + localY;
			if (worldY >= -2) continue; // Optimization: skip if above cave level

			const t = Math.min(1, worldY / DENSITY_TRANSITION_DEPTH);
			const caveDensity = MIN_CAVE_DENSITY * t + MAX_CAVE_DENSITY * (1 - t);

			for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
				const worldZ = chunkWorldZ + localZ;
				for (let localX = 0; localX < CHUNK_SIZE; localX++) {
					const worldX = chunkWorldX + localX;
					const noiseValue = this.caveNoise(worldX, worldY, worldZ);

					if (noiseValue > caveDensity) {
						const blockId = worldY < LAVA_LEVEL ? 24 : 0; // Lava or Air
						placeBlock(worldX, worldY, worldZ, blockId, true);
					}
				}
			}
		}
	}
}
