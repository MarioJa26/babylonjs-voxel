import type { Chunk } from "../Chunk";

export class TerrainTaskQueue {
	/**
	 * Insertion order provides FIFO behavior.
	 *
	 * Value semantics:
	 * - true: lighting may be deferred
	 * - false: lighting must not be deferred
	 */
	private queue = new Map<Chunk, boolean>();

	get size(): number {
		return this.queue.size;
	}

	get isEmpty(): boolean {
		return this.queue.size === 0;
	}

	has(chunk: Chunk): boolean {
		return this.queue.has(chunk);
	}

	add(chunk: Chunk, deferLighting = true): void {
		const existing = this.queue.get(chunk);

		if (existing === undefined) {
			this.queue.set(chunk, deferLighting);
			return;
		}

		/*
		 * A non-deferred request overrides a deferred request, but a later
		 * deferred request must never weaken an existing non-deferred one.
		 */
		if (existing && !deferLighting) {
			this.queue.set(chunk, false);
		}
	}

	takeFirst(): Chunk | undefined {
		const iterator = this.queue.keys();
		const first = iterator.next();

		if (first.done) {
			return undefined;
		}

		const chunk = first.value;
		this.queue.delete(chunk);

		return chunk;
	}

	getDeferLighting(chunk: Chunk): boolean {
		return this.queue.get(chunk) ?? true;
	}

	/** Drop queue and defer-lighting state. */
	remove(chunk: Chunk): void {
		this.queue.delete(chunk);
	}
}
