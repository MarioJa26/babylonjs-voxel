import {
	filtersFullSunlight,
	WATER_BLOCK_ID,
} from "../World/Chunk/Worker/ChunkMesherConstants";
import {
	FACE_NX,
	FACE_NY,
	FACE_NZ,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
} from "../World/Shape/BlockShapes";
import type { Biome } from "./Biome/BiomeTypes";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";

/** Low 10 bits of a packed block value (id | state << 10). */
const PACKED_ID_MASK = 0x3ff;

/**
 * Face of our border cell that touches the neighbor, per face index:
 * [+X, -X, +Y, -Y, +Z, -Z].
 */
const BORDER_ENTER_BITS = new Uint8Array([
	FACE_PX,
	FACE_NX,
	FACE_PY,
	FACE_NY,
	FACE_PZ,
	FACE_NZ,
]);

export type LightSeedState = {
	/**
	 * Compact, independently owned snapshot of the initially seeded queue.
	 */
	queue: Uint16Array;
	length: number;
};

export class LightGenerator {
	private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y = 32;

	private static readonly _transparentLUT: Uint8Array = (() => {
		const lut = new Uint8Array(1024);
		lut[0] = 1;
		lut[WATER_BLOCK_ID] = 1;
		lut[60] = 1;
		lut[61] = 1;
		lut[64] = 1;
		lut[66] = 1;
		lut[91] = 1;
		return lut;
	})();

	private static readonly _filtersFullSunLUT: Uint8Array = (() => {
		const lut = new Uint8Array(1024);

		for (let blockId = 0; blockId < lut.length; blockId++) {
			lut[blockId] = filtersFullSunlight(blockId) ? 1 : 0;
		}

		return lut;
	})();

	private static readonly _emissionLUT: Uint8Array = (() => {
		const lut = new Uint8Array(1024);
		lut[10] = 15;
		lut[11] = 15;
		lut[24] = 15;
		lut[94] = 15;
		return lut;
	})();

	private static closedFaceMaskLUT: Uint8Array | null = null;

	private readonly chunkSize: number;
	private readonly chunkSizeSq: number;
	private readonly chunkVolume: number;
	private readonly csShift: number;
	private readonly csShift2: number;
	private readonly queueCapacity: number;
	private readonly queueMask: number;

	/**
	 * Reused by initial seeding and the immediate propagation path.
	 */
	private readonly lightQueue: Uint16Array;

	/**
	 * Allocated only if deferred propagation is actually used.
	 *
	 * Immediate-only generators therefore retain one queue rather than two.
	 */
	private scratchQueue: Uint16Array | null = null;

	public static setClosedFaceMaskLUT(lut: Uint8Array | null): void {
		LightGenerator.closedFaceMaskLUT = lut;
	}

	public static getClosedFaceMaskLUT(): Uint8Array | null {
		return LightGenerator.closedFaceMaskLUT;
	}

	constructor(params: GenerationParamsType) {
		const chunkSize = params.CHUNK_SIZE;
		const chunkSizeSq = chunkSize * chunkSize;
		const chunkVolume = chunkSizeSq * chunkSize;
		const queueCapacity = nextPowerOfTwo(chunkVolume * 2);

		this.chunkSize = chunkSize;
		this.chunkSizeSq = chunkSizeSq;
		this.chunkVolume = chunkVolume;
		this.queueCapacity = queueCapacity;
		this.queueMask = queueCapacity - 1;

		let csShift = 0;

		for (let value = chunkSize; value > 1; value >>= 1) {
			csShift++;
		}

		this.csShift = csShift;
		this.csShift2 = csShift * 2;
		this.lightQueue = new Uint16Array(queueCapacity);
	}

	/**
	 * Performs initial top-down seeding and returns an independently owned
	 * compact queue snapshot for deferred propagation.
	 */
	public seedInitialLight(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		_biome: Biome,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		topSunlightMask?: Uint8Array,
	): LightSeedState {
		const length = this.seedInitialLightIntoSharedQueue(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
		);

		// This allocation is required because lightQueue is reused by later
		// generation calls. Returning a view would corrupt deferred seeds.
		const queue = new Uint16Array(length);
		queue.set(this.lightQueue.subarray(0, length));

		return { queue, length };
	}

