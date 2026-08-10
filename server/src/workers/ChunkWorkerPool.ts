/**
 * ChunkWorkerPool.ts — Manages a pool of Node.js worker threads for parallel
 * chunk generation. Handles task queuing, worker lifecycle, and crash recovery.
 *
 * Optimization notes:
 * - Each worker tracks its in-flight task id, so a crashed worker only
 *   affects its own work (the task is requeued) — healthy workers keep going.
 * - Batch dispatch groups coords into one message per worker instead of
 *   one message per chunk (fewer round-trips, fewer main-thread wakeups).
 * - terminate()/recreateWorkers() settle every queued/in-flight task, so
 *   callers never hang on unresolved promises.
 */

import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

interface ChunkResult {
	blocks: Uint8Array;
	light: Uint8Array;
	palette?: number[];
	isUniform: boolean;
	uniformBlockId: number;
	hash: number;
}

type PendingTask =
	| {
			id: number;
			kind: "single";
			chunkX: number;
			chunkY: number;
			chunkZ: number;
			resolve: (result: ChunkResult) => void;
			reject: (error: Error) => void;
	  }
	| {
			id: number;
			kind: "batch";
			coords: Array<{ chunkX: number; chunkY: number; chunkZ: number }>;
			resolve: (results: ChunkResult[]) => void;
			reject: (error: Error) => void;
	  };

type WorkerMessage =
	| {
			id: number;
			kind: "single";
			blocks: Uint8Array;
			light: Uint8Array;
			palette?: number[];
			isUniform: boolean;
			uniformBlockId: number;
			hash: number;
	  }
	| { id: number; kind: "batch"; items: ChunkResult[] }
	| { id: number; error: string };

interface WorkerState {
	worker: Worker;
	busy: boolean;
	activeTaskId?: number;
	disposed?: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolvePoolSize(): number {
	const cpuCount = cpus().length;
	const workerBudget = Math.max(2, cpuCount - 1);
	return Math.max(2, Math.min(8, workerBudget));
}

export class ChunkWorkerPool {
	private workers: WorkerState[] = [];
	private queue: PendingTask[] = [];
	private pendingTasks = new Map<number, PendingTask>();
	private nextId = 1;
	private seed = "default";
	private wasmEnabled = true;
	private initialized = false;

	async initialize(seed: string, wasmEnabled = true): Promise<void> {
		if (this.initialized) {
			if (seed !== this.seed || wasmEnabled !== this.wasmEnabled) {
				this.seed = seed;
				this.wasmEnabled = wasmEnabled;
				await this.recreateWorkers();
			}
			return;
		}

		this.seed = seed;
		this.wasmEnabled = wasmEnabled;
		const poolSize = resolvePoolSize();

		for (let i = 0; i < poolSize; i++) {
			this.workers.push(this.createWorkerState());
		}

		this.initialized = true;
	}

	private createWorkerState(): WorkerState {
		const workerPath = join(__dirname, "chunkWorkerBootstrap.mjs");
		const worker = new Worker(workerPath);

		worker.on("message", (msg: WorkerMessage) => {
			this.handleWorkerMessage(worker, msg);
		});

		worker.on("error", (err) => {
			console.error("[ChunkWorkerPool] Worker error:", err);
			this.recoverWorker(worker);
		});

		worker.on("exit", (code) => {
			const ws = this.workers.find((w) => w.worker === worker);
			if (ws?.disposed) return; // intentional termination
			if (code !== 0) {
				console.error(`[ChunkWorkerPool] Worker exited with code ${code}`);
				this.recoverWorker(worker);
			}
		});

		return { worker, busy: false };
	}

	private handleWorkerMessage(worker: Worker, msg: WorkerMessage): void {
		const ws = this.workers.find((w) => w.worker === worker);
		if (ws) {
			ws.busy = false;
			ws.activeTaskId = undefined;
		}

		const task = this.pendingTasks.get(msg.id);
		if (!task) {
			this.processQueue();
			return;
		}

		this.pendingTasks.delete(msg.id);

		if ("error" in msg) {
			task.reject(new Error(msg.error));
		} else if (task.kind === "single" && msg.kind === "single") {
			task.resolve({
				blocks: msg.blocks,
				light: msg.light,
				palette: msg.palette,
				isUniform: msg.isUniform,
				uniformBlockId: msg.uniformBlockId,
				hash: msg.hash,
			});
		} else if (task.kind === "batch" && msg.kind === "batch") {
			task.resolve(msg.items);
		} else {
			task.reject(new Error("Mismatched worker response"));
		}

		this.processQueue();
	}

