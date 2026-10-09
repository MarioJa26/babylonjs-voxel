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

// Always large enough to hold one seed for every cell in the chunk.
const seedCapacity = Math.max(8, 1 << (32 - Math.clz32(SIZE3 - 1)));

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
	const seedQueue = new Uint16Array(seedCapacity);

	const worldBaseX = chunk.chunkX * SIZE;
	const worldBaseY = chunk.chunkY * SIZE;
	const worldBaseZ = chunk.chunkZ * SIZE;
	const topWorldY = worldBaseY + TOP_LOCAL_Y;

	const loadedAbove = aboveChunk?.isLoaded ? aboveChunk : undefined;

	const useGeneratorHeight =
		loadedAbove === undefined && topWorldY >= MIN_GENERATION_WORLD_Y;

	// Narrow the storage representation once rather than in every voxel.
	const directBlocks =
		canReadBlocks && !isUniform && palette === null
			? (blocks as Uint8Array | Uint16Array)
			: null;

	const paletteBlocks =
		canReadBlocks && !isUniform && palette !== null
			? (blocks as Uint8Array)
			: null;

	let length = 0;

	for (let x = 0; x < SIZE; x++) {
		const worldX = worldBaseX + x;

		for (let z = 0; z < SIZE; z++) {
			let incomingSkyLight = 0;
			let sourceFiltersFullSun = false;

			if (loadedAbove !== undefined) {
				const aboveBlockPacked = loadedAbove.getBlockPacked(x, 0, z);

				if (isTransparent(aboveBlockPacked, 1, -1)) {
					incomingSkyLight = loadedAbove.getSkyLight(x, 0, z);
					sourceFiltersFullSun = filtersFullSunlight(
						unpackBlockId(aboveBlockPacked),
					);
				}
			} else if (useGeneratorHeight) {
				const terrainHeight = getFinalTerrainHeight(worldX, worldBaseZ + z);

				if (topWorldY >= terrainHeight - 48) {
					incomingSkyLight = 15;
				}
			}

			let index = x + z * SIZE2 + TOP_LOCAL_Y * SIZE;

			for (let y = TOP_LOCAL_Y; y >= 0; y--, index -= SIZE) {
				if (
					loadedAbove === undefined &&
					worldBaseY + y < MIN_GENERATION_WORLD_Y
				) {
					break;
				}

				let blockPacked = 0;

				if (canReadBlocks) {
					if (isUniform) {
						blockPacked = uniformBlockId;
					} else if (paletteBlocks !== null) {
						const byte = paletteBlocks[index >>> 1];
						const paletteIndex = (index & 1) === 0 ? byte & 0x0f : byte >>> 4;

						blockPacked = palette![paletteIndex];
					} else {
						blockPacked = directBlocks![index];
					}
				}

				// Light cannot enter this cell through its upper face.
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

				const preservesFullSun =
					incomingSkyLight === 15 && !sourceFiltersFullSun && !filtersSun;

				const cellSkyLight = preservesFullSun ? 15 : incomingSkyLight - 1;

				if (cellSkyLight === 0) {
					incomingSkyLight = 0;
					sourceFiltersFullSun = filtersSun;
					continue;
				}

				light[index] =
					(light[index] & LIGHT_NIBBLE_MASK) |
					(cellSkyLight << SKY_LIGHT_SHIFT);

				// seedCapacity is guaranteed to be at least SIZE³.
				if (!filtersSun) {
					seedQueue[length++] = (x << 10) | (y << 5) | z;
				}

				// Light cannot leave through the lower face.
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

	return {
		length,
		seeds: seedQueue.slice(0, length),
	};
}
