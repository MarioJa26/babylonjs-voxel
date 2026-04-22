import type { Biome } from "./Biome/BiomeTypes";
import type { GenerationParamsType } from "./NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "./TerrainHeightMap";

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

	/**
	 * Reusable queue buffer for the "generate immediately" path.
	 * This avoids per-call queue allocation when doing full lighting now.
	 */
	private lightQueue: Uint16Array;

	private static queueCapacity: number;
	private static queueMask: number;

	private static readonly DENSITY_INFLUENCE_RANGE = 48;
	private static readonly WATER_BLOCK_ID = 30;

	constructor(params: GenerationParamsType) {
		LightGenerator.chunkSize = params.CHUNK_SIZE;
		LightGenerator.chunkSizeSq =
			LightGenerator.chunkSize * LightGenerator.chunkSize;

		const rawCap = LightGenerator.chunkSize ** 3;
		const pot = nextPowerOfTwo(rawCap);

		LightGenerator.queueCapacity = pot;
		LightGenerator.queueMask = pot - 1;

		this.lightQueue = new Uint16Array(pot);
	}

	/**
	 * Backward-compatible full lighting path:
	 * - seed skylight / emissive light
	 * - propagate via BFS
	 */
	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		_biome: Biome,
		blocks: Uint8Array,
		light: Uint8Array,
		topSunlightMask?: Uint8Array,
	): void {
		const initialTail = this.seedInitialLightIntoSharedQueue(
			chunkX,
			chunkY,
			chunkZ,
			blocks,
			light,
			topSunlightMask,
		);

		if (initialTail > 0) {
			this.propagateLightFromQueue(blocks, light, this.lightQueue, initialTail);
		}
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

		// Allocate a full-capacity queue for BFS expansion and seed it with the snapshot.
		const queue = new Uint16Array(LightGenerator.queueCapacity);
		queue.set(seedState.queue, 0);

		this.propagateLightFromQueue(blocks, light, queue, seedState.length);
	}

	/**
	 * Shared internal seeding routine used by both:
	 * - generate(...) immediate full-light path
	 * - seedInitialLight(...) deferred-light path
	 *
	 * Returns the number of initially seeded queue entries.
	 */
	private seedInitialLightIntoSharedQueue(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array,
		light: Uint8Array,
		topSunlightMask?: Uint8Array,
	): number {
		let tail = 0;

		const queue = this.lightQueue;
		const mask = LightGenerator.queueMask;
		const CHUNK_SIZE = LightGenerator.chunkSize;
		const CHUNK_SIZE_SQ = LightGenerator.chunkSizeSq;

		const chunkWorldX = chunkX * CHUNK_SIZE;
		const chunkWorldZ = chunkZ * CHUNK_SIZE;
		const topWorldY = chunkY * CHUNK_SIZE + CHUNK_SIZE - 1;

		// Clear light buffer before seeding.
		// If callers reuse buffers, this prevents old lighting data from leaking.
		light.fill(0);

		for (let x = 0; x < CHUNK_SIZE; x++) {
			const worldX = chunkWorldX + x;

			for (let z = 0; z < CHUNK_SIZE; z++) {
				const worldZ = chunkWorldZ + z;
				const columnIndex = x + z * CHUNK_SIZE;

				let incomingSkyLight = topSunlightMask
					? topSunlightMask[columnIndex] !== 0
						? 15
						: 0
					: this.columnReceivesDirectSun(worldX, worldZ, topWorldY)
						? 15
						: 0;

				let sourceIsWater = false;

				for (let y = CHUNK_SIZE - 1; y >= 0; y--) {
					const idx = x + y * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
					const blockId = blocks[idx];

					if (!LightGenerator.isTransparentBlock(blockId)) {
						incomingSkyLight = 0;
						sourceIsWater = false;

						// Lava emits block light
						if (blockId === 24) {
							light[idx] = (light[idx] & 0xf0) | 15;
							queue[tail & mask] = (x << 10) | (y << 5) | z;
							tail++;
						}

						continue;
					}

					if (incomingSkyLight <= 0) {
						sourceIsWater = LightGenerator.isWaterBlock(blockId);
						continue;
					}

					const blockIsWater = LightGenerator.isWaterBlock(blockId);

					const preservesFullSun =
						incomingSkyLight === 15 && !sourceIsWater && !blockIsWater;

					const cellSkyLight = preservesFullSun
						? 15
						: Math.max(incomingSkyLight - 1, 0);

					if (cellSkyLight === 0) {
						incomingSkyLight = 0;
						sourceIsWater = blockIsWater;
						continue;
					}

					light[idx] = (light[idx] & 0x0f) | (cellSkyLight << 4);
					// Water blocks receive and pass light downward, but must not be
					// seeded into the BFS queue — that would spread light sideways
					// through water and cause a bright halo at chunk top borders.
					if (!blockIsWater) {
						queue[tail & mask] = (x << 10) | (y << 5) | z;
						tail++;
					}

					incomingSkyLight = cellSkyLight;
					sourceIsWater = blockIsWater;
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
		const CHUNK_SIZE_SQ = LightGenerator.chunkSizeSq;

		while (head < tail) {
			const val = queue[head & mask];
			head++;

			const x = (val >> 10) & 0x1f;
			const y = (val >> 5) & 0x1f;
			const z = val & 0x1f;

			const idx = x + y * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
			const lightVal = light[idx];
			const skyLight = (lightVal >> 4) & 0x0f;
			const blockLight = lightVal & 0x0f;

			if (skyLight <= 1 && blockLight <= 1) {
				continue;
			}

			const skyM1 = skyLight - 1;
			const blkM1 = blockLight - 1;

			if (x + 1 < CHUNK_SIZE) {
				tail = this.tryPropagate(
					x + 1,
					y,
					z,
					skyM1,
					blkM1,
					blocks,
					light,
					queue,
					tail,
					CHUNK_SIZE,
					CHUNK_SIZE_SQ,
				);
			}

			if (x > 0) {
				tail = this.tryPropagate(
					x - 1,
					y,
					z,
					skyM1,
					blkM1,
					blocks,
					light,
					queue,
					tail,
					CHUNK_SIZE,
					CHUNK_SIZE_SQ,
				);
			}

			if (y + 1 < CHUNK_SIZE) {
				tail = this.tryPropagate(
					x,
					y + 1,
					z,
					skyM1,
					blkM1,
					blocks,
					light,
					queue,
					tail,
					CHUNK_SIZE,
					CHUNK_SIZE_SQ,
				);
			}

			if (y > 0) {
				const belowIdx = x + (y - 1) * CHUNK_SIZE + z * CHUNK_SIZE_SQ;
				const preservesFullSunDown =
					skyLight === 15 &&
					!LightGenerator.isWaterBlock(blocks[idx]) &&
					!LightGenerator.isWaterBlock(blocks[belowIdx]);

				tail = this.tryPropagate(
					x,
					y - 1,
					z,
					preservesFullSunDown ? 15 : skyM1,
					blkM1,
					blocks,
					light,
					queue,
					tail,
					CHUNK_SIZE,
					CHUNK_SIZE_SQ,
				);
			}

			if (z + 1 < CHUNK_SIZE) {
				tail = this.tryPropagate(
					x,
					y,
					z + 1,
					skyM1,
					blkM1,
					blocks,
					light,
					queue,
					tail,
					CHUNK_SIZE,
					CHUNK_SIZE_SQ,
				);
			}

			if (z > 0) {
				tail = this.tryPropagate(
					x,
					y,
					z - 1,
					skyM1,
					blkM1,
					blocks,
					light,
					queue,
					tail,
					CHUNK_SIZE,
					CHUNK_SIZE_SQ,
				);
			}
		}
	}

	private tryPropagate(
		nx: number,
		ny: number,
		nz: number,
		targetSky: number,
		targetBlock: number,
		blocks: Uint8Array,
		light: Uint8Array,
		queue: Uint16Array,
		tail: number,
		CHUNK_SIZE: number,
		CHUNK_SIZE_SQ: number,
	): number {
		const idx = nx + ny * CHUNK_SIZE + nz * CHUNK_SIZE_SQ;

		if (!LightGenerator.isTransparentBlock(blocks[idx])) {
			return tail;
		}

		// Water only passes light downward (handled in the seeding loop).
		// Block lateral BFS propagation into or through water.
		if (LightGenerator.isWaterBlock(blocks[idx])) {
			return tail;
		}

		const currentVal = light[idx];
		const currentSky = (currentVal >> 4) & 0x0f;
		const currentBlock = currentVal & 0x0f;

		const newSky = targetSky > currentSky ? targetSky : currentSky;
		const newBlock = targetBlock > currentBlock ? targetBlock : currentBlock;

		if (newSky !== currentSky || newBlock !== currentBlock) {
			light[idx] = (newSky << 4) | newBlock;
			queue[tail & LightGenerator.queueMask] = (nx << 10) | (ny << 5) | nz;
			return tail + 1;
		}

		return tail;
	}

	private static isTransparentBlock(blockId: number): boolean {
		return (
			blockId === 0 ||
			blockId === 30 ||
			blockId === 60 ||
			blockId === 61 ||
			blockId === 64
		);
	}

	private static isWaterBlock(blockId: number): boolean {
		return blockId === LightGenerator.WATER_BLOCK_ID;
	}

	private columnReceivesDirectSun(
		worldX: number,
		worldZ: number,
		topWorldY: number,
	): boolean {
		const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(
			worldX,
			worldZ,
		);
		return topWorldY >= terrainHeight - LightGenerator.DENSITY_INFLUENCE_RANGE;
	}
}

/** Returns the smallest power of two that is >= n. */
function nextPowerOfTwo(n: number): number {
	if (n <= 1) return 1;
	let p = 1;
	while (p < n) p <<= 1;
	return p;
}
