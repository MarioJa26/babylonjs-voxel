/**
 * blobCodec.worker.ts: off-main-thread deflate/inflate for chunk blobs.
 *
 * Protocol:
 *   { id, compress, bytes } -> { id, ok, result? }
 *
 * Inputs are structured-cloned because callers retain their buffers. Successful
 * outputs are transferred back to the main thread without another byte copy.
 */

const FORMAT = "deflate";

/**
 * Bound concurrent native codec pipelines inside this worker.
 *
 * The main thread may already submit work in waves, but messages from different
 * callers can still overlap. Without an internal limit, every message starts a
 * CompressionStream or DecompressionStream immediately, creating a large
 * promise and stream burst inside this worker.
 */
const MAX_CONCURRENT_CODECS = 4;

type CodecRequest = {
	id: number;
	compress: boolean;
	bytes: Uint8Array<ArrayBuffer>;
};

type CodecSuccessResponse = {
	id: number;
	ok: true;
	result: Uint8Array<ArrayBuffer>;
};

type CodecFailureResponse = {
	id: number;
	ok: false;
};

const requestQueue: CodecRequest[] = [];
let requestQueueHead = 0;
/**
 * How far the payload-release pass has progressed.
 *
 * Separate from `requestQueueHead` because the two advance for different
 * reasons at different rates: the head is the dequeue cursor, while this is the
 * point up to which slots have had their `bytes` cleared. Keeping them distinct
 * makes payload release O(1) amortized per request instead of re-walking the
 * whole consumed prefix on every settle (which would be O(n²) across a burst).
 */
let requestQueueReleasedHead = 0;
let activeCodecCount = 0;

/**
 * Feed one payload directly into a native codec and combine its output.
 *
 * Reading starts before writing so the codec cannot deadlock on readable-side
 * backpressure. A single output chunk is returned directly when it occupies its
 * entire ArrayBuffer.
 */
async function runCodec(
	codec: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<BufferSource>;
	},
	bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
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

			const chunk = result.value;

			outputChunks.push(chunk);
			outputLength += chunk.byteLength;
		}
	})();

	try {
		await writer.write(bytes);
		await writer.close();
		await readPromise;
	} catch (error) {
		/*
		 * Abort both sides. Observe cleanup rejections so the original codec
		 * error remains the failure reported by this operation.
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
		const only = outputChunks[0];

		/*
		 * Transfer the existing buffer only when the view covers it completely.
		 * Otherwise transferring the backing buffer could expose unrelated
		 * prefix or suffix bytes.
		 */
		if (
			only.buffer instanceof ArrayBuffer &&
			only.byteOffset === 0 &&
			only.byteLength === only.buffer.byteLength
		) {
			return only as Uint8Array<ArrayBuffer>;
		}
	}

	const output = new Uint8Array(outputLength);
	let outputOffset = 0;

	for (let i = 0; i < outputChunks.length; i++) {
		const chunk = outputChunks[i];

		output.set(chunk, outputOffset);
		outputOffset += chunk.byteLength;
	}

	return output;
}

async function processRequest(request: CodecRequest): Promise<void> {
	const { id, compress, bytes } = request;

	try {
		let result: Uint8Array<ArrayBuffer>;

		if (compress) {
			if (typeof CompressionStream === "undefined") {
				throw new Error("CompressionStream unavailable");
			}

			result = await runCodec(new CompressionStream(FORMAT), bytes);
		} else {
			if (typeof DecompressionStream === "undefined") {
				throw new Error("DecompressionStream unavailable");
			}

			result = await runCodec(new DecompressionStream(FORMAT), bytes);
		}

		const response: CodecSuccessResponse = {
			id,
			ok: true,
			result,
		};

		/*
		 * result is newly produced and no longer used by this worker, so its
		 * complete backing buffer can be transferred.
		 */
		self.postMessage(response, [result.buffer]);
	} catch {
		const response: CodecFailureResponse = {
			id,
			ok: false,
		};

		self.postMessage(response);
	}
}

