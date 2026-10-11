/**
 * ChunkWorkerPool.ts — Manages a pool of Node.js worker threads for parallel
 * chunk generation. Handles task queuing, worker lifecycle, and crash recovery.
 */

import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { detectPhysicalCores } from "./PhysicalCores";
import { PendingTaskKindType } from "./workerProtocol.ts";

interface ChunkResult {
	blocks: Uint8Array | Uint16Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
}

type ChunkCoord = {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
};

type PendingTask =
	| {
			id: number;
			kind: PendingTaskKindType.SINGLE;
			chunkX: number;
			chunkY: number;
			chunkZ: number;
			priority: TaskPriority;
			resolve: (result: ChunkResult) => void;
			reject: (error: Error) => void;
	  }
	| {
			id: number;
			kind: PendingTaskKindType.BATCH;
			coords: ChunkCoord[];
			priority: TaskPriority;
			resolve: (results: ChunkResult[]) => void;
			reject: (error: Error) => void;
	  }
	| {
			id: number;
			kind: PendingTaskKindType.RELIGHT;
			chunkX: number;
			chunkY: number;
			chunkZ: number;
			priority: TaskPriority;
			blocks: Uint8Array | Uint16Array;
			topSunlightMask?: Uint8Array;
			neighborLight?: (Uint8Array | null)[];
			resolve: (light: Uint8Array) => void;
			reject: (error: Error) => void;
	  };

type WorkerMessage =
	| {
			id: number;
			kind: PendingTaskKindType.SINGLE;
			blocks: Uint8Array | Uint16Array;
			light: Uint8Array;
			palette?: number[];
			isUniform: boolean;
			uniformBlockId: number;
	  }
	| {
			id: number;
			kind: PendingTaskKindType.BATCH;
			items: ChunkResult[];
	  }
	| {
			id: number;
			light: Uint8Array;
	  }
	| {
			id: number;
			error: string;
	  };

interface WorkerState {
	worker: Worker;
	busy: boolean;
	activeTaskId?: number;
	disposed?: boolean;
}

const filename = fileURLToPath(import.meta.url);
const workerPath = join(dirname(filename), "chunkWorkerBootstrap.mjs");

function pendingTaskKindLabel(kind: PendingTaskKindType): string {
	switch (kind) {
		case PendingTaskKindType.SINGLE:
			return "single";
		case PendingTaskKindType.BATCH:
			return "batch";
		case PendingTaskKindType.RELIGHT:
			return "relight";
		default:
			return "unknown";
	}
}

/**
 * Worker queue priority tiers.
 *
 * PERFORMANCE / FAIRNESS.
 *
 * This pool used to be a single FIFO. The consequence was that the 637-chunk
 * spawn prewarm — enqueued during `onCreate`, before any player exists — sat
 * in front of every chunk a joining player asks for. A player who joined while
 * prewarm was still draining queued behind the whole tail of it.
 *
 * Tiers let interactive work jump the queue. Within a tier, FIFO is preserved
 * so equal-priority work stays fair and the batch grouping in dispatchAll still
 * sees similar work close together.
 *
 * A frozen object rather than a `const enum` so the value crosses the
 * module boundary to ChunkGenerationService under isolatedModules builds.
 */
export const TaskPriority = {
	/** A player is waiting for this chunk right now. Always served first. */
	Interactive: 0,
	/** Background warming (spawn prewarm). Never delays an interactive task. */
	Background: 1,
	/** Speculative/exploratory. Only runs when the pool would otherwise idle. */
	Speculative: 2,
} as const;

export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

function priorityTierName(tier: TaskPriority): string {
	switch (tier) {
		case TaskPriority.Interactive:
			return "interactive";
		case TaskPriority.Background:
			return "background";
		default:
			return "speculative";
	}
}

/**
 * Resolve the chunk-generation worker thread count.
 *
 * PHYSICAL CORES, NOT LOGICAL THREADS. `cpus().length` reports hardware
 * threads, which is 2x physical cores on any SMT machine. Sizing a CPU-bound
 * pool from that oversubscribes: N threads on N/2 physical cores run slower
 * than N/2 threads on N/2 cores, because SMT siblings contend for the same
 * execution resources. The old `Math.min(8, cpus().length - 1)` produced 8
 * workers on a 6-core Ryzen — measurably worse than 6.
 *
 * One core is reserved for the main thread, which is the most
 * latency-sensitive thread in the process (20 Hz tick, mob/water simulation,
 * blob deflate, LevelDB write pump). Chunk generation is a background
 * workload and must never starve it.
 *
 * `override` > 0 wins outright. Use it when co-locating this server with the
 * game client on one box and leaving it roughly half the physical cores.
 */
