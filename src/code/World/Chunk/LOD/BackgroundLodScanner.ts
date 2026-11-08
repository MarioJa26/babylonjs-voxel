// ---------------------------------------------------------------------------
// BackgroundLodScanner: background LOD2/3 precompute scheduling.
//
// Sweeps loaded chunks in radius, scores candidates by distance, and enqueues
// the top-N missing LOD meshes.
//
// Candidate storage is bounded to the per-update enqueue cap. This avoids
// collecting and sorting every eligible chunk when only a small number can
// actually be scheduled.
// ---------------------------------------------------------------------------

import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";
import { Chunk } from "../Chunk";
import { packInflightKey } from "../Runtime/RemeshFlightTracker";

export type LodScanHost = {
	queuedCount(): number;
	hasQueued(key: number): boolean;
	enqueue(chunk: Chunk, lod: number, key: number): void;
	kick(): void;
};

export class BackgroundLodScanner {
	private lastScheduleTs = 0;

	/**
	 * Sorted, bounded candidate buffers.
	 *
	 * Entries are kept in ascending score order. Their length never exceeds
	 * LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE.
	 *
	 * Candidate keys are retained with each entry so dispatch does not need to
	 * repack the chunk ID and LOD.
	 */
	private readonly candidateChunks: Chunk[] = [];
	private readonly candidateLods: number[] = [];
	private readonly candidateKeys: number[] = [];
	private readonly candidateScores: number[] = [];

	/**
	 * Reused spatial-query output.
	 */
	private readonly queryScratch: Chunk[] = [];

	scan(
		host: LodScanHost,
		centerChunkX: number,
		centerChunkY: number,
		centerChunkZ: number,
	): void {
		const now = performance.now();
		const throttleMs = Math.max(
			0,
			SETTING_PARAMS.LOD_PRECOMPUTE_SCHEDULE_THROTTLE_MS | 0,
		);

		if (throttleMs > 0 && now - this.lastScheduleTs < throttleMs) {
			return;
		}

		this.lastScheduleTs = now;

		const maxEnqueue = Math.max(
			1,
			SETTING_PARAMS.LOD_PRECOMPUTE_MAX_ENQUEUE_PER_UPDATE | 0,
		);

		/*
		 * Avoid the full spatial query while enough work is already queued to
		 * keep the background precompute pipeline occupied.
		 *
		 * Division avoids possible overflow from maxEnqueue * 2.
		 */
		if (host.queuedCount() >= maxEnqueue * 2) {
			return;
		}

		const horizontalRadius =
			SETTING_PARAMS.RENDER_DISTANCE +
			SETTING_PARAMS.LOD_PRECOMPUTE_HORIZONTAL_OFFSET;

		const verticalRadius =
			SETTING_PARAMS.VERTICAL_RENDER_DISTANCE +
			SETTING_PARAMS.LOD_PRECOMPUTE_VERTICAL_OFFSET;

		const candidateChunks = this.candidateChunks;
		const candidateLods = this.candidateLods;
		const candidateKeys = this.candidateKeys;
		const candidateScores = this.candidateScores;

		candidateChunks.length = 0;
		candidateLods.length = 0;
		candidateKeys.length = 0;
		candidateScores.length = 0;

		const queryScratch = this.queryScratch;
		queryScratch.length = 0;

		Chunk.loadedChunkIndex.queryCollect(
			centerChunkX,
			centerChunkY,
			centerChunkZ,
			horizontalRadius + 1,
			verticalRadius + 1,
			queryScratch,
		);

		for (let i = 0, length = queryScratch.length; i < length; i++) {
			const chunk = queryScratch[i];

			if (
				!chunk.hasVoxelData ||
				chunk.isDirty ||
				!chunk.isModified ||
				chunk.chunkY < 0
			) {
				continue;
			}

			const offsetX = chunk.chunkX - centerChunkX;
			const offsetZ = chunk.chunkZ - centerChunkZ;

			const deltaX = offsetX < 0 ? -offsetX : offsetX;
			const deltaZ = offsetZ < 0 ? -offsetZ : offsetZ;
			const horizontalDistance = deltaX > deltaZ ? deltaX : deltaZ;

			if (horizontalDistance > horizontalRadius) {
				continue;
			}

			const offsetY = chunk.chunkY - centerChunkY;
			const verticalDistance = offsetY < 0 ? -offsetY : offsetY;

			if (verticalDistance > verticalRadius) {
				continue;
			}

			/*
			 * The distance component is shared by both LOD candidates.
			 * Lower scores have higher scheduling priority.
			 *
			 * LOD 2 sorts immediately before LOD 3 for the same chunk.
			 */
			const distanceScore = horizontalDistance * 100 + verticalDistance * 10;

			this.considerCandidate(host, chunk, 2, distanceScore + 2, maxEnqueue);

			this.considerCandidate(host, chunk, 3, distanceScore + 3, maxEnqueue);
		}

		/*
		 * Release query references immediately. Candidate buffers retain only
		 * the bounded set that may be dispatched.
		 */
		queryScratch.length = 0;

		const candidateCount = candidateChunks.length;

		if (candidateCount === 0) {
			return;
		}

		let added = 0;

		for (let i = 0; i < candidateCount; i++) {
			const key = candidateKeys[i];

			/*
			 * Recheck because host state may have changed through another
			 * scheduling path since candidate selection.
			 */
			if (host.hasQueued(key)) {
				continue;
			}

			host.enqueue(candidateChunks[i], candidateLods[i], key);
			added++;
		}

		/*
		 * Do not retain chunk references between scans.
		 */
		candidateChunks.length = 0;
		candidateLods.length = 0;
		candidateKeys.length = 0;
		candidateScores.length = 0;

		if (added > 0) {
			host.kick();
		}
	}

