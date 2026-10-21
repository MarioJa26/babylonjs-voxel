/**
 * ChunkWorkerPool.ts — Manages a pool of Node.js worker threads for parallel
 * chunk generation. Handles task queuing, worker lifecycle, priority tiers,
 * overload control, and crash recovery.
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
 * Interactive work is served before background work. Within each tier, FIFO
 * order is retained.
 */
export const TaskPriority = {
	/** A player is waiting for this chunk or relight operation. */
	Interactive: 0,

	/** Background warming, such as spawn-area pre-generation. */
	Background: 1,

	/** Speculative work that should only consume otherwise-idle capacity. */
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
 * Resolve the chunk-generation worker count.
 *
 * CPU-bound workers are sized from physical cores rather than logical CPUs.
 * One physical core is reserved for the latency-sensitive main thread.
 */
export function resolvePoolSize(override = 0): number {
	const requested = Math.floor(override);

	if (Number.isFinite(requested) && requested > 0) {
		return Math.max(1, requested);
	}

	const physical = detectPhysicalCores(cpus().length);
	return Math.max(1, physical - 1);
}

export class ChunkWorkerPool {
	private workers: WorkerState[] = [];

	private readonly workerByInstance = new Map<Worker, WorkerState>();

	/**
	 * Per-tier FIFO queues.
	 *
	 * queueStarts points at the first live entry in each queue, allowing normal
	 * dequeue operations to remain O(1).
	 */
	private queues: PendingTask[][] = [[], [], []];

	private queueStarts: number[] = [0, 0, 0];

	/**
	 * Soft queue cap.
	 *
	 * Replaceable background and speculative tasks are rejected after this
	 * threshold. Interactive tasks remain admitted so existing player-facing
	 * behavior is preserved.
	 */
	private static readonly MAX_QUEUED_TASKS = 512;

	private droppedTaskCount = 0;

	/**
	 * Tasks currently owned by workers and awaiting responses.
	 */
	private readonly pendingTasks = new Map<number, PendingTask>();

	private nextId = 1;

	private seed = "default";

	private wasmEnabled = true;

	private poolSizeOverride = 0;

	private initialized = false;

	private terminated = false;

	/**
	 * Maximum adjacent Y-levels from one column sent together to one worker.
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

		const logicalCores = cpus().length;
		const physicalCores = detectPhysicalCores(logicalCores);

		console.log(
			`[ChunkWorkerPool] ${poolSize} generation worker thread(s) ` +
				`(cpus() reports ${logicalCores} logical / ` +
				`${physicalCores} physical` +
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

		const id = this.allocateTaskId();

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
	 * Admit a task if the relevant overload policy permits it.
	 *
	 * Interactive work preserves the original non-shedding behavior. Background
	 * and speculative work are rejected once the queued-task cap is reached.
	 */
	private tryReserveQueueSlot(priority: TaskPriority): boolean {
		if (this.queuedTaskCount < ChunkWorkerPool.MAX_QUEUED_TASKS) {
			return true;
		}

		if (priority === TaskPriority.Interactive) {
			return true;
		}

		this.droppedTaskCount++;
		return false;
	}

	private overflowError(): Error {
		return new Error(
			"Chunk worker pool queue is full; background generation was shed under load",
		);
	}

	/** Number of replaceable tasks rejected due to queue pressure. */
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
		 * Group coordinate indices by X/Z column. Numeric nested maps avoid
		 * coordinate-string construction and accidental string collisions.
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
						 * Snapshot coordinates so later caller mutations cannot
						 * alter a queued worker request.
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
					if (batchResults.length !== batchIndices.length) {
						throw new Error(
							"Chunk worker returned an unexpected batch result count",
						);
					}

					for (let i = 0; i < batchResults.length; i++) {
						results[batchIndices[i]] = batchResults[i];
					}
				}),
			);
		}

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

		const priority = TaskPriority.Interactive;

		if (!this.tryReserveQueueSlot(priority)) {
			return Promise.reject(this.overflowError());
		}

		const id = this.allocateTaskId();

		return new Promise((resolve, reject) => {
			this.queues[priority].push({
				id,
				kind: PendingTaskKindType.RELIGHT,
				chunkX,
				chunkY,
				chunkZ,
				priority,
				blocks,
				topSunlightMask,

				/*
				 * Snapshot the outer array. Typed-array buffers are intentionally
				 * retained without copying.
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

		const id = this.allocateTaskId();

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

	/**
	 * Allocate a safe task ID.
	 *
	 * Reaching MAX_SAFE_INTEGER is practically unlikely, but wrapping avoids
	 * producing imprecise numeric Map keys in a long-running process.
	 */
	private allocateTaskId(): number {
		for (;;) {
			const id = this.nextId;

			this.nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;

			if (!this.taskIdInUse(id)) {
				return id;
			}
		}
	}

	private taskIdInUse(id: number): boolean {
		if (this.pendingTasks.has(id)) {
			return true;
		}

		for (let tier = 0; tier < this.queues.length; tier++) {
			const queue = this.queues[tier];

			for (let i = this.queueStarts[tier]; i < queue.length; i++) {
				if (queue[i].id === id) {
					return true;
				}
			}
		}

		return false;
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

			/*
			 * Even a zero-code exit is unexpected unless the worker was explicitly
			 * disposed. Recover it so pool capacity is not silently reduced.
			 */
			if (code !== 0) {
				console.error(`[ChunkWorkerPool] Worker exited with code ${code}`);
			} else {
				console.error(
					"[ChunkWorkerPool] Worker exited unexpectedly with code 0",
				);
			}

			this.recoverWorker(worker);
		});

		this.workerByInstance.set(worker, state);

		return state;
	}

	private handleWorkerMessage(worker: Worker, message: WorkerMessage): void {
		const state = this.workerByInstance.get(worker);

		/*
		 * Ignore stale messages from workers that were recovered or intentionally
		 * disposed.
		 */
		if (state === undefined || state.disposed) {
			return;
		}

		const activeTaskId = state.activeTaskId;

		/*
		 * A worker must only answer the task currently assigned to it. Ignoring a
		 * mismatched response prevents an old or malformed response from marking
		 * the worker idle while its real task remains active.
		 */
		if (activeTaskId === undefined || message.id !== activeTaskId) {
			console.warn(
				`[ChunkWorkerPool] Ignoring stale worker response id=${message.id}; ` +
					`active=${activeTaskId ?? "none"}`,
			);
			return;
		}

		const task = this.pendingTasks.get(message.id);

		state.busy = false;
		state.activeTaskId = undefined;

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

		const workers = this.workers;
		const pendingTasks = this.pendingTasks;

		/*
		 * Walk workers once. This avoids repeatedly searching from workers[0]
		 * while filling multiple idle workers.
		 */
		for (let workerIndex = 0; workerIndex < workers.length; workerIndex++) {
			const state = workers[workerIndex];

			if (state.busy || state.disposed) {
				continue;
			}

			/*
			 * Repeat only when postMessage throws synchronously. That allows this
			 * still-idle worker to attempt another queued task immediately.
			 */
			for (;;) {
				const task = this.takeNextTask();

				if (task === undefined) {
					this.compactQueuesIfNeeded();
					return;
				}

				state.busy = true;
				state.activeTaskId = task.id;
				pendingTasks.set(task.id, task);

				try {
					this.postTaskToWorker(state.worker, task);

					// The worker now owns one task.
					break;
				} catch (error: unknown) {
					state.busy = false;
					state.activeTaskId = undefined;
					pendingTasks.delete(task.id);

					task.reject(
						error instanceof Error
							? error
							: new Error(`Failed to post task to worker: ${String(error)}`),
					);
				}
			}
		}

		this.compactQueuesIfNeeded();
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
			 * SharedArrayBuffer cannot be transferred. Normal ArrayBuffer-backed
			 * typed arrays retain the existing transfer-and-detach behavior.
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

		/*
		 * Mark disposed before terminate() so a later exit event cannot trigger a
		 * second recovery.
		 */
		state.disposed = true;

		this.workers.splice(stateIndex, 1);
		this.workerByInstance.delete(deadWorker);

		const activeTaskId = state.activeTaskId;

		state.activeTaskId = undefined;
		state.busy = false;

		if (activeTaskId !== undefined) {
			const task = this.pendingTasks.get(activeTaskId);

			if (task !== undefined) {
				this.pendingTasks.delete(activeTaskId);

				/*
				 * A relight request transfers its blocks buffer to the worker.
				 * If the worker failed after transfer, the main-thread buffer is
				 * detached and cannot safely be retried.
				 */
				if (
					task.kind === PendingTaskKindType.RELIGHT &&
					!(task.blocks.buffer instanceof SharedArrayBuffer) &&
					task.blocks.buffer.byteLength === 0
				) {
					task.reject(
						new Error(
							"Relight worker failed after its block buffer was transferred",
						),
					);
				} else {
					this.requeueFront(task);
				}
			}
		}

		/*
		 * On an exit event this is harmless. On an error event it ensures the
		 * failed worker does not remain alive after removal from the pool.
		 */
		void deadWorker.terminate().catch(() => {
			// The worker may already have exited.
		});

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

		this.workers = replacementWorkers;

		for (let i = 0; i < poolSize; i++) {
			replacementWorkers[i] = this.createWorkerState();
		}
	}

	/**
	 * Put a recovered task at the front of its existing priority tier.
	 *
	 * The consumed slot immediately before queueStart is reused. This is O(1),
	 * preserves the queued suffix, and prevents already-consumed tasks from
	 * being restored.
	 */
	private requeueFront(task: PendingTask): void {
		const tier = task.priority;
		const queue = this.queues[tier];
		const start = this.queueStarts[tier];

		if (start > 0) {
			const newStart = start - 1;

			queue[newStart] = task;
			this.queueStarts[tier] = newStart;
			return;
		}

		/*
		 * No consumed prefix is available. Worker crashes are exceptional, so
		 * the O(n) shift here is preferable to complicating the normal queue.
		 */
		queue.unshift(task);
	}

	/**
	 * Return the next task from the highest-priority non-empty tier.
	 */
	private takeNextTask(): PendingTask | undefined {
		for (let tier = 0; tier < this.queues.length; tier++) {
			const start = this.queueStarts[tier];
			const queue = this.queues[tier];

			if (start < queue.length) {
				const task = queue[start];

				/*
				 * Release the consumed queue reference immediately. The task stays
				 * alive in pendingTasks after dispatch.
				 */
				queue[start] = undefined as unknown as PendingTask;
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
			 * Replace the array so an oversized backing store can be reclaimed.
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

		for (let i = 0; i < this.workers.length; i++) {
			this.workers[i].busy = false;
			this.workers[i].activeTaskId = undefined;
		}
	}

	private compactQueuesIfNeeded(): void {
		for (let tier = 0; tier < this.queues.length; tier++) {
			const start = this.queueStarts[tier];

			if (start === 0) {
				continue;
			}

			const queue = this.queues[tier];
			const length = queue.length;

			if (start >= length) {
				this.queues[tier] = [];
				this.queueStarts[tier] = 0;
				continue;
			}

			/*
			 * Compact after meaningful drift. One allocation releases the consumed
			 * prefix and avoids retaining a continually growing sparse queue.
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
