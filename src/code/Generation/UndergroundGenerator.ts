import {
	CAVE_FLAG_CARVED,
	CAVE_FLAG_TUNNEL_CORE,
	evaluateCaveCarve,
	NO_SURFACE_Y,
} from "./CaveCarver";
import { CaveNoiseGrid } from "./CaveNoiseGrid";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";

const MIN_SOLID_NEIGHBORS = 5;
const SMOOTHING_PASSES = 2;

const MAX_CHUNK_VOLUME = 32 * 32 * 32;
const _carve = new Uint8Array(MAX_CHUNK_VOLUME);

export class UndergroundGenerator {
	private readonly params: GenerationParamsType;
	private readonly CHUNK_SIZE: number;
	private readonly LAVA_LEVEL: number;

	private readonly cheeseNoise: (x: number, y: number, z: number) => number;
	private readonly tunnelNoise: (x: number, y: number, z: number) => number;
	private readonly detailNoise: (x: number, y: number, z: number) => number;

	private readonly caveGrid: CaveNoiseGrid;

	constructor(
		params: GenerationParamsType,
		cheeseNoise: (x: number, y: number, z: number) => number,
		tunnelNoise: (x: number, y: number, z: number) => number,
		detailNoise: (x: number, y: number, z: number) => number,
	) {
		this.params = params;
		this.CHUNK_SIZE = params.CHUNK_SIZE;
		this.LAVA_LEVEL = params.LAVA_LEVEL;

		this.cheeseNoise = cheeseNoise;
		this.tunnelNoise = tunnelNoise;
		this.detailNoise = detailNoise;

		this.caveGrid = new CaveNoiseGrid(
			0,
			0,
			0,
			this.CHUNK_SIZE,
			4,
			this.cheeseNoise,
			this.tunnelNoise,
			this.detailNoise,
		);
	}

	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		topSurfaceYMap: Int16Array,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow?: boolean,
		) => void,
		blocks?: Uint8Array,
	): void {
		const CHUNK_SIZE = this.CHUNK_SIZE;
		const LAVA_LEVEL = this.LAVA_LEVEL;
		const params = this.params;

		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const chunkWorldY = chunkY * CHUNK_SIZE;

		const cs = CHUNK_SIZE;
		const cs2 = cs * cs;
		const vol = cs * cs2;

		// PERF: Reuse pre-sampled cave noise grid instead of allocating new one per chunk.
		this.caveGrid.reset(chunkX, chunkY, chunkZ, cs);

		_carve.fill(0, 0, vol);

		for (let localY = 0; localY < cs; localY++) {
			const worldY = chunkWorldY + localY;
			const yBase = localY * cs;

			for (let localZ = 0; localZ < cs; localZ++) {
				const yzBase = yBase + localZ * cs2;

				for (let localX = 0; localX < cs; localX++) {
					const surfaceY = topSurfaceYMap[localX + localZ * cs] ?? NO_SURFACE_Y;

					// PERF: Skip voxels already carved to air by terrain generation.
					if (blocks) {
						const blockIdx = localX + localY * cs + localZ * cs2;
						if (blocks[blockIdx] === 0) continue;
					}

					const cave = evaluateCaveCarve(
						params,
						worldY,
						surfaceY,
						this.caveGrid.getCheese(localX, localY, localZ),
						this.caveGrid.getTunnel(localX, localY, localZ),
						this.caveGrid.getDetail(localX, localY, localZ),
					);
					if (!cave.shouldCarve) continue;

					_carve[yzBase + localX] =
						CAVE_FLAG_CARVED | (cave.tunnelCore ? CAVE_FLAG_TUNNEL_CORE : 0);
				}
			}
		}

		const inner = cs - 1;
		for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
			for (let localY = 1; localY < inner; localY++) {
				const yBase = localY * cs;
				for (let localZ = 1; localZ < inner; localZ++) {
					const yzBase = yBase + localZ * cs2;
					for (let localX = 1; localX < inner; localX++) {
						const idx = yzBase + localX;
						if ((_carve[idx] & CAVE_FLAG_CARVED) === 0) continue;

						const carvedNeighbors =
							((_carve[idx - 1] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
							((_carve[idx + 1] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
							((_carve[idx - cs2] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
							((_carve[idx + cs2] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
							((_carve[idx - cs] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
							((_carve[idx + cs] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0);
						const solidNeighbors = 6 - carvedNeighbors;
						const tunnelCore =
							(_carve[idx] & CAVE_FLAG_TUNNEL_CORE) === CAVE_FLAG_TUNNEL_CORE;

						if (
							(!tunnelCore && carvedNeighbors <= 1) ||
							solidNeighbors >= MIN_SOLID_NEIGHBORS ||
							(!tunnelCore && solidNeighbors >= 3 && carvedNeighbors <= 2)
						) {
							_carve[idx] = 0;
						}
					}
				}
			}
		}

		for (let localY = 0; localY < cs; localY++) {
			const worldY = chunkWorldY + localY;
			const blockId = worldY < LAVA_LEVEL ? 24 : 0;
			const yBase = localY * cs;

			for (let localZ = 0; localZ < cs; localZ++) {
				const worldZ = chunkWorldZ + localZ;
				const yzBase = yBase + localZ * cs2;

				for (let localX = 0; localX < cs; localX++) {
					if ((_carve[yzBase + localX] & CAVE_FLAG_CARVED) === 0) continue;
					placeBlock(chunkWorldX + localX, worldY, worldZ, blockId, true);
				}
			}
		}
	}
}
