import { Chunk } from "../Chunk";
import { ChunkWorkerPool } from "../ChunkWorkerPool";

/**
 * Snapshot of everything needed to tell "chunk streaming is idle" apart from
 * "chunk streaming has wedged", captured in one pass.
 */
export type StreamingSnapshot = {
	// Demand: is there any work the streaming system believes it must do?
	loadQueueLength: number;
	unloadQueueLength: number;
	terrainQueueLength: number;
	desiredStateCount: number;

	// Supply: can it actually do the work?
	schedulerProcessing: boolean;
	schedulerStage: string;
	schedulerProgress: string;
	idleWorkers: number;
	workerCount: number;

	// Population: what exists right now.
	chunkInstances: number;
	loadedChunks: number;
	loadedWithVoxels: number;
	loadedWithoutVoxels: number;
	unloadedScheduled: number;

	// Output: is work landing? These are monotonically increasing counters, so
	// a flat reading across many samples means nothing is completing.
	totalLoaded: number;
	totalGenerated: number;
	totalHydrated: number;
	totalUnloaded: number;

	// Multiplayer request pipeline. `remotePending` at or above the pool's
	// MAX_OUTSTANDING_REMOTE cap means the pump is backpressured shut and no
	// further chunk can be requested until pending entries settle.
	remoteEnabled: boolean;
	remoteTaskQueue: number;
	remotePending: number;
	remotePendingCap: number;
	remoteParked: number;
};

export type StreamingSnapshotSource = () => StreamingSnapshot;

const noopSource: StreamingSnapshotSource = () => ({
	loadQueueLength: 0,
	unloadQueueLength: 0,
	terrainQueueLength: 0,
	desiredStateCount: 0,
	schedulerProcessing: false,
	schedulerStage: "Idle",
	schedulerProgress: "-",
	idleWorkers: 0,
	workerCount: 0,
	chunkInstances: 0,
	loadedChunks: 0,
	loadedWithVoxels: 0,
	loadedWithoutVoxels: 0,
	unloadedScheduled: 0,
	totalLoaded: 0,
	totalGenerated: 0,
	totalHydrated: 0,
	totalUnloaded: 0,
	remoteEnabled: false,
	remoteTaskQueue: 0,
	remotePending: 0,
	remotePendingCap: 0,
	remoteParked: 0,
});

/** Milliseconds between watchdog evaluations. */
const SAMPLE_INTERVAL_MS = 1000;

/**
 * Consecutive samples with pending demand, no completed work, and no worker
 * able to accept a task, before the pipeline is declared wedged.
 *
 * Deliberately slow (5 s). Legitimate quiet periods are common: standing still
 * in a fully-loaded view has an empty queue, and a burst of unloads with slow
 * disk produces gaps in completions that resolve themselves.
 */
const STALL_SAMPLE_THRESHOLD = 5;

function hasPendingDemand(s: StreamingSnapshot): boolean {
	return (
		s.loadQueueLength > 0 ||
		s.unloadQueueLength > 0 ||
		s.terrainQueueLength > 0 ||
		s.unloadedScheduled > 0 ||
		// Multiplayer: chunks waiting on the server are pending work even though
		// they never enter loadQueue or the local worker pool.
		(s.remoteEnabled && (s.remoteTaskQueue > 0 || s.remotePending > 0))
	);
}

function completedWork(s: StreamingSnapshot): number {
	return s.totalLoaded + s.totalGenerated + s.totalHydrated + s.totalUnloaded;
}

function describeMemory(): string {
	const mem = (
		performance as unknown as {
			memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
		}
	).memory;
	if (!mem) return "n/a";
	const mib = (b: number) => (b / 1048576).toFixed(0);
	return `${mib(mem.usedJSHeapSize)}/${mib(mem.jsHeapSizeLimit)} MiB`;
}

