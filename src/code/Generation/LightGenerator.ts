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
		// Virtual shape variants inherit source transparency (glass stairs
		// read as glass, not opaque).
		for (const source of [WATER_BLOCK_ID, 60, 61, 64, 66, 91]) {
			const base = 500 + (source - 1) * 5;
			for (let i = 0; i < 5; i++) {
				const virtualId = base + i;
				if (virtualId >= 0 && virtualId < lut.length) lut[virtualId] = 1;
			}
		}
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

	/**
	 * Reused by initial seeding and the immediate propagation path. Sized to
	 * exactly `chunkVolume`: with the deduplicated `queued` stamp set a voxel
	 * can never be pending twice, so the ring can never wrap around and
	 * overwrite an unprocessed entry.
	 */
	private readonly lightQueue: Uint16Array;

	/**
	 * Stamp set: `queued[i] !== 0` means voxel `i` already has a pending
	 * queue entry. Enqueueing a voxel that is already pending is a no-op —
	 * its (possibly increased) light value is read fresh when it is popped.
	 */
	private readonly queued: Uint8Array;

	/**
	 * Allocated only if deferred propagation is actually used.
	 *
	 * Immediate-only generators therefore retain one queue rather than two.
	 */
	private scratchQueue: Uint16Array | null = null;

	/**
	 * Epoch used to clear the `queued` stamp set without a full O(volume)
	 * reset; wraps to a fresh fill after it would overflow.
	 */
	private queuedEpoch = 1;

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

		this.chunkSize = chunkSize;
		this.chunkSizeSq = chunkSizeSq;
		this.chunkVolume = chunkVolume;
		this.lightQueue = new Uint16Array(chunkVolume);
		this.queued = new Uint8Array(chunkVolume);
	}

	/**
	 * Lowest Y that may contain a light source in a generated chunk.
	 *
	 * Chunks entirely below this get an all-zero light array, which keeps the
	 * skylight column pass off the (vast majority of) solid deep chunks. The
	 * side effect is that a torch or lava placed at generation time down there
	 * emits nothing. Structures that build lit interiors below this line
	 * (MayaTempleFeature's dungeon) pass a lower floor so their emission seeds
	 * are still collected. Player-placed torches are unaffected: the block-edit
	 * path adds emission at any depth.
	 */
	public static readonly EMISSION_MIN_WORLD_Y =
		LightGenerator.SKYLIGHT_GENERATION_MIN_WORLD_Y;

	/**
	 * Emission floor used for chunks that contain a sealed structure. Deep
	 * enough to cover the lowest dungeon level (MAYA_MIN_DUNGEON_Y = -48) with
	 * room for the surrounding rock, but still far above the -128 floor below
	 * which `relightChunk` and friends bail out entirely.
	 */
	public static readonly SEALED_EMISSION_MIN_WORLD_Y = -96;

	/**
	 * Clears the pending-voxel stamp set. Bumps the epoch instead of doing an
	 * O(volume) fill so repeated seeding stays cheap; because the stamps are
	 * stored in a Uint8Array the epoch must stay in 1..255, so the array is
	 * zeroed and the epoch reset before it would overflow.
	 */
	private resetQueued(): void {
		this.queuedEpoch++;

		if (this.queuedEpoch > 255) {
			this.queued.fill(0);
			this.queuedEpoch = 1;
		}
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
		emissionMinWorldY: number = LightGenerator.EMISSION_MIN_WORLD_Y,
	): LightSeedState {
		const length = this.seedInitialLightIntoSharedQueue(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
			emissionMinWorldY,
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
			queue = new Uint16Array(this.chunkVolume);
			this.scratchQueue = queue;
		}

		// Clear the pending stamp set, copy the saved seeds in, then mark each
		// copied index as queued so propagation never enqueues a seed twice.
		this.resetQueued();
		queue.set(seedState.queue, 0);

		for (let i = 0; i < initialTail; i++) {
			this.queued[queue[i]] = this.queuedEpoch;
		}

		this.propagateLightFromQueue(blocks, light, queue, initialTail);
	}

	public seedAndPropagateLightImmediate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		topSunlightMask?: Uint8Array,
		emissionMinWorldY: number = LightGenerator.EMISSION_MIN_WORLD_Y,
	): void {
		const tail = this.seedInitialLightIntoSharedQueue(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
			emissionMinWorldY,
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
		emissionMinWorldY: number = LightGenerator.EMISSION_MIN_WORLD_Y,
	): void {
		let tail = this.seedInitialLightIntoSharedQueue(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
			emissionMinWorldY,
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
		const chunkSize = this.chunkSize;
		const chunkSizeSq = this.chunkSizeSq;
		const chunkVolume = this.chunkVolume;
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
				const aY = a * chunkSize;

				for (let b = 0; b < chunkSize; b++) {
					const bY = b * chunkSize;
					const bZ = b * chunkSizeSq;

					let targetIndex: number;
					let sourceIndex: number;

					switch (face) {
						case 0:
							targetIndex = csMask + aY + bZ;
							sourceIndex = aY + bZ;
							break;

						case 1:
							targetIndex = aY + bZ;
							sourceIndex = csMask + aY + bZ;
							break;

						case 2:
							targetIndex = a + csMask * chunkSize + bZ;
							sourceIndex = a + bZ;
							break;

						case 3:
							targetIndex = a + bZ;
							sourceIndex = a + csMask * chunkSize + bZ;
							break;

						case 4:
							targetIndex = a + bY + csMask * chunkSizeSq;
							sourceIndex = a + bY;
							break;

						default:
							targetIndex = a + bY;
							sourceIndex = a + bY + csMask * chunkSizeSq;
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

					writeTail = enqueue(
						queue,
						writeTail,
						targetIndex,
						this.queued,
						this.queuedEpoch,
					);
				}
			}
		}

		return writeTail;
	}

	private seedInitialLightIntoSharedQueue(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		topSunlightMask: Uint8Array | undefined,
		emissionMinWorldY: number = LightGenerator.EMISSION_MIN_WORLD_Y,
	): number {
		const queue = this.lightQueue;
		const chunkSize = this.chunkSize;
		const chunkSizeSq = this.chunkSizeSq;
		const chunkVolume = this.chunkVolume;
		const transparentLUT = LightGenerator._transparentLUT;
		const filtersFullSunLUT = LightGenerator._filtersFullSunLUT;
		const emissionLUT = LightGenerator._emissionLUT;
		const closedFaceMaskLUT = LightGenerator.closedFaceMaskLUT;
		const minimumWorldY = emissionMinWorldY;

		const chunkWorldY = chunkY * chunkSize;
		let tail = 0;

		this.resetQueued();
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
							tail = enqueue(queue, tail, index, this.queued, this.queuedEpoch);
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
						tail = enqueue(queue, tail, index, this.queued, this.queuedEpoch);
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

		for (let index = 0; index < chunkVolume; index++) {
			const emission = emissionLUT[blocks[index] & PACKED_ID_MASK];

			if (emission > 0 && (light[index] & 0x0f) < emission) {
				light[index] = (light[index] & 0xf0) | emission;
				tail = enqueue(queue, tail, index, this.queued, this.queuedEpoch);
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
		const volume = this.chunkVolume;
		const chunkSize = this.chunkSize;
		const chunkSizeSq = this.chunkSizeSq;
		const maxCoordinate = chunkSize - 1;

		const queued = this.queued;
		const epoch = this.queuedEpoch;

		const transparentLUT = LightGenerator._transparentLUT;
		const filtersFullSunLUT = LightGenerator._filtersFullSunLUT;
		const emissionLUT = LightGenerator._emissionLUT;
		const closedFaceMaskLUT = LightGenerator.closedFaceMaskLUT;

		let head = 0;
		let headSlot = 0;
		let tail = initialTail;

		while (head < tail) {
			const index = queue[headSlot];

			head++;
			headSlot++;

			if (headSlot === volume) {
				headSlot = 0;
			}

			// Allow this voxel to be queued again if a stronger light value reaches
			// it after the current entry has been processed.
			queued[index] = 0;

			const sourceLight = light[index];
			const skyLight = sourceLight >>> 4;
			const blockLight = sourceLight & 0x0f;

			if (skyLight <= 1 && blockLight <= 1) {
				continue;
			}

			const sourcePacked = blocks[index];
			const sourceBlockId = sourcePacked & PACKED_ID_MASK;
			const sourceFiltersFullSun = filtersFullSunLUT[sourceBlockId];

			const reducedSky = skyLight - 1;
			const reducedBlock = blockLight - 1;

			/*
			 * Convert the linear index without leaving fractional intermediate
			 * values. The previous expressions:
			 *
			 *   (index / chunkSize) % chunkSize
			 *   index / chunkSizeSq
			 *
			 * produced non-integer coordinates for most voxels, so boundary
			 * comparisons such as `y !== maxCoordinate` were incorrect.
			 */
			const x = index % chunkSize;
			const yz = (index - x) / chunkSize;
			const y = yz % chunkSize;
			const z = (yz - y) / chunkSize;

			if (x < maxCoordinate) {
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
					queued,
					epoch,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			if (x > 0) {
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
					queued,
					epoch,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			if (y < maxCoordinate) {
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
					queued,
					epoch,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			if (y > 0) {
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
					queued,
					epoch,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			if (z < maxCoordinate) {
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
					queued,
					epoch,
					transparentLUT,
					filtersFullSunLUT,
					emissionLUT,
					closedFaceMaskLUT,
				);
			}

			if (z > 0) {
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
					queued,
					epoch,
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
		if (typeof blockId !== "number" || !Number.isFinite(blockId)) return false;
		const id = Math.floor(blockId);
		if (id >= 0 && id < 1024) {
			if (LightGenerator._transparentLUT[id] !== 0) return true;
		}
		// Fallback beyond the LUT: virtual -> source inheritance.
		if (id >= 500) {
			const source = Math.floor((id - 500) / 5) + 1;
			return (
				source === 0 ||
				source === WATER_BLOCK_ID ||
				source === 60 ||
				source === 61 ||
				source === 64 ||
				source === 66 ||
				source === 91
			);
		}
		return false;
	}

	public static blockFiltersFullSunlight(blockId: number): boolean {
		if (typeof blockId !== "number" || !Number.isFinite(blockId)) return false;
		const id = Math.floor(blockId);
		if (id >= 0 && id < 1024) {
			if (LightGenerator._filtersFullSunLUT[id] !== 0) return true;
		}
		if (id >= 500) {
			return Math.floor((id - 500) / 5) + 1 === WATER_BLOCK_ID;
		}
		return false;
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
	queued: Uint8Array,
	epoch: number,
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

	return enqueue(queue, tail, targetIndex, queued, epoch);
}

/**
 * Appends `index` to the volume-bounded queue only if it is not already
 * pending, stamping it as queued.
 *
 * A voxel is therefore held at most once at a time: if its light value rises
 * while it is pending, the duplicate write is dropped and the latest value is
 * read when the voxel is eventually popped. Because the number of *simultaneously
 * pending* voxels can never exceed the chunk volume, the `volume`-sized ring
 * can never wrap around and clobber an unprocessed entry. The ring wraps with
 * `% volume` (not a power-of-two mask) so it stays correct for any chunk size.
 */
function enqueue(
	queue: Uint16Array,
	tail: number,
	index: number,
	queued: Uint8Array,
	epoch: number,
): number {
	if (queued[index] === epoch) {
		return tail;
	}

	queued[index] = epoch;
	queue[tail % queue.length] = index;

	return tail + 1;
}
