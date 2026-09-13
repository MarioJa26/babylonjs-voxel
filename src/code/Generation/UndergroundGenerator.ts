import { CHUNK_SIZE } from "../Lib/VoxelMath";
import { WATER_BLOCK_ID } from "../World/Chunk/Worker/ChunkMesherConstants";
import {
	CAVE_FLAG_CARVED,
	CAVE_FLAG_TUNNEL_CORE,
	clamp01,
	evaluateCaveCarve,
} from "./CaveCarver";
import { CaveNoiseGrid } from "./CaveNoiseGrid";
import type { NoiseInstance } from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";

const MIN_SOLID_NEIGHBORS = 5;
const SMOOTHING_PASSES = 2;

const MAX_CHUNK_VOLUME = 32 * 32 * 32;
const _carve = new Uint8Array(MAX_CHUNK_VOLUME);
const _caveSample = new Float32Array(3);
const _carvedIndices = new Uint32Array(MAX_CHUNK_VOLUME);

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
		cheeseInstance?: NoiseInstance,
		tunnelInstance?: NoiseInstance,
		detailInstance?: NoiseInstance,
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
			cheeseInstance,
			tunnelInstance,
			detailInstance,
		);
	}

	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		topSurfaceYMap: Int16Array,
		placeBlockLocal: (
			lx: number,
			ly: number,
			lz: number,
			id: number,
			ow?: boolean,
		) => void,
		blocks?: Uint8Array,
	): void {
		const LAVA_LEVEL = this.LAVA_LEVEL;
		const params = this.params;

		const cs = CHUNK_SIZE;
		const cs2 = cs * cs;
		const vol = cs * cs2;
		const chunkWorldY = chunkY * cs;

		// Preserve existing behavior: without a block buffer, the old code found no
		// solid voxels and returned before doing cave work.
		if (!blocks) {
			return;
		}

		// PERF: Caves only matter if the chunk contains at least one non-air,
		// non-water block. This skips cave-grid sampling for empty/water chunks.
		let hasSolid = false;
		for (let i = 0; i < vol; i++) {
			const block = blocks[i];
			if (block !== 0 && block !== WATER_BLOCK_ID) {
				hasSolid = true;
				break;
			}
		}

		if (!hasSolid) {
			return;
		}

		// PERF: Reuse pre-sampled cave noise grid instead of allocating per chunk.
		this.caveGrid.reset(chunkX, chunkY, chunkZ, cs);

		_carve.fill(0, 0, vol);

		const fullDepthDenom = Math.max(
			1,
			params.CAVE_SURFACE_BLEND_UPPER - params.CAVE_FULL_DENSITY_DEPTH,
		);

		let carvedCount = 0;

		for (let localY = 0; localY < cs; localY++) {
			const worldY = chunkWorldY + localY;
			const yBase = localY * cs;

			const depthT = clamp01(
				(worldY - params.CAVE_FULL_DENSITY_DEPTH) / fullDepthDenom,
			);

			const caveDensity =
				params.CAVE_DENSITY_MIN * (1 - depthT) +
				params.CAVE_DENSITY_MAX * depthT;

			for (let localZ = 0; localZ < cs; localZ++) {
				const yzBase = yBase + localZ * cs2;
				const surfaceMapBase = localZ * cs;

				for (let localX = 0; localX < cs; localX++) {
					const idx = yzBase + localX;

					// PERF: Skip voxels already carved to air by terrain generation.
					if (blocks[idx] === 0) {
						continue;
					}

					this.caveGrid.get3(localX, localY, localZ, _caveSample);

					const cave = evaluateCaveCarve(
						params,
						worldY,
						topSurfaceYMap[surfaceMapBase + localX],
						_caveSample[0],
						_caveSample[1],
						_caveSample[2],
						undefined,
						caveDensity,
					);

					if (!cave.shouldCarve) {
						continue;
					}

					_carve[idx] =
						CAVE_FLAG_CARVED | (cave.tunnelCore ? CAVE_FLAG_TUNNEL_CORE : 0);

					_carvedIndices[carvedCount++] = idx;
				}
			}
		}

		if (carvedCount === 0) {
			return;
		}

		const inner = cs - 1;

		for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
			let writeCount = 0;
			let changed = false;

			for (let i = 0; i < carvedCount; i++) {
				const idx = _carvedIndices[i];

				if ((_carve[idx] & CAVE_FLAG_CARVED) === 0) {
					changed = true;
					continue;
				}

				const localZ = (idx / cs2) | 0;
				const rem = idx - localZ * cs2;
				const localY = (rem / cs) | 0;
				const localX = rem - localY * cs;

				// Match the original smoother: only interior cells are smoothed.
				if (
					localX <= 0 ||
					localX >= inner ||
					localY <= 0 ||
					localY >= inner ||
					localZ <= 0 ||
					localZ >= inner
				) {
					_carvedIndices[writeCount++] = idx;
					continue;
				}

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
					(!tunnelCore && solidNeighbors >= MIN_SOLID_NEIGHBORS) ||
					(!tunnelCore && solidNeighbors >= 3 && carvedNeighbors <= 2)
				) {
					_carve[idx] = 0;
					changed = true;
					continue;
				}

				_carvedIndices[writeCount++] = idx;
			}

			carvedCount = writeCount;

			if (!changed || carvedCount === 0) {
				break;
			}
		}

		for (let i = 0; i < carvedCount; i++) {
			const idx = _carvedIndices[i];

			if ((_carve[idx] & CAVE_FLAG_CARVED) === 0) {
				continue;
			}

			const localZ = (idx / cs2) | 0;
			const rem = idx - localZ * cs2;
			const localY = (rem / cs) | 0;
			const localX = rem - localY * cs;

			const worldY = chunkWorldY + localY;
			const blockId = worldY < LAVA_LEVEL ? 24 : 0;

			placeBlockLocal(localX, localY, localZ, blockId, true);
		}
	}
}
