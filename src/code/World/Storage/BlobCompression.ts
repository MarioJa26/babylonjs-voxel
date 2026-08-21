/**
 * BlobCompression — zlib ("deflate") compression for chunk blobs.
 *
 * Shared by the browser IndexedDB store (shrinks the value an IDB put() has
 * to structured-clone synchronously — the bulk of the per-put cost) and the
 * server→client wire format (bandwidth).
 *
 * Engine Optimizations:
 * 1. Native Stream Consumption: Replaced JS `reader.read()` loops with
 *    `Response.arrayBuffer()`. This offloads stream-to-buffer aggregation
 *    to the browser's C++ network stack, eliminating JS microtask overhead,
 *    promise chaining, and intermediate chunk array allocations.
 * 2. Direct ReadableStream: Bypassed `Blob` creation and `.stream()` overhead
 *    by piping directly from a `ReadableStream` controller.
 */

export const BLOB_MARKER_RAW = 0x00;
export const BLOB_MARKER_DEFLATE = 0x01;

/** Below this size compression is not worth the CPU — store raw. */
const MIN_COMPRESSIBLE_BYTES = 128;

/** origLen is untrusted (corrupt payloads) — bound the preallocation. */
const MAX_INFLATE_BYTES = 1 << 26; // 64 MiB

const FORMAT = "deflate";

/**
 * Blob() and some stream implementations only accept views backed by a plain
 * ArrayBuffer. A value backed by a SharedArrayBuffer (or resizable buffer)
 * must be copied first to prevent detached-buffer errors downstream.
 */
function toPlainBytes(bytes: Uint8Array): Uint8Array {
	if (bytes.buffer instanceof ArrayBuffer) {
		return bytes;
	}
	return new Uint8Array(bytes);
}

/** True when both streams exist AND accept our "deflate" format. */
export function deflateSupported(): boolean {
	if (
		typeof CompressionStream === "undefined" ||
		typeof DecompressionStream === "undefined"
	) {
		return false;
	}

	try {
		new CompressionStream(FORMAT);
		new DecompressionStream(FORMAT);
		return true;
	} catch {
		return false;
	}
}

/**
 * Engine optimization: Create a ReadableStream directly from bytes.
 * Bypasses the overhead of `new Blob([bytes]).stream()`.
 */
function createByteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

/** Compress bytes with zlib "deflate". */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === "undefined") {
		throw new Error("CompressionStream is not available");
	}

	const stream = createByteStream(toPlainBytes(bytes)).pipeThrough(
		new CompressionStream(FORMAT),
	);

	// Engine optimization: Response.arrayBuffer() consumes the stream natively
	// in C++, avoiding the JS microtask queue and manual chunk aggregation.
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

/**
 * Decompress bytes produced by deflate into a buffer of exactly outLen bytes.
 */
export async function inflateInto(
	data: Uint8Array,
	outLen: number,
): Promise<Uint8Array> {
	if (outLen < 0 || outLen > MAX_INFLATE_BYTES) {
		throw new Error(`Invalid inflated size: ${outLen}`);
	}

	if (typeof DecompressionStream === "undefined") {
		throw new Error("DecompressionStream is not available");
	}

	const stream = createByteStream(toPlainBytes(data)).pipeThrough(
		new DecompressionStream(FORMAT),
	);

	// Native C++ consumption avoids JS reader loops and offset tracking.
	const buffer = await new Response(stream).arrayBuffer();
	const out = new Uint8Array(buffer);

	if (out.byteLength !== outLen) {
		throw new Error(
			`Decompressed size mismatch: expected ${outLen}, got ${out.byteLength}`,
		);
	}

	return out;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
	bytes[offset + 3] = value >>> 24;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] |
			(bytes[offset + 1] << 8) |
			(bytes[offset + 2] << 16) |
			(bytes[offset + 3] << 24)) >>>
		0
	);
}

function frameRaw(bytes: Uint8Array): Uint8Array {
	const framed = new Uint8Array(bytes.byteLength + 1);
	framed[0] = BLOB_MARKER_RAW;
	framed.set(bytes, 1);
	return framed;
}

/**
 * Frame a value for storage: raw payload prefixed with 0x00 when it is too
 * small to be worth compressing or the runtime lacks the codec, otherwise
 * [0x01][origLen:u32][deflated] when the payload actually shrinks.
 */
export async function compressBlob(bytes: Uint8Array): Promise<Uint8Array> {
	if (bytes.byteLength < MIN_COMPRESSIBLE_BYTES) {
		return frameRaw(bytes);
	}

	const compressed = await deflate(bytes);

	if (compressed.byteLength >= bytes.byteLength) {
		return frameRaw(bytes);
	}

	return frameDeflated(bytes.byteLength, compressed);
}

/**
 * Frame an already-deflated payload for storage: [0x01][origLen:u32 LE][deflate].
 */
export function frameDeflated(
	origLen: number,
	deflated: Uint8Array,
): Uint8Array {
	const framed = new Uint8Array(deflated.byteLength + 5);
	framed[0] = BLOB_MARKER_DEFLATE;
	writeUint32LE(framed, 1, origLen);
	framed.set(deflated, 5);
	return framed;
}

/**
 * Undo compressBlob framing. Values without the marker prefix (legacy raw)
 * are returned unchanged.
 */
export async function decompressBlob(bytes: Uint8Array): Promise<Uint8Array> {
	if (bytes.byteLength === 0) return bytes;

	const marker = bytes[0];

	if (marker === BLOB_MARKER_DEFLATE) {
		const origLen = readUint32LE(bytes, 1);
		return inflateInto(bytes.subarray(5), origLen);
	}

	if (marker === BLOB_MARKER_RAW) {
		return bytes.subarray(1);
	}

	return bytes;
}
