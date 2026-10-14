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
	 */
	private candidateChunks: Chunk[] = [];
	private candidateLods: number[] = [];
	private candidateScores: number[] = [];

	private queryScratch: Chunk[] = [];

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
		 * A full-radius spatial query is unnecessary while enough work is
		 * already queued to keep the precompute pipeline occupied.
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
		const candidateScores = this.candidateScores;

		candidateChunks.length = 0;
		candidateLods.length = 0;
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

			const deltaX = Math.abs(chunk.chunkX - centerChunkX);
			const deltaZ = Math.abs(chunk.chunkZ - centerChunkZ);
			const horizontalDistance = deltaX > deltaZ ? deltaX : deltaZ;

			if (horizontalDistance > horizontalRadius) {
				continue;
			}

			const verticalDistance = Math.abs(chunk.chunkY - centerChunkY);

			if (verticalDistance > verticalRadius) {
				continue;
			}

			/*
			 * The distance component is shared by both LOD candidates.
			 * Lower scores have higher scheduling priority.
			 */
			const distanceScore = horizontalDistance * 100 + verticalDistance * 10;

			this.considerCandidate(host, chunk, 2, distanceScore + 2, maxEnqueue);

			this.considerCandidate(host, chunk, 3, distanceScore + 3, maxEnqueue);
		}

		/*
		 * Release query references immediately. The candidate buffers retain
		 * only the small number of chunks that may actually be enqueued.
		 */
		queryScratch.length = 0;

		const candidateCount = candidateChunks.length;

		if (candidateCount === 0) {
			return;
		}

		let added = 0;

		for (let i = 0; i < candidateCount; i++) {
			const chunk = candidateChunks[i];
			const lod = candidateLods[i];
			const key = packInflightKey(chunk.numericId, lod);

			/*
			 * Recheck at dispatch time because host state may have changed
			 * through callbacks or other scheduling paths.
			 */
			if (host.hasQueued(key)) {
				continue;
			}

			host.enqueue(chunk, lod, key);
			added++;
		}

		/*
		 * Do not retain chunk references between scans.
		 */
		candidateChunks.length = 0;
		candidateLods.length = 0;
		candidateScores.length = 0;

		if (added > 0) {
			host.kick();
		}
	}

	/**
	 * Add an eligible candidate to the bounded, score-sorted candidate list.
	 *
	 * Equal scores retain discovery order, matching stable ascending sort
	 * behavior. Storage never grows beyond `capacity`.
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
		 * If the buffer is full and this candidate is no better than the
		 * current worst candidate, it cannot enter the top-N set.
		 *
		 * Equal-score candidates are rejected here so earlier discovery order
		 * wins, matching a stable full-array sort.
		 */
		if (candidateCount === capacity && score >= scores[candidateCount - 1]) {
			return;
		}

		/*
		 * Find the first score greater than this candidate's score. Inserting
		 * after equal scores preserves discovery order for ties.
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

		if (candidateCount < capacity) {
			/*
			 * Extend the arrays before shifting entries right.
			 */
			chunks.push(chunk);
			lods.push(lod);
			scores.push(score);
		}

		const lastIndex = candidateCount < capacity ? candidateCount : capacity - 1;

		for (let i = lastIndex; i > insertAt; i--) {
			chunks[i] = chunks[i - 1];
			lods[i] = lods[i - 1];
			scores[i] = scores[i - 1];
		}

		chunks[insertAt] = chunk;
		lods[insertAt] = lod;
		scores[insertAt] = score;
	}
}
