// ---------------------------------------------------------------------------
// WASM noise bootstrap: loads kernels.wasm and installs the SIMD noise
// backend via setNoiseBackend(). Called from the terrain worker
// (chunk.worker.ts) before it accepts SetWorldSeed, and from main.ts.
//
// Safe to call from any context. Concurrent callers of the same loader share
// one load attempt. Failures retain the JavaScript noise backend.
// ---------------------------------------------------------------------------

import { setNoiseBackend } from "../Generation/NoiseAndParameters/FastNoise/FastNoiseFactory";
import { createWasmNoiseBackend } from "./WasmKernels";

/**
 * kernels.wasm served from public/wasm/ (copied there by
 * scripts/build-wasm.mjs; Vite mirrors public/ to the dist root verbatim).
 */
export const KERNELS_WASM_URL = "/wasm/kernels.wasm";

/**
 * Default filesystem path for the server (Node.js). Relative to cwd.
 */
export const KERNELS_WASM_PATH = "src/code/wasm/kernels.wasm";

let wasmNoisePromise: Promise<boolean> | null = null;

/** ?noWasm=1 in the URL forces the JS backend for parity debugging. */
function isWasmNoiseDisabled(): boolean {
	return (
		typeof location !== "undefined" &&
		typeof location.search === "string" &&
		new URLSearchParams(location.search).has("noWasm")
	);
}

/**
 * Installs the WASM noise backend from already-loaded bytes.
 *
 * Keeping installation in one helper ensures browser and Node.js loaders use
 * identical backend initialization behavior.
 */
function installWasmNoise(bytes: Uint8Array): void {
	setNoiseBackend(createWasmNoiseBackend(bytes));
}

/**
 * Loads kernels.wasm over HTTP and installs it as the active noise backend.
 * Resolves true on success and false on failure. Never rejects.
 *
 * Memoized: concurrent callers share the same load attempt.
 */
export function enableWasmNoise(
	url: string = KERNELS_WASM_URL,
): Promise<boolean> {
	return (wasmNoisePromise ??= loadWasmNoise(url));
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
		installWasmNoise(bytes);
		return true;
	} catch (error) {
		console.warn("[wasm-noise] load failed - keeping JS noise backend:", error);
		return false;
	}
}

/**
 * Node.js filesystem loader for the server.
 *
 * Loads kernels.wasm from disk and installs it as the active noise backend.
 * Resolves true on success and false on failure. Never rejects.
 *
 * Searches these locations:
 *   1. The explicit path, when absolute
 *   2. Resolved against process.cwd()
 *   3. Resolved against process.cwd()/..
 *   4. Resolved against process.cwd()/../..
 */
export function loadWasmNoiseFromFile(
	filePath: string = KERNELS_WASM_PATH,
): Promise<boolean> {
	return (wasmNoisePromise ??= loadWasmNoiseFile(filePath));
}

async function loadWasmNoiseFile(filePath: string): Promise<boolean> {
	try {
		const [{ readFile }, { resolve, isAbsolute }] = await Promise.all([
			import("node:fs/promises"),
			import("node:path"),
		]);

		const cwd = process.cwd();
		const candidates = isAbsolute(filePath)
			? [filePath]
			: [
					resolve(cwd, filePath),
					resolve(cwd, "..", filePath),
					resolve(cwd, "..", "..", filePath),
				];

		for (const absolutePath of candidates) {
			try {
				// Buffer extends Uint8Array, so no additional byte copy is
				// needed before passing it to the WASM backend factory.
				const bytes = await readFile(absolutePath);

				installWasmNoise(bytes);

				console.log(
					`[wasm-noise] loaded from ${absolutePath} (${bytes.byteLength} bytes)`,
				);
				return true;
			} catch (error) {
				if (!isFileNotFoundError(error)) {
					console.warn(`[wasm-noise] read failed for ${absolutePath}:`, error);
				}
			}
		}

		console.warn(
			"[wasm-noise] file not found in any candidate path - keeping JS noise backend",
		);
		console.warn("  tried:", candidates.join(", "));
		return false;
	} catch (error) {
		// Covers failures from dynamic imports, process.cwd(), path
		// resolution, and other Node environment initialization.
		console.warn(
			"[wasm-noise] filesystem loader failed - keeping JS noise backend:",
			error,
		);
		return false;
	}
}

function isFileNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
