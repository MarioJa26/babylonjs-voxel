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
 * Face of OUR border cell that touches the neighbor, per face index
 * [+X, -X, +Y, -Y, +Z, -Z]. Light crossing the boundary enters through it.
 */
const BORDER_ENTER_BITS = [FACE_PX, FACE_NX, FACE_PY, FACE_NY, FACE_PZ, FACE_NZ];

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

	/**
	 * Optional per-face closed-mask LUT indexed by packed block value
	 * (id | state << 10, exactly the layout of ChunkFaceMasks.
	 * precomputeClosedFaceMasks). When set, BFS light enters/exits cells
	 * through their OPEN faces only — multi-box shapes (slabs, stairs, ...)
	 * light up through their open halves exactly like the client's
	 * incremental engine. When null, legacy whole-block transparency applies.
	 */
	private static closedFaceMaskLUT: Uint8Array | null = null;

	public static setClosedFaceMaskLUT(lut: Uint8Array | null): void {
		LightGenerator.closedFaceMaskLUT = lut;
	}

	public static getClosedFaceMaskLUT(): Uint8Array | null {
		return LightGenerator.closedFaceMaskLUT;
	}

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
	 * Immediate full-light path.
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
	 * Immediate full-light path with cross-chunk border seeding.
	 *
	 * Identical to seedAndPropagateLightImmediate, except light values from
	 * the six face-adjacent chunks are ingested before BFS propagation so
	 * light flows across chunk borders (torch glow reaching into this chunk,
	 * lateral skylight under overhangs, etc.).
	 *
	 * `neighborLight` is indexed [0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z]; each
	 * entry is the neighbor's full 32³ light array (same voxel layout), or
	 * null when the neighbor has no stored light (treated as dark).
	 */
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

	/**
	 * Ingest the six neighbors' border light values into the seed queue.
	 *
	 * Crossing a chunk boundary costs one attenuation step, so a border cell
	 * receives max(current, neighborValue - 1) per nibble — matching how
	 * propagateLightFromQueue spreads between cells. Only transparent target
	 * cells accept seeds; opaque cells stay dark.
	 */
	private seedFromNeighborBorders(
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		neighborLight: ReadonlyArray<Uint8Array | null>,
		tail: number,
	): number {
		const queue = this.lightQueue;
		const CS = this.chunkSize;
		const CSSQ = this.chunkSizeSq;
		const csMask = CS - 1;
		const transparentLUT = LightGenerator._transparentLUT;
		const lut = LightGenerator.closedFaceMaskLUT;

		let t = tail;

		for (let face = 0; face < 6; face++) {
			const nl = neighborLight[face];
			if (!nl || nl.length < CSSQ * CS) continue;

			// Light enters the border cell through the face that touches the
			// neighbor: +X neighbor -> our FACE_PX, etc.
			const enterBit = BORDER_ENTER_BITS[face];

			for (let a = 0; a < CS; a++) {
				for (let b = 0; b < CS; b++) {
					let targetIdx: number;
					let srcIdx: number;

					switch (face) {
						case 0: // +X: our x=31 plane ↔ neighbor x=0 plane
							targetIdx = csMask | (a << this.csShift) | (b << this.csShift2);
							srcIdx = (a << this.csShift) | (b << this.csShift2);
							break;
						case 1: // -X
							targetIdx = (a << this.csShift) | (b << this.csShift2);
							srcIdx = csMask | (a << this.csShift) | (b << this.csShift2);
							break;
						case 2: // +Y: our y=31 ↔ neighbor y=0
							targetIdx = a | (csMask << this.csShift) | (b << this.csShift2);
							srcIdx = a | (b << this.csShift2);
							break;
						case 3: // -Y
							targetIdx = a | (b << this.csShift2);
							srcIdx = a | (csMask << this.csShift) | (b << this.csShift2);
							break;
						case 4: // +Z: our z=31 ↔ neighbor z=0
							targetIdx = a | (b << this.csShift) | (csMask << this.csShift2);
							srcIdx = a | (b << this.csShift);
							break;
						default: // -Z
							targetIdx = a | (b << this.csShift);
							srcIdx = a | (b << this.csShift) | (csMask << this.csShift2);
							break;
					}

					const packed = blocks[targetIdx];
					const blockId = packed & PACKED_ID_MASK;
					const open = lut
						? (lut[packed & 0xffff] & enterBit) === 0
						: blockId < 1024 && transparentLUT[blockId] !== 0;
					if (!open) continue;

					const srcVal = nl[srcIdx];
					const srcSky = (srcVal >> 4) - 1;
					const srcBlock = (srcVal & 0x0f) - 1;
					if (srcSky <= 0 && srcBlock <= 0) continue;

					const cur = light[targetIdx];
					const curSky = cur >> 4;
					const curBlock = cur & 0x0f;
					const newSky = srcSky > curSky ? srcSky : curSky;
					const newBlock = srcBlock > curBlock ? srcBlock : curBlock;

					if (newSky !== curSky || newBlock !== curBlock) {
						light[targetIdx] = (newSky << 4) | newBlock;
						queue[t & this.queueMask] = targetIdx;
						t++;
					}
				}
			}
		}

		return t;
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

					const packed = blocks[idx];
					const blockId = packed & PACKED_ID_MASK;
					const lut = LightGenerator.closedFaceMaskLUT;

					// Sky descends into a cell through its TOP face. With the
					// shape LUT, multi-box blocks whose top half is open (e.g.
					// bottom slabs) accept skylight like the live engine.
					const blocked = lut
						? (lut[packed & 0xffff] & FACE_PY) !== 0
						: blockId >= 1024 || transparentLUT[blockId] === 0;

					if (blocked) {
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

					// The column continues downward only if this cell is open
					// at its BOTTOM face as well (shape-aware parity: a slab's
					// closed underside stops the vertical sun column).
					if (lut && (lut[packed & 0xffff] & FACE_NY) !== 0) {
						incomingSkyLight = 0;
					} else {
						incomingSkyLight = cellSkyLight;
					}
					sourceFiltersFullSun = blockFiltersFullSun;
				}
			}
		}

		// Seed block light from all emission sources.
		for (let i = 0, len = blocks.length; i < len; i++) {
			const emission = emissionLUT[blocks[i] & PACKED_ID_MASK];

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

			const sourcePacked = blocks[idx];
			const sourceBlockId = sourcePacked & PACKED_ID_MASK;
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
				);
			}

			if ((idx & csMask) !== 0) {
				tail = this.tryPropagate(
					idx - 1,
					skyM1,
					blkM1,
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
				);
			}

			if (((idx >> csShift) & csMask) !== csMask) {
				tail = this.tryPropagate(
					idx + CHUNK_SIZE,
					skyM1,
					blkM1,
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
				);
			}

			if (((idx >> csShift) & csMask) !== 0) {
				const belowIdx = idx - CHUNK_SIZE;
				const belowFiltersFullSun =
					(blocks[belowIdx] & PACKED_ID_MASK) < 1024
						? filtersFullSunLUT[blocks[belowIdx] & PACKED_ID_MASK]
						: 0;

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
				);
			}

			if (idx >> csShift2 !== csMask) {
				tail = this.tryPropagate(
					idx + CHUNK_SIZE_SQ,
					skyM1,
					blkM1,
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
				);
			}

			if (idx >> csShift2 !== 0) {
				tail = this.tryPropagate(
					idx - CHUNK_SIZE_SQ,
					skyM1,
					blkM1,
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
		enterBit: number,
		exitBit: number,
		sourcePacked: number,
		blocks: Uint8Array | Uint16Array,
		light: Uint8Array,
		queue: Uint16Array,
		tail: number,
		mask: number,
		transparentLUT: Uint8Array,
		filtersFullSunLUT: Uint8Array,
	): number {
		const targetPacked = blocks[nIdx];
		const targetBlockId = targetPacked & PACKED_ID_MASK;
		const lut = LightGenerator.closedFaceMaskLUT;

		// Light enters the target through the face opposite the travel
		// direction. With the shape LUT, open halves of multi-box blocks
		// accept light exactly like the client's incremental engine.
		let enterable: boolean;
		if (lut) {
			enterable = (lut[targetPacked & 0xffff] & enterBit) === 0;
		} else {
			enterable =
				targetBlockId < 1024 && transparentLUT[targetBlockId] !== 0;
		}
		if (!enterable) {
			return tail;
		}

		// ...and exits the source through its travel-direction face, unless
		// the source itself emits (lava/torch cells store light but are
		// otherwise closed).
		if (lut) {
			const sourceOpens =
				(lut[sourcePacked & 0xffff] & exitBit) === 0 ||
				LightGenerator._emissionLUT[sourcePacked & PACKED_ID_MASK] > 0;
			if (!sourceOpens) {
				return tail;
			}
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

	/** True when the block lets light pass (air, water, glass, ...). */
	public static isBlockTransparent(blockId: number): boolean {
		return (
			blockId >= 0 &&
			blockId < 1024 &&
			LightGenerator._transparentLUT[blockId] !== 0
		);
	}

	/**
	 * True when the block filters full sunlight (e.g. leaves/water): light
	 * passing through decrements instead of propagating at full strength.
	 */
	public static blockFiltersFullSunlight(blockId: number): boolean {
		return (
			blockId >= 0 &&
			blockId < 1024 &&
			LightGenerator._filtersFullSunLUT[blockId] !== 0
		);
	}
}

/** Returns the smallest power of two that is >= n. */
function nextPowerOfTwo(n: number): number {
	if (n <= 1) return 1;

	let p = 1;
	while (p < n) p <<= 1;

	return p;
}