	/**
	 * Performs deferred BFS propagation from a stored seed snapshot.
	 */
	public propagateLight(
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		seedState: LightSeedState,
	): void {
		const initialTail = seedState.length;

		if (initialTail <= 0) {
			return;
		}

		let queue = this.scratchQueue;

		if (queue === null) {
			queue = new Uint16Array(this.queueCapacity);
			this.scratchQueue = queue;
		}

		// LightSeedState.queue is produced at exactly `length`, so no temporary
		// subarray view is required here.
		queue.set(seedState.queue, 0);

		this.propagateLightFromQueue(blocks, light, queue, initialTail);
	}

	public seedAndPropagateLightImmediate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		topSunlightMask?: Uint8Array,
	): void {
		const tail = this.seedInitialLightIntoSharedQueue(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
		);

		if (tail > 0) {
			this.propagateLightFromQueue(blocks, light, this.lightQueue, tail);
		}
	}

	public seedAndPropagateLightWithNeighbors(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		topSunlightMask: Uint8Array | undefined,
		neighborLight: ReadonlyArray<Uint8Array | null>,
	): void {
		let tail = this.seedInitialLightIntoSharedQueue(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
		);

		tail = this.seedFromNeighborBorders(blocks, light, neighborLight, tail);

		if (tail > 0) {
			this.propagateLightFromQueue(blocks, light, this.lightQueue, tail);
		}
	}

	private seedFromNeighborBorders(
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		neighborLight: ReadonlyArray<Uint8Array | null>,
		tail: number,
	): number {
		const queue = this.lightQueue;
		const queueMask = this.queueMask;
		const chunkSize = this.chunkSize;
		const chunkVolume = this.chunkVolume;
		const csShift = this.csShift;
		const csShift2 = this.csShift2;
		const csMask = chunkSize - 1;
		const transparentLUT = LightGenerator._transparentLUT;
		const closedFaceMaskLUT = LightGenerator.closedFaceMaskLUT;

		let writeTail = tail;

		for (let face = 0; face < 6; face++) {
			const neighbor = neighborLight[face];

			if (!neighbor || neighbor.length < chunkVolume) {
				continue;
			}

			const enterBit = BORDER_ENTER_BITS[face];

			for (let a = 0; a < chunkSize; a++) {
				const aY = a << csShift;

				for (let b = 0; b < chunkSize; b++) {
					const bY = b << csShift;
					const bZ = b << csShift2;

					let targetIndex: number;
					let sourceIndex: number;

					switch (face) {
						case 0:
							targetIndex = csMask | aY | bZ;
							sourceIndex = aY | bZ;
							break;

						case 1:
							targetIndex = aY | bZ;
							sourceIndex = csMask | aY | bZ;
							break;

						case 2:
							targetIndex = a | (csMask << csShift) | bZ;
							sourceIndex = a | bZ;
							break;

						case 3:
							targetIndex = a | bZ;
							sourceIndex = a | (csMask << csShift) | bZ;
							break;

						case 4:
							targetIndex = a | bY | (csMask << csShift2);
							sourceIndex = a | bY;
							break;

						default:
							targetIndex = a | bY;
							sourceIndex = a | bY | (csMask << csShift2);
							break;
					}

					const packed = blocks[targetIndex];
					const blockId = packed & PACKED_ID_MASK;

					const open = closedFaceMaskLUT
						? (closedFaceMaskLUT[packed & 0xffff] & enterBit) === 0
						: transparentLUT[blockId] !== 0;

					if (!open) {
						continue;
					}

					const sourceLight = neighbor[sourceIndex];
					const sourceSky = (sourceLight >> 4) - 1;
					const sourceBlock = (sourceLight & 0x0f) - 1;

					if (sourceSky <= 0 && sourceBlock <= 0) {
						continue;
					}

					const current = light[targetIndex];
					const currentSky = current >> 4;
					const currentBlock = current & 0x0f;

					const nextSky = sourceSky > currentSky ? sourceSky : currentSky;

					const nextBlock =
						sourceBlock > currentBlock ? sourceBlock : currentBlock;

					if (nextSky === currentSky && nextBlock === currentBlock) {
						continue;
					}

					light[targetIndex] = (nextSky << 4) | nextBlock;

					queue[writeTail & queueMask] = targetIndex;
					writeTail++;
				}
			}
		}

		return writeTail;
	}

	private seedInitialLightIntoSharedQueue(
		_chunkX: number,
		chunkY: number,
		_chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		topSunlightMask?: Uint8Array,
	): number {
		const queue = this.lightQueue;
		const chunkSize = this.chunkSize;
		const chunkSizeSq = this.chunkSizeSq;
		const transparentLUT = LightGenerator._transparentLUT;
		const filtersFullSunLUT = LightGenerator._filtersFullSunLUT;
		const emissionLUT = LightGenerator._emissionLUT;
		const closedFaceMaskLUT = LightGenerator.closedFaceMaskLUT;
		const minimumWorldY = LightGenerator.SKYLIGHT_GENERATION_MIN_WORLD_Y;

		const chunkWorldY = chunkY * chunkSize;
		let tail = 0;

		light.fill(0);

		if (chunkWorldY + chunkSize - 1 < minimumWorldY) {
			return 0;
		}

		for (let x = 0; x < chunkSize; x++) {
			for (let z = 0; z < chunkSize; z++) {
				const columnIndex = x + z * chunkSize;
				const columnBase = x + z * chunkSizeSq;

				let incomingSkyLight =
					topSunlightMask === undefined || topSunlightMask[columnIndex] !== 0
						? 15
						: 0;

				let sourceFiltersFullSun = 0;
				let index = columnBase + (chunkSize - 1) * chunkSize;

				for (let y = chunkSize - 1; y >= 0; y--, index -= chunkSize) {
					const worldY = chunkWorldY + y;

					if (worldY < minimumWorldY) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = 0;
						continue;
					}

					const packed = blocks[index];
					const blockId = packed & PACKED_ID_MASK;
					const closedFaces = closedFaceMaskLUT
						? closedFaceMaskLUT[packed & 0xffff]
						: 0;

					const blocked = closedFaceMaskLUT
						? (closedFaces & FACE_PY) !== 0
						: transparentLUT[blockId] === 0;

					if (blocked) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = 0;

						if (blockId === 24) {
							light[index] = (light[index] & 0xf0) | 15;
							queue[tail++] = index;
						}

						continue;
					}

					const blockFiltersFullSun = filtersFullSunLUT[blockId];

					if (incomingSkyLight <= 0) {
						sourceFiltersFullSun = blockFiltersFullSun;
						continue;
					}

					const preservesFullSun =
						incomingSkyLight === 15 &&
						sourceFiltersFullSun === 0 &&
						blockFiltersFullSun === 0;

					const cellSkyLight = preservesFullSun ? 15 : incomingSkyLight - 1;

					if (cellSkyLight === 0) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = blockFiltersFullSun;
						continue;
					}

					light[index] = (light[index] & 0x0f) | (cellSkyLight << 4);

					if (blockFiltersFullSun === 0 || sourceFiltersFullSun === 0) {
						queue[tail++] = index;
					}

					if (closedFaceMaskLUT && (closedFaces & FACE_NY) !== 0) {
						incomingSkyLight = 0;
					} else {
						incomingSkyLight = cellSkyLight;
					}

					sourceFiltersFullSun = blockFiltersFullSun;
				}
			}
		}

		for (let index = 0; index < blocks.length; index++) {
			const emission = emissionLUT[blocks[index] & PACKED_ID_MASK];

			if (emission > 0 && (light[index] & 0x0f) < emission) {
				light[index] = (light[index] & 0xf0) | emission;
				queue[tail++] = index;
			}
		}

		return tail;
	}

	private propagateLightFromQueue(
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		queue: Uint16Array,
		initialTail: number,
	): void {
		const mask = this.queueMask;
		const chunkSize = this.chunkSize;
		const chunkSizeSq = this.chunkSizeSq;
		const csShift = this.csShift;
		const csShift2 = this.csShift2;
		const csMask = chunkSize - 1;
		const transparentLUT = LightGenerator._transparentLUT;
		const filtersFullSunLUT = LightGenerator._filtersFullSunLUT;
		const emissionLUT = LightGenerator._emissionLUT;
		const closedFaceMaskLUT = LightGenerator.closedFaceMaskLUT;

		let head = 0;
		let tail = initialTail;

		while (head < tail) {
			const index = queue[head & mask];
			head++;

			const sourceLight = light[index];
			const skyLight = sourceLight >> 4;
			const blockLight = sourceLight & 0x0f;

			if (skyLight <= 1 && blockLight <= 1) {
				continue;
			}

			const sourcePacked = blocks[index];
			const sourceBlockId = sourcePacked & PACKED_ID_MASK;
			const sourceFiltersFullSun = filtersFullSunLUT[sourceBlockId];

			const reducedSky = skyLight - 1;
			const reducedBlock = blockLight - 1;

			if ((index & csMask) !== csMask) {
				tail = tryPropagate(
					index + 1,
					reducedSky,
					reducedBlock,
					sourceFiltersFullSun,
					false,
					FACE_NX,
					FACE_PX,
					sourcePacked,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			if ((index & csMask) !== 0) {
				tail = tryPropagate(
					index - 1,
					reducedSky,
					reducedBlock,
					sourceFiltersFullSun,
					false,
					FACE_PX,
					FACE_NX,
					sourcePacked,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			const y = (index >> csShift) & csMask;

			if (y !== csMask) {
				tail = tryPropagate(
					index + chunkSize,
					reducedSky,
					reducedBlock,
					sourceFiltersFullSun,
					false,
					FACE_NY,
					FACE_PY,
					sourcePacked,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			if (y !== 0) {
				const belowIndex = index - chunkSize;
				const belowPacked = blocks[belowIndex];
				const belowBlockId = belowPacked & PACKED_ID_MASK;
				const belowFiltersFullSun = filtersFullSunLUT[belowBlockId];

				const preservesFullSunDown =
					skyLight === 15 &&
					sourceFiltersFullSun === 0 &&
					belowFiltersFullSun === 0;

				tail = tryPropagate(
					belowIndex,
					preservesFullSunDown ? 15 : reducedSky,
					reducedBlock,
					sourceFiltersFullSun,
					true,
					FACE_PY,
					FACE_NY,
					sourcePacked,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			const z = index >> csShift2;

			if (z !== csMask) {
				tail = tryPropagate(
					index + chunkSizeSq,
					reducedSky,
					reducedBlock,
					sourceFiltersFullSun,
					false,
					FACE_NZ,
					FACE_PZ,
					sourcePacked,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			if (z !== 0) {
				tail = tryPropagate(
					index - chunkSizeSq,
					reducedSky,
					reducedBlock,
					sourceFiltersFullSun,
					false,
					FACE_PZ,
					FACE_NZ,
					sourcePacked,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}
		}
	}

	public static getLightEmission(blockId: number): number {
		return blockId >= 0 && blockId < 256
			? LightGenerator._emissionLUT[blockId]
			: 0;
	}

	public static isBlockTransparent(blockId: number): boolean {
		return (
			blockId >= 0 &&
			blockId < 1024 &&
			LightGenerator._transparentLUT[blockId] !== 0
		);
	}

	public static blockFiltersFullSunlight(blockId: number): boolean {
		return (
			blockId >= 0 &&
			blockId < 1024 &&
			LightGenerator._filtersFullSunLUT[blockId] !== 0
		);
	}
}

function tryPropagate(
	targetIndex: number,
	targetSky: number,
	targetBlock: number,
	sourceFiltersFullSun: number,
	isDown: boolean,
	enterBit: number,
	exitBit: number,
	sourcePacked: number,
	blocks: Uint8Array | Uint16Array,
	light: Uint8Array,
	queue: Uint16Array,
	tail: number,
	queueMask: number,
	transparentLUT: Uint8Array,
	filtersFullSunLUT: Uint8Array,
	emissionLUT: Uint8Array,
	closedFaceMaskLUT: Uint8Array | null,
): number {
	const targetPacked = blocks[targetIndex];
	const targetBlockId = targetPacked & PACKED_ID_MASK;

	if (closedFaceMaskLUT) {
		if ((closedFaceMaskLUT[targetPacked & 0xffff] & enterBit) !== 0) {
			return tail;
		}

		const sourceClosedFaces = closedFaceMaskLUT[sourcePacked & 0xffff];

		if (
			(sourceClosedFaces & exitBit) !== 0 &&
			emissionLUT[sourcePacked & PACKED_ID_MASK] === 0
		) {
			return tail;
		}
	} else if (transparentLUT[targetBlockId] === 0) {
		return tail;
	}

	if (
		targetSky > 0 &&
		!isDown &&
		filtersFullSunLUT[targetBlockId] !== sourceFiltersFullSun
	) {
		return tail;
	}

	const current = light[targetIndex];
	const currentSky = current >> 4;
	const currentBlock = current & 0x0f;

	const nextSky = targetSky > currentSky ? targetSky : currentSky;

	const nextBlock = targetBlock > currentBlock ? targetBlock : currentBlock;

	if (nextSky === currentSky && nextBlock === currentBlock) {
		return tail;
	}

	light[targetIndex] = (nextSky << 4) | nextBlock;
	queue[tail & queueMask] = targetIndex;

	return tail + 1;
}

/** Returns the smallest power of two greater than or equal to n. */
function nextPowerOfTwo(n: number): number {
	if (n <= 1) {
		return 1;
	}

	let power = 1;

	while (power < n) {
		power *= 2;
	}

	return power;
}
