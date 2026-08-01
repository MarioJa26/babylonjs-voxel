import type { Chunk } from "../Chunk";

const CELL_SIZE = 32;

function hashCellKey(cx: number, cy: number, cz: number): number {
	return (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
}

function chunkToCellKey(chunk: Chunk): number {
	return hashCellKey(
		Math.floor(chunk.chunkX / CELL_SIZE),
		Math.floor(chunk.chunkY / CELL_SIZE),
		Math.floor(chunk.chunkZ / CELL_SIZE),
	);
}

export class LoadedChunkIndex {
	private readonly cells = new Map<number, Set<Chunk>>();
	private readonly chunkCellKeys = new Map<number, number>();

	register(chunk: Chunk): void {
		const key = chunkToCellKey(chunk);
		this.chunkCellKeys.set(chunk.numericId, key);
		let cell = this.cells.get(key);
		if (!cell) {
			cell = new Set();
			this.cells.set(key, cell);
		}
		cell.add(chunk);
	}

	unregister(chunk: Chunk): void {
		const key = this.chunkCellKeys.get(chunk.numericId);
		if (!key) return;
		this.chunkCellKeys.delete(chunk.numericId);
		const cell = this.cells.get(key);
		if (cell) {
			cell.delete(chunk);
			if (cell.size === 0) this.cells.delete(key);
		}
	}

	*query(
		centerX: number,
		centerY: number,
		centerZ: number,
		horizontalRadius: number,
		verticalRadius: number,
	): IterableIterator<Chunk> {
		const minCX = Math.floor((centerX - horizontalRadius) / CELL_SIZE);
		const maxCX = Math.floor((centerX + horizontalRadius) / CELL_SIZE);
		const minCY = Math.floor((centerY - verticalRadius) / CELL_SIZE);
		const maxCY = Math.floor((centerY + verticalRadius) / CELL_SIZE);
		const minCZ = Math.floor((centerZ - horizontalRadius) / CELL_SIZE);
		const maxCZ = Math.floor((centerZ + horizontalRadius) / CELL_SIZE);

		for (let cx = minCX; cx <= maxCX; cx++) {
			for (let cy = minCY; cy <= maxCY; cy++) {
				for (let cz = minCZ; cz <= maxCZ; cz++) {
					const cell = this.cells.get(hashCellKey(cx, cy, cz));
					if (!cell) continue;
					for (const chunk of cell) {
						yield chunk;
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
		const minCX = Math.floor((centerX - horizontalRadius) / CELL_SIZE);
		const maxCX = Math.floor((centerX + horizontalRadius) / CELL_SIZE);
		const minCY = Math.floor((centerY - verticalRadius) / CELL_SIZE);
		const maxCY = Math.floor((centerY + verticalRadius) / CELL_SIZE);
		const minCZ = Math.floor((centerZ - horizontalRadius) / CELL_SIZE);
		const maxCZ = Math.floor((centerZ + horizontalRadius) / CELL_SIZE);

		for (let cx = minCX; cx <= maxCX; cx++) {
			for (let cy = minCY; cy <= maxCY; cy++) {
				for (let cz = minCZ; cz <= maxCZ; cz++) {
					const cell = this.cells.get(hashCellKey(cx, cy, cz));
					if (!cell) continue;
					for (const chunk of cell) {
						out.push(chunk);
					}
				}
			}
		}
	}

	*all(): IterableIterator<Chunk> {
		for (const cell of this.cells.values()) {
			for (const chunk of cell) {
				yield chunk;
			}
		}
	}
}
