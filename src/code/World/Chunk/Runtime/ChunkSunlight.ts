import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { getFinalTerrainHeight } from "@/code/Generation/TerrainHeightMap";
import { LIGHT_NIBBLE_MASK, SKY_LIGHT_SHIFT } from "@/code/Lib/VoxelMath";
import { isTransparent } from "../Meshing/ChunkFaceMasks";
import { unpackBlockId } from "../DataStructures/BlockEncoding";
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
const MIN_GENERATION_WORLD_Y = 32;
const seedCapacity = Math.max(8, 1 << (32 - Math.clz32(SIZE ** 3)));
const seedQueue = new Uint16Array(seedCapacity);

export function seedSunlight(
	chunk: SunlightChunk,
	aboveChunk: SunlightChunk | undefined,
	light: Uint8Array,
	blocks: Uint8Array | Uint16Array | null,
	palette: Uint16Array | null,
	isUniform: boolean,
	uniformBlockId: number,
	canReadBlocks: boolean,
): number {
	const topWorldY = chunk.chunkY * SIZE + SIZE - 1;
	const hasLoadedAbove = aboveChunk?.isLoaded === true;
	const canSeedFromGeneratorHeight = topWorldY >= MIN_GENERATION_WORLD_Y;
	const worldBaseX = chunk.chunkX * SIZE;
	const worldBaseY = chunk.chunkY * SIZE;
	const worldBaseZ = chunk.chunkZ * SIZE;
	const paletteBytes = palette !== null ? (blocks as Uint8Array) : null;
	let length = 0;

	for (let x = 0; x < SIZE; x++) {
		for (let z = 0; z < SIZE; z++) {
			let incomingSkyLight = 0;
			let sourceFiltersFullSun = false;

			if (hasLoadedAbove && aboveChunk !== undefined) {
				const aboveBlockPacked = aboveChunk.getBlockPacked(x, 0, z);
				if (isTransparent(aboveBlockPacked, 1, -1)) {
					incomingSkyLight = aboveChunk.getSkyLight(x, 0, z);
					sourceFiltersFullSun = filtersFullSunlight(
						unpackBlockId(aboveBlockPacked),
					);
				}
			} else if (canSeedFromGeneratorHeight) {
				const terrainHeight = getFinalTerrainHeight(
					worldBaseX + x,
					worldBaseZ + z,
				);
				if (topWorldY >= terrainHeight - 48) incomingSkyLight = 15;
			}

			const columnBase = x + z * SIZE2;
			let index = columnBase + (SIZE - 1) * SIZE;

			for (let y = SIZE - 1; y >= 0; y--, index -= SIZE) {
				const worldY = worldBaseY + y;
				if (!hasLoadedAbove && worldY < MIN_GENERATION_WORLD_Y) break;

				let blockPacked = 0;
				if (canReadBlocks) {
					if (isUniform) {
						blockPacked = uniformBlockId;
					} else if (paletteBytes !== null) {
						const byte = paletteBytes[index >>> 1];
						const nibble = (index & 1) === 0 ? byte & 0x0f : byte >>> 4;
						blockPacked = palette![nibble];
					} else {
						blockPacked = blocks![index];
					}
				}

				if (!isTransparent(blockPacked, 1, 1)) {
					incomingSkyLight = 0;
					sourceFiltersFullSun = false;
					continue;
				}
				if (incomingSkyLight <= 0) continue;

				const filtersSun = filtersFullSunlight(unpackBlockId(blockPacked));
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

				if (!filtersSun && length < seedCapacity) {
					seedQueue[length++] = (x << 10) | (y << 5) | z;
				}

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

	return length;
}

export function copySunlightSeeds(length: number): Uint16Array {
	return seedQueue.slice(0, length);
}