/**
 * Start queued work until the internal codec concurrency limit is reached.
 */
function drainRequestQueue(): void {
	while (
		activeCodecCount < MAX_CONCURRENT_CODECS &&
		requestQueueHead < requestQueue.length
	) {
		const request = requestQueue[requestQueueHead++];

		activeCodecCount++;

		void processRequest(request).then(onRequestSettled, onRequestSettled);
	}

	compactRequestQueueIfNeeded();
}

/**
 * Shared settlement path. processRequest normally handles its own errors, but
 * both Promise branches are supplied defensively so the queue cannot stall if
 * response posting itself throws.
 */
function onRequestSettled(): void {
	activeCodecCount--;
	drainRequestQueue();
}

/**
 * Release processed request objects without calling Array.shift() per message.
 *
 * Two separate costs are handled here, and conflating them is why the old
 * version retained memory under steady load:
 *
 * 1. ARRAY SLOTS — the `copyWithin` below is O(n) and must stay amortized.
 *
 * 2. PAYLOAD BYTES — each queued request holds a `bytes` Uint8Array that is a
 *    structured-clone COPY of the caller's buffer (inputs are cloned, not
 *    transferred, because callers retain theirs). A consumed slot that is not
 *    cleared keeps 32-98 KB alive. The `head < 128` floor below meant a slow
 *    trickle of work never triggered compaction, so well over a hundred cloned
 *    payloads stayed resident indefinitely.
 *
 * So the slots are nulled eagerly and unconditionally — O(1) per settle, no
 * threshold — while the array is compacted only on the amortized schedule.
 */
function compactRequestQueueIfNeeded(): void {
	const head = requestQueueHead;

	if (head === 0) {
		return;
	}

	/*
	 * Release the payload of every newly consumed request. This is O(1)
	 * amortized — the cursor only ever moves forward — while the array
	 * compaction below stays on its own threshold. `requestQueueHead` already
	 * indexes past these holes, so no other indexing needs to know.
	 */
	for (let i = requestQueueReleasedHead; i < head; i++) {
		const consumed = requestQueue[i];
		if (consumed === undefined) continue;

		// Drop the reference to the cloned input so GC can reclaim 32-98 KB.
		consumed.bytes = EMPTY_INPUT;
		requestQueue[i] = undefined as unknown as CodecRequest;
	}
	requestQueueReleasedHead = head;

	if (head === requestQueue.length) {
		requestQueue.length = 0;
		requestQueueHead = 0;
		requestQueueReleasedHead = 0;
		return;
	}

	if (head < 128 || head * 2 < requestQueue.length) {
		return;
	}

	requestQueue.copyWithin(0, head);
	requestQueue.length -= head;
	requestQueueHead = 0;
	requestQueueReleasedHead = 0;
}

/**
 * Shared empty buffer written over a released request's `bytes`.
 *
 * Reassigning the field is what releases the reference — the old buffer is then
 * unreachable. A single shared zero-length view is enough; the field is never
 * read again.
 */
const EMPTY_INPUT = new Uint8Array(0);

self.onmessage = (event: MessageEvent<CodecRequest>): void => {
	const request = event.data;

	/*
	 * Validate the inexpensive envelope before retaining it in the queue.
	 * Detailed compressed-data validation remains the responsibility of the
	 * native codec and the caller's expected-length check.
	 */
	if (
		!Number.isSafeInteger(request.id) ||
		request.id < 0 ||
		typeof request.compress !== "boolean" ||
		!(request.bytes instanceof Uint8Array)
	) {
		const id = Number.isSafeInteger(request.id) ? request.id : 0;

		const response: CodecFailureResponse = {
			id,
			ok: false,
		};

		self.postMessage(response);
		return;
	}

	requestQueue.push(request);
	drainRequestQueue();
};
