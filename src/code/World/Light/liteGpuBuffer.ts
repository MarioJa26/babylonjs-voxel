/**
 * Minimal GPU storage-buffer helpers for Babylon Lite.
 *
 * Lite 1.11+ exposes a *managed* storage-buffer API
 *
 * NOTE: we still reach `engine._device` only for `queue.onSubmittedWorkDone()`,
 * which has no public Lite equivalent and is required to safely recycle GPU
 * buffers after in-flight frames complete.
 */
import type { EngineContext } from "@babylonjs/lite";

interface EngineWithDevice extends EngineContext {
	_device: GPUDevice;
}

function deviceOf(engine: EngineContext): GPUDevice {
	return (engine as EngineWithDevice)._device;
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