export function resolvePoolSize(override = 0): number {
	const requested = Math.floor(override);
	if (Number.isFinite(requested) && requested > 0) {
		return Math.max(1, requested);
	}

	const physical = detectPhysicalCores(cpus().length);
	const budget = Math.max(1, physical - 1);

	return Math.max(1, budget);
}

export class ChunkWorkerPool {
	private workers: WorkerState[] = [];
	private readonly workerByInstance = new Map<Worker, WorkerState>();

	/*
	 * Per-tier FIFO queues drained in priority order. `queueStart` makes dequeue
	 * O(1) per tier; dispatched entries are released periodically by
	 * compactQueueIfNeeded().
	 *
	 * Three queues instead of one because interactive work must be able to jump
	 * ahead of the 637-chunk spawn prewarm that runs at room creation — under a
	 * single FIFO a joining player queued behind the entire prewarm tail.
	 */
	private queues: PendingTask[][] = [[], [], []];
	private queueStarts: number[] = [0, 0, 0];

	/**
	 * Hard cap on queued (not yet dispatched) tasks.
	 *
	 * The queue used to be unbounded and `pendingCount` was exported but never
	 * read, so a client that walked away from unexplored terrain left its
	 * chunks queued to be generated — and written to disk — for nothing. Bounding
	 * it makes overload visible and sheddable instead of silently unbounded.
	 */
	private static readonly MAX_QUEUED_TASKS = 512;
	private droppedTaskCount = 0;

	private readonly pendingTasks = new Map<number, PendingTask>();

	private nextId = 1;
	private seed = "default";
	private wasmEnabled = true;
	private poolSizeOverride = 0;
	private initialized = false;
	private terminated = false;

	/**
	 * Max chunks per column to send to a single worker. Larger columns are split
	 * across workers so bulk generation can use all workers in parallel while
	 * still keeping adjacent Y-levels together for column-cache hits.
	 */
	private static readonly MAX_COLUMN_GROUP_SIZE = 4;

	async initialize(
		seed: string,
		wasmEnabled = true,
		poolSizeOverride = 0,
	): Promise<void> {
		if (this.initialized) {
			if (
				seed !== this.seed ||
				wasmEnabled !== this.wasmEnabled ||
				poolSizeOverride !== this.poolSizeOverride
			) {
				this.seed = seed;
				this.wasmEnabled = wasmEnabled;
				this.poolSizeOverride = poolSizeOverride;
				await this.recreateWorkers();
			}
			return;
		}

		this.terminated = false;
		this.seed = seed;
		this.wasmEnabled = wasmEnabled;
		this.poolSizeOverride = poolSizeOverride;

		const poolSize = resolvePoolSize(poolSizeOverride);
		const workers = new Array<WorkerState>(poolSize);

		for (let i = 0; i < poolSize; i++) {
			workers[i] = this.createWorkerState();
		}

		this.workers = workers;
		this.initialized = true;

		console.log(
			`[ChunkWorkerPool] ${poolSize} generation worker thread(s) ` +
				`(cpus() reports ${cpus().length} logical / ` +
				`${detectPhysicalCores(cpus().length)} physical` +
				`${poolSizeOverride > 0 ? `, override=${poolSizeOverride}` : ""})`,
		);
	}

