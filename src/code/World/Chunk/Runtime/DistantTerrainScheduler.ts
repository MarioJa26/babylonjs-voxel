// ---------------------------------------------------------------------------
// DistantTerrainScheduler: distant-terrain request queue + in-flight guard +
// worker readiness + request ids (extracted from ChunkWorkerPool).
//
// Only one distant-terrain build runs at a time (inFlight). Scheduling a new
// request while one is in flight truncates everything after the consume index
// so the newest request wins; a request scheduled while idle clears the whole
// queue first. Worker readiness tracks InitDistantTerrainShared replies per
// worker index.
// ---------------------------------------------------------------------------
import type { DistantTerrainTask } from "../DataStructures/WorkerMessageType";

export class DistantTerrainScheduler {
	private queue: DistantTerrainTask[] = [];
	private readIdx = 0;
	private inFlight = false;
	private readyWorkers = new Set<number>();
	private workerIndex = 0;
	private nextRequestId = 1;
	private latestRequestId = 0;

	get hasPending(): boolean {
		return this.readIdx < this.queue.length;
	}

	get pendingCount(): number {
		return this.queue.length - this.readIdx;
	}

	get isInFlight(): boolean {
		return this.inFlight;
	}

	get latestId(): number {
		return this.latestRequestId;
	}

	get assignedWorker(): number {
		return this.workerIndex;
	}

	setWorkerIndex(index: number): void {
		this.workerIndex = index;
	}

	schedule(
		centerChunkX: number,
		centerChunkZ: number,
		radius: number,
		renderDistance: number,
		gridStep: number,
	): number {
		const requestId = this.nextRequestId++;
		this.latestRequestId = requestId;
		const task: DistantTerrainTask = {
			requestId,
			centerChunkX,
			centerChunkZ,
			radius,
			renderDistance,
			gridStep,
		};
		const readIndex = this.inFlight ? this.readIdx : 0;
		this.queue.length = readIndex;
		this.readIdx = readIndex;
		this.queue.push(task);
		return requestId;
	}

	/** Newest request wins — drop everything queued. */
	invalidate(): void {
		this.latestRequestId = 0;
	}

	takeNext(): DistantTerrainTask | undefined {
		if (this.readIdx >= this.queue.length) return undefined;
		return this.queue[this.readIdx++];
	}

	/** Rewind one slot (dispatch aborted: worker not ready/idle). */
	releaseBack(): void {
		if (this.readIdx > 0) this.readIdx--;
	}

	/** Failure path: slot-restore when possible, else requeue at the back. */
	pushBack(task: DistantTerrainTask): void {
		if (this.readIdx > 0) {
			this.readIdx--;
			this.queue[this.readIdx] = task;
		} else {
			this.queue.push(task);
		}
	}

	markInFlight(): void {
		this.inFlight = true;
	}

	clearInFlight(): void {
		this.inFlight = false;
	}

	markReady(workerIndex: number): void {
		this.readyWorkers.add(workerIndex);
	}

	unmark(workerIndex: number): void {
		this.readyWorkers.delete(workerIndex);
	}

	clearReady(): void {
		this.readyWorkers.clear();
	}

	isWorkerReady(workerIndex: number): boolean {
		return this.readyWorkers.has(workerIndex);
	}
}
