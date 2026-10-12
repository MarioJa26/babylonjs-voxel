/**
 * BlobCompression: zlib "deflate" compression for chunk blobs.
 *
 * Uses a dedicated codec worker when available and falls back to native stream
 * codecs inline. Stored values are framed as either:
 *
 *   [0x00][raw payload]
 *   [0x01][original length:u32 LE][deflated payload]
 */

export const BLOB_MARKER_RAW = 0x00;
export const BLOB_MARKER_DEFLATE = 0x01;

/** Below this size, compression is unlikely to recover its CPU cost. */
const MIN_COMPRESSIBLE_BYTES = 128;

/** Maximum accepted decompressed size from untrusted framing metadata. */
const MAX_INFLATE_BYTES = 1 << 26; // 64 MiB

const DEFLATE_HEADER_BYTES = 5;
const FORMAT = "deflate";

/**
 * Blob and stream APIs require an ArrayBuffer-backed view. Shared or resizable
 * buffers are copied before being passed to the native codec.
 */
function toPlainBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const buffer = bytes.buffer;

	if (buffer instanceof ArrayBuffer && !isResizableArrayBuffer(buffer)) {
		return bytes as Uint8Array<ArrayBuffer>;
	}

	return new Uint8Array(bytes);
}

/**
 * Resizable ArrayBuffers are not available in every runtime, so inspect the
 * optional property without requiring a newer TypeScript library definition.
 */
function isResizableArrayBuffer(buffer: ArrayBuffer): boolean {
	return (buffer as ArrayBuffer & { resizable?: boolean }).resizable === true;
}

let cachedDeflateSupport: boolean | undefined;

/**
 * True when both native codec streams exist and accept the "deflate" format.
 *
 * The constructors are probed only once. Repeated capability checks otherwise
 * create and discard two stream pipelines each time.
 */
export function deflateSupported(): boolean {
	const cached = cachedDeflateSupport;

	if (cached !== undefined) {
		return cached;
	}

	if (
		typeof CompressionStream === "undefined" ||
		typeof DecompressionStream === "undefined"
	) {
		cachedDeflateSupport = false;
		return false;
	}

	try {
		new CompressionStream(FORMAT);
		new DecompressionStream(FORMAT);

		cachedDeflateSupport = true;
		return true;
	} catch {
		cachedDeflateSupport = false;
		return false;
	}
}

/**
 * Feed one payload directly into a native stream codec and combine its output.
 *
 * Reading begins before writing so codec backpressure cannot deadlock when the
 * readable side fills.
 */
async function runCodec(
	codec: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<BufferSource>;
	},
	bytes: Uint8Array,
): Promise<Uint8Array> {
	const reader = codec.readable.getReader();
	const writer = codec.writable.getWriter();

	const outputChunks: Uint8Array[] = [];
	let outputLength = 0;

	const readPromise = (async (): Promise<void> => {
		for (;;) {
			const result = await reader.read();

			if (result.done) {
				return;
			}

			const value = result.value;
			outputChunks.push(value);
			outputLength += value.byteLength;
		}
	})();

	try {
		await writer.write(toPlainBytes(bytes));
		await writer.close();
		await readPromise;
	} catch (error) {
		/*
		 * Abort/cancel both halves. Promise rejections are deliberately observed
		 * because the original codec error is the one exposed to the caller.
		 */
		void writer.abort(error).catch(() => {});
		void reader.cancel(error).catch(() => {});
		void readPromise.catch(() => {});

		throw error;
	} finally {
		writer.releaseLock();
		reader.releaseLock();
	}

	if (outputChunks.length === 1) {
		/*
		 * The stream owns this chunk, so returning it directly avoids one result
		 * allocation and copy in the common single-output case.
		 */
		return outputChunks[0];
	}

	const output = new Uint8Array(outputLength);
	let offset = 0;

	for (let i = 0; i < outputChunks.length; i++) {
		const chunk = outputChunks[i];

		output.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return output;
}

/** Compress bytes using zlib "deflate". */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === "undefined") {
		throw new Error("CompressionStream is not available");
	}

	return runCodec(new CompressionStream(FORMAT), bytes);
}

