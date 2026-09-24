import type { Chunk } from "../Chunk";

const MAX_POOL_SIZE = 512;
const pool: Chunk[] = [];

export function takePooledChunk(): Chunk | undefined {
	return pool.pop();
}

export function releasePooledChunk(chunk: Chunk): void {
	if (chunk.isBoatChunk) return;
	if (pool.length < MAX_POOL_SIZE) pool.push(chunk);
}
