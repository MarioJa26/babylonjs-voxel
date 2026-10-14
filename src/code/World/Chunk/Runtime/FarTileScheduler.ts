// ---------------------------------------------------------------------------
// FarTileScheduler: far-tile (LOD6+) request queue (extracted from
// ChunkWorkerPool — Step 3b-iii).
//
// Owns the FIFO queue + consume index + in-flight count + request-id counter.
// The pool keeps the completion callback (onFarTileGenerated) and the worker
// dispatch itself; this class only tracks what is queued, what was handed
// out, and what has settled.
// ---------------------------------------------------------------------------
import type { GenerateFarTileRequest } from "../DataStructures/WorkerMessageType";

export type FarTileTask = Omit<GenerateFarTileRequest, "type">;

export class FarTileScheduler {
	private queue: FarTileTask[] = [];
	private readIdx = 0;
	private inFlight = 0;
	private nextRequestId = 1;
	readonly maxInFlight = 3;

	get hasPending(): boolean {
		return this.readIdx < this.queue.length;
	}

	get canDispatch(): boolean {
		return this.hasPending && this.inFlight < this.maxInFlight;
	}

	get inFlightCount(): number {
		return this.inFlight;
	}

	schedule(levelIndex: number, tileX: number, tileZ: number): number {
		const requestId = this.nextRequestId++;
		this.queue.push({ requestId, levelIndex, tileX, tileZ });
		return requestId;
	}

	reset(): void {
		this.queue.length = 0;
		this.readIdx = 0;
	}

	/**
	 * Dequeue the next task if a dispatch slot is free. Returns undefined
	 * when empty or at the in-flight cap (caller `continue`s / skips).
	 * Mirrors the pool's old `queue[readIdx++]` selection arm.
	 */
	tryDequeue(): FarTileTask | undefined {
		if (!this.canDispatch) return undefined;
		return this.queue[this.readIdx++];
	}

	/** Called when a dequeued task is handed to a worker. */
	markDispatched(): void {
		this.inFlight++;
	}

	/** Called on worker result or worker failure. Floors at zero. */
	markCompleted(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
	}

	/**
	 * Periodic compaction: drop the consumed queue prefix when it exceeds
	 * half the array. Returns true when a compaction ran (caller breaks out
	 * of the dispatch loop, matching the old selection-chain arm).
	 */
	compactIfNeeded(): boolean {
		if (this.readIdx > 64 && this.readIdx * 2 >= this.queue.length) {
			this.queue.copyWithin(0, this.readIdx);
			this.queue.length -= this.readIdx;
			this.readIdx = 0;
			return true;
		}
		return false;
	}
}
