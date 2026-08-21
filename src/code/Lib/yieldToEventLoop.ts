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
