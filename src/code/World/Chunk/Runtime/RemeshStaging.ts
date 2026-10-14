import type { Chunk } from "../Chunk";

export class RemeshStaging {
	private pending = new Map<Chunk, boolean>();

	get size(): number {
		return this.pending.size;
	}

	get isEmpty(): boolean {
		return this.pending.size === 0;
	}

	has(chunk: Chunk): boolean {
		return this.pending.has(chunk);
	}

	delete(chunk: Chunk): void {
		this.pending.delete(chunk);
	}

	/** Stage a request, upgrading but never downgrading priority. */
	add(chunk: Chunk, priority: boolean): void {
		if (priority) {
			this.pending.set(chunk, true);
		} else if (!this.pending.has(chunk)) {
			this.pending.set(chunk, false);
		}
	}

	/**
	 * Drain all staged entries into the reusable output array.
	 *
	 * Existing tuple objects are updated in place to avoid allocating one
	 * `[Chunk, boolean]` array per staged entry on every drain.
	 */
	drainInto(out: Array<[Chunk, boolean]>): void {
		let writeIndex = 0;

		this.pending.forEach((priority, chunk) => {
			const entry = out[writeIndex];

			if (entry === undefined) {
				out.push([chunk, priority]);
			} else {
				entry[0] = chunk;
				entry[1] = priority;
			}

			writeIndex++;
		});

		out.length = writeIndex;
		this.pending.clear();
	}
}
