// ---------------------------------------------------------------------------
// IdleWorkerTracker: idle-worker queue (extracted from ChunkWorkerPool).
//
// A worker is idle if and only if it appears in `positions`.
//
// `indices` is a flat FIFO with a consume pointer. Only entries in
// [readIdx, indices.length) are live. Consumed entries remain as a prefix
// until opportunistic compaction.
//
// `positions` maps each live worker index to its physical position in
// `indices`, supporting constant-time membership, removal, and preferred
// worker selection.
// ---------------------------------------------------------------------------

export class IdleWorkerTracker {
	private indices: number[] = [];

	/**
	 * Live worker index -> physical position in `indices`.
	 *
	 * This map is also the authoritative idle-membership structure.
	 */
	private positions = new Map<number, number>();

	private readIdx = 0;

	/** Number of workers currently available for dispatch. */
	get effectiveCount(): number {
		return this.positions.size;
	}

	/** Whether the worker is currently idle. */
	has(workerIndex: number): boolean {
		return this.positions.has(workerIndex);
	}

	/**
	 * Mark a worker idle.
	 *
	 * This operation is idempotent. Calling it for an already-idle worker
	 * does not add a duplicate queue entry.
	 */
	markIdle(workerIndex: number): void {
		const positions = this.positions;

		if (positions.has(workerIndex)) {
			return;
		}

		const position = this.indices.length;

		this.indices.push(workerIndex);
		positions.set(workerIndex, position);
	}

	/**
	 * Remove an idle worker in O(1) using swap-remove within the live range.
	 *
	 * The final live worker is moved into the removed worker's slot. This may
	 * alter that worker's relative FIFO order, matching the original behavior.
	 */
	remove(workerIndex: number): void {
		const positions = this.positions;
		const position = positions.get(workerIndex);

		if (position === undefined) {
			return;
		}

		positions.delete(workerIndex);

		const indices = this.indices;
		const lastPosition = indices.length - 1;

		if (position !== lastPosition) {
			const swappedWorker = indices[lastPosition];

			indices[position] = swappedWorker;
			positions.set(swappedWorker, position);
		}

		indices.length = lastPosition;
	}

	/**
	 * Consume the next idle worker from the front of the live queue.
	 *
	 * Returns -1 when no idle worker is available. The consumed array prefix
	 * remains allocated until `maybeCompact()` decides that compaction is
	 * worthwhile.
	 */
	consumeNext(): number {
		const position = this.readIdx;
		const indices = this.indices;

		if (position >= indices.length) {
			return -1;
		}

		const workerIndex = indices[position];

		this.readIdx = position + 1;
		this.positions.delete(workerIndex);

		return workerIndex;
	}

	/**
	 * Move a preferred idle worker to the front in O(1).
	 *
	 * If successful, the next call to `consumeNext()` returns `preferred`.
	 * Returns false when the preferred worker is not currently idle.
	 */
	swapPreferredToFront(preferred: number): boolean {
		const positions = this.positions;
		const preferredPosition = positions.get(preferred);

		if (preferredPosition === undefined) {
			return false;
		}

		const frontPosition = this.readIdx;

		if (preferredPosition === frontPosition) {
			return true;
		}

		const indices = this.indices;
		const frontWorker = indices[frontPosition];

		indices[frontPosition] = preferred;
		indices[preferredPosition] = frontWorker;

		positions.set(preferred, frontPosition);
		positions.set(frontWorker, preferredPosition);

		return true;
	}

	/**
	 * Discard the consumed prefix and update the physical positions of all
	 * remaining idle workers.
	 */
	compact(): void {
		const consumed = this.readIdx;

		if (consumed === 0) {
			return;
		}

		const indices = this.indices;
		const remaining = indices.length - consumed;

		if (remaining === 0) {
			indices.length = 0;
			this.readIdx = 0;
			this.positions.clear();
			return;
		}

		indices.copyWithin(0, consumed);
		indices.length = remaining;
		this.readIdx = 0;

		const positions = this.positions;

		for (let i = 0; i < remaining; i++) {
			positions.set(indices[i], i);
		}
	}

	/**
	 * Compact when more than eight entries have been consumed and the
	 * consumed prefix occupies at least half of the backing array.
	 */
	maybeCompact(): void {
		const readIdx = this.readIdx;

		if (readIdx > 8 && readIdx * 2 >= this.indices.length) {
			this.compact();
		}
	}
}