	/**
	 * Adds an eligible candidate to the bounded, score-sorted list.
	 *
	 * Equal scores retain discovery order. Storage never grows beyond
	 * `capacity`.
	 */
	private considerCandidate(
		host: LodScanHost,
		chunk: Chunk,
		lod: number,
		score: number,
		capacity: number,
	): void {
		if (chunk.hasCachedLODMesh(lod)) {
			return;
		}

		const key = packInflightKey(chunk.numericId, lod);

		if (host.hasQueued(key)) {
			return;
		}

		const scores = this.candidateScores;
		const candidateCount = scores.length;

		/*
		 * When full, candidates equal to or worse than the current last entry
		 * cannot enter the stable top-N set.
		 */
		if (candidateCount === capacity && score >= scores[candidateCount - 1]) {
			return;
		}

		/*
		 * Upper-bound binary search: insert after existing equal scores to
		 * preserve discovery order.
		 */
		let low = 0;
		let high = candidateCount;

		while (low < high) {
			const middle = (low + high) >>> 1;

			if (scores[middle] <= score) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		const insertAt = low;
		const chunks = this.candidateChunks;
		const lods = this.candidateLods;
		const keys = this.candidateKeys;

		if (candidateCount < capacity) {
			/*
			 * Extend the arrays once before shifting entries right.
			 * Placeholder values are overwritten below.
			 */
			chunks.length = candidateCount + 1;
			lods.length = candidateCount + 1;
			keys.length = candidateCount + 1;
			scores.length = candidateCount + 1;
		}

		const lastIndex = candidateCount < capacity ? candidateCount : capacity - 1;

		for (let i = lastIndex; i > insertAt; i--) {
			chunks[i] = chunks[i - 1];
			lods[i] = lods[i - 1];
			keys[i] = keys[i - 1];
			scores[i] = scores[i - 1];
		}

		chunks[insertAt] = chunk;
		lods[insertAt] = lod;
		keys[insertAt] = key;
		scores[insertAt] = score;
	}
}
