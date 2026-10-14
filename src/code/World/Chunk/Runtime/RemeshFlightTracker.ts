import type { Chunk } from "../Chunk";

const LOD_MASK = 0xf;

/**
 * Retained for compatibility with existing callers and diagnostics.
 *
 * Avoid bit shifts here because JavaScript bitwise operations coerce the
 * numeric chunk ID to a signed 32-bit integer.
 */
export function packInflightKey(numericId: number, lod: number): number {
	return numericId * 16 + (lod & LOD_MASK);
}

export class RemeshFlightTracker {
	/**
	 * Chunk numeric ID -> 16-bit mask of in-flight LOD levels.
	 *
	 * Bit N is set when LOD N is in flight.
	 */
	private inflightLods = new Map<number, number>();

	private baselines = new Map<bigint, number>();

	static packBaseline(blockRevision: number, lod: number): number {
		return blockRevision * 16 + (lod & LOD_MASK);
	}

	isSameLodInflight(chunk: Chunk): boolean {
		const lod = (chunk.lodLevel ?? 0) & LOD_MASK;
		const mask = this.inflightLods.get(chunk.numericId) ?? 0;

		return (mask & (1 << lod)) !== 0;
	}

	isAnyLodInflight(chunk: Chunk): boolean {
		return this.inflightLods.has(chunk.numericId);
	}

	add(chunk: Chunk, lod: number): void {
		const numericId = chunk.numericId;
		const lodBit = 1 << (lod & LOD_MASK);
		const currentMask = this.inflightLods.get(numericId) ?? 0;

		this.inflightLods.set(numericId, currentMask | lodBit);
	}

	clear(chunk: Chunk, lod: number): void {
		const numericId = chunk.numericId;
		const currentMask = this.inflightLods.get(numericId);

		if (currentMask === undefined) {
			return;
		}

		const lodBit = 1 << (lod & LOD_MASK);
		const remainingMask = currentMask & ~lodBit;

		if (remainingMask === 0) {
			this.inflightLods.delete(numericId);
		} else {
			this.inflightLods.set(numericId, remainingMask);
		}
	}

	clearAll(chunk: Chunk): void {
		this.inflightLods.delete(chunk.numericId);
	}

	recordBaseline(chunk: Chunk, lod: number): void {
		this.baselines.set(
			chunk.id,
			RemeshFlightTracker.packBaseline(chunk.blockRevision, lod),
		);
	}

	getBaseline(chunkId: bigint): number | undefined {
		return this.baselines.get(chunkId);
	}

	deleteBaseline(chunkId: bigint): void {
		this.baselines.delete(chunkId);
	}
}
