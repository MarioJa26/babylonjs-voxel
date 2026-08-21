/**
 * BlobCompression — zlib ("deflate") compression for chunk blobs.
 *
 * Shared by the browser IndexedDB store (shrinks the value an IDB put() has
 * to structured-clone synchronously — the bulk of the per-put cost) and the
 * server→client wire format (bandwidth).
 *
 * Engine Optimizations:
 * 1. Direct codec feeding: each op writes into the CompressionStream/
 *    DecompressionStream writable and drains the readable via
 *    Response.arrayBuffer() — no custom ReadableStream, no pipeThrough
 *    pumping loop, minimal promise/microtask hops per blob.
 * 2. Bounded concurrency: callers batch compress/inflate fan-outs through
 *    mapInWaves (Lib/yieldToEventLoop.ts) so hundreds of concurrent
 *    pipelines cannot monopolize the main thread with one giant microtask
 *    drain (the "Run microtasks" profile hotspot).
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
function toPlainBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer) {
		return bytes as Uint8Array<ArrayBuffer>;
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
 * Feed a single-chunk payload straight into a codec's writable and drain its
 * readable via Response. Going through `source.pipeThrough(codec)` instead
 * would run the streams-spec pumping loop — several promise/microtask hops
 * per chunk plus a custom ReadableStream allocation — and when a batch of
 * hundreds of small blobs compresses concurrently, those hops dominate the
 * profile (`Run microtasks`). A direct write+close keeps each pipeline at
 * the minimum number of hops.
 */
async function runCodec(
	codec: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<BufferSource>;
	},
	bytes: Uint8Array,
): Promise<Uint8Array> {
	// Start draining the readable before feeding the writable so a large
	// payload can never stall on readable-side backpressure.
	const done = new Response(codec.readable).arrayBuffer();

	const writer = codec.writable.getWriter();
	try {
		await writer.write(toPlainBytes(bytes));
		await writer.close();
	} catch (error) {
		done.catch(() => {}); // avoid an unhandled rejection on the read side
		throw error;
	} finally {
		writer.releaseLock();
	}

	return new Uint8Array(await done);
}

/** Compress bytes with zlib "deflate". */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === "undefined") {
		throw new Error("CompressionStream is not available");
	}

	return runCodec(new CompressionStream(FORMAT), bytes);
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

	const out = await runCodec(new DecompressionStream(FORMAT), data);

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
