/**
 * Position smoothing for remote players, owned by the renderer rather than by
 * the network client.
 *
 * The buffer retains the two newest timestamped network samples. Rendering is
 * intentionally delayed behind the latest sample so normal packet delivery uses
 * interpolation, with short bounded extrapolation when a packet arrives late.
 */

/** Interpolation is delayed this far behind wall-clock time, in milliseconds. */
const INTERPOLATION_DELAY_MS = 100;

/**
 * Maximum time beyond the newest sample for which observed velocity is
 * extrapolated.
 */
const MAX_EXTRAPOLATION_MS = 250;

export interface RemotePlayerNetworkSample {
	x: number;
	y: number;
	z: number;
	yaw: number;

	/** Wall-clock arrival time, in milliseconds. */
	atMs: number;
}

export interface RemotePlayerRenderSnapshot {
	x: number;
	y: number;
	z: number;
	yaw: number;

	/**
	 * Interpolation progress between the retained samples.
	 *
	 * Values remain within 0..1. Extrapolated snapshots report 1 because they
	 * are already beyond the newest authoritative sample.
	 */
	alpha: number;
}

/**
 * Per-player interpolation buffer.
 *
 * Samples are stored in fixed scalar fields rather than an array of objects.
 * Each player therefore allocates only this buffer object, and sampling avoids
 * array indexing and sample-object property indirection on every frame.
 */
export class RemotePlayerInterpolationBuffer {
	private count = 0;

	private olderX = 0;
	private olderY = 0;
	private olderZ = 0;
	private olderYaw = 0;
	private olderAtMs = 0;

	private newerX = 0;
	private newerY = 0;
	private newerZ = 0;
	private newerYaw = 0;
	private newerAtMs = 0;

	/**
	 * Record a newly received authoritative sample.
	 *
	 * Timestamps are expected to be nondecreasing. A sample older than the
	 * latest retained one is rejected because accepting it would make the pair
	 * no longer time ordered.
	 *
	 * A sample with the same timestamp replaces the newest sample. This avoids
	 * retaining a zero-duration interval while ensuring the latest accepted
	 * state wins.
	 */
	push(x: number, y: number, z: number, yaw: number, atMs: number): void {
		if (this.count === 0) {
			this.newerX = x;
			this.newerY = y;
			this.newerZ = z;
			this.newerYaw = normalizeYaw(yaw);
			this.newerAtMs = atMs;
			this.count = 1;
			return;
		}

		if (atMs < this.newerAtMs) {
			return;
		}

		if (atMs === this.newerAtMs) {
			this.newerX = x;
			this.newerY = y;
			this.newerZ = z;
			this.newerYaw = normalizeYaw(yaw);
			return;
		}

		this.olderX = this.newerX;
		this.olderY = this.newerY;
		this.olderZ = this.newerZ;
		this.olderYaw = this.newerYaw;
		this.olderAtMs = this.newerAtMs;

		this.newerX = x;
		this.newerY = y;
		this.newerZ = z;
		this.newerYaw = normalizeYaw(yaw);
		this.newerAtMs = atMs;

		this.count = 2;
	}

	/**
	 * Resolve a render snapshot for `nowMs`.
	 *
	 * The caller supplies `out`, keeping this per-player, per-frame operation
	 * allocation-free.
	 */
	sample(nowMs: number, out: RemotePlayerRenderSnapshot): void {
		const count = this.count;

		if (count === 0) {
			out.x = 0;
			out.y = 0;
			out.z = 0;
			out.yaw = 0;
			out.alpha = 0;
			return;
		}

		if (count === 1) {
			out.x = this.newerX;
			out.y = this.newerY;
			out.z = this.newerZ;
			out.yaw = this.newerYaw;
			out.alpha = 0;
			return;
		}

		const olderAtMs = this.olderAtMs;
		const newerAtMs = this.newerAtMs;
		const spanMs = newerAtMs - olderAtMs;

		if (spanMs <= 0) {
			out.x = this.newerX;
			out.y = this.newerY;
			out.z = this.newerZ;
			out.yaw = this.newerYaw;
			out.alpha = 1;
			return;
		}

		const targetMs = nowMs - INTERPOLATION_DELAY_MS;
		const alpha = (targetMs - olderAtMs) / spanMs;

		const deltaX = this.newerX - this.olderX;
		const deltaY = this.newerY - this.olderY;
		const deltaZ = this.newerZ - this.olderZ;
		const deltaYaw = shortestYawDelta(this.olderYaw, this.newerYaw);

		if (alpha <= 0) {
			out.x = this.olderX;
			out.y = this.olderY;
			out.z = this.olderZ;
			out.yaw = this.olderYaw;
			out.alpha = 0;
			return;
		}

		if (alpha < 1) {
			out.x = this.olderX + deltaX * alpha;
			out.y = this.olderY + deltaY * alpha;
			out.z = this.olderZ + deltaZ * alpha;
			out.yaw = normalizeYaw(this.olderYaw + deltaYaw * alpha);
			out.alpha = alpha;
			return;
		}

		/*
		 * The target is beyond the newest authoritative sample. Extrapolate
		 * position and rotation from the observed interval, but cap the elapsed
		 * time so a stalled stream cannot produce unbounded drift.
		 */
		let extrapolationMs = targetMs - newerAtMs;

		if (extrapolationMs < 0) {
			extrapolationMs = 0;
		} else if (extrapolationMs > MAX_EXTRAPOLATION_MS) {
			extrapolationMs = MAX_EXTRAPOLATION_MS;
		}

		const extrapolationScale = extrapolationMs / spanMs;

		out.x = this.newerX + deltaX * extrapolationScale;
		out.y = this.newerY + deltaY * extrapolationScale;
		out.z = this.newerZ + deltaZ * extrapolationScale;
		out.yaw = normalizeYaw(this.newerYaw + deltaYaw * extrapolationScale);
		out.alpha = 1;
	}

	/** Most recent sample time, or -1 when the buffer is empty. */
	get lastSampleMs(): number {
		return this.count === 0 ? -1 : this.newerAtMs;
	}

	/**
	 * Empty the buffer.
	 *
	 * Scalar sample values need not be cleared because `count` controls whether
	 * they are observable.
	 */
	reset(): void {
		this.count = 0;
	}
}

/**
 * Return the signed shortest angular difference from `fromYaw` to `toYaw`.
 */
function shortestYawDelta(fromYaw: number, toYaw: number): number {
	let delta = toYaw - fromYaw;

	if (delta > 180) {
		delta -= 360;
	} else if (delta < -180) {
		delta += 360;
	}

	return delta;
}

/**
 * Normalize a yaw angle into the range [0, 360).
 *
 * The fast branches handle interpolation and normal network values. The modulo
 * fallback safely handles arbitrary caller input outside a single revolution.
 */
function normalizeYaw(yaw: number): number {
	if (yaw >= 360) {
		if (yaw < 720) {
			return yaw - 360;
		}

		return yaw % 360;
	}

	if (yaw < 0) {
		if (yaw >= -360) {
			return yaw + 360;
		}

		const normalized = yaw % 360;
		return normalized < 0 ? normalized + 360 : normalized;
	}

	return yaw;
}
