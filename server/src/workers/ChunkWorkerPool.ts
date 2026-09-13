/**
 * ChunkWorkerPool.ts — Manages a pool of Node.js worker threads for parallel
 * chunk generation. Handles task queuing, worker lifecycle, and crash recovery.
 */

import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
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
			resolve: (result: ChunkResult) => void;
			reject: (error: Error) => void;
	  }
	| {
			id: number;
			kind: PendingTaskKindType.BATCH;
			coords: ChunkCoord[];
			resolve: (results: ChunkResult[]) => void;
			reject: (error: Error) => void;
	  }
	| {
			id: number;
			kind: PendingTaskKindType.RELIGHT;
			chunkX: number;
			chunkY: number;
			chunkZ: number;
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

function resolvePoolSize(): number {
	const cpuCount = cpus().length;
	const workerBudget = Math.max(2, cpuCount - 1);
	return Math.max(2, Math.min(8, workerBudget));
}

export class ChunkWorkerPool {
	private workers: WorkerState[] = [];
	private readonly workerByInstance = new Map<Worker, WorkerState>();

	/*
	 * queueStart makes dequeue O(1). Dispatched entries are released
	 * periodically by compactQueueIfNeeded().
	 */
	private queue: PendingTask[] = [];
	private queueStart = 0;

	private readonly pendingTasks = new Map<number, PendingTask>();

	private nextId = 1;
	private seed = "default";
	private wasmEnabled = true;
	private initialized = false;
	private terminated = false;

	/**
	 * Max chunks per column to send to a single worker. Larger columns are split
	 * across workers so bulk generation can use all workers in parallel while
	 * still keeping adjacent Y-levels together for column-cache hits.
	 */
	private static readonly MAX_COLUMN_GROUP_SIZE = 4;

	async initialize(seed: string, wasmEnabled = true): Promise<void> {
		if (this.initialized) {
			if (seed !== this.seed || wasmEnabled !== this.wasmEnabled) {
				this.seed = seed;
				this.wasmEnabled = wasmEnabled;
				await this.recreateWorkers();
			}
			return;
		}

		this.terminated = false;
		this.seed = seed;
		this.wasmEnabled = wasmEnabled;

		const poolSize = resolvePoolSize();
		const workers = new Array<WorkerState>(poolSize);

		for (let i = 0; i < poolSize; i++) {
			workers[i] = this.createWorkerState();
		}

		this.workers = workers;
		this.initialized = true;
	}

	dispatch(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkResult> {
		const unavailable = this.getUnavailableError();
		if (unavailable) {
			return Promise.reject(unavailable);
		}

		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			this.queue.push({
				id,
				kind: PendingTaskKindType.SINGLE,
				chunkX,
				chunkY,
				chunkZ,
				resolve,
				reject,
			});

			this.processQueue();
		});
	}

	dispatchAll(coords: ChunkCoord[]): Promise<ChunkResult[]> {
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
				this._dispatchBatch(batch).then((batchResults) => {
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
			this.queue.push({
				id,
				kind: PendingTaskKindType.RELIGHT,
				chunkX,
				chunkY,
				chunkZ,
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
		return this.queue.length - this.queueStart + this.pendingTasks.size;
	}

	private _dispatchBatch(coords: ChunkCoord[]): Promise<ChunkResult[]> {
		const unavailable = this.getUnavailableError();
		if (unavailable) {
			return Promise.reject(unavailable);
		}

		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			this.queue.push({
				id,
				kind: PendingTaskKindType.BATCH,
				coords,
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
			const queueDepth = this.queue.length - this.queueStart;

			console.error(
				`[ChunkWorkerPool] worker error ` +
					`(task ${pendingTaskKindLabel(task.kind)} id=${task.id}): ` +
					`${message.error} ` +
					`[pending=${this.pendingTasks.size} ` +
					`queued=${queueDepth} workers=${this.workers.length}]`,
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
			if (this.queueStart >= this.queue.length) {
				this.compactQueueIfNeeded();
				return;
			}

			let freeWorker: WorkerState | undefined;

			for (let i = 0; i < this.workers.length; i++) {
				const state = this.workers[i];

				if (!state.busy && !state.disposed) {
					freeWorker = state;
					break;
				}
			}

			if (freeWorker === undefined) {
				this.compactQueueIfNeeded();
				return;
			}

			const task = this.queue[this.queueStart++];

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

		const poolSize = resolvePoolSize();
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
		if (this.queueStart > 0) {
			this.queue[--this.queueStart] = task;
		} else {
			this.queue.unshift(task);
		}
	}

	private rejectQueued(error: Error): void {
		for (let i = this.queueStart; i < this.queue.length; i++) {
			this.queue[i].reject(error);
		}

		/*
		 * Replace the array rather than setting length to zero so a very large
		 * queue's backing storage can be reclaimed.
		 */
		this.queue = [];
		this.queueStart = 0;
	}

	private rejectAllWork(error: Error): void {
		this.rejectQueued(error);

		for (const task of this.pendingTasks.values()) {
			task.reject(error);
		}

		this.pendingTasks.clear();
	}

	private compactQueueIfNeeded(): void {
		const start = this.queueStart;

		if (start === 0) {
			return;
		}

		const length = this.queue.length;

		if (start >= length) {
			/*
			 * Replacing the array releases references and allows oversized
			 * backing storage to be reclaimed.
			 */
			this.queue = [];
			this.queueStart = 0;
			return;
		}

		/*
		 * Compact only after meaningful drift. slice() allocates one smaller
		 * array, but releases all references held by consumed queue slots.
		 */
		if (start > 1024 && start * 2 >= length) {
			this.queue = this.queue.slice(start);
			this.queueStart = 0;
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
