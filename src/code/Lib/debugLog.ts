/**
 * Debug logging helper shared by client and server.
 *
 * Hot-path logging (per chunk request / per block edit) is gated behind
 * this so production runs skip the stdout writes entirely:
 * - Server (Node): enabled when the DEBUG env var is truthy (DEBUG=1).
 * - Client (browser): enabled when the URL has a ?debug query param.
 */

function isDebugEnabled(): boolean {
	if (typeof process !== "undefined" && typeof process.env !== "undefined") {
		const v = process.env.DEBUG;
		if (v === "1" || v?.toLowerCase() === "true") return true;
	}
	if (typeof location !== "undefined") {
		return new URLSearchParams(location.search).has("debug");
	}
	return false;
}

const enabled = isDebugEnabled();

/** Whether debug logging is active — gate hot-path template literals with this. */
export const DEBUG_ENABLED = enabled;

/** Log only when debug output is enabled — no-op in production. */
export function debugLog(...args: unknown[]): void {
	if (enabled) console.log(...args);
}
