import type { Chunk } from "../Chunk";

const CELL_SHIFT = 5;

const HASH_X = 73856093;
const HASH_Y = 19349663;
const HASH_Z = 83492791;

type LoadedChunkCell = {
	hash: number;
	cx: number;
	cy: number;
	cz: number;
	chunks: Set<Chunk>;
};

function chunkCoordToCell(coord: number): number {
	// Same as Math.floor(coord / 32) for signed 32-bit integer coordinates.
	// Important: arithmetic shift correctly floors negative coordinates.
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
			previousCell.chunks.add(chunk);
			return;
		}

		if (previousCell !== undefined) {
			this.removeFromCell(chunk, previousCell);
		}

		const bucket = this.cells.get(hash);
		let cell: LoadedChunkCell | undefined;

		if (bucket === undefined) {
			cell = {
				hash,
				cx,
				cy,
				cz,
				chunks: new Set<Chunk>(),
			};

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
				cell = {
					hash,
					cx,
					cy,
					cz,
					chunks: new Set<Chunk>(),
				};

				bucket.push(cell);
			}
		}

		cell.chunks.add(chunk);
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

						for (const chunk of cell.chunks) {
							yield chunk;
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

						for (const chunk of cell.chunks) {
							out.push(chunk);
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
				for (const chunk of bucket[i].chunks) {
					yield chunk;
				}
			}
		}
	}

	private removeFromCell(chunk: Chunk, cell: LoadedChunkCell): void {
		cell.chunks.delete(chunk);

		if (cell.chunks.size !== 0) {
			return;
		}

		const bucket = this.cells.get(cell.hash);

		if (bucket === undefined) {
			return;
		}

		if (bucket.length === 1) {
			this.cells.delete(cell.hash);
			return;
		}

		const index = bucket.indexOf(cell);

		if (index >= 0) {
			bucket[index] = bucket[bucket.length - 1];
			bucket.pop();
		}
	}
}
