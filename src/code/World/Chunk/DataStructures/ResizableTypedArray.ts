export class ResizableTypedArray<
	T extends Uint8Array | Uint16Array | Int8Array | Float32Array,
> {
	private array: T;
	private capacity: number;
	public length = 0;

	constructor(
		private ctor: new (capacity: number) => T,
		initialCapacity = 512,
	) {
		this.capacity = Math.max(1, initialCapacity);
		this.array = new this.ctor(this.capacity);
	}

	push4(a: number, b: number, c: number, d: number): void {
		const nextLength = this.length + 4;
		if (nextLength > this.capacity) {
			this.grow(nextLength);
		}

		const arr = this.array;
		const i = this.length;
		arr[i] = a;
		arr[i + 1] = b;
		arr[i + 2] = c;
		arr[i + 3] = d;
		this.length = nextLength;
	}

	push6(
		a: number,
		b: number,
		c: number,
		d: number,
		e: number,
		f: number,
	): void {
		const nextLength = this.length + 6;
		if (nextLength > this.capacity) {
			this.grow(nextLength);
		}

		const arr = this.array;
		const i = this.length;
		arr[i] = a;
		arr[i + 1] = b;
		arr[i + 2] = c;
		arr[i + 3] = d;
		arr[i + 4] = e;
		arr[i + 5] = f;
		this.length = nextLength;
	}

	push8(
		a: number,
		b: number,
		c: number,
		d: number,
		e: number,
		f: number,
		g: number,
		h: number,
	): void {
		const nextLength = this.length + 8;
		if (nextLength > this.capacity) {
			this.grow(nextLength);
		}

		const arr = this.array;
		const i = this.length;
		arr[i] = a;
		arr[i + 1] = b;
		arr[i + 2] = c;
		arr[i + 3] = d;
		arr[i + 4] = e;
		arr[i + 5] = f;
		arr[i + 6] = g;
		arr[i + 7] = h;
		this.length = nextLength;
	}

	push12(
		a: number,
		b: number,
		c: number,
		d: number,
		e: number,
		f: number,
		g: number,
		h: number,
		i1: number,
		j: number,
		k: number,
		l: number,
	): void {
		const nextLength = this.length + 12;
		if (nextLength > this.capacity) {
			this.grow(nextLength);
		}

		const arr = this.array;
		const i = this.length;
		arr[i] = a;
		arr[i + 1] = b;
		arr[i + 2] = c;
		arr[i + 3] = d;
		arr[i + 4] = e;
		arr[i + 5] = f;
		arr[i + 6] = g;
		arr[i + 7] = h;
		arr[i + 8] = i1;
		arr[i + 9] = j;
		arr[i + 10] = k;
		arr[i + 11] = l;
		this.length = nextLength;
	}

	private grow(minCapacity: number): void {
		let newCapacity = this.capacity << 1;
		while (newCapacity < minCapacity) {
			newCapacity <<= 1;
		}

		const newArray = new this.ctor(newCapacity);
		newArray.set(this.array.subarray(0, this.length));
		this.array = newArray;
		this.capacity = newCapacity;
	}

	get finalArray(): T {
		return this.array.slice(0, this.length) as T;
	}
}
