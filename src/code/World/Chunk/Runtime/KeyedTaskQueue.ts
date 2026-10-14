export class KeyedTaskQueue<T> {
	/*
	 * Consumed slots are cleared immediately. The array is still compacted
	 * periodically to keep its backing storage and indices bounded.
	 */
	private items: Array<T | undefined> = [];
	private readIdx = 0;
	private keys = new Set<number>();

	/**
	 * @param strictCompaction Matches the original per-queue thresholds:
	 * lodPrecompute used `readIdx * 2 > length`; relight/far used `>=`.
	 */
	constructor(private readonly strictCompaction = false) {}

	get hasPending(): boolean {
		return this.readIdx < this.items.length;
	}

	get pendingCount(): number {
		return this.items.length - this.readIdx;
	}

	hasKey(key: number): boolean {
		return this.keys.has(key);
	}

	deleteKey(key: number): void {
		this.keys.delete(key);
	}

	/** Push unless the key is already queued. Returns true when pushed. */
	enqueue(item: T, key: number): boolean {
		const keys = this.keys;

		if (keys.has(key)) {
			return false;
		}

		keys.add(key);
		this.items.push(item);

		return true;
	}

	/**
	 * Advance the consume index and return the next item.
	 *
	 * Key deletion intentionally remains the caller's responsibility.
	 */
	takeNext(): T | undefined {
		const index = this.readIdx;
		const items = this.items;

		if (index >= items.length) {
			return undefined;
		}

		const item = items[index];

		/*
		 * Release potentially large task/chunk object graphs immediately,
		 * rather than retaining them until the next compaction.
		 */
		items[index] = undefined;
		this.readIdx = index + 1;

		return item;
	}

	/**
	 * Tombstone unread entries matching `predicate` by replacing each slot
	 * with `replace(item)`.
	 *
	 * Keys are not modified because disposal paths explicitly remove them.
	 */
	invalidate(
		predicate: (item: T) => boolean,
		replace: (item: T) => T,
		firstOnly = false,
	): void {
		const items = this.items;
		const length = items.length;

		for (let i = this.readIdx; i < length; i++) {
			const item = items[i];

			/*
			 * Undefined appears only in consumed slots, which are before
			 * readIdx, but retain the guard for defensive safety.
			 */
			if (item === undefined || !predicate(item)) {
				continue;
			}

			items[i] = replace(item);

			if (firstOnly) {
				return;
			}
		}
	}

	/** Drop the consumed prefix once it reaches the configured threshold. */
	compactIfNeeded(): void {
		const readIdx = this.readIdx;

		if (readIdx <= 64) {
			return;
		}

		const items = this.items;
		const length = items.length;
		const doubleRead = readIdx * 2;

		const shouldCompact = this.strictCompaction
			? doubleRead > length
			: doubleRead >= length;

		if (!shouldCompact) {
			return;
		}

		const remaining = length - readIdx;

		items.copyWithin(0, readIdx, length);
		items.length = remaining;
		this.readIdx = 0;
	}

	clear(): void {
		this.items.length = 0;
		this.readIdx = 0;
		this.keys.clear();
	}
}
