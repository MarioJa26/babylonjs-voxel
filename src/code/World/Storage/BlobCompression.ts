/**
 * BlobCompression — zlib ("deflate") compression for chunk blobs.
 *
 * Shared by the browser IndexedDB store (shrinks the value an IDB put() has
 * to structured-clone synchronously — the bulk of the per-put cost) and the
 * server→client wire format (bandwidth). `CompressionStream` /
 * `DecompressionStream` are available in Chromium/Firefox/Safari secure
 * contexts and as globals in Node ≥ 18 (the server runs ≥ 22), so both ends
 * speak the same codec with no native dependencies.
 *
 * The "deflate" (zlib) format is used rather than "deflate-raw": Node only
 * implements "gzip" and "deflate", so raw deflate would fail server-side
 * while the client could produce it — and both ends must share a codec.
 * zlib adds a 6-byte wrapper (2-byte header + 4-byte Adler-32) per payload.
 *
 * Streams are drained manually (reader loop) instead of through
 * `Response.arrayBuffer()`: Response buffers the whole stream internally
 * before handing back the ArrayBuffer, so the data exists in memory twice at
 * peak. Draining directly means only the output chunks and the final concat
 * are alive at the same time. Inflating into a caller-supplied exact-size
 * buffer (the original length is framed alongside the payload) skips the
 * concat entirely and validates the result, mirroring the old gzip ISIZE
 * check the pre-OPFS IndexedDB storage used.
 *
 * Storage framing: browser-stored Uint8Array values get a one-byte prefix:
 *   0x00 = raw (too small / compressor unavailable / compression not worth it)
 *   0x01 = [origLen:u32 LE][zlib-deflate payload]
 * Values written before this feature shipped have no prefix and are read
 * through unchanged (legacy raw). Strings pass through untouched.
 *
 * The wire format uses the same zlib-deflate payload + origLen field but is
 * self-describing via the message type, so no prefix byte is added there.
 */
export const BLOB_MARKER_RAW = 0x00;
export const BLOB_MARKER_DEFLATE = 0x01;

/** Below this size compression is not worth the CPU — store raw. */
const MIN_COMPRESSIBLE_BYTES = 128;

/** origLen is untrusted (corrupt payloads) — bound the preallocation. */
const MAX_INFLATE_BYTES = 1 << 26; // 64 MiB

const FORMAT = "deflate";

/**
 * Blob() only accepts views backed by a plain ArrayBuffer, so a value backed
 * by a SharedArrayBuffer (or a resizable buffer) must be copied first. Chunk
 * blobs are normally plain ArrayBuffer-backed; the copy is the exception.
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
		// e.g. Node supports CompressionStream but not the requested format.
		return false;
	}
}

/** Compress bytes with zlib "deflate". */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === "undefined") {
		throw new Error("CompressionStream is not available");
	}
	const stream = new Blob([toPlainBytes(bytes)])
		.stream()
		.pipeThrough(new CompressionStream(FORMAT));
	return drainCollect(stream);
}

/**
 * Decompress bytes produced by deflate into a preallocated buffer of exactly
 * outLen bytes. Throws if the stream produces more or fewer bytes — the
 * caller framed origLen, so a mismatch means corruption.
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
	const stream = new Blob([toPlainBytes(data)])
		.stream()
		.pipeThrough(new DecompressionStream(FORMAT));

	const out = new Uint8Array(outLen);
	const reader = stream.getReader();
	let offset = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) {
				out.set(value, offset);
				offset += value.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}

	if (offset !== outLen) {
		throw new Error(
			`Decompressed size mismatch: expected ${outLen}, got ${offset}`,
		);
	}

	return out;
}

/** Drain a stream into a single freshly allocated Uint8Array. */
async function drainCollect(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				totalBytes += value.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Single allocation + single pass of memcpy to assemble the final buffer.
	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (const c of chunks) {
		result.set(c, offset);
		offset += c.byteLength;
	}
	return result;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >> 8) & 0xff;
	bytes[offset + 2] = (value >> 16) & 0xff;
	bytes[offset + 3] = (value >>> 24) & 0xff;
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

/**
 * Frame a value for storage: raw payload prefixed with 0x00 when it is too
 * small to be worth compressing or the runtime lacks the codec, otherwise
 * [0x01][origLen:u32][deflated] when the payload actually shrinks.
 */
export async function compressBlob(bytes: Uint8Array): Promise<Uint8Array> {
	if (
		bytes.byteLength < MIN_COMPRESSIBLE_BYTES ||
		typeof CompressionStream === "undefined"
	) {
		const framed = new Uint8Array(bytes.byteLength + 1);
		framed[0] = BLOB_MARKER_RAW;
		framed.set(bytes, 1);
		return framed;
	}

	const compressed = await deflate(bytes);

	if (compressed.byteLength >= bytes.byteLength) {
		const framed = new Uint8Array(bytes.byteLength + 1);
		framed[0] = BLOB_MARKER_RAW;
		framed.set(bytes, 1);
		return framed;
	}

	const framed = new Uint8Array(compressed.byteLength + 5);
	framed[0] = BLOB_MARKER_DEFLATE;
	writeUint32LE(framed, 1, bytes.byteLength);
	framed.set(compressed, 5);
	return framed;
}

/**
 * Undo compressBlob framing. Values without the marker prefix (legacy raw)
 * are returned unchanged; a deflated payload is inflated back into an
 * exact-size buffer using the framed original length (throws on mismatch).
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
