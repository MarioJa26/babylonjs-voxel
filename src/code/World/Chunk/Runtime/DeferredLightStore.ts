import type { Chunk } from "../Chunk";

export type DeferredLightSeed = {
	queue: Uint16Array;
	length: number;
};

const COMPACT_MIN_PREFIX = 64;

export class DeferredLightStore {
	private queue: (Chunk | null)[] = [];
	private readIdx = 0;

	/**
	 * Chunk ID -> physical queue index.
	 *
	 * This replaces the separate queued-ID set and makes disposal
	 * invalidation O(1) instead of scanning the unread queue.
	 */
	private queuedSlots = new Map<bigint, number>();

	private seeds = new Map<bigint, DeferredLightSeed>();

	/**
	 * Reused while merging seed queues. Because seed values are uint16,
	 * this set remains bounded by 65,536 entries.
	 */
	private seen = new Set<number>();

	get pendingCount(): number {
		return this.queue.length - this.readIdx;
	}

	get hasPending(): boolean {
		return this.readIdx < this.queue.length;
	}

	get seedStateCount(): number {
		return this.seeds.size;
	}

	/** Queued or holding seed state; skip duplicate sky scan while pending. */
	has(chunk: Chunk): boolean {
		const chunkId = chunk.id;
		return this.queuedSlots.has(chunkId) || this.seeds.has(chunkId);
	}

	/** In the pump queue; save must wait for the BFS to finish. */
	isQueued(chunk: Chunk): boolean {
		return this.queuedSlots.has(chunk.id);
	}

	/**
	 * Enqueue a refinement, merging seeds when the chunk already has seed
	 * state.
	 *
	 * Returns whether this call newly queued the chunk and whether it merged
	 * into an existing seed state.
	 */
	enqueue(
		chunk: Chunk,
		seedQueue: Uint16Array,
		seedLength: number,
	): { enqueued: boolean; merged: boolean } {
		if (seedLength <= 0) {
			return { enqueued: false, merged: false };
		}

		const chunkId = chunk.id;
		const existing = this.seeds.get(chunkId);
		let merged = false;

		if (existing !== undefined) {
			this.mergeSeeds(existing, seedQueue, seedLength);
			merged = true;
		} else {
			this.seeds.set(chunkId, {
				queue: seedQueue,
				length: seedLength,
			});
		}

		if (this.queuedSlots.has(chunkId)) {
			return { enqueued: false, merged };
		}

		const queueIndex = this.queue.length;

		this.queue.push(chunk);
		this.queuedSlots.set(chunkId, queueIndex);

		return { enqueued: true, merged };
	}

	/**
	 * Advance and return the next entry.
	 *
	 * Tombstoned slots return `{ chunk: null }` without affecting seed state.
	 * Live chunks release their queued index and seed state.
	 */
	takeNext():
		| { chunk: Chunk; seed: DeferredLightSeed | undefined }
		| { chunk: null }
		| undefined {
		const index = this.readIdx;

		if (index >= this.queue.length) {
			return undefined;
		}

		const chunk = this.queue[index];

		/*
		 * Clear consumed references immediately so large chunk graphs can be
		 * collected before the next queue compaction.
		 */
		this.queue[index] = null;
		this.readIdx = index + 1;

		if (chunk === null) {
			return { chunk: null };
		}

		const chunkId = chunk.id;

		this.queuedSlots.delete(chunkId);

		const seed = this.seeds.get(chunkId);
		this.seeds.delete(chunkId);

		return { chunk, seed };
	}

	/** Disposal: drop ID/seed state and tombstone the live queue slot. */
	invalidate(chunk: Chunk): void {
		const chunkId = chunk.id;
		const queueIndex = this.queuedSlots.get(chunkId);

		this.queuedSlots.delete(chunkId);
		this.seeds.delete(chunkId);

		if (queueIndex !== undefined) {
			this.queue[queueIndex] = null;
		}
	}

	/** Drop the consumed prefix once it exceeds half the array. */
	compactIfNeeded(): void {
		const readIdx = this.readIdx;
		const queue = this.queue;

		if (readIdx <= COMPACT_MIN_PREFIX) {
			return;
		}

		if (readIdx * 2 <= queue.length) {
			return;
		}

		const remaining = queue.length - readIdx;

		queue.copyWithin(0, readIdx);
		queue.length = remaining;
		this.readIdx = 0;

		/*
		 * Queue positions changed, so rebuild the slot index. This work occurs
		 * only when compaction already incurs an O(n) array copy.
		 */
		const queuedSlots = this.queuedSlots;
		queuedSlots.clear();

		for (let i = 0; i < remaining; i++) {
			const chunk = queue[i];

			if (chunk !== null) {
				queuedSlots.set(chunk.id, i);
			}
		}
	}

	private mergeSeeds(
		existing: DeferredLightSeed,
		incomingQueue: Uint16Array,
		incomingLength: number,
	): void {
		const existingLength = existing.length;
		const seen = this.seen;

		seen.clear();

		for (let i = 0; i < existingLength; i++) {
			seen.add(existing.queue[i]);
		}

		/*
		 * Grow geometrically rather than allocating exactly `needed` on every
		 * merge. The existing buffer may still avoid allocation entirely.
		 */
		const maximumLength = existingLength + incomingLength;
		let targetQueue = existing.queue;

		if (maximumLength > targetQueue.length) {
			let newCapacity = Math.max(1, targetQueue.length);

			while (newCapacity < maximumLength) {
				newCapacity *= 2;
			}

			targetQueue = new Uint16Array(newCapacity);
			targetQueue.set(existing.queue.subarray(0, existingLength));
			existing.queue = targetQueue;
		}

		let writeIndex = existingLength;

		for (let i = 0; i < incomingLength; i++) {
			const value = incomingQueue[i];

			if (seen.has(value)) {
				continue;
			}

			/*
			 * Add newly appended values too, ensuring duplicates within the
			 * incoming seed queue are removed.
			 */
			seen.add(value);
			targetQueue[writeIndex++] = value;
		}

		existing.length = writeIndex;
		seen.clear();
	}
}