/**
 * Watches the streaming pipeline and reports the moment it stops making
 * progress despite having work queued.
 *
 * Why this exists: every "chunks stopped loading" failure mode looked like the
 * same symptom from the outside — spawn is fine, then a while later nothing
 * new appears — and they have completely different root causes (parked
 * scheduler await, drained worker pool, orphan chunks, culling). Guessing from
 * the symptom is unreliable; this captures the actual internal state at the
 * moment of the stall and prints it, so the cause is identifiable from one
 * report.
 *
 * It is a pure observer: it reads counters and logs, and never mutates
 * streaming state.
 */
export class StreamingWatchdog {
	private source: StreamingSnapshotSource = noopSource;
	private lastSampleMs = -Infinity;
	private lastCompletedWork = 0;
	private stallSamples = 0;
	private reportedForStreak = false;

	/** Set to false to mute (e.g. while intentionally paused). */
	public enabled = true;

	/** Last captured snapshot, retained for the HUD and manual dumps. */
	public lastSnapshot: StreamingSnapshot | null = null;

	public attach(source: StreamingSnapshotSource): void {
		this.source = source;
	}

	/** Call once per frame from the streaming tick. Cost is one timestamp compare. */
	public tick(nowMs: number): void {
		if (!this.enabled) return;

		if (nowMs - this.lastSampleMs < SAMPLE_INTERVAL_MS) return;

		// Skip the first sample so the counters have a previous value to differ from.
		if (this.lastSnapshot === null) {
			this.lastSampleMs = nowMs;
			this.lastSnapshot = this.source();
			this.lastCompletedWork = completedWork(this.lastSnapshot);
			return;
		}

		this.lastSampleMs = nowMs;

		const snapshot = this.source();
		this.lastSnapshot = snapshot;

		const done = completedWork(snapshot);
		const madeProgress = done !== this.lastCompletedWork;
		this.lastCompletedWork = done;

		// A parked scheduler with pending work is the loudest signal: the pump
		// itself is stuck rather than merely idle.
		const schedulerWedged =
			snapshot.schedulerProcessing && hasPendingDemand(snapshot);

		if (madeProgress || !hasPendingDemand(snapshot) || schedulerWedged) {
			this.stallSamples = 0;
			this.reportedForStreak = false;
			return;
		}

		// Nothing completed while work is queued AND workers are available.
		// (If idleWorkers were 0 the workers would be the bottleneck, which the
		// dump below makes obvious.)
		this.stallSamples++;

		if (
			this.stallSamples >= STALL_SAMPLE_THRESHOLD &&
			!this.reportedForStreak
		) {
			this.reportedForStreak = true;
			this.report(snapshot, this.stallSamples * (SAMPLE_INTERVAL_MS / 1000));
		}
	}

