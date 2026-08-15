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
	private static chunkSize: number;
	private static chunkSizeSq: number;
	private static csShift: number;
	private static csShift2: number;
	private static queueMask: number;

	/**
	 * Reusable queue buffer for the immediate path.
	 */
	private lightQueue: Uint16Array;

	/**
	 * Static scratch buffer reused across all propagateLight calls.
	 */
	private static scratchQueue: Uint16Array | null = null;

	private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y = 32;

	private static readonly _transparentLUT: Uint8Array = (() => {
		const lut = new Uint8Array(128);
		lut[0] = 1;
		lut[WATER_BLOCK_ID] = 1;
		lut[60] = 1;
		lut[61] = 1;
		lut[64] = 1;
		lut[66] = 1;
		lut[91] = 1;
		return lut;
	})();

	private static readonly _emissionLUT: Uint8Array = (() => {
		const lut = new Uint8Array(256);
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
		const pot = nextPowerOfTwo(rawCap);

		LightGenerator.chunkSize = chunkSize;
		LightGenerator.chunkSizeSq = chunkSizeSq;
		LightGenerator.queueMask = pot - 1;

		// CHUNK_SIZE is expected to be a power of two.
		let csShift = 0;
		for (let m = chunkSize; m > 1; m >>= 1) {
			csShift++;
		}

		LightGenerator.csShift = csShift;
		LightGenerator.csShift2 = csShift * 2;

		this.lightQueue = new Uint16Array(pot);
		LightGenerator.scratchQueue = new Uint16Array(pot);
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
		blocks: Uint8Array,
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
		blocks: Uint8Array,
		light: Uint8Array,
		seedState: LightSeedState,
	): void {
		const initialTail = seedState.length;
		if (initialTail <= 0) {
			return;
		}

		const queue = LightGenerator.scratchQueue!;
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
		blocks: Uint8Array,
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
		blocks: Uint8Array,
		light: Uint8Array,
		topSunlightMask?: Uint8Array,
	): number {
		let tail = 0;

		const queue = this.lightQueue;
		const mask = LightGenerator.queueMask;
		const CHUNK_SIZE = LightGenerator.chunkSize;
		const CHUNK_SIZE_SQ = LightGenerator.chunkSizeSq;
		const transparentLUT = LightGenerator._transparentLUT;
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

				let sourceFiltersFullSun = false;
				let idx = colBase + (CHUNK_SIZE - 1) * CHUNK_SIZE;

				for (let y = CHUNK_SIZE - 1; y >= 0; y--, idx -= CHUNK_SIZE) {
					const worldY = chunkWorldY + y;

					if (worldY < LightGenerator.SKYLIGHT_GENERATION_MIN_WORLD_Y) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = false;
						continue;
					}

					const blockId = blocks[idx];

					if (blockId >= 128 || transparentLUT[blockId] === 0) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = false;

						// Preserve existing special lava behavior.
						if (blockId === 24) {
							light[idx] = (light[idx] & 0xf0) | 15;
							queue[tail & mask] = idx;
							tail++;
						}

						continue;
					}

					if (incomingSkyLight <= 0) {
						sourceFiltersFullSun = filtersFullSunlight(blockId);
						continue;
					}

					const blockFiltersFullSun = filtersFullSunlight(blockId);

					const preservesFullSun =
						incomingSkyLight === 15 &&
						!sourceFiltersFullSun &&
						!blockFiltersFullSun;

					const cellSkyLight = preservesFullSun ? 15 : incomingSkyLight - 1;

					if (cellSkyLight === 0) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = blockFiltersFullSun;
						continue;
					}

					light[idx] = (light[idx] & 0x0f) | (cellSkyLight << 4);

					const shouldSeed = !blockFiltersFullSun || !sourceFiltersFullSun;
					if (shouldSeed) {
						queue[tail & mask] = idx;
						tail++;
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
				queue[tail & mask] = i;
				tail++;
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
		blocks: Uint8Array,
		light: Uint8Array,
		queue: Uint16Array,
		initialTail: number,
	): void {
		let head = 0;
		let tail = initialTail;

		const mask = LightGenerator.queueMask;
		const CHUNK_SIZE = LightGenerator.chunkSize;
		const CHUNK_SIZE_SQ = LightGenerator.chunkSizeSq;
		const csShift = LightGenerator.csShift;
		const csShift2 = LightGenerator.csShift2;
		const csMask = CHUNK_SIZE - 1;
		const transparentLUT = LightGenerator._transparentLUT;

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
			const sourceFiltersFullSun = filtersFullSunlight(sourceBlockId);
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
				);
			}

			if (((idx >> csShift) & csMask) !== 0) {
				const belowIdx = idx - CHUNK_SIZE;
				const belowBlockId = blocks[belowIdx];

				const preservesFullSunDown =
					skyLight === 15 &&
					!sourceFiltersFullSun &&
					!filtersFullSunlight(belowBlockId);

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
				);
			}
		}
	}

	private tryPropagate(
		nIdx: number,
		targetSky: number,
		targetBlock: number,
		sourceFiltersFullSun: boolean,
		isDown: boolean,
		blocks: Uint8Array,
		light: Uint8Array,
		queue: Uint16Array,
		tail: number,
		mask: number,
		transparentLUT: Uint8Array,
	): number {
		const targetBlockId = blocks[nIdx];

		if (targetBlockId >= 128 || transparentLUT[targetBlockId] === 0) {
			return tail;
		}

		// Skylight water/filter rules:
		// - filtered blocks receive lateral skylight only from filtered blocks
		// - filtered blocks emit lateral skylight only into filtered blocks
		// - downward propagation is allowed
		if (targetSky > 0 && !isDown) {
			const targetFiltersFullSun = filtersFullSunlight(targetBlockId);

			if (targetFiltersFullSun !== sourceFiltersFullSun) {
				return tail;
			}
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

	private static isTransparentBlock(blockId: number): boolean {
		return blockId < 128 && LightGenerator._transparentLUT[blockId] === 1;
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
