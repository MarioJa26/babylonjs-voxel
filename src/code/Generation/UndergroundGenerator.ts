import { WATER_BLOCK_ID } from "../World/Chunk/Worker/ChunkMesherConstants";
import {
	CAVE_FLAG_CARVED,
	CAVE_FLAG_TUNNEL_CORE,
	evaluateCaveCarve,
} from "./CaveCarver";
import { CaveNoiseGrid } from "./CaveNoiseGrid";
import type { NoiseInstance } from "./NoiseAndParameters/FastNoise/FastNoiseFactory";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { fillMineshaftSealMask } from "./Structure/MineshaftSeal";
import { fillSealColumnMask } from "./Structure/StructureSeal";

const MIN_SOLID_NEIGHBORS = 5;
const SMOOTHING_PASSES = 2;

const MAX_CHUNK_EDGE = 32;
const MAX_CHUNK_VOLUME = MAX_CHUNK_EDGE * MAX_CHUNK_EDGE * MAX_CHUNK_EDGE;

const _carve = new Uint8Array(MAX_CHUNK_VOLUME);
const _caveSample = new Float32Array(3);

const _carvedIndices = new Uint32Array(MAX_CHUNK_VOLUME);

/*
 * Store voxel coordinates alongside each carved index.
 *
 * This costs about 96 KiB of persistent scratch storage, but removes index
 * division and remainder operations from both smoothing passes and final
 * block placement.
 */
const _carvedX = new Uint8Array(MAX_CHUNK_VOLUME);
const _carvedY = new Uint8Array(MAX_CHUNK_VOLUME);
const _carvedZ = new Uint8Array(MAX_CHUNK_VOLUME);

/**
 * Per-column seal flag, indexed as localX + localZ * chunkSize.
 * The larger fixed allocation is retained for compatibility with the seal
 * helpers, which may clear or address the supplied scratch buffer directly.
 */
const _sealColumns = new Uint8Array(MAX_CHUNK_VOLUME);

export class UndergroundGenerator {
	private readonly params: GenerationParamsType;
	private readonly CHUNK_SIZE: number;
	private readonly LAVA_LEVEL: number;

	private readonly cheeseNoise: (x: number, y: number, z: number) => number;

	private readonly tunnelNoise: (x: number, y: number, z: number) => number;

	private readonly detailNoise: (x: number, y: number, z: number) => number;

	private readonly caveGrid: CaveNoiseGrid;

