// ---------------------------------------------------------------------------
// DispatchAccounting: per-worker dispatch counters (extracted from
// ChunkWorkerPool — Step 3a of the God-class split).
//
// Owns the per-worker dispatch counts, the recent-dispatch ring, and the
// last-tick / total dispatch tallies. The pool keeps all other debug counters;
// this class only tracks who was dispatched when.
// ---------------------------------------------------------------------------
import { RingBuffer } from "../DataStructures/RingBuffer";

export class DispatchAccounting {
	private counts: number[] = [];
	private ring: RingBuffer<number>;
	private lastCount = 0;
	private totalCount = 0;

	constructor(ringSize = 24) {
		this.ring = new RingBuffer<number>(ringSize);
	}

	/** Called once per constructed worker to keep counts aligned by index. */
	addWorker(): void {
		this.counts.push(0);
	}

	record(workerIndex: number): void {
		if (workerIndex < 0) return;
		while (this.counts.length <= workerIndex) {
			this.counts.push(0);
		}
		this.counts[workerIndex]++;
		this.ring.push(workerIndex);
	}

	/** End-of-tick bookkeeping: last-tick count + running total. */
	commitTick(dispatchedThisTick: number): void {
		this.lastCount = dispatchedThisTick;
		this.totalCount += dispatchedThisTick;
	}

	get lastDispatchCount(): number {
		return this.lastCount;
	}

	get totalDispatchCount(): number {
		return this.totalCount;
	}

	copyCountsInto(dst: number[]): void {
		dst.length = 0;
		for (let i = 0; i < this.counts.length; i++) dst.push(this.counts[i]);
	}

	copyRecentInto(dst: number[]): void {
		this.ring.forEachInto(dst);
	}
}