	/** Log a full dump immediately, regardless of stall state. */
	public report(snapshot: StreamingSnapshot, elapsedSeconds?: number): void {
		const s = snapshot;

		const lines = [
			`=== CHUNK STREAMING ${elapsedSeconds === undefined ? "DIAGNOSTIC" : `STALLED for ${elapsedSeconds.toFixed(0)}s`} ===`,
			`demand      : loadQueue=${s.loadQueueLength} unloadQueue=${s.unloadQueueLength} terrainQ=${s.terrainQueueLength} desiredStates=${s.desiredStateCount}`,
			`supply      : scheduler=${s.schedulerProcessing ? "PARKED" : "idle"} stage=${s.schedulerStage} [${s.schedulerProgress}]`,
			`             workers idle=${s.idleWorkers}/${s.workerCount}`,
			`population  : instances=${s.chunkInstances} loaded=${s.loadedChunks}` +
				` (voxels=${s.loadedWithVoxels} noVoxels=${s.loadedWithoutVoxels})` +
				` unloaded+Scheduled=${s.unloadedScheduled}`,
			`output(total): loaded=${s.totalLoaded} generated=${s.totalGenerated}` +
				` hydrated=${s.totalHydrated} unloaded=${s.totalUnloaded}`,
			s.remoteEnabled
				? `remote (MP) : taskQueue=${s.remoteTaskQueue} pending=${s.remotePending}/${s.remotePendingCap} parked=${s.remoteParked}`
				: `remote (MP) : disabled`,
			`heap        : ${describeMemory()}`,
			`--- read this ---`,
		];

		if (s.remoteEnabled) {
			if (s.remotePendingCap > 0 && s.remotePending >= s.remotePendingCap) {
				lines.push(
					`  REMOTE PUMP IS SHUT: pending=${s.remotePending} has hit the ` +
						`MAX_OUTSTANDING_REMOTE cap (${s.remotePendingCap}). Every pump ` +
						`bails on backpressure, so NO further chunk can be requested. ` +
						`Entries here are requests whose settlement callback never fired.`,
				);
			}
			if (s.remoteTaskQueue > 0 && s.remotePending >= s.remotePendingCap) {
				lines.push(
					`  ${s.remoteTaskQueue} chunk(s) are queued for the server but ` +
						`cannot be sent because the pending set is saturated.`,
				);
			}
			if (s.remoteParked > 0) {
				lines.push(
					`  ${s.remoteParked} chunk(s) parked after MAX_REMOTE_RETRY; ` +
						`they retry on a backoff timer.`,
				);
			}
			if (s.totalLoaded === 0 && s.totalGenerated === 0) {
				lines.push(
					`  NOTHING has ever been loaded or generated from the server -> ` +
						`the chunk data path is not completing at all (transport, ` +
						`join, or request rejection). Check the console for ` +
						`[RemoteGen] / [RemoteChunkProvider] errors.`,
				);
			}
		}

		lines.push(
			s.schedulerProcessing
				? `  scheduler is PARKED mid-stage "${s.schedulerStage}" [${s.schedulerProgress}]` +
						` -> an await never settled (storage). Progress above shows where.`
				: `  scheduler is IDLE and was offered no work -> the queue is empty or every entry was dropped.`,
			s.loadQueueLength > 0 && s.idleWorkers > 0
				? `  loadQueue has ${s.loadQueueLength} entries and ${s.idleWorkers} idle workers, yet nothing` +
						` completes -> requests are being dequeued and discarded (revision/LOD mismatch).`
				: `  (no actionable local load pressure: loadQueue=${s.loadQueueLength}, idle=${s.idleWorkers})`,
			s.loadedWithoutVoxels > 0
				? `  ${s.loadedWithoutVoxels} loaded chunks have NO voxel data -> hydration stalled.`
				: `  no chunk is stuck un-hydrated.`,
			s.unloadedScheduled > 0
				? `  ${s.unloadedScheduled} chunks are isTerrainScheduled but NOT loaded and NOT queued ->` +
						` orphans; nothing will ever revisit them.`
				: `  no orphaned chunks.`,
		);

		console.warn(lines.join("\n"));
	}
}

/** Count every chunk-state shape the stall report needs, in one pass. */
export function surveyChunkStates(): {
	chunkInstances: number;
	loadedChunks: number;
	loadedWithVoxels: number;
	loadedWithoutVoxels: number;
	unloadedScheduled: number;
} {
	let chunkInstances = 0;
	let loadedChunks = 0;
	let loadedWithVoxels = 0;
	let loadedWithoutVoxels = 0;
	let unloadedScheduled = 0;

	for (const chunk of Chunk.chunkInstances.values()) {
		chunkInstances++;

		if (chunk.isLoaded) {
			loadedChunks++;
			if (chunk.hasVoxelData) loadedWithVoxels++;
			else loadedWithoutVoxels++;
		} else if (chunk.isTerrainScheduled) {
			unloadedScheduled++;
		}
	}

	return {
		chunkInstances,
		loadedChunks,
		loadedWithVoxels,
		loadedWithoutVoxels,
		unloadedScheduled,
	};
}

/** Worker-pool counts used by the stall report. */
export function surveyWorkerPool(): {
	idleWorkers: number;
	workerCount: number;
	terrainQueueLength: number;
} {
	const stats = ChunkWorkerPool.getInstance().getDebugStats();
	return {
		idleWorkers: stats.idleWorkers,
		workerCount: stats.workerCount,
		terrainQueueLength: stats.terrainQueueLength,
	};
}
