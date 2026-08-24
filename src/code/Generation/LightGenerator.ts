import {
	filtersFullSunlight,
	WATER_BLOCK_ID,
} from "../World/Chunk/Worker/ChunkMesherConstants";
import type { Biome } from "./Biome/BiomeTypes";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";

export type LightSeedState = {
	/**
	 * Compact snapshot of the initially seeded light queue.
	 * This is safe to store and propagate later even if the generator instance
	 * is reused for other chunks in the meantime.
	 */
	queue: Uint16Array;
	length: number;
};

export class LightGenerator {
	private readonly chunkSize: number;
	private readonly chunkSizeSq: number;
	private readonly csShift: number;
	private readonly csShift2: number;
	private readonly queueMask: number;

	/**
	 * Reusable queue buffer for the immediate path.
	 *
	 * Capacity is intentionally larger than chunk volume because seeding can add:
	 * - skylight entries
	 * - block emission entries
	 *
	 * In the densest case those can both approach chunk volume.
	 */
	private readonly lightQueue: Uint16Array;

	/**
	 * Instance-local scratch buffer for deferred propagation.
	 * Avoids cross-instance/static state corruption when different chunk sizes exist.
	 */
	private readonly scratchQueue: Uint16Array;

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

	constructor(params: GenerationParamsType) {
		const chunkSize = params.CHUNK_SIZE;
		const chunkSizeSq = chunkSize * chunkSize;
		const rawCap = chunkSize * chunkSizeSq;

		/*
		 * Seeding can enqueue up to roughly:
		 * - every cell due to skylight
		 * - every cell due to block emission
		 *
		 * The old queue size of rawCap could silently overwrite entries before
		 * seedInitialLight() sliced the compact snapshot.
		 */
		const queueCapacity = nextPowerOfTwo(rawCap * 2);

		this.chunkSize = chunkSize;
		this.chunkSizeSq = chunkSizeSq;
		this.queueMask = queueCapacity - 1;

		// CHUNK_SIZE is expected to be a power of two.
		let csShift = 0;
		for (let m = chunkSize; m > 1; m >>= 1) {
			csShift++;
		}

		this.csShift = csShift;
		this.csShift2 = csShift * 2;

		this.lightQueue = new Uint16Array(queueCapacity);
		this.scratchQueue = new Uint16Array(queueCapacity);
	}

	/**
	 * First-paint lighting path:
	 * Performs only the initial top-down light seeding and returns a compact
	 * queue snapshot that can be propagated later.
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
		const initialTail = this.seedInitialLightIntoSharedQueue(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
		);

		return {
			queue: this.lightQueue.slice(0, initialTail),
			length: initialTail,
		};
	}

	/**
	 * Deferred refinement path:
	 * Takes a previously returned seed snapshot and performs the BFS propagation.
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

		const queue = this.scratchQueue;
		queue.set(seedState.queue, 0);

		this.propagateLightFromQueue(blocks, light, queue, initialTail);
	}

	/**
	 * Immediate full-lighting path.
	 */
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

	/**
	 * Shared internal seeding routine.
	 */
	private seedInitialLightIntoSharedQueue(
		_chunkX: number,
		chunkY: number,
		_chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		topSunlightMask?: Uint8Array,
	): number {
		let tail = 0;

		const queue = this.lightQueue;
		const CHUNK_SIZE = this.chunkSize;
		const CHUNK_SIZE_SQ = this.chunkSizeSq;
		const transparentLUT = LightGenerator._transparentLUT;
		const filtersFullSunLUT = LightGenerator._filtersFullSunLUT;
		const emissionLUT = LightGenerator._emissionLUT;

		const chunkWorldY = chunkY * CHUNK_SIZE;

		// If callers reuse buffers, this prevents old lighting data from leaking.
		light.fill(0);

		if (
			chunkWorldY + CHUNK_SIZE - 1 <
			LightGenerator.SKYLIGHT_GENERATION_MIN_WORLD_Y
		) {
			return 0;
		}

		for (let x = 0; x < CHUNK_SIZE; x++) {
			for (let z = 0; z < CHUNK_SIZE; z++) {
				const columnIndex = x + z * CHUNK_SIZE;
				const colBase = x + z * CHUNK_SIZE_SQ;

				let incomingSkyLight =
					topSunlightMask === undefined || topSunlightMask[columnIndex] !== 0
						? 15
						: 0;

				let sourceFiltersFullSun = 0;
				let idx = colBase + (CHUNK_SIZE - 1) * CHUNK_SIZE;

				for (let y = CHUNK_SIZE - 1; y >= 0; y--, idx -= CHUNK_SIZE) {
					const worldY = chunkWorldY + y;

					if (worldY < LightGenerator.SKYLIGHT_GENERATION_MIN_WORLD_Y) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = 0;
						continue;
					}

					const blockId = blocks[idx];

					if (blockId >= 1024 || transparentLUT[blockId] === 0) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = 0;

						// Preserve existing special lava behavior.
						if (blockId === 24) {
							light[idx] = (light[idx] & 0xf0) | 15;
							queue[tail++] = idx;
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

					light[idx] = (light[idx] & 0x0f) | (cellSkyLight << 4);

					const shouldSeed =
						blockFiltersFullSun === 0 || sourceFiltersFullSun === 0;

					if (shouldSeed) {
						queue[tail++] = idx;
					}

					incomingSkyLight = cellSkyLight;
					sourceFiltersFullSun = blockFiltersFullSun;
				}
			}
		}

		// Seed block light from all emission sources.
		for (let i = 0, len = blocks.length; i < len; i++) {
			const emission = emissionLUT[blocks[i]];

			if (emission > 0 && (light[i] & 0x0f) < emission) {
				light[i] = (light[i] & 0xf0) | emission;
				queue[tail++] = i;
			}
		}

		return tail;
	}

