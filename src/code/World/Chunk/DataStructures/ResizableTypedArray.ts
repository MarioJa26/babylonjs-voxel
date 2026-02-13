export class ResizableTypedArray<
  T extends Uint8Array | Uint16Array | Int8Array,
> {
  private array: T;
  private capacity: number;
  public length = 0;

  constructor(
    private ctor: new (capacity: number) => T,
    initialCapacity = 512,
  ) {
    this.capacity = initialCapacity;
    this.array = new ctor(this.capacity);
  }

  private ensureCapacity(additional: number): void {
    const minCapacity = this.length + additional;
    if (minCapacity > this.capacity) {
      this.grow(minCapacity);
    }
  }

  push4(a: number, b: number, c: number, d: number): void {
    this.ensureCapacity(4);
    const i = this.length;
    this.array[i] = a;
    this.array[i + 1] = b;
    this.array[i + 2] = c;
    this.array[i + 3] = d;
    this.length = i + 4;
  }

  push6(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void {
    this.ensureCapacity(6);
    const i = this.length;
    this.array[i] = a;
    this.array[i + 1] = b;
    this.array[i + 2] = c;
    this.array[i + 3] = d;
    this.array[i + 4] = e;
    this.array[i + 5] = f;
    this.length = i + 6;
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
    this.ensureCapacity(8);
    const i = this.length;
    this.array[i] = a;
    this.array[i + 1] = b;
    this.array[i + 2] = c;
    this.array[i + 3] = d;
    this.array[i + 4] = e;
    this.array[i + 5] = f;
    this.array[i + 6] = g;
    this.array[i + 7] = h;
    this.length = i + 8;
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
    this.ensureCapacity(12);
    const i = this.length;
    this.array[i] = a;
    this.array[i + 1] = b;
    this.array[i + 2] = c;
    this.array[i + 3] = d;
    this.array[i + 4] = e;
    this.array[i + 5] = f;
    this.array[i + 6] = g;
    this.array[i + 7] = h;
    this.array[i + 8] = i1;
    this.array[i + 9] = j;
    this.array[i + 10] = k;
    this.array[i + 11] = l;
    this.length = i + 12;
  }

  private grow(minCapacity: number): void {
    let newCapacity = this.capacity * 2;
    while (newCapacity < minCapacity) {
      newCapacity *= 2;
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
