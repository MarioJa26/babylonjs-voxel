import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { getFinalTerrainHeight } from "@/code/Generation/TerrainHeightMap";
import { LIGHT_NIBBLE_MASK, SKY_LIGHT_SHIFT } from "@/code/Lib/VoxelMath";
import { unpackBlockId } from "../DataStructures/BlockEncoding";
import { isTransparent } from "../Meshing/ChunkFaceMasks";
import { filtersFullSunlight } from "../Worker/ChunkMesherConstants";

interface SunlightChunk {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	isLoaded: boolean;
	getBlockPacked(x: number, y: number, z: number): number;
	getSkyLight(x: number, y: number, z: number): number;
}

const SIZE = GenerationParams.CHUNK_SIZE;
const SIZE2 = SIZE * SIZE;
const SIZE3 = SIZE2 * SIZE;
const TOP_LOCAL_Y = SIZE - 1;
const MIN_GENERATION_WORLD_Y = 32;

/*
 * Always large enough to hold one seed for every chunk cell.
 *
 * SIZE3 is normally 32³ = 32,768, so this produces a 32,768-entry queue.
 */
const SEED_CAPACITY = Math.max(8, 1 << (32 - Math.clz32(SIZE3 - 1)));

const STORAGE_UNREADABLE = 0;
const STORAGE_UNIFORM = 1;
const STORAGE_PALETTE = 2;
const STORAGE_DIRECT_U8 = 3;
const STORAGE_DIRECT_U16 = 4;

