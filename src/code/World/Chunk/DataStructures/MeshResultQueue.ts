import type { FullMeshMessage } from "./WorkerMessageType";

const INITIAL_CAPACITY = 64;

export class MeshResultQueue {
	private items: Array<FullMeshMessage | undefined> = [];
	private workerIdx: number[] = [];

	private head = 0;
	private count = 0;

	get pendingCount(): number {
		return this.count;
	}

	get hasPending(): boolean {
		return this.count !== 0;
	}

	push(data: FullMeshMessage, workerIndex: number): void {
		this.ensureCapacity(this.count + 1);

		const index = this.physicalIndex(this.count);
		this.items[index] = data;
		this.workerIdx[index] = workerIndex;
		this.count++;
	}

	peekOldest(): { data: FullMeshMessage; workerIndex: number } | undefined {
		if (this.count === 0) {
			return undefined;
		}

		return {
			data: this.items[this.head]!,
			workerIndex: this.workerIdx[this.head] ?? 0,
		};
	}

	/** Backpressure overwrite: replace the oldest unread slot in place. */
	overwriteOldest(data: FullMeshMessage, workerIndex: number): void {
		if (this.count === 0) {
			this.push(data, workerIndex);
			return;
		}

		this.items[this.head] = data;
		this.workerIdx[this.head] = workerIndex;
	}

	takeNext(): { data: FullMeshMessage; workerIndex: number } | undefined {
		if (this.count === 0) {
			return undefined;
		}

		const index = this.head;
		const data = this.items[index]!;
		const workerIndex = this.workerIdx[index] ?? 0;

		// Release the potentially large mesh message as soon as it is consumed.
		this.items[index] = undefined;
		this.workerIdx[index] = 0;

		this.count--;

		if (this.count === 0) {
			this.head = 0;
		} else {
			this.head++;
			if (this.head === this.items.length) {
				this.head = 0;
			}
		}

		return { data, workerIndex };
	}

	/**
	 * Retained for call-site compatibility.
	 *
	 * The circular buffer has no consumed prefix, so explicit compaction is
	 * no longer necessary.
	 */
	compactIfNeeded(): void {
		// No-op.
	}

	private physicalIndex(offset: number): number {
		const index = this.head + offset;
		const capacity = this.items.length;

		return index < capacity ? index : index - capacity;
	}

	private ensureCapacity(required: number): void {
		const oldCapacity = this.items.length;

		if (required <= oldCapacity) {
			return;
		}

		let newCapacity = oldCapacity === 0 ? INITIAL_CAPACITY : oldCapacity * 2;

		while (newCapacity < required) {
			newCapacity *= 2;
		}

		const newItems = new Array<FullMeshMessage | undefined>(newCapacity);
		const newWorkerIdx = new Array<number>(newCapacity);

		if (this.count > 0) {
			const firstLength = Math.min(this.count, oldCapacity - this.head);

			for (let i = 0; i < firstLength; i++) {
				const source = this.head + i;
				newItems[i] = this.items[source];
				newWorkerIdx[i] = this.workerIdx[source];
			}

			const secondLength = this.count - firstLength;

			for (let i = 0; i < secondLength; i++) {
				newItems[firstLength + i] = this.items[i];
				newWorkerIdx[firstLength + i] = this.workerIdx[i];
			}
		}

		this.items = newItems;
		this.workerIdx = newWorkerIdx;
		this.head = 0;
	}
}