	public constructor(
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
			cheeseNoise,
			tunnelNoise,
			detailNoise,
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
		seedAsInt?: number,
	): boolean {
		if (blocks === undefined) {
			return false;
		}

		const params = this.params;
		const chunkSize = this.CHUNK_SIZE;
		const chunkSizeSq = chunkSize * chunkSize;
		const chunkVolume = chunkSizeSq * chunkSize;

		if (chunkVolume > MAX_CHUNK_VOLUME) {
			throw new Error(
				`UndergroundGenerator chunk volume ${chunkVolume} exceeds ` +
					`scratch capacity ${MAX_CHUNK_VOLUME}.`,
			);
		}

		if (topSurfaceYMap.length < chunkSizeSq) {
			throw new Error(
				`UndergroundGenerator topSurfaceYMap is too small. ` +
					`Expected at least ${chunkSizeSq}, got ${topSurfaceYMap.length}.`,
			);
		}

		if (blocks.length < chunkVolume) {
			throw new Error(
				`UndergroundGenerator block buffer is too small. ` +
					`Expected at least ${chunkVolume}, got ${blocks.length}.`,
			);
		}

		/*
		 * Avoid constructing the cave-noise grid for chunks containing only
		 * air and water.
		 */
		let hasSolidBlock = false;

		for (let index = 0; index < chunkVolume; index++) {
			const blockId = blocks[index];

			if (blockId !== 0 && blockId !== WATER_BLOCK_ID) {
				hasSolidBlock = true;
				break;
			}
		}

		if (!hasSolidBlock) {
			return false;
		}

		/*
		 * Build the structure protection mask before evaluating caves.
		 */
		let sealActive = false;
		let sealMinY = 0;
		let sealMaxY = -1;

		if (seedAsInt !== undefined) {
			const templeSeal = fillSealColumnMask(
				chunkX,
				chunkZ,
				chunkSize,
				seedAsInt,
				_sealColumns,
			);

			if (templeSeal.hasSeal) {
				sealActive = true;
				sealMinY = templeSeal.minY;
				sealMaxY = templeSeal.maxY;
			}

			const mineshaftSeal = fillMineshaftSealMask(
				chunkX,
				chunkZ,
				chunkSize,
				seedAsInt,
				_sealColumns,
			);

			if (mineshaftSeal.hasSeal) {
				if (!sealActive) {
					sealActive = true;
					sealMinY = mineshaftSeal.minY;
					sealMaxY = mineshaftSeal.maxY;
				} else {
					if (mineshaftSeal.minY < sealMinY) {
						sealMinY = mineshaftSeal.minY;
					}

					if (mineshaftSeal.maxY > sealMaxY) {
						sealMaxY = mineshaftSeal.maxY;
					}
				}
			}
		}

		this.caveGrid.reset(chunkX, chunkY, chunkZ, chunkSize);

		_carve.fill(0, 0, chunkVolume);

		const chunkWorldY = chunkY * chunkSize;

		const caveFullDensityDepth = params.CAVE_FULL_DENSITY_DEPTH;

		const caveDensityMin = params.CAVE_DENSITY_MIN;

		const caveDensityDelta = params.CAVE_DENSITY_MAX - caveDensityMin;

		const fullDepthDenominator = Math.max(
			1,
			params.CAVE_SURFACE_BLEND_UPPER - caveFullDensityDepth,
		);

		const inverseFullDepthDenominator = 1 / fullDepthDenominator;

		let carvedCount = 0;

		/*
		 * Memory layout:
		 *
		 * index = localX
		 *       + localY * chunkSize
		 *       + localZ * chunkSizeSq
		 *
		 * The loop order retains contiguous X traversal while incrementally
		 * maintaining index bases.
		 */
		let yBase = 0;

		for (let localY = 0; localY < chunkSize; localY++, yBase += chunkSize) {
			const worldY = chunkWorldY + localY;

			const ySealed = sealActive && worldY >= sealMinY && worldY <= sealMaxY;

			const unclampedDepthT =
				(worldY - caveFullDensityDepth) * inverseFullDepthDenominator;

			const depthT =
				unclampedDepthT <= 0 ? 0 : unclampedDepthT >= 1 ? 1 : unclampedDepthT;

			const caveDensity = caveDensityMin + caveDensityDelta * depthT;

			let voxelBase = yBase;
			let surfaceMapBase = 0;

			for (
				let localZ = 0;
				localZ < chunkSize;
				localZ++, voxelBase += chunkSizeSq, surfaceMapBase += chunkSize
			) {
				let index = voxelBase;

				for (let localX = 0; localX < chunkSize; localX++, index++) {
					/*
					 * Preserve the existing behavior: water and other non-air
					 * blocks remain eligible for cave evaluation. Only voxels
					 * already carved to air are skipped.
					 */
					if (blocks[index] === 0) {
						continue;
					}

					if (ySealed && _sealColumns[surfaceMapBase + localX] !== 0) {
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

					_carve[index] =
						CAVE_FLAG_CARVED | (cave.tunnelCore ? CAVE_FLAG_TUNNEL_CORE : 0);

					_carvedIndices[carvedCount] = index;
					_carvedX[carvedCount] = localX;
					_carvedY[carvedCount] = localY;
					_carvedZ[carvedCount] = localZ;

					carvedCount++;
				}
			}
		}

		if (carvedCount === 0) {
			return sealActive;
		}

		const lastLocal = chunkSize - 1;

		/*
		 * Compact surviving carved voxels in place after every smoothing pass.
		 *
		 * The original three non-tunnel-core removal conditions simplify to:
		 *
		 *     carvedNeighbors <= 2
		 *
		 * because solidNeighbors is always 6 - carvedNeighbors.
		 */
		for (let pass = 0; pass < SMOOTHING_PASSES && carvedCount > 0; pass++) {
			let survivorCount = 0;
			let removedAny = false;

			for (let readIndex = 0; readIndex < carvedCount; readIndex++) {
				const voxelIndex = _carvedIndices[readIndex];
				const flags = _carve[voxelIndex];

				if ((flags & CAVE_FLAG_CARVED) === 0) {
					removedAny = true;
					continue;
				}

				const localX = _carvedX[readIndex];
				const localY = _carvedY[readIndex];
				const localZ = _carvedZ[readIndex];

				/*
				 * Boundary voxels must remain untouched because neighboring
				 * chunks are evaluated independently.
				 */
				if (
					localX === 0 ||
					localX === lastLocal ||
					localY === 0 ||
					localY === lastLocal ||
					localZ === 0 ||
					localZ === lastLocal
				) {
					_carvedIndices[survivorCount] = voxelIndex;
					_carvedX[survivorCount] = localX;
					_carvedY[survivorCount] = localY;
					_carvedZ[survivorCount] = localZ;
					survivorCount++;
					continue;
				}

				const carvedNeighbors =
					((_carve[voxelIndex - 1] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
					((_carve[voxelIndex + 1] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
					((_carve[voxelIndex - chunkSize] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
					((_carve[voxelIndex + chunkSize] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0) +
					((_carve[voxelIndex - chunkSizeSq] & CAVE_FLAG_CARVED) !== 0
						? 1
						: 0) +
					((_carve[voxelIndex + chunkSizeSq] & CAVE_FLAG_CARVED) !== 0 ? 1 : 0);

				const tunnelCore = (flags & CAVE_FLAG_TUNNEL_CORE) !== 0;

				if (!tunnelCore && carvedNeighbors <= 2) {
					_carve[voxelIndex] = 0;
					removedAny = true;
					continue;
				}

				_carvedIndices[survivorCount] = voxelIndex;
				_carvedX[survivorCount] = localX;
				_carvedY[survivorCount] = localY;
				_carvedZ[survivorCount] = localZ;
				survivorCount++;
			}

			carvedCount = survivorCount;

			if (!removedAny) {
				break;
			}
		}

		const lavaLevel = this.LAVA_LEVEL;

		for (let i = 0; i < carvedCount; i++) {
			const localX = _carvedX[i];
			const localY = _carvedY[i];
			const localZ = _carvedZ[i];

			const blockId = chunkWorldY + localY < lavaLevel ? 24 : 0;

			placeBlockLocal(localX, localY, localZ, blockId, true);
		}

		return sealActive;
	}
}