/** Signals that the worker path failed and the inline codec should be used. */
class CodecWorkerUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodecWorkerUnavailable";
	}
}

type PendingCodecRequest = {
	resolve: (bytes: Uint8Array) => void;
	reject: (error: Error) => void;
};

type CodecWorkerResponse = {
	id: number;
	ok: boolean;
	result?: Uint8Array;
};

let codecWorker: Worker | null | undefined;
let nextCodecRequestId = 1;

const pendingCodecRequests = new Map<number, PendingCodecRequest>();

function rejectAllCodecRequests(message: string): void {
	if (pendingCodecRequests.size === 0) {
		return;
	}

	const error = new CodecWorkerUnavailable(message);

	for (const pending of pendingCodecRequests.values()) {
		pending.reject(error);
	}

	pendingCodecRequests.clear();
}

function disableCodecWorker(worker: Worker, message: string): void {
	/*
	 * Ignore errors from an obsolete worker after a replacement attempt.
	 */
	if (codecWorker !== worker) {
		return;
	}

	codecWorker = null;
	rejectAllCodecRequests(message);
	worker.terminate();
}

function ensureCodecWorker(): Worker | null {
	if (codecWorker !== undefined) {
		return codecWorker;
	}

	if (typeof Worker === "undefined") {
		codecWorker = null;
		return null;
	}

	try {
		const worker = new Worker(
			new URL("./blobCodec.worker.ts", import.meta.url),
			{
				type: "module",
				name: "blob-codec",
			},
		);

		worker.onmessage = (event: MessageEvent<CodecWorkerResponse>): void => {
			const response = event.data;
			const pending = pendingCodecRequests.get(response.id);

			if (pending === undefined) {
				return;
			}

			pendingCodecRequests.delete(response.id);

			if (response.ok && response.result instanceof Uint8Array) {
				pending.resolve(response.result);
				return;
			}

			pending.reject(
				new CodecWorkerUnavailable("Codec worker operation failed"),
			);
		};

		worker.onerror = (): void => {
			disableCodecWorker(worker, "Codec worker error");
		};

		worker.onmessageerror = (): void => {
			disableCodecWorker(worker, "Codec worker message error");
		};

		codecWorker = worker;
		return worker;
	} catch {
		codecWorker = null;
		return null;
	}
}

/**
 * Run one operation through the dedicated codec worker.
 *
 * Inputs are cloned because callers retain their buffers. Outputs are expected
 * to be transferred back by the worker.
 */
function codecWorkerRun(
	compress: boolean,
	bytes: Uint8Array,
): Promise<Uint8Array> {
	const worker = ensureCodecWorker();

	if (worker === null) {
		return Promise.reject(
			new CodecWorkerUnavailable("Codec worker unavailable"),
		);
	}

	const id = nextCodecRequestId++;

	/*
	 * Avoid reaching an unsafe integer after an extremely long session. Reuse
	 * starts only when no practical request can still carry the old ID.
	 */
	if (nextCodecRequestId > Number.MAX_SAFE_INTEGER) {
		nextCodecRequestId = 1;
	}

	return new Promise<Uint8Array>((resolve, reject) => {
		pendingCodecRequests.set(id, {
			resolve,
			reject,
		});

		try {
			worker.postMessage({
				id,
				compress,
				bytes,
			});
		} catch (error) {
			/*
			 * postMessage can throw synchronously, for example during worker
			 * termination or structured cloning. Remove the pending entry so it
			 * cannot leak forever.
			 */
			pendingCodecRequests.delete(id);

			reject(
				new CodecWorkerUnavailable(
					error instanceof Error
						? error.message
						: "Codec worker postMessage failed",
				),
			);
		}
	});
}

/**
 * Decompress a deflated payload and require exactly `outLen` output bytes.
 */
