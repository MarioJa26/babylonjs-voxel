import type { Chunk } from "../Chunk";

/*
 * Eight-chunk cells provide substantially tighter spatial queries than the old
 * 32-chunk cells. More hash probes are traded for far fewer unrelated chunks
 * returned by unload and LOD-refresh scans.
 */
const CELL_SHIFT = 3;

const HASH_X = 73_856_093;
const HASH_Y = 19_349_663;
const HASH_Z = 83_492_791;

type LoadedChunkCell = {
	hash: number;
	cx: number;
	cy: number;
	cz: number;

	/**
	 * Dense chunk storage.
	 *
	 * A chunk's position in this array is stored in chunkSlots, allowing O(1)
	 * swap-removal without maintaining a duplicated Set<Chunk>.
	 */
	chunks: Chunk[];
};

function chunkCoordToCell(coord: number): number {
	/*
	 * Equivalent to Math.floor(coord / 2^CELL_SHIFT) for signed 32-bit chunk
	 * coordinates. Arithmetic right shift correctly floors negative values.
	 */
	return coord >> CELL_SHIFT;
}

function hashCellKey(cx: number, cy: number, cz: number): number {
	return Math.imul(cx, HASH_X) ^ Math.imul(cy, HASH_Y) ^ Math.imul(cz, HASH_Z);
}

export class LoadedChunkIndex {
	/**
	 * Integer hash to one or more exact cells.
	 *
	 * Arrays are needed only for genuine integer-hash collisions. Cell
	 * coordinates are always checked before a bucket entry is used.
	 */
	private readonly cells = new Map<number, LoadedChunkCell[]>();

	/**
	 * Chunk numeric ID to its exact cell.
	 *
	 * Storing the cell object avoids recomputing coordinates during unregister
	 * and prevents sentinel-key ambiguity.
	 */
	private readonly chunkCells = new Map<number, LoadedChunkCell>();

	/**
	 * Chunk numeric ID to its slot in LoadedChunkCell.chunks.
	 *
	 * Together with chunkCells, this makes removal O(1). The moved chunk's slot
	 * is updated during swap-removal.
	 */
	private readonly chunkSlots = new Map<number, number>();

	/**
	 * Recycled empty cells.
	 *
	 * Each pooled object retains its chunks array and therefore avoids repeated
	 * cell-object and array allocation during unload/reload bursts.
	 */
	private readonly freeCells: LoadedChunkCell[] = [];

	private allocateCell(
		hash: number,
		cx: number,
		cy: number,
		cz: number,
	): LoadedChunkCell {
		const pooled = this.freeCells.pop();

		if (pooled !== undefined) {
			pooled.hash = hash;
			pooled.cx = cx;
			pooled.cy = cy;
			pooled.cz = cz;

			// Cleared before recycling.
			return pooled;
		}

		return {
			hash,
			cx,
			cy,
			cz,
			chunks: [],
		};
	}

	/**
	 * Register a loaded chunk or move its existing registration to the correct
	 * spatial cell.
	 */
	register(chunk: Chunk): void {
		const numericId = chunk.numericId;

		const cx = chunk.chunkX >> CELL_SHIFT;
		const cy = chunk.chunkY >> CELL_SHIFT;
		const cz = chunk.chunkZ >> CELL_SHIFT;

		const previousCell = this.chunkCells.get(numericId);

		if (
			previousCell !== undefined &&
			previousCell.cx === cx &&
			previousCell.cy === cy &&
			previousCell.cz === cz
		) {
			/*
			 * Already registered in the correct cell. The slot identity check
			 * repairs missing slot bookkeeping without duplicating the chunk.
			 */
			const previousSlot = this.chunkSlots.get(numericId);

			if (
				previousSlot !== undefined &&
				previousCell.chunks[previousSlot] === chunk
			) {
				return;
			}

			const recoveredSlot = previousCell.chunks.indexOf(chunk);

			if (recoveredSlot !== -1) {
				this.chunkSlots.set(numericId, recoveredSlot);
				return;
			}

			const slot = previousCell.chunks.length;

			previousCell.chunks.push(chunk);
			this.chunkSlots.set(numericId, slot);

			return;
		}

		if (previousCell !== undefined) {
			this.removeFromCell(numericId, chunk, previousCell);
		}

		const hash = hashCellKey(cx, cy, cz);
		let bucket = this.cells.get(hash);
		let cell: LoadedChunkCell | undefined;

		if (bucket === undefined) {
			cell = this.allocateCell(hash, cx, cy, cz);

			bucket = [cell];
			this.cells.set(hash, bucket);
		} else {
			for (let i = 0; i < bucket.length; i++) {
				const candidate = bucket[i];

				if (candidate.cx === cx && candidate.cy === cy && candidate.cz === cz) {
					cell = candidate;
					break;
				}
			}

			if (cell === undefined) {
				cell = this.allocateCell(hash, cx, cy, cz);

				bucket.push(cell);
			}
		}

		const slot = cell.chunks.length;

		cell.chunks.push(chunk);
		this.chunkCells.set(numericId, cell);
		this.chunkSlots.set(numericId, slot);
	}

	/**
	 * Remove a chunk from the index.
	 */
	unregister(chunk: Chunk): void {
		const numericId = chunk.numericId;
		const cell = this.chunkCells.get(numericId);

		if (cell === undefined) {
			return;
		}

		this.removeFromCell(numericId, chunk, cell);
	}

