export class MinHeap<T> {
	private readonly items: T[] = [];

	public constructor(private readonly less: (a: T, b: T) => boolean) {}

	public get length(): number {
		return this.items.length;
	}

	/**
	 * Return the minimum item without removing it.
	 */
	public peek(): T | undefined {
		return this.items[0];
	}

	/**
	 * Insert one item in O(log n).
	 */
	public push(value: T): void {
		const items = this.items;
		const less = this.less;

		let index = items.length;

		/*
		 * Extend the array once, then sift the hole upward. Parent values move
		 * down only when necessary, and `value` is written once at its final
		 * position.
		 */
		items.push(value);

		while (index > 0) {
			const parentIndex = (index - 1) >>> 1;
			const parent = items[parentIndex];

			if (!less(value, parent)) {
				break;
			}

			items[index] = parent;
			index = parentIndex;
		}

		items[index] = value;
	}

	/**
	 * Remove and return the minimum item in O(log n).
	 *
	 * Returns undefined when the heap is empty.
	 */
	public pop(): T | undefined {
		const items = this.items;
		const length = items.length;

		if (length === 0) {
			return undefined;
		}

		const root = items[0];

		if (length === 1) {
			items.pop();
			return root;
		}

		/*
		 * At this point the array has at least two entries, so the popped value
		 * exists even when T itself permits undefined.
		 */
		const replacement = items.pop() as T;
		const newLength = length - 1;
		const half = newLength >>> 1;
		const less = this.less;

		let index = 0;

		/*
		 * Sift a hole downward. Only the selected child is copied upward on
		 * each iteration; the replacement is written once at its final slot.
		 */
		while (index < half) {
			const leftIndex = index * 2 + 1;
			const rightIndex = leftIndex + 1;

			let childIndex = leftIndex;
			let child = items[leftIndex];

			if (rightIndex < newLength) {
				const right = items[rightIndex];

				if (less(right, child)) {
					childIndex = rightIndex;
					child = right;
				}
			}

			if (!less(child, replacement)) {
				break;
			}

			items[index] = child;
			index = childIndex;
		}

		items[index] = replacement;

		return root;
	}

	/**
	 * Remove every item while retaining the array object for future reuse.
	 */
	public clear(): void {
		this.items.length = 0;
	}
}
