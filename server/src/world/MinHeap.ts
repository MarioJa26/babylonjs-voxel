export class MinHeap<T> {
	private readonly items: T[] = [];

	constructor(private readonly less: (a: T, b: T) => boolean) {}

	get length(): number {
		return this.items.length;
	}

	push(value: T): void {
		const items = this.items;
		let i = items.length;
		items.push(value);

		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!this.less(value, items[p])) break;
			items[i] = items[p];
			i = p;
		}

		items[i] = value;
	}

	pop(): T | undefined {
		const items = this.items;
		const first = items[0];
		const last = items.pop();

		if (last !== undefined && items.length > 0) {
			let i = 0;
			const half = items.length >> 1;

			while (i < half) {
				let child = i * 2 + 1;
				const right = child + 1;

				if (right < items.length && this.less(items[right], items[child])) {
					child = right;
				}

				if (!this.less(items[child], last)) break;

				items[i] = items[child];
				i = child;
			}

			items[i] = last;
		}

		return first;
	}
}
