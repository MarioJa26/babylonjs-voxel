/**
 * Minimal GPU storage-buffer helpers for Babylon Lite.
 *
 * Lite 1.11+ exposes a *managed* storage-buffer API
 * (`createStorageBuffer` / `updateStorageBuffer` / `disposeStorageBuffer`) that
 * owns the underlying GPUBuffer, its device association, and disposal. Use
 * these instead of reaching into the engine's private `_device` to call
 * `device.createBuffer` directly — the managed buffers are what
 * `setShaderStorageBuffer` now expects.
 *
 * NOTE: we still reach `engine._device` only for `queue.onSubmittedWorkDone()`,
 * which has no public Lite equivalent and is required to safely recycle GPU
 * buffers after in-flight frames complete.
 */
import {
	createStorageBuffer,
	disposeStorageBuffer,
	type EngineContext,
	type StorageBuffer,
	updateStorageBuffer,
} from "@babylonjs/lite";

interface EngineWithDevice extends EngineContext {
	_device: GPUDevice;
}

function deviceOf(engine: EngineContext): GPUDevice {
	return (engine as EngineWithDevice)._device;
}

/**
 * Create a managed storage buffer initialised from `data`.
 * Returns a Lite `StorageBuffer` (not a raw GPUBuffer) — pass it straight to
 * `setShaderStorageBuffer`.
 */
export function createLiteStorageBuffer(
	engine: EngineContext,
	data: Float32Array | Uint32Array,
	label = "lite-storage-buffer",
): StorageBuffer {
	return createStorageBuffer(engine, data, label);
}

/**
 * Re-upload `data` into an existing managed storage buffer at the given byte
 * offset (replaces a byte range in place, preserving the bind identity).
 */
export function updateLiteStorageBuffer(
	engine: EngineContext,
	buffer: StorageBuffer,
	data: Float32Array | Uint32Array,
	byteOffset = 0,
): void {
	updateStorageBuffer(engine, buffer, data, byteOffset);
}

/**
 * Dispose a managed storage buffer once the GPU is done with it.
 */
export function disposeLiteStorageBuffer(buffer: StorageBuffer): void {
	disposeStorageBuffer(buffer);
}

/**
 * Resolve once the GPU has finished all work submitted so far. Used to safely
 * recycle / dispose buffers that a frame may still be reading.
 */
export function onGpuWorkDone(engine: EngineContext): Promise<void> {
	return deviceOf(engine)
		.queue.onSubmittedWorkDone()
		.then(
			() => {},
			() => {},
		);
}