	/**
	 * Internal BFS propagation used by both:
	 * - immediate full-light path
	 * - deferred refinement path
	 */
	private propagateLightFromQueue(
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		queue: Uint16Array,
		initialTail: number,
	): void {
		let head = 0;
		let tail = initialTail;

		const mask = this.queueMask;
		const CHUNK_SIZE = this.chunkSize;
		const CHUNK_SIZE_SQ = this.chunkSizeSq;
		const csShift = this.csShift;
		const csShift2 = this.csShift2;
		const csMask = CHUNK_SIZE - 1;
		const transparentLUT = LightGenerator._transparentLUT;
		const filtersFullSunLUT = LightGenerator._filtersFullSunLUT;

		while (head < tail) {
			const idx = queue[head & mask];
			head++;

			const lightVal = light[idx];
			const skyLight = lightVal >> 4;
			const blockLight = lightVal & 0x0f;

			if (skyLight <= 1 && blockLight <= 1) {
				continue;
			}

			const sourceBlockId = blocks[idx];
			const sourceFiltersFullSun =
				sourceBlockId < 1024 ? filtersFullSunLUT[sourceBlockId] : 0;

			const skyM1 = skyLight - 1;
			const blkM1 = blockLight - 1;

			if ((idx & csMask) !== csMask) {
				tail = this.tryPropagate(
					idx + 1,
					skyM1,
					blkM1,
					sourceFiltersFullSun,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
				);
			}

			if ((idx & csMask) !== 0) {
				tail = this.tryPropagate(
					idx - 1,
					skyM1,
					blkM1,
					sourceFiltersFullSun,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
				);
			}

			if (((idx >> csShift) & csMask) !== csMask) {
				tail = this.tryPropagate(
					idx + CHUNK_SIZE,
					skyM1,
					blkM1,
					sourceFiltersFullSun,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
				);
			}

			if (((idx >> csShift) & csMask) !== 0) {
				const belowIdx = idx - CHUNK_SIZE;
				const belowBlockId = blocks[belowIdx];
				const belowFiltersFullSun =
					belowBlockId < 1024 ? filtersFullSunLUT[belowBlockId] : 0;

				const preservesFullSunDown =
					skyLight === 15 &&
					sourceFiltersFullSun === 0 &&
					belowFiltersFullSun === 0;

				tail = this.tryPropagate(
					belowIdx,
					preservesFullSunDown ? 15 : skyM1,
					blkM1,
					sourceFiltersFullSun,
					true,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
				);
			}

			if (idx >> csShift2 !== csMask) {
				tail = this.tryPropagate(
					idx + CHUNK_SIZE_SQ,
					skyM1,
					blkM1,
					sourceFiltersFullSun,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
				);
			}

			if (idx >> csShift2 !== 0) {
				tail = this.tryPropagate(
					idx - CHUNK_SIZE_SQ,
					skyM1,
					blkM1,
					sourceFiltersFullSun,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
					transparentLUT,
					filtersFullSunLUT,
				);
			}
		}
	}

	private tryPropagate(
		nIdx: number,
		targetSky: number,
		targetBlock: number,
		sourceFiltersFullSun: number,
		isDown: boolean,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		queue: Uint16Array,
		tail: number,
		mask: number,
		transparentLUT: Uint8Array,
		filtersFullSunLUT: Uint8Array,
	): number {
		const targetBlockId = blocks[nIdx];

		if (targetBlockId >= 1024 || transparentLUT[targetBlockId] === 0) {
			return tail;
		}

		// Skylight water/filter rules:
		// - filtered blocks receive lateral skylight only from filtered blocks
		// - filtered blocks emit lateral skylight only into filtered blocks
		// - downward propagation is allowed
		if (
			targetSky > 0 &&
			!isDown &&
			filtersFullSunLUT[targetBlockId] !== sourceFiltersFullSun
		) {
			return tail;
		}

		const currentVal = light[nIdx];
		const currentSky = currentVal >> 4;
		const currentBlock = currentVal & 0x0f;

		const newSky = targetSky > currentSky ? targetSky : currentSky;
		const newBlock = targetBlock > currentBlock ? targetBlock : currentBlock;

		if (newSky !== currentSky || newBlock !== currentBlock) {
			light[nIdx] = (newSky << 4) | newBlock;
			queue[tail & mask] = nIdx;
			return tail + 1;
		}

		return tail;
	}

	public static getLightEmission(blockId: number): number {
		return blockId >= 0 && blockId < 256
			? LightGenerator._emissionLUT[blockId]
			: 0;
	}
}

/** Returns the smallest power of two that is >= n. */
function nextPowerOfTwo(n: number): number {
	if (n <= 1) return 1;

	let p = 1;
	while (p < n) p <<= 1;

	return p;
}
