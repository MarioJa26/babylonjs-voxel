/**
 * A frame-wide budget for work that several independent systems can each
 * legitimately decide to do.
 *
 * PERF/RATIONALE: every one of these systems already had its own throttle —
 * `RemoteChunkProvider` decompressed in windows of 4, `flushDirtyMergedGroups`
 * had a 2 MiB GPU upload cap and a 5.5 ms deadline, particles had a pool cap.
 * Each stayed inside its own budget. The failure mode is the SUM: a reconnect
 * can decompress 8 chunks, build 4 merged groups, upload 2 MiB, and simulate
 * 2000 colliding particles in one frame, and every individual subsystem
 * believes it behaved correctly.
 *
 * A shared budget makes the aggregate explicit. Consumers that cannot afford
 * their work this frame DEFER it — the next frame re-evaluates — rather than
 * dropping it. Deferral is safe because all four work kinds are already
 * idempotent and re-derivable from persistent state:
 *
 * - Chunk decompression re-reads the pending request map (unchanged entries
 *   return early without re-inflating).
 * - Mesh builds are guarded by `MergedMeshManager.dirtyGroups`, so a group left
 *   dirty is picked up by the next flush.
 * - GPU uploads re-pack from the group CPU buffer, which still holds the data.
 * - Collision checks are per-particle; skipping one just delays settling.
 *
 * Nothing here decides *whether* work should happen. It only answers "can this
 * frame afford it?", and the answer is a cheap counter decrement.
 */
export class FrameWorkBudget {
	private uploadBytesRemaining = 0;
	private collisionChecksRemaining = 0;
	private decompressionsRemaining = 0;
	private meshBuildsRemaining = 0;

	/**
	 * Reset all budgets for the frame about to run. Called exactly once per
	 * frame, before any consumer asks.
	 *
	 * A negative allowance is treated as zero rather than granted credit: an
	 * over-subscribed budget must deny work, never permit it.
	 */
	beginFrame(
		uploadBytes: number,
		collisionChecks: number,
		decompressions: number,
		meshBuilds: number,
	): void {
		this.uploadBytesRemaining = Math.max(0, uploadBytes);
		this.collisionChecksRemaining = Math.max(0, collisionChecks);
		this.decompressionsRemaining = Math.max(0, decompressions);
		this.meshBuildsRemaining = Math.max(0, meshBuilds);
	}

	/**
	 * Reserve upload bytes.
	 *
	 * A zero-byte request always succeeds: a mesh that uploaded no faces still
	 * needs its metadata written, and blocking that would strand a group in a
	 * half-applied state.
	 *
	 * @returns true if the bytes were reserved; false if the caller should defer.
	 */
	takeUploadBytes(bytes: number): boolean {
		if (bytes <= 0) return true;
		if (bytes > this.uploadBytesRemaining) return false;

		this.uploadBytesRemaining -= bytes;
		return true;
	}

	/**
	 * Reserve collision samples for debris particles.
	 *
	 * Default 1 keeps the common call site terse: a batch of N colliding
	 * particles should ask for N at once rather than discover exhaustion one
	 * particle at a time.
	 */
	takeCollisionChecks(count = 1): boolean {
		if (count > this.collisionChecksRemaining) return false;

		this.collisionChecksRemaining -= count;
		return true;
	}

	takeDecompression(): boolean {
		if (this.decompressionsRemaining <= 0) return false;

		this.decompressionsRemaining--;
		return true;
	}

	takeMeshBuild(): boolean {
		if (this.meshBuildsRemaining <= 0) return false;

		this.meshBuildsRemaining--;
		return true;
	}

	/** Remaining allowances, for HUD diagnostics. */
	readRemaining(): {
		uploadBytes: number;
		collisionChecks: number;
		decompressions: number;
		meshBuilds: number;
	} {
		return {
			uploadBytes: this.uploadBytesRemaining,
			collisionChecks: this.collisionChecksRemaining,
			decompressions: this.decompressionsRemaining,
			meshBuilds: this.meshBuildsRemaining,
		};
	}

	/** True when nothing at all is affordable this frame. */
	isExhausted(): boolean {
		return (
			this.uploadBytesRemaining <= 0 &&
			this.collisionChecksRemaining <= 0 &&
			this.decompressionsRemaining <= 0 &&
			this.meshBuildsRemaining <= 0
		);
	}

	/**
	 * Reset to an empty budget without granting credit.
	 *
	 * Used when the renderer stops (tab hidden, scene disposed) so that work
	 * arriving while unpaused cannot spend a stale allowance. Consumers already
	 * poll `enabled` for the primary effect; this closes the gap where work was
	 * queued before the stall and drains after it.
	 */
	suspend(): void {
		this.beginFrame(0, 0, 0, 0);
	}
}

export const FRAME_WORK_BUDGET = new FrameWorkBudget();
