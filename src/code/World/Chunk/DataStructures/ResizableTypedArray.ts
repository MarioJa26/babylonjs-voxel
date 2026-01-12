export class ResizableTypedArray<
  T extends Uint8Array | Uint16Array | Int8Array
> {
  private array: T;
  private capacity: number;
  public length = 0;

  constructor(
    private ctor: new (capacity: number) => T,
    initialCapacity = 256
  ) {
    this.capacity = initialCapacity;
    this.array = new ctor(this.capacity);
  }

  push(...values: number[]): void {
    if (this.length + values.length > this.capacity) {
      this.grow(this.length + values.length);
    }
    this.array.set(values, this.length);
    this.length += values.length;
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
    if (this.length < this.capacity) {
      return this.array.slice(0, this.length) as T;
    }
    return this.array.subarray(0, this.length) as T;
  }
}
