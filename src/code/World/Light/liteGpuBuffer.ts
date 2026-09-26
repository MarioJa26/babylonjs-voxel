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

// ---------------------------------------------------------------------------
// GPU back-pressure signal
//
// How long the device queue takes to drain everything submitted so far. This is
// the one number that distinguishes "the CPU is slow" from "we are handing the
// GPU more work than it can retire", and it is measured from the frame loop
// (PlayerLoopController) because only there do we know a frame boundary.
//
// It is published here rather than kept private because the streaming pipeline
// needs it for flow control: mesh results are produced by workers at a rate set
// by CPU throughput, but each applied result dirties a merged group whose
// rebuild enqueues storage + thin-instance uploads. When the queue is far
// behind, applying results faster only deepens the hole, so ingestion is
// throttled until the device catches up.
// ---------------------------------------------------------------------------

/** Queue-drain below this (ms) is considered healthy. */
const GPU_PRESSURE_IDLE_MS = 8;
/** Queue-drain above this (ms) is considered saturated; ingestion all but stops. */
const GPU_PRESSURE_MAX_MS = 120;

let _gpuPressureMs = 0;

/**
 * Publish a fresh queue-drain sample. Smoothed with a fast-attack / slow-decay
 * EWMA: we want to back off within a frame or two of a spike, but recover
 * gradually so a single slow frame does not throttle streaming for long.
 */
export function publishGpuPressure(sampleMs: number): void {
	if (sampleMs < 0 || !Number.isFinite(sampleMs)) return;
	_gpuPressureMs =
		sampleMs > _gpuPressureMs
			? sampleMs
			: _gpuPressureMs * 0.9 + sampleMs * 0.1;
}

/** Latest smoothed queue-drain time in ms. */
export function getGpuPressureMs(): number {
	return _gpuPressureMs;
}

/**
 * Throttle factor in [0, 1]: 1 = no pressure (run at full rate), 0 = fully
 * saturated (ingestion should nearly stop).
 */
export function getGpuPressureFactor(): number {
	if (_gpuPressureMs <= GPU_PRESSURE_IDLE_MS) return 1;
	if (_gpuPressureMs >= GPU_PRESSURE_MAX_MS) return 0;

	// Linear ramp between the two thresholds.
	return (
		1 -
		(_gpuPressureMs - GPU_PRESSURE_IDLE_MS) /
			(GPU_PRESSURE_MAX_MS - GPU_PRESSURE_IDLE_MS)
	);
}

/** Reset the signal (scene teardown / device loss). */
export function resetGpuPressure(): void {
	_gpuPressureMs = 0;
}