	private processQueue(): void {
		// Dispatch as many tasks as there are free workers and queued tasks.
		// The old single-dispatch version only filled one worker per call, so
		// when multiple workers finished simultaneously the remaining free
		// workers stayed idle until the next completion event woke them.
		for (;;) {
			if (this.queue.length === 0) return;

			const freeWorker = this.workers.find((w) => !w.busy);
			if (!freeWorker) return;

			const task = this.queue.shift()!;
			freeWorker.busy = true;
			freeWorker.activeTaskId = task.id;
			this.pendingTasks.set(task.id, task);

			if (task.kind === "single") {
				freeWorker.worker.postMessage({
					id: task.id,
					kind: "single",
					seed: this.seed,
					wasmEnabled: this.wasmEnabled,
					chunkX: task.chunkX,
					chunkY: task.chunkY,
					chunkZ: task.chunkZ,
				});
			} else {
				freeWorker.worker.postMessage({
					id: task.id,
					kind: "batch",
					seed: this.seed,
					wasmEnabled: this.wasmEnabled,
					items: task.coords,
				});
			}
		}
	}

	dispatch(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkResult> {
		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			this.queue.push({
				id,
				kind: "single",
				chunkX,
				chunkY,
				chunkZ,
				resolve,
				reject,
			});
			this.processQueue();
		});
	}

	/**
	 * Dispatch many chunks in parallel. Coords are split into one contiguous
	 * group per worker and sent as a single batch message each, so result
	 * order matches the input order while round-trips stay low.
	 */
	dispatchAll(
		coords: Array<{ chunkX: number; chunkY: number; chunkZ: number }>,
	): Promise<ChunkResult[]> {
		if (coords.length === 0) return Promise.resolve([]);

		const workerCount = Math.max(1, this.workers.length);
		const groupSize = Math.ceil(coords.length / workerCount);
		const groups: Array<
			Array<{ chunkX: number; chunkY: number; chunkZ: number }>
		> = [];

		for (let i = 0; i < coords.length; i += groupSize) {
			groups.push(coords.slice(i, i + groupSize));
		}

		return Promise.all(groups.map((group) => this._dispatchBatch(group))).then(
			(parts) => parts.flat(),
		);
	}

	private _dispatchBatch(
		coords: Array<{ chunkX: number; chunkY: number; chunkZ: number }>,
	): Promise<ChunkResult[]> {
		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			this.queue.push({
				id,
				kind: "batch",
				coords,
				resolve,
				reject,
			});
			this.processQueue();
		});
	}

	private recoverWorker(deadWorker: Worker): void {
		const wsIndex = this.workers.findIndex((w) => w.worker === deadWorker);
		if (wsIndex < 0) return; // already recovered (error + exit can double-fire)
		if (this.workers[wsIndex].disposed) return; // intentional termination
		const ws = this.workers[wsIndex];
		this.workers.splice(wsIndex, 1);

		// Requeue the dead worker's in-flight task so its work is redone.
		if (ws.activeTaskId !== undefined) {
			const task = this.pendingTasks.get(ws.activeTaskId);
			if (task) {
				this.pendingTasks.delete(ws.activeTaskId);
				this.queue.unshift(task);
			}
		}

		this.workers.push(this.createWorkerState());
		this.processQueue();
	}

	private async recreateWorkers(): Promise<void> {
		// Settle all queued + in-flight work (seed changed → results invalid).
		const err = new Error("Seed changed — chunk generation aborted");
		for (const task of this.queue) task.reject(err);
		for (const task of this.pendingTasks.values()) task.reject(err);
		this.queue = [];
		this.pendingTasks.clear();

		for (const ws of this.workers) {
			ws.disposed = true;
			await ws.worker.terminate();
		}
		this.workers = [];

		const poolSize = resolvePoolSize();
		for (let i = 0; i < poolSize; i++) {
			this.workers.push(this.createWorkerState());
		}
	}

	async terminate(): Promise<void> {
		// Settle everything so callers never hang on unresolved promises.
		const err = new Error("Chunk worker pool terminated");
		for (const task of this.queue) task.reject(err);
		for (const task of this.pendingTasks.values()) task.reject(err);
		this.queue = [];
		this.pendingTasks.clear();

		for (const ws of this.workers) {
			ws.disposed = true;
		}
		await Promise.all(this.workers.map((w) => w.worker.terminate()));
		this.workers = [];
		this.initialized = false;
	}

	get pendingCount(): number {
		return this.queue.length + this.pendingTasks.size;
	}
}