export async function inflateInto(
	data: Uint8Array,
	outLen: number,
): Promise<Uint8Array> {
	validateInflatedLength(outLen);

	if (typeof DecompressionStream === "undefined") {
		throw new Error("DecompressionStream is not available");
	}

	const output = await runCodec(new DecompressionStream(FORMAT), data);

	validateDecodedSize(output.byteLength, outLen);

	return output;
}

function validateInflatedLength(outLen: number): void {
	if (!Number.isInteger(outLen) || outLen < 0 || outLen > MAX_INFLATE_BYTES) {
		throw new Error(`Invalid inflated size: ${outLen}`);
	}
}

function validateDecodedSize(
	actualLength: number,
	expectedLength: number,
): void {
	if (actualLength !== expectedLength) {
		throw new Error(
			`Decompressed size mismatch: expected ` +
				`${expectedLength}, got ${actualLength}`,
		);
	}
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
 * Frame a payload for storage, compressing it only when doing so saves space.
 */
export async function compressBlob(bytes: Uint8Array): Promise<Uint8Array> {
	const originalLength = bytes.byteLength;

	if (originalLength < MIN_COMPRESSIBLE_BYTES || !deflateSupported()) {
		return frameRaw(bytes);
	}

	let compressed: Uint8Array;

	try {
		compressed = await codecWorkerRun(true, bytes);
	} catch (error) {
		if (!(error instanceof CodecWorkerUnavailable)) {
			throw error;
		}

		compressed = await deflate(bytes);
	}

	/*
	 * A deflated frame has five bytes of metadata. Compression must beat the
	 * complete framed raw representation, not merely the unframed payload.
	 *
	 * Raw size:       originalLength + 1
	 * Deflated size:  compressedLength + 5
	 */
	if (compressed.byteLength + DEFLATE_HEADER_BYTES >= originalLength + 1) {
		return frameRaw(bytes);
	}

	return frameDeflated(originalLength, compressed);
}

/**
 * Frame an already-deflated payload:
 *
 * [0x01][original length:u32 LE][deflated bytes]
 */
export function frameDeflated(
	origLen: number,
	deflated: Uint8Array,
): Uint8Array {
	validateInflatedLength(origLen);

	const framed = new Uint8Array(deflated.byteLength + DEFLATE_HEADER_BYTES);

	framed[0] = BLOB_MARKER_DEFLATE;
	writeUint32LE(framed, 1, origLen);
	framed.set(deflated, DEFLATE_HEADER_BYTES);

	return framed;
}

/**
 * Undo storage framing.
 *
 * Values without a recognized marker are treated as legacy unframed raw blobs.
 */
export async function decompressBlob(bytes: Uint8Array): Promise<Uint8Array> {
	const byteLength = bytes.byteLength;

	if (byteLength === 0) {
		return bytes;
	}

	const marker = bytes[0];

	if (marker === BLOB_MARKER_RAW) {
		return bytes.subarray(1);
	}

	if (marker !== BLOB_MARKER_DEFLATE) {
		return bytes;
	}

	/*
	 * A deflated frame requires one marker byte and four original-length bytes.
	 * Validate before readUint32LE to prevent truncated data from being read as
	 * an accidental length.
	 */
	if (byteLength < DEFLATE_HEADER_BYTES) {
		throw new Error(`Truncated deflated blob header: ${byteLength} bytes`);
	}

	const originalLength = readUint32LE(bytes, 1);
	validateInflatedLength(originalLength);

	const payload = bytes.subarray(DEFLATE_HEADER_BYTES);

	if (payload.byteLength === 0 && originalLength !== 0) {
		throw new Error("Deflated blob contains no compressed payload");
	}

	try {
		const output = await codecWorkerRun(false, payload);

		validateDecodedSize(output.byteLength, originalLength);

		return output;
	} catch (error) {
		if (!(error instanceof CodecWorkerUnavailable)) {
			throw error;
		}
	}

	return inflateInto(payload, originalLength);
}
