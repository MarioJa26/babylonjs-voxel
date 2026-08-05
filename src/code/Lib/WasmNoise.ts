// ---------------------------------------------------------------------------
// WASM noise bootstrap: loads kernels.wasm and installs the SIMD noise
// backend via setNoiseBackend(). Called from the terrain worker
// (chunk.worker.ts) before it accepts SetWorldSeed, and from main.ts.
// Safe to call from any context; memoized so concurrent callers share one
// load attempt. Never throws — any failure falls back to the JS backend.
// ---------------------------------------------------------------------------

import { setNoiseBackend } from "../Generation/NoiseAndParameters/FastNoise/FastNoiseFactory";
import { createWasmNoiseBackend } from "./WasmKernels";

/**
 * kernels.wasm served from public/wasm/ (copied there by
 * scripts/build-wasm.mjs; Vite mirrors public/ to the dist root verbatim).
 */
export const KERNELS_WASM_URL = "/wasm/kernels.wasm";

let wasmNoisePromise: Promise<boolean> | null = null;

/** ?noWasm=1 in the URL forces the JS backend (parity debugging). */
function isWasmNoiseDisabled(): boolean {
	if (typeof location === "undefined" || typeof location.search !== "string") {
		return false;
	}
	return new URLSearchParams(location.search).has("noWasm");
}

/**
 * Loads kernels.wasm and installs it as the active noise backend.
 * Resolves true on success; false on any failure (JS backend stays active).
 * Memoized: only the first caller performs the load.
 */
export function enableWasmNoise(
	url: string = KERNELS_WASM_URL,
): Promise<boolean> {
	if (wasmNoisePromise) return wasmNoisePromise;
	wasmNoisePromise = loadWasmNoise(url);
	return wasmNoisePromise;
}

async function loadWasmNoise(url: string): Promise<boolean> {
	if (isWasmNoiseDisabled()) {
		console.warn(
			"[wasm-noise] disabled (?noWasm=1) - keeping JS noise backend",
		);
		return false;
	}
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} for ${url}`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		setNoiseBackend(createWasmNoiseBackend(bytes));
		console.info(
			`[wasm-noise] SIMD noise backend active (${bytes.byteLength} bytes)`,
		);
		return true;
	} catch (error) {
		console.warn("[wasm-noise] load failed - keeping JS noise backend:", error);
		return false;
	}
}
