import { type Chunk, getChunk } from "../Chunk";

function areAllChunksAround(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	horizontalRadius: number,
	verticalRadius: number,
	isReady: (chunk: Chunk) => boolean,
): boolean {
	for (let dy = -verticalRadius; dy <= verticalRadius; dy++) {
		for (let dz = -horizontalRadius; dz <= horizontalRadius; dz++) {
			for (let dx = -horizontalRadius; dx <= horizontalRadius; dx++) {
				const chunk = getChunk(chunkX + dx, chunkY + dy, chunkZ + dz);
				if (!chunk || !isReady(chunk)) return false;
			}
		}
	}

	return true;
}

export function areChunksLoadedAround(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	horizontalRadius: number = 1,
	verticalRadius: number = 0,
): boolean {
	return areAllChunksAround(
		chunkX,
		chunkY,
		chunkZ,
		horizontalRadius,
		verticalRadius,
		(chunk) => chunk.isLoaded && chunk.hasVoxelData,
	);
}

export function areChunksLod0ReadyAround(
	chunkX: number,
	chunkY: number,
	chunkZ: number,
	horizontalRadius: number = 1,
	verticalRadius: number = 0,
): boolean {
	return areAllChunksAround(
		chunkX,
		chunkY,
		chunkZ,
		horizontalRadius,
		verticalRadius,
		(chunk) => chunk.lodLevel === 0 && chunk.isLoaded && chunk.hasVoxelData,
	);
}