	/**
	 * Yield all chunks in spatial cells intersecting the supplied chunk-space
	 * bounding box.
	 *
	 * As in the original implementation, this performs cell-level filtering.
	 * Consumers may apply exact distance checks afterward.
	 */
	*query(
		centerX: number,
		centerY: number,
		centerZ: number,
		horizontalRadius: number,
		verticalRadius: number,
	): IterableIterator<Chunk> {
		const minCX = chunkCoordToCell(centerX - horizontalRadius);
		const maxCX = chunkCoordToCell(centerX + horizontalRadius);
		const minCY = chunkCoordToCell(centerY - verticalRadius);
		const maxCY = chunkCoordToCell(centerY + verticalRadius);
		const minCZ = chunkCoordToCell(centerZ - horizontalRadius);
		const maxCZ = chunkCoordToCell(centerZ + horizontalRadius);

		const cells = this.cells;

		for (let cx = minCX; cx <= maxCX; cx++) {
			const hx = Math.imul(cx, HASH_X);

			for (let cy = minCY; cy <= maxCY; cy++) {
				const hxy = hx ^ Math.imul(cy, HASH_Y);

				for (let cz = minCZ; cz <= maxCZ; cz++) {
					const hash = hxy ^ Math.imul(cz, HASH_Z);

					const bucket = cells.get(hash);

					if (bucket === undefined) {
						continue;
					}

					for (
						let bucketIndex = 0;
						bucketIndex < bucket.length;
						bucketIndex++
					) {
						const cell = bucket[bucketIndex];

						if (cell.cx !== cx || cell.cy !== cy || cell.cz !== cz) {
							continue;
						}

						const chunks = cell.chunks;

						for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
							yield chunks[chunkIndex];
						}

						break;
					}
				}
			}
		}
	}

	/**
	 * Append all chunks in intersecting spatial cells to `out`.
	 *
	 * The destination is not cleared. This allows callers to reuse a scratch
	 * array and control its lifetime.
	 */
	queryCollect(
		centerX: number,
		centerY: number,
		centerZ: number,
		horizontalRadius: number,
		verticalRadius: number,
		out: Chunk[],
	): void {
		const minCX = chunkCoordToCell(centerX - horizontalRadius);
		const maxCX = chunkCoordToCell(centerX + horizontalRadius);
		const minCY = chunkCoordToCell(centerY - verticalRadius);
		const maxCY = chunkCoordToCell(centerY + verticalRadius);
		const minCZ = chunkCoordToCell(centerZ - horizontalRadius);
		const maxCZ = chunkCoordToCell(centerZ + horizontalRadius);

		const cells = this.cells;
		let outIndex = out.length;

		for (let cx = minCX; cx <= maxCX; cx++) {
			const hx = Math.imul(cx, HASH_X);

			for (let cy = minCY; cy <= maxCY; cy++) {
				const hxy = hx ^ Math.imul(cy, HASH_Y);

				for (let cz = minCZ; cz <= maxCZ; cz++) {
					const hash = hxy ^ Math.imul(cz, HASH_Z);

					const bucket = cells.get(hash);

					if (bucket === undefined) {
						continue;
					}

					for (
						let bucketIndex = 0;
						bucketIndex < bucket.length;
						bucketIndex++
					) {
						const cell = bucket[bucketIndex];

						if (cell.cx !== cx || cell.cy !== cy || cell.cz !== cz) {
							continue;
						}

						const chunks = cell.chunks;

						/*
						 * Indexed assignment avoids a function call to push()
						 * for every collected chunk and updates array length
						 * naturally.
						 */
						for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
							out[outIndex++] = chunks[chunkIndex];
						}

						break;
					}
				}
			}
		}
	}

	/**
	 * Iterate every indexed chunk.
	 */
	*all(): IterableIterator<Chunk> {
		for (const bucket of this.cells.values()) {
			for (let bucketIndex = 0; bucketIndex < bucket.length; bucketIndex++) {
				const chunks = bucket[bucketIndex].chunks;

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					yield chunks[chunkIndex];
				}
			}
		}
	}

	/**
	 * Remove one chunk using its recorded dense-array slot.
	 *
	 * Normal removal is O(1). A linear recovery scan is retained only for
	 * defensive repair if slot bookkeeping is inconsistent.
	 */
	private removeFromCell(
		numericId: number,
		chunk: Chunk,
		cell: LoadedChunkCell,
	): void {
		const chunks = cell.chunks;
		let slot = this.chunkSlots.get(numericId);

		if (slot === undefined || chunks[slot] !== chunk) {
			/*
			 * Bookkeeping drift should not happen, but recovering here is safer
			 * than removing a different chunk or leaving a duplicate behind.
			 */
			slot = chunks.indexOf(chunk);
		}

		this.chunkCells.delete(numericId);
		this.chunkSlots.delete(numericId);

		if (slot !== -1 && slot !== undefined) {
			const lastIndex = chunks.length - 1;
			const movedChunk = chunks[lastIndex];

			if (slot !== lastIndex) {
				chunks[slot] = movedChunk;
				this.chunkSlots.set(movedChunk.numericId, slot);
			}

			chunks.pop();
		}

		if (chunks.length !== 0) {
			return;
		}

		this.removeEmptyCell(cell);
	}

	/**
	 * Remove an empty exact cell from its hash bucket and recycle it.
	 */
	private removeEmptyCell(cell: LoadedChunkCell): void {
		const cells = this.cells;
		const bucket = cells.get(cell.hash);

		if (bucket === undefined) {
			return;
		}

		if (bucket.length === 1) {
			/*
			 * Verify identity defensively before deleting the complete bucket.
			 */
			if (bucket[0] !== cell) {
				return;
			}

			cells.delete(cell.hash);
		} else {
			const index = bucket.indexOf(cell);

			if (index === -1) {
				return;
			}

			const lastIndex = bucket.length - 1;

			if (index !== lastIndex) {
				bucket[index] = bucket[lastIndex];
			}

			bucket.pop();
		}

		// The dense list is already empty and ready for reuse.
		this.freeCells.push(cell);
	}
}
