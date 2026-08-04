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

	/**
	 * Reusable queue buffer for the "generate immediately" path.
	 * This avoids per-call queue allocation when doing full lighting now.
	 */
	private lightQueue: Uint16Array;

	private static queueMask: number;

	/**
	 * Static scratch buffer reused across all propagateLight calls.
	 * Eliminates the 64KB allocation per deferred lighting refinement.
	 */
	private static scratchQueue: Uint16Array | null = null;

	private static readonly SKYLIGHT_GENERATION_MIN_WORLD_Y = 32;

	constructor(params: GenerationParamsType) {
		LightGenerator.chunkSize = params.CHUNK_SIZE;
		LightGenerator.chunkSizeSq =
			LightGenerator.chunkSize * LightGenerator.chunkSize;

		const rawCap = LightGenerator.chunkSize ** 3;
		const pot = nextPowerOfTwo(rawCap);

		LightGenerator.queueMask = pot - 1;

		// CHUNK_SIZE is a power of two: shift = bit position of the set bit.
		let csShift = 0;
		for (let m = LightGenerator.chunkSize; m > 1; m >>= 1) {
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
	 *
	 * Use this when you want chunks to appear fast, then refine lighting after.
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
		if (seedState.length <= 0) {
			return;
		}

		const queue = LightGenerator.scratchQueue!;
		queue.set(seedState.queue, 0);

		this.propagateLightFromQueue(blocks, light, queue, seedState.length);
	}

	/**
	 * Immediate full-lighting path: seeds skylight into the shared queue and
	 * propagates from it in place, without allocating the snapshot slice that
	 * seedInitialLight + propagateLight produce. The queue is a ring buffer, so
	 * reading and extending it in the same pass is safe.
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
	 * Shared internal seeding routine used by both:
	 * - generate(...) immediate full-light path
	 * - seedInitialLight(...) deferred-light path
	 *
	 * Returns the number of initially seeded queue entries.
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

		const chunkWorldY = chunkY * CHUNK_SIZE;

		// Clear light buffer before seeding.
		// If callers reuse buffers, this prevents old lighting data from leaking.
		light.fill(0);

		// Early-out: entire chunk is below minimum skylight Y — no sky light to seed.
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

				let incomingSkyLight = topSunlightMask
					? topSunlightMask[columnIndex] !== 0
						? 15
						: 0
					: 15;

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

					if (!LightGenerator.isTransparentBlock(blockId)) {
						incomingSkyLight = 0;
						sourceFiltersFullSun = false;

						// Lava emits block light
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
					// Seed non-water lit cells as before.
					// Additionally seed water only at air->water transitions so
					// skylight can enter connected water bodies without flooding the
					// queue with every water voxel in tall columns.
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

		return tail;
	}

	/**
	 * Internal BFS propagation used by both:
	 * - generate(...) immediate full-light path
	 * - propagateLight(...) deferred refinement path
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
		const csShift = LightGenerator.csShift;
		const csMask = CHUNK_SIZE - 1;
		const csShift2 = LightGenerator.csShift2;

		while (head < tail) {
			const idx = queue[head & mask];
			head++;

			const sourceBlockId = blocks[idx];
			const lightVal = light[idx];
			const skyLight = (lightVal >> 4) & 0x0f;
			const blockLight = lightVal & 0x0f;

			if (skyLight <= 1 && blockLight <= 1) {
				continue;
			}

			const skyM1 = skyLight - 1;
			const blkM1 = blockLight - 1;

			if ((idx & csMask) !== csMask) {
				tail = this.tryPropagate(
					idx + 1,
					skyM1,
					blkM1,
					sourceBlockId,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
				);
			}

			if ((idx & csMask) !== 0) {
				tail = this.tryPropagate(
					idx - 1,
					skyM1,
					blkM1,
					sourceBlockId,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
				);
			}

			if (((idx >> csShift) & csMask) !== csMask) {
				tail = this.tryPropagate(
					idx + CHUNK_SIZE,
					skyM1,
					blkM1,
					sourceBlockId,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
				);
			}

			if (((idx >> csShift) & csMask) !== 0) {
				const belowIdx = idx - CHUNK_SIZE;
				const preservesFullSunDown =
					skyLight === 15 &&
					!filtersFullSunlight(sourceBlockId) &&
					!filtersFullSunlight(blocks[belowIdx]);

				tail = this.tryPropagate(
					belowIdx,
					preservesFullSunDown ? 15 : skyM1,
					blkM1,
					sourceBlockId,
					true,
					blocks,
					light,
					queue,
					tail,
					mask,
				);
			}

			if ((idx >> csShift2) !== csMask) {
				tail = this.tryPropagate(
					idx + CHUNK_SIZE * CHUNK_SIZE,
					skyM1,
					blkM1,
					sourceBlockId,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
				);
			}

			if ((idx >> csShift2) !== 0) {
				tail = this.tryPropagate(
					idx - CHUNK_SIZE * CHUNK_SIZE,
					skyM1,
					blkM1,
					sourceBlockId,
					false,
					blocks,
					light,
					queue,
					tail,
					mask,
				);
			}
		}
	}

	private tryPropagate(
		nIdx: number,
		targetSky: number,
		targetBlock: number,
		sourceBlockId: number,
		isDown: boolean,
		blocks: Uint8Array,
		light: Uint8Array,
		queue: Uint16Array,
		tail: number,
		mask: number,
	): number {
		const targetBlockId = blocks[nIdx];
		if (!LightGenerator.isTransparentBlock(targetBlockId)) {
			return tail;
		}

		// Skylight water rules:
		// - water receives lateral skylight only from water
		// - water emits lateral skylight only into water
		// - downward propagation is allowed
		if (targetSky > 0 && !isDown) {
			const sourceIsWater = filtersFullSunlight(sourceBlockId);
			const targetIsWater = filtersFullSunlight(targetBlockId);
			if (targetIsWater && !sourceIsWater) return tail;
			if (sourceIsWater && !targetIsWater) return tail;
		}

		const currentVal = light[nIdx];
		const currentSky = (currentVal >> 4) & 0x0f;
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

	private static isTransparentBlock(blockId: number): boolean {
		return blockId < 128 && LightGenerator._transparentLUT[blockId] === 1;
	}
}

/** Returns the smallest power of two that is >= n. */
function nextPowerOfTwo(n: number): number {
	if (n <= 1) return 1;
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}
