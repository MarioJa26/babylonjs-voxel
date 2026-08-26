import { getChunk } from "../Chunk";

export function areChunksLoadedAround(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	horizontalRadius: number = 1,
	verticalRadius: number = 0,
): boolean {
	for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
		for (let dz = -horizontalRadius; dz <= horizontalRadius; dz++) {
			for (let dx = -horizontalRadius; dx <= horizontalRadius; dx++) {
				const chunk = getChunk(chunkX + dx, chunkY + dy, chunkZ + dz);
				if (!chunk) return false;
				if (!chunk.isLoaded || !chunk.hasVoxelData) return false;
			}
		}
	}

	return true;
}

export function areChunksLod0ReadyAround(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	horizontalRadius: number = 1,
	verticalRadius: number = 0,
): boolean {
	for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
		for (let dz = -horizontalRadius; dz <= horizontalRadius; dz++) {
			for (let dx = -horizontalRadius; dx <= horizontalRadius; dx++) {
				const chunk = getChunk(chunkX + dx, chunkY + dy, chunkZ + dz);
				if (!chunk) return false;
				if (chunk.lodLevel !== 0 || !chunk.isLoaded || !chunk.hasVoxelData) {
					return false;
				}
			}
		}
	}

	return true;
}