export function seedSunlight(
	chunk: SunlightChunk,
	aboveChunk: SunlightChunk | undefined,
	light: Uint8Array,
	blocks: Uint8Array | Uint16Array | null,
	palette: Uint16Array | null,
	isUniform: boolean,
	uniformBlockId: number,
	canReadBlocks: boolean,
): { length: number; seeds: Uint16Array } {
	/*
	 * The result must own a compact buffer, so this working queue is allocated
	 * at maximum capacity and trimmed once at the end.
	 */
	const seedQueue = new Uint16Array(SEED_CAPACITY);

	const worldBaseX = chunk.chunkX * SIZE;
	const worldBaseY = chunk.chunkY * SIZE;
	const worldBaseZ = chunk.chunkZ * SIZE;
	const topWorldY = worldBaseY + TOP_LOCAL_Y;

	const loadedAbove =
		aboveChunk !== undefined && aboveChunk.isLoaded ? aboveChunk : undefined;

	const hasLoadedAbove = loadedAbove !== undefined;
	const useGeneratorHeight =
		!hasLoadedAbove && topWorldY >= MIN_GENERATION_WORLD_Y;

	/*
	 * When there is no loaded chunk above, cells below the generation floor
	 * are not processed. Compute the lower local bound once instead of checking
	 * worldBaseY + y during every Y iteration.
	 */
	const minimumLocalY = hasLoadedAbove
		? 0
		: Math.max(0, MIN_GENERATION_WORLD_Y - worldBaseY);

	if (minimumLocalY > TOP_LOCAL_Y) {
		return {
			length: 0,
			seeds: new Uint16Array(0),
		};
	}

	/*
	 * Resolve the block storage representation once.
	 */
	let storageMode = STORAGE_UNREADABLE;
	let directU8: Uint8Array | null = null;
	let directU16: Uint16Array | null = null;
	let paletteBlocks: Uint8Array | null = null;

	if (canReadBlocks) {
		if (isUniform) {
			storageMode = STORAGE_UNIFORM;
		} else if (palette !== null && blocks instanceof Uint8Array) {
			storageMode = STORAGE_PALETTE;
			paletteBlocks = blocks;
		} else if (blocks instanceof Uint16Array) {
			storageMode = STORAGE_DIRECT_U16;
			directU16 = blocks;
		} else if (blocks instanceof Uint8Array) {
			storageMode = STORAGE_DIRECT_U8;
			directU8 = blocks;
		}
	}

	const lightPreserveMask = LIGHT_NIBBLE_MASK;
	const skyShift = SKY_LIGHT_SHIFT;

	let length = 0;

	for (let x = 0; x < SIZE; x++) {
		const worldX = worldBaseX + x;

		/*
		 * Y changes the flattened index by SIZE. Since SIZE is 32 and therefore
		 * even, every block in one vertical palette column uses the same nibble:
		 * even X uses the low nibble, odd X uses the high nibble.
		 */
		const paletteShift = (x & 1) << 2;

		for (let z = 0; z < SIZE; z++) {
			let incomingSkyLight = 0;
			let sourceFiltersFullSun = false;

			if (loadedAbove !== undefined) {
				const aboveBlockPacked = loadedAbove.getBlockPacked(x, 0, z);

				/*
				 * Light enters this chunk through the above cell's lower face.
				 */
				if (isTransparent(aboveBlockPacked, 1, -1)) {
					incomingSkyLight = loadedAbove.getSkyLight(x, 0, z);

					if (incomingSkyLight > 0) {
						sourceFiltersFullSun = filtersFullSunlight(
							unpackBlockId(aboveBlockPacked),
						);
					}
				}
			} else if (useGeneratorHeight) {
				const terrainHeight = getFinalTerrainHeight(worldX, worldBaseZ + z);

				if (topWorldY >= terrainHeight - 48) {
					incomingSkyLight = 15;
				}
			}

			/*
			 * Flattening order:
			 *
			 * index = x + y * SIZE + z * SIZE²
			 */
			let index = x + z * SIZE2 + TOP_LOCAL_Y * SIZE;

			for (let y = TOP_LOCAL_Y; y >= minimumLocalY; y--, index -= SIZE) {
				let blockPacked: number;

				switch (storageMode) {
					case STORAGE_UNIFORM:
						blockPacked = uniformBlockId;
						break;

					case STORAGE_PALETTE: {
						const byte = paletteBlocks![index >>> 1];
						const paletteIndex = (byte >>> paletteShift) & 0x0f;

						/*
						 * Preserve the original behavior for valid palette
						 * indices. The fallback prevents undefined from flowing
						 * into block decoding when cache data is malformed.
						 */
						blockPacked = palette![paletteIndex] ?? 0;
						break;
					}

					case STORAGE_DIRECT_U16:
						blockPacked = directU16![index];
						break;

					case STORAGE_DIRECT_U8:
						blockPacked = directU8![index];
						break;

					default:
						blockPacked = 0;
						break;
				}

				/*
				 * Light cannot enter through this block's upper face.
				 */
				if (!isTransparent(blockPacked, 1, 1)) {
					incomingSkyLight = 0;
					sourceFiltersFullSun = false;
					continue;
				}

				if (incomingSkyLight === 0) {
					continue;
				}

				const blockId = unpackBlockId(blockPacked);
				const filtersSun = filtersFullSunlight(blockId);

				/*
				 * Direct, unfiltered sunlight remains level 15 while travelling
				 * vertically through blocks that do not filter full sunlight.
				 * Otherwise it attenuates by one level.
				 */
				const cellSkyLight =
					incomingSkyLight === 15 && !sourceFiltersFullSun && !filtersSun
						? 15
						: incomingSkyLight - 1;

				if (cellSkyLight <= 0) {
					incomingSkyLight = 0;
					sourceFiltersFullSun = filtersSun;
					continue;
				}

				const currentLight = light[index];

				light[index] =
					(currentLight & lightPreserveMask) | (cellSkyLight << skyShift);

				/*
				 * Filter blocks do not become deferred lateral-propagation
				 * seeds.
				 */
				if (!filtersSun) {
					seedQueue[length++] = (x << 10) | (y << 5) | z;
				}

				/*
				 * Light cannot leave through this block's lower face.
				 */
				if (!isTransparent(blockPacked, 1, -1)) {
					incomingSkyLight = 0;
					sourceFiltersFullSun = filtersSun;
					continue;
				}

				incomingSkyLight = cellSkyLight;
				sourceFiltersFullSun = filtersSun;
			}
		}
	}

	/*
	 * slice() creates the compact, independently owned result expected by
	 * callers. Returning subarray() would retain and potentially transfer the
	 * full maximum-capacity backing buffer.
	 */
	return {
		length,
		seeds: length === 0 ? new Uint16Array(0) : seedQueue.slice(0, length),
	};
}
