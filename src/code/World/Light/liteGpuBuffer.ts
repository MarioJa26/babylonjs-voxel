/**
 * Minimal GPU queue helpers and back-pressure tracking for Babylon Lite.
 *
 * Lite 1.11+ exposes a managed storage-buffer API. Direct device access is
 * still required for GPUQueue.onSubmittedWorkDone(), which has no public Lite
 * equivalent.
 */
import type { EngineContext } from "@babylonjs/lite";

interface EngineWithDevice extends EngineContext {
	_device: GPUDevice;
}

function deviceOf(engine: EngineContext): GPUDevice {
	return (engine as EngineWithDevice)._device;
}

/*
 * Shared promise handlers avoid allocating two new closures for every queue
 * drain measurement.
 *
 * Rejections are intentionally converted to successful completion because
 * callers use this only as a safe disposal/recycling boundary. Device-loss
 * handling occurs elsewhere.
 */
function ignoreGpuCompletion(): void {
	// Intentionally empty.
}

/**
 * Resolves after the GPU finishes all work submitted before this call.
 *
 * The returned promise also resolves if queue completion rejects, preserving
 * the original behavior during device loss.
 */
export function onGpuWorkDone(engine: EngineContext): Promise<void> {
	return deviceOf(engine)
		.queue.onSubmittedWorkDone()
		.then(ignoreGpuCompletion, ignoreGpuCompletion);
}

// ---------------------------------------------------------------------------
// GPU back-pressure signal
// ---------------------------------------------------------------------------

/** Queue-drain times at or below this threshold are considered healthy. */
const GPU_PRESSURE_IDLE_MS = 8;

/** Queue-drain times at or above this threshold are considered saturated. */
const GPU_PRESSURE_MAX_MS = 120;

/** Reciprocal of the pressure ramp width, precomputed once. */
const GPU_PRESSURE_RANGE_INVERSE =
	1 / (GPU_PRESSURE_MAX_MS - GPU_PRESSURE_IDLE_MS);

/** Slow-decay EWMA weights. */
const GPU_PRESSURE_DECAY_OLD = 0.9;
const GPU_PRESSURE_DECAY_SAMPLE = 0.1;

let _gpuPressureMs = 0;
let _gpuPressureFactor = 1;

/**
 * Recomputes the cached throttle factor after the pressure value changes.
 */
function updateGpuPressureFactor(): void {
	const pressureMs = _gpuPressureMs;

	if (pressureMs <= GPU_PRESSURE_IDLE_MS) {
		_gpuPressureFactor = 1;
		return;
	}

	if (pressureMs >= GPU_PRESSURE_MAX_MS) {
		_gpuPressureFactor = 0;
		return;
	}

	_gpuPressureFactor =
		(GPU_PRESSURE_MAX_MS - pressureMs) * GPU_PRESSURE_RANGE_INVERSE;
}

/**
 * Publishes a fresh queue-drain sample.
 *
 * Pressure has immediate attack and slow EWMA decay:
 * - A sample above the current pressure is adopted immediately.
 * - A lower sample contributes 10%, allowing pressure to recover gradually.
 */
export function publishGpuPressure(sampleMs: number): void {
	if (!Number.isFinite(sampleMs) || sampleMs < 0) {
		return;
	}

	const currentPressure = _gpuPressureMs;

	_gpuPressureMs =
		sampleMs > currentPressure
			? sampleMs
			: currentPressure * GPU_PRESSURE_DECAY_OLD +
				sampleMs * GPU_PRESSURE_DECAY_SAMPLE;

	updateGpuPressureFactor();
}

/** Returns the latest smoothed queue-drain time in milliseconds. */
export function getGpuPressureMs(): number {
	return _gpuPressureMs;
}

/**
 * Returns the cached ingestion throttle in the inclusive range [0, 1].
 *
 * 1 means healthy and full-rate ingestion.
 * 0 means saturated and ingestion should stop or nearly stop.
 */
export function getGpuPressureFactor(): number {
	return _gpuPressureFactor;
}

/** Resets pressure tracking during scene teardown or device loss. */
export function resetGpuPressure(): void {
	_gpuPressureMs = 0;
	_gpuPressureFactor = 1;
}
