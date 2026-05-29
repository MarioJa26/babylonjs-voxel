// ---------------------------------------------------------------------------
// Ring buffer — O(1) push/shift with no GC pressure from Array.shift()
// ---------------------------------------------------------------------------
export class RingBuffer<T> {
	private buf: (T | undefined)[];
	private head = 0;
	private tail = 0;
	private _size = 0;
	readonly capacity: number;

	constructor(capacity: number) {
		this.capacity = capacity;
		this.buf = new Array(capacity);
	}

	get size(): number {
		return this._size;
	}

	push(value: T): void {
		if (this._size === this.capacity) {
			// Overwrite oldest
			this.buf[this.head] = value;
			this.head = (this.head + 1) % this.capacity;
		} else {
			this.buf[this.tail] = value;
			this.tail = (this.tail + 1) % this.capacity;
			this._size++;
		}
	}

	shift(): T | undefined {
		if (this._size === 0) return undefined;
		const val = this.buf[this.head];
		this.buf[this.head] = undefined; // release GC ref
		this.head = (this.head + 1) % this.capacity;
		this._size--;
		return val;
	}

	toArray(): T[] {
		const out: T[] = new Array(this._size);
		for (let i = 0; i < this._size; i++) {
			out[i] = this.buf[(this.head + i) % this.capacity] as T;
		}
		return out;
	}

	/**
	 * Calls `fn` for each element in order (oldest to newest).
	 * Avoids allocating a new array.
	 */
	forEach(fn: (value: T) => void): void {
		for (let i = 0; i < this._size; i++) {
			fn(this.buf[(this.head + i) % this.capacity] as T);
		}
	}

	/**
	 * Appends each element (oldest to newest) into `dest`, clearing it first.
	 * Reuses the destination array across calls to avoid per-frame allocation.
	 */
	forEachInto(dest: T[]): void {
		dest.length = 0;
		for (let i = 0; i < this._size; i++) {
			dest.push(this.buf[(this.head + i) % this.capacity] as T);
		}
	}
}
