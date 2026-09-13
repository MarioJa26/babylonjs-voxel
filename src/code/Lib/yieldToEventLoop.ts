/**
 * Yield control back to the event loop without paying the minimum delay
 * `setTimeout(fn, 0)` incurs in browsers — first call is ~1ms, and per the
 * HTML spec, timers nested 5+ deep get clamped to a 4ms floor. A batch with
 * many windows can hit that clamp on every boundary, adding real latency to
 * something that's meant to be a cheap "let the browser breathe" checkpoint.
 *
 * A MessageChannel round trip dispatches as an ordinary macrotask with no
 * such floor, so this stays close to true zero-delay regardless of nesting.
 * Shared module-level channel: concurrent callers coalesce onto the same
 * port and get flushed together, which is strictly less overhead than one
 * channel per call site.
 *
 * IMPORTANT: this yields to a *macrotask*, not a microtask. Use it for
 * continuation points that must let the event loop breathe (rendering,
 * input, rAF) — a chain re-arming through `queueMicrotask` instead would
 * spin forever in `Run microtasks` and starve the main thread.
 */
let yieldPort: MessagePort | null = null;
let yieldResolvers: Array<() => void> = [];

export function yieldToEventLoop(): Promise<void> {
	if (typeof MessageChannel === "undefined") {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}
	return new Promise((resolve) => {
		if (yieldPort === null) {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => {
				const resolvers = yieldResolvers;
				yieldResolvers = [];
				for (let i = 0; i < resolvers.length; i++) resolvers[i]();
			};
			yieldPort = channel.port2;
		}
		yieldResolvers.push(resolve);
		yieldPort.postMessage(null);
	});
}

/**
 * Map `items` through `fn` with bounded concurrency: processes in waves of
 * `waveSize`, yielding to the event loop (macrotask) between waves.
 *
 * A large batch of promise-heavy work fanned out with a single Promise.all
 * (e.g. hundreds of CompressionStream pipelines completing at once) drains
 * as one giant microtask burst and can monopolize the main thread even
 * though each individual operation is cheap. Splitting into waves keeps
 * each microtask drain small and lets rendering/input interleave between
 * waves; the MessageChannel yield keeps the per-wave overhead near zero.
 */
export async function mapInWaves<T, R>(
	items: readonly T[],
	waveSize: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);

	for (let start = 0; start < items.length; start += waveSize) {
		if (start > 0) await yieldToEventLoop();

		const end = Math.min(start + waveSize, items.length);
		const wave: Promise<void>[] = [];

		for (let i = start; i < end; i++) {
			wave.push(
				fn(items[i], i).then((result) => {
					results[i] = result;
				}),
			);
		}

		await Promise.all(wave);
	}

	return results;
}
