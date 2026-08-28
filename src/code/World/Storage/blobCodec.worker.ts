/**
 * blobCodec.worker.ts — off-main-thread deflate/inflate for chunk blobs.
 *
 * The CompressionStream/DecompressionStream codecs run natively off-thread in
 * Chromium, but driving them from the main thread costs a burst of promise
 * hops + Response/arrayBuffer work per blob, which during bulk load/save waves
 * shows up as main-thread jank. This worker owns the pipelines instead.
 *
 * Protocol: { id, op, bytes } → { id, ok, result? }. Inputs arrive as
 * structured-clone copies (never transfers — callers keep their references);
 * outputs are transferred back zero-copy.
 */

const FORMAT = "deflate";

async function runCodec(
	codec: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<BufferSource>;
	},
	bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
	const done = new Response(codec.readable).arrayBuffer();

	const writer = codec.writable.getWriter();
	try {
		await writer.write(bytes);
		await writer.close();
	} finally {
		writer.releaseLock();
	}

	return new Uint8Array(await done);
}

self.onmessage = async (
	event: MessageEvent<{
		id: number;
		compress: boolean;
		bytes: Uint8Array<ArrayBuffer>;
	}>,
) => {
	const { id, compress, bytes } = event.data;

	try {
		let result: Uint8Array;

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

		const transfer = result.buffer as ArrayBuffer;
		self.postMessage({ id, ok: true, result }, [transfer]);
	} catch {
		self.postMessage({ id, ok: false });
	}
};