	dispatch(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		priority: TaskPriority = TaskPriority.Interactive,
	): Promise<ChunkResult> {
		const unavailable = this.getUnavailableError();
		if (unavailable) {
			return Promise.reject(unavailable);
		}

		if (!this.tryReserveQueueSlot(priority)) {
			return Promise.reject(this.overflowError());
		}

		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			this.queues[priority].push({
				id,
				kind: PendingTaskKindType.SINGLE,
				chunkX,
				chunkY,
				chunkZ,
				priority,
				resolve,
				reject,
			});

			this.processQueue();
		});
	}

	/**
	 * Admit a task only if the queue has room.
	 *
	 * Interactive work is never shed — it is what a player is waiting on, and
	 * dropping it would leave a hole in the world. Background and speculative
	 * work is shed first, because it is by definition replaceable: the player
	 * will ask again when they get close.
	 */
	private tryReserveQueueSlot(priority: TaskPriority): boolean {
		if (this.queuedTaskCount < ChunkWorkerPool.MAX_QUEUED_TASKS) {
			return true;
		}

		if (priority === TaskPriority.Interactive) {
			// Still admit interactive work even when the queue is at the cap.
			// The cap exists to bound speculative memory growth, and a player
			// waiting on a chunk must never be refused because of one.
			return true;
		}

		this.droppedTaskCount++;
		return false;
	}

	private overflowError(): Error {
		return new Error(
			"Chunk worker pool queue is full — background generation shed under load",
		);
	}

	/** Tasks shed because the queue was full. Surfaced in logs for tuning. */
	get droppedTasks(): number {
		return this.droppedTaskCount;
	}

	dispatchAll(
		coords: ChunkCoord[],
		priority: TaskPriority = TaskPriority.Interactive,
	): Promise<ChunkResult[]> {
		const count = coords.length;

		if (count === 0) {
			return Promise.resolve([]);
		}

		const unavailable = this.getUnavailableError();
		if (unavailable) {
			return Promise.reject(unavailable);
		}

		const workerCount = this.workers.length;
		const maxGroupSize = ChunkWorkerPool.MAX_COLUMN_GROUP_SIZE;

		/*
		 * Keep numeric nested maps to avoid temporary string keys and coordinate
		 * collisions. Each leaf contains indices into the caller's coords array.
		 */
		const columnsByX = new Map<number, Map<number, number[]>>();

		for (let i = 0; i < count; i++) {
			const coord = coords[i];

			let columnsByZ = columnsByX.get(coord.chunkX);
			if (columnsByZ === undefined) {
				columnsByZ = new Map<number, number[]>();
				columnsByX.set(coord.chunkX, columnsByZ);
			}

			let indices = columnsByZ.get(coord.chunkZ);
			if (indices === undefined) {
				indices = [];
				columnsByZ.set(coord.chunkZ, indices);
			}

			indices.push(i);
		}

		/*
		 * Build final worker batches directly.
		 *
		 * The previous implementation first allocated:
		 *   - a groups array
		 *   - one object per group
		 *   - sliced index arrays for large columns
		 *   - an array of group arrays per worker
		 *
		 * None of those structures are needed. A column group can be assigned
		 * immediately to the least-loaded worker.
		 */
		const batches = new Array<ChunkCoord[] | undefined>(workerCount);
		const originalIndices = new Array<number[] | undefined>(workerCount);
		const workerLoads = new Uint32Array(workerCount);

		for (const columnsByZ of columnsByX.values()) {
			for (const indices of columnsByZ.values()) {
				const columnLength = indices.length;

				if (columnLength > 1) {
					indices.sort(
						(left, right) => coords[left].chunkY - coords[right].chunkY,
					);
				}

				for (
					let groupStart = 0;
					groupStart < columnLength;
					groupStart += maxGroupSize
				) {
					const groupEnd = Math.min(groupStart + maxGroupSize, columnLength);
					const groupLength = groupEnd - groupStart;

					let targetWorker = 0;
					let minimumLoad = workerLoads[0];

					for (let workerIndex = 1; workerIndex < workerCount; workerIndex++) {
						const load = workerLoads[workerIndex];

						if (load < minimumLoad) {
							minimumLoad = load;
							targetWorker = workerIndex;
						}
					}

					let batch = batches[targetWorker];
					if (batch === undefined) {
						batch = [];
						batches[targetWorker] = batch;
					}

					let batchIndices = originalIndices[targetWorker];
					if (batchIndices === undefined) {
						batchIndices = [];
						originalIndices[targetWorker] = batchIndices;
					}

					for (let position = groupStart; position < groupEnd; position++) {
						const originalIndex = indices[position];
						const coord = coords[originalIndex];

						/*
						 * Preserve the original snapshot behavior. Keeping the
						 * caller's object reference would allow mutations after
						 * dispatchAll() to alter a queued worker request.
						 */
						batch.push({
							chunkX: coord.chunkX,
							chunkY: coord.chunkY,
							chunkZ: coord.chunkZ,
						});

						batchIndices.push(originalIndex);
					}

					workerLoads[targetWorker] += groupLength;
				}
			}
		}

		/*
		 * Release the temporary column maps before asynchronous work begins.
		 * This does not force garbage collection, but it shortens reachability.
		 */
		columnsByX.clear();

		const results = new Array<ChunkResult>(count);
		const dispatches: Promise<void>[] = [];

		for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
			const batch = batches[workerIndex];
			if (batch === undefined) {
				continue;
			}

			const batchIndices = originalIndices[workerIndex]!;

			dispatches.push(
				this._dispatchBatch(batch, priority).then((batchResults) => {
					for (let i = 0; i < batchResults.length; i++) {
						results[batchIndices[i]] = batchResults[i];
					}
				}),
			);
		}

		/*
		 * Results are written directly into their final positions. This avoids
		 * Promise.all retaining a second nested array of all batch results for a
		 * separate flattening pass.
		 */
		return Promise.all(dispatches).then(() => results);
	}

	postRelight(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array | Uint16Array,
		topSunlightMask?: Uint8Array,
		neighborLight?: ReadonlyArray<Uint8Array | null>,
	): Promise<Uint8Array> {
		const unavailable = this.getUnavailableError();
		if (unavailable) {
			return Promise.reject(unavailable);
		}

		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			// Relight is triggered by a live block edit, so it is interactive work:
			// the player is looking at the change they just made.
			this.queues[TaskPriority.Interactive].push({
				id,
				kind: PendingTaskKindType.RELIGHT,
				chunkX,
				chunkY,
				chunkZ,
				priority: TaskPriority.Interactive,
				blocks,
				topSunlightMask,

				/*
				 * Preserve the original snapshot of the outer array. The typed
				 * arrays themselves are intentionally not copied.
				 */
				neighborLight: neighborLight
					? Array.prototype.slice.call(neighborLight)
					: undefined,

				resolve,
				reject,
			});

			this.processQueue();
		});
	}

	async terminate(): Promise<void> {
		if (this.terminated) {
			return;
		}

		this.terminated = true;
		this.rejectAllWork(new Error("Chunk worker pool terminated"));

		const workers = this.workers;

		for (let i = 0; i < workers.length; i++) {
			workers[i].disposed = true;
		}

		const terminations = new Array<Promise<number>>(workers.length);

		for (let i = 0; i < workers.length; i++) {
			terminations[i] = workers[i].worker.terminate();
		}

		await Promise.all(terminations);

		this.workers = [];
		this.workerByInstance.clear();
		this.initialized = false;
	}

	get pendingCount(): number {
		return this.queuedTaskCount + this.pendingTasks.size;
	}

	private _dispatchBatch(
		coords: ChunkCoord[],
		priority: TaskPriority = TaskPriority.Interactive,
	): Promise<ChunkResult[]> {
		const unavailable = this.getUnavailableError();
		if (unavailable) {
			return Promise.reject(unavailable);
		}

		if (!this.tryReserveQueueSlot(priority)) {
			return Promise.reject(this.overflowError());
		}

		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			this.queues[priority].push({
				id,
				kind: PendingTaskKindType.BATCH,
				coords,
				priority,
				resolve,
				reject,
			});

			this.processQueue();
		});
	}

	private createWorkerState(): WorkerState {
		const worker = new Worker(workerPath);
		const state: WorkerState = {
			worker,
			busy: false,
		};

		worker.on("message", (message: WorkerMessage) => {
			this.handleWorkerMessage(worker, message);
		});

		worker.on("error", (error) => {
			console.error("[ChunkWorkerPool] Worker error:", error);
			this.recoverWorker(worker);
		});

		worker.on("exit", (code) => {
			const currentState = this.workerByInstance.get(worker);
			if (currentState?.disposed) {
				return;
			}

			if (code !== 0) {
				console.error(`[ChunkWorkerPool] Worker exited with code ${code}`);
				this.recoverWorker(worker);
			}
		});

		this.workerByInstance.set(worker, state);
		return state;
	}

	private handleWorkerMessage(worker: Worker, message: WorkerMessage): void {
		const state = this.workerByInstance.get(worker);

		/*
		 * Ignore stale messages from a worker that was already recovered or
		 * intentionally disposed.
		 */
		if (state === undefined || state.disposed) {
			return;
		}

		state.busy = false;
		state.activeTaskId = undefined;

		const task = this.pendingTasks.get(message.id);

		if (task === undefined) {
			this.processQueue();
			return;
		}

		this.pendingTasks.delete(message.id);

		if ("error" in message) {
			const queueDepth = this.queuedTaskCount;

			console.error(
				`[ChunkWorkerPool] worker error ` +
					`(task ${pendingTaskKindLabel(task.kind)} ` +
					`${priorityTierName(task.priority)} id=${task.id}): ` +
					`${message.error} ` +
					`[pending=${this.pendingTasks.size} ` +
					`queued=${queueDepth} workers=${this.workers.length} ` +
					`dropped=${this.droppedTaskCount}]`,
			);

			task.reject(new Error(message.error));
		} else if (task.kind === PendingTaskKindType.RELIGHT) {
			if ("light" in message && !("kind" in message)) {
				task.resolve(message.light);
			} else {
				task.reject(new Error("Mismatched relight response"));
			}
		} else if (
			task.kind === PendingTaskKindType.SINGLE &&
			"kind" in message &&
			message.kind === PendingTaskKindType.SINGLE
		) {
			/*
			 * A new result object is retained here intentionally. Resolving with
			 * message directly would expose protocol-only id and kind fields and
			 * would therefore alter observable behavior.
			 */
			task.resolve({
				blocks: message.blocks,
				light: message.light,
				palette: message.palette,
				isUniform: message.isUniform,
				uniformBlockId: message.uniformBlockId,
			});
		} else if (
			task.kind === PendingTaskKindType.BATCH &&
			"kind" in message &&
			message.kind === PendingTaskKindType.BATCH
		) {
			task.resolve(message.items);
		} else {
			task.reject(new Error("Mismatched worker response"));
		}

		this.processQueue();
	}

	private processQueue(): void {
		if (this.terminated) {
			this.rejectQueued(new Error("Chunk worker pool terminated"));
			return;
		}

		for (;;) {
			let freeWorker: WorkerState | undefined;

			for (let i = 0; i < this.workers.length; i++) {
				const state = this.workers[i];

				if (!state.busy && !state.disposed) {
					freeWorker = state;
					break;
				}
			}

			if (freeWorker === undefined) {
				this.compactQueuesIfNeeded();
				return;
			}

			// Drain the highest-priority tier that has work. Idle capacity is
			// offered to the next tier down, so background work still fills a
			// pool that no interactive request is using.
			const task = this.takeNextTask();

			if (task === undefined) {
				this.compactQueuesIfNeeded();
				return;
			}

			freeWorker.busy = true;
			freeWorker.activeTaskId = task.id;
			this.pendingTasks.set(task.id, task);

			try {
				this.postTaskToWorker(freeWorker.worker, task);
			} catch (error) {
				freeWorker.busy = false;
				freeWorker.activeTaskId = undefined;
				this.pendingTasks.delete(task.id);

				task.reject(
					error instanceof Error
						? error
						: new Error(`Failed to post task to worker: ${String(error)}`),
				);
			}
		}
	}

	private postTaskToWorker(worker: Worker, task: PendingTask): void {
		if (task.kind === PendingTaskKindType.SINGLE) {
			worker.postMessage({
				id: task.id,
				kind: PendingTaskKindType.SINGLE,
				seed: this.seed,
				wasmEnabled: this.wasmEnabled,
				chunkX: task.chunkX,
				chunkY: task.chunkY,
				chunkZ: task.chunkZ,
			});

			return;
		}

		if (task.kind === PendingTaskKindType.RELIGHT) {
			const message = {
				id: task.id,
				chunkX: task.chunkX,
				chunkY: task.chunkY,
				chunkZ: task.chunkZ,
				blocks: task.blocks,
				topSunlightMask: task.topSunlightMask,
				neighborLight: task.neighborLight,
				seed: this.seed,
				wasmEnabled: this.wasmEnabled,
			};

			const buffer = task.blocks.buffer;

			/*
			 * Avoid allocating an empty transfer-list array for shared memory.
			 * Non-shared buffers retain the original transfer and detachment
			 * behavior.
			 */
			if (buffer instanceof SharedArrayBuffer) {
				worker.postMessage(message);
			} else {
				worker.postMessage(message, [buffer]);
			}

			return;
		}

		worker.postMessage({
			id: task.id,
			kind: PendingTaskKindType.BATCH,
			seed: this.seed,
			wasmEnabled: this.wasmEnabled,
			items: task.coords,
		});
	}

	private recoverWorker(deadWorker: Worker): void {
		const state = this.workerByInstance.get(deadWorker);

		if (state === undefined || state.disposed) {
			return;
		}

		const stateIndex = this.workers.indexOf(state);
		if (stateIndex < 0) {
			return;
		}

		state.disposed = true;
		this.workers.splice(stateIndex, 1);
		this.workerByInstance.delete(deadWorker);

		const activeTaskId = state.activeTaskId;

		if (activeTaskId !== undefined) {
			const task = this.pendingTasks.get(activeTaskId);

			if (task !== undefined) {
				this.pendingTasks.delete(activeTaskId);
				this.requeueFront(task);
			}
		}

		if (!this.terminated) {
			this.workers.push(this.createWorkerState());
			this.processQueue();
		}
	}

	private async recreateWorkers(): Promise<void> {
		this.rejectAllWork(new Error("Seed changed; chunk generation aborted"));

		const oldWorkers = this.workers;

		for (let i = 0; i < oldWorkers.length; i++) {
			oldWorkers[i].disposed = true;
		}

		const terminations = new Array<Promise<number>>(oldWorkers.length);

		for (let i = 0; i < oldWorkers.length; i++) {
			terminations[i] = oldWorkers[i].worker.terminate();
		}

		await Promise.all(terminations);

		this.workerByInstance.clear();

		const poolSize = resolvePoolSize(this.poolSizeOverride);
		const replacementWorkers = new Array<WorkerState>(poolSize);

		/*
		 * Assign the new array before creating workers so event-driven recovery
		 * always observes the current worker collection.
		 */
		this.workers = replacementWorkers;

		for (let i = 0; i < poolSize; i++) {
			replacementWorkers[i] = this.createWorkerState();
		}
	}

	private requeueFront(task: PendingTask): void {
		const tier = task.priority;
		const queue = this.queues[tier];
		const start = this.queueStarts[tier];

		if (start > 0) {
			this.queues[tier] = queue.slice(0, start);
			this.queues[tier].unshift(task);
			this.queueStarts[tier] = 0;
		} else {
			queue.unshift(task);
		}
	}

	/**
	 * Pop the next task, highest-priority tier first.
	 *
	 * Within a tier this is FIFO, which keeps dispatchAll's column grouping
	 * seeing similar work close together and stops one tenant from starving
	 * another at equal priority.
	 */
	private takeNextTask(): PendingTask | undefined {
		for (let tier = 0; tier < this.queues.length; tier++) {
			const start = this.queueStarts[tier];

			if (start < this.queues[tier].length) {
				const task = this.queues[tier][start];
				this.queueStarts[tier] = start + 1;
				return task;
			}
		}

		return undefined;
	}

	private get queuedTaskCount(): number {
		let total = 0;

		for (let tier = 0; tier < this.queues.length; tier++) {
			total += this.queues[tier].length - this.queueStarts[tier];
		}

		return total;
	}

	private rejectQueued(error: Error): void {
		for (let tier = 0; tier < this.queues.length; tier++) {
			const queue = this.queues[tier];
			const start = this.queueStarts[tier];

			for (let i = start; i < queue.length; i++) {
				queue[i].reject(error);
			}

			/*
			 * Replace the array rather than setting length to zero so a very
			 * large queue's backing storage can be reclaimed.
			 */
			this.queues[tier] = [];
			this.queueStarts[tier] = 0;
		}
	}

	private rejectAllWork(error: Error): void {
		this.rejectQueued(error);

		for (const task of this.pendingTasks.values()) {
			task.reject(error);
		}

		this.pendingTasks.clear();
	}

	private compactQueuesIfNeeded(): void {
		for (let tier = 0; tier < this.queues.length; tier++) {
			const start = this.queueStarts[tier];

			if (start === 0) continue;

			const queue = this.queues[tier];
			const length = queue.length;

			if (start >= length) {
				/*
				 * Replacing the array releases references and allows oversized
				 * backing storage to be reclaimed.
				 */
				this.queues[tier] = [];
				this.queueStarts[tier] = 0;
				continue;
			}

			/*
			 * Compact only after meaningful drift. slice() allocates one smaller
			 * array, but releases all references held by consumed queue slots.
			 */
			if (start > 1024 && start * 2 >= length) {
				this.queues[tier] = queue.slice(start);
				this.queueStarts[tier] = 0;
			}
		}
	}

	private getUnavailableError(): Error | null {
		if (this.terminated) {
			return new Error("Chunk worker pool terminated");
		}

		if (!this.initialized || this.workers.length === 0) {
			return new Error("Chunk worker pool not initialized");
		}

		return null;
	}
}
