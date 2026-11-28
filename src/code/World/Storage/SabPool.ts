/**
 * Pool SharedArrayBuffers by exact size; recycle only when nothing can still
 * read them (see `acquire`/`release` callers). Acquired buffers are NOT zeroed.
 */
export class SabPool {
	private free: SharedArrayBuffer[] = [];

	constructor(
		readonly byteLength: number,
		readonly max = 256,
	) {}

	acquire(): SharedArrayBuffer {
		return this.free.pop() ?? new SharedArrayBuffer(this.byteLength);
	}

	release(buf: SharedArrayBuffer): void {
		if (
			buf.byteLength === this.byteLength &&
			this.free.length < this.max
		) {
			this.free.push(buf);
		}
	}
}
