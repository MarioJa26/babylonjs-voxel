import type { Chunk } from "../Chunk";

// PERF: 8-chunk cells instead of 32-chunk ones. With 32-chunk cells a
// radius query's AABB covered only 1-2 cells per axis, so unload scans and
// LOD refreshes collected essentially EVERY loaded chunk regardless of the
// actual radius. Smaller cells multiply the number of Map probes (cheap)
// while cutting the collected-set noise dramatically.
const CELL_SHIFT = 3;

const HASH_X = 73856093;
const HASH_Y = 19349663;
const HASH_Z = 83492791;

type LoadedChunkCell = {
	hash: number;
	cx: number;
	cy: number;
	cz: number;
	chunks: Set<Chunk>;
	chunkList: Chunk[];
};

function chunkCoordToCell(coord: number): number {
	// Same as Math.floor(coord / 2^CELL_SHIFT) for signed 32-bit coordinates.
	// Arithmetic shift correctly floors negative coordinates.
	return coord >> CELL_SHIFT;
}

function hashCellKey(cx: number, cy: number, cz: number): number {
	return Math.imul(cx, HASH_X) ^ Math.imul(cy, HASH_Y) ^ Math.imul(cz, HASH_Z);
}

function chunkCellX(chunk: Chunk): number {
	return chunk.chunkX >> CELL_SHIFT;
}

function chunkCellY(chunk: Chunk): number {
	return chunk.chunkY >> CELL_SHIFT;
}

function chunkCellZ(chunk: Chunk): number {
	return chunk.chunkZ >> CELL_SHIFT;
}

export class LoadedChunkIndex {
	// hash -> one or more exact cells.
	// Multiple exact cells are only needed when the integer hash collides.
	private readonly cells = new Map<number, LoadedChunkCell[]>();

	// numericId -> exact cell object.
	// Storing the cell object makes unregister O(1) and avoids the old key=0 bug.
	private readonly chunkCells = new Map<number, LoadedChunkCell>();

	// P0-3: pooled empty cells to avoid `new Set` + object churn per streaming burst.
	// Cells are recycled when their chunk count drops to zero.
	private readonly _freeCells: LoadedChunkCell[] = [];

	private _allocCell(
		hash: number,
		cx: number,
		cy: number,
		cz: number,
	): LoadedChunkCell {
		const pooled = this._freeCells.pop();
		if (pooled !== undefined) {
			pooled.hash = hash;
			pooled.cx = cx;
			pooled.cy = cy;
			pooled.cz = cz;
			// Set and list are already cleared on recycle.
			return pooled;
		}
		return {
			hash,
			cx,
			cy,
			cz,
			chunks: new Set<Chunk>(),
			chunkList: [],
		};
	}

	register(chunk: Chunk): void {
		const numericId = chunk.numericId;

		const cx = chunkCellX(chunk);
		const cy = chunkCellY(chunk);
		const cz = chunkCellZ(chunk);
		const hash = hashCellKey(cx, cy, cz);

		const previousCell = this.chunkCells.get(numericId);

		if (
			previousCell !== undefined &&
			previousCell.cx === cx &&
			previousCell.cy === cy &&
			previousCell.cz === cz
		) {
			if (!previousCell.chunks.has(chunk)) {
				previousCell.chunks.add(chunk);
				previousCell.chunkList.push(chunk);
			}
			return;
		}

		if (previousCell !== undefined) {
			this.removeFromCell(chunk, previousCell);
		}

		const bucket = this.cells.get(hash);
		let cell: LoadedChunkCell | undefined;

		if (bucket === undefined) {
			cell = this._allocCell(hash, cx, cy, cz);
			this.cells.set(hash, [cell]);
		} else {
			for (let i = 0; i < bucket.length; i++) {
				const candidate = bucket[i];

				if (candidate.cx === cx && candidate.cy === cy && candidate.cz === cz) {
					cell = candidate;
					break;
				}
			}

			if (cell === undefined) {
				cell = this._allocCell(hash, cx, cy, cz);
				bucket.push(cell);
			}
		}

		cell.chunks.add(chunk);
		cell.chunkList.push(chunk);
		this.chunkCells.set(numericId, cell);
	}

	unregister(chunk: Chunk): void {
		const cell = this.chunkCells.get(chunk.numericId);

		if (cell === undefined) {
			return;
		}

		this.chunkCells.delete(chunk.numericId);
		this.removeFromCell(chunk, cell);
	}

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

		for (let cx = minCX; cx <= maxCX; cx++) {
			const hx = Math.imul(cx, HASH_X);

			for (let cy = minCY; cy <= maxCY; cy++) {
				const hxy = hx ^ Math.imul(cy, HASH_Y);

				for (let cz = minCZ; cz <= maxCZ; cz++) {
					const bucket = this.cells.get(hxy ^ Math.imul(cz, HASH_Z));

					if (bucket === undefined) {
						continue;
					}

					for (let i = 0; i < bucket.length; i++) {
						const cell = bucket[i];

						if (cell.cx !== cx || cell.cy !== cy || cell.cz !== cz) {
							continue;
						}

						const list = cell.chunkList;
						for (let j = 0; j < list.length; j++) {
							yield list[j];
						}

						break;
					}
				}
			}
		}
	}

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

		for (let cx = minCX; cx <= maxCX; cx++) {
			const hx = Math.imul(cx, HASH_X);

			for (let cy = minCY; cy <= maxCY; cy++) {
				const hxy = hx ^ Math.imul(cy, HASH_Y);

				for (let cz = minCZ; cz <= maxCZ; cz++) {
					const bucket = this.cells.get(hxy ^ Math.imul(cz, HASH_Z));

					if (bucket === undefined) {
						continue;
					}

					for (let i = 0; i < bucket.length; i++) {
						const cell = bucket[i];

						if (cell.cx !== cx || cell.cy !== cy || cell.cz !== cz) {
							continue;
						}

						const list = cell.chunkList;
						for (let j = 0; j < list.length; j++) {
							out.push(list[j]);
						}

						break;
					}
				}
			}
		}
	}

	*all(): IterableIterator<Chunk> {
		for (const bucket of this.cells.values()) {
			for (let i = 0; i < bucket.length; i++) {
				const list = bucket[i].chunkList;
				for (let j = 0; j < list.length; j++) {
					yield list[j];
				}
			}
		}
	}

	private removeFromCell(chunk: Chunk, cell: LoadedChunkCell): void {
		cell.chunks.delete(chunk);
		// P1-5: keep array in sync via swap-remove (O(n) but cell avg < 16).
		const list = cell.chunkList;
		const idx = list.indexOf(chunk);
		if (idx >= 0) {
			list[idx] = list[list.length - 1];
			list.pop();
		}

		if (cell.chunks.size !== 0) {
			return;
		}

		const bucket = this.cells.get(cell.hash);

		if (bucket === undefined) {
			return;
		}

		if (bucket.length === 1) {
			this.cells.delete(cell.hash);
		} else {
			const index = bucket.indexOf(cell);
			if (index >= 0) {
				bucket[index] = bucket[bucket.length - 1];
				bucket.pop();
			}
		}
		// P0-3: recycle empty cell (Set + list cleared) to avoid GC.
		// Chunks already removed, set is empty, list is empty.
		this._freeCells.push(cell);
	}
}
