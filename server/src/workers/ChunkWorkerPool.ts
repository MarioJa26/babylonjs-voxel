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
	  }
	| {
			id: number;
			kind: "relight";
			chunkX: number;
			chunkY: number;
			chunkZ: number;
			blocks: Uint8Array;
			resolve: (light: Uint8Array) => void;
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
	| { id: number; light: Uint8Array }
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
	private terminated = false;

	async initialize(seed: string, wasmEnabled = true): Promise<void> {
		if (this.initialized) {
			if (seed !== this.seed || wasmEnabled !== this.wasmEnabled) {
				this.seed = seed;
				this.wasmEnabled = wasmEnabled;
				await this.recreateWorkers();
			}
			return;
		}

		// Allow a fresh start after terminate() (e.g. for tests).
		this.terminated = false;
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
		} else if (task.kind === "relight") {
			if ("light" in msg && !("kind" in msg)) {
				task.resolve(msg.light);
			} else {
				task.reject(new Error("Mismatched relight response"));
			}
		} else if (task.kind === "single" && "kind" in msg && msg.kind === "single") {
			task.resolve({
				blocks: msg.blocks,
				light: msg.light,
				palette: msg.palette,
				isUniform: msg.isUniform,
				uniformBlockId: msg.uniformBlockId,
				hash: msg.hash,
			});
		} else if (task.kind === "batch" && "kind" in msg && msg.kind === "batch") {
			task.resolve(msg.items);
		} else {
			task.reject(new Error("Mismatched worker response"));
		}

		this.processQueue();
	}

	private processQueue(): void {
		// After terminate() no workers exist — drain the queue with rejections
		// so queued tasks never hang (the terminate race: a task dispatched
		// between pool.initialize() resolving and worker termination).
		if (this.terminated) {
			const err = new Error("Chunk worker pool terminated");
			for (const task of this.queue) task.reject(err);
			this.queue = [];
			return;
		}

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
			} else if (task.kind === "relight") {
				const buffer = task.blocks.buffer;
				const transferList =
					buffer instanceof SharedArrayBuffer ? [] : [buffer];
				freeWorker.worker.postMessage(
					{
						id: task.id,
						chunkX: task.chunkX,
						chunkY: task.chunkY,
						chunkZ: task.chunkZ,
						blocks: task.blocks,
					},
					transferList,
				);
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
		if (this.terminated) {
			return Promise.reject(new Error("Chunk worker pool terminated"));
		}

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
	 * Max chunks per column to send to a single worker. Larger columns are
	 * split across workers so that bulk generation (e.g. joining) can use all
	 * workers in parallel, while still keeping adjacent Y-levels together for
	 * SurfaceGenerator.columnCache hits.
	 */
	private static readonly MAX_COLUMN_GROUP_SIZE = 4;

	/**
	 * Dispatch many chunks in parallel. Coords are grouped by vertical column
	 * (same chunkX, chunkZ) so each worker processes full columns and can
	 * reuse column-level noise/state. Columns are distributed across workers,
	 * and results are flattened back into input order.
	 */
	dispatchAll(
		coords: Array<{ chunkX: number; chunkY: number; chunkZ: number }>,
	): Promise<ChunkResult[]> {
		if (coords.length === 0) return Promise.resolve([]);
		if (this.terminated) {
			return Promise.reject(new Error("Chunk worker pool terminated"));
		}

		const maxGroup = ChunkWorkerPool.MAX_COLUMN_GROUP_SIZE;

		// Track original indices for result reordering
		const indexed = coords.map((c, i) => ({ ...c, origIndex: i }));

		// Group by column key (chunkX, chunkZ), sorted by chunkY within each column
		const columnMap = new Map<string, Array<{ chunkX: number; chunkY: number; chunkZ: number; origIndex: number }>>();
		for (const c of indexed) {
			const colKey = `${c.chunkX},${c.chunkZ}`;
			let col = columnMap.get(colKey);
			if (!col) {
				col = [];
				columnMap.set(colKey, col);
			}
			col.push(c);
		}

		// Split large columns into groups of maxGroup size (adjacent Y-levels)
		const groups: Array<Array<{ chunkX: number; chunkY: number; chunkZ: number; origIndex: number }>> = [];
		for (const col of columnMap.values()) {
			col.sort((a, b) => a.chunkY - b.chunkY);
			if (col.length <= maxGroup) {
				groups.push(col);
			} else {
				// Split into chunks of maxGroup, keeping adjacent Y-levels together
				for (let i = 0; i < col.length; i += maxGroup) {
					groups.push(col.slice(i, i + maxGroup));
				}
			}
		}

		// Distribute groups across workers via least-loaded assignment
		const workerCount = Math.max(1, this.workers.length);
		const workerGroups: Array<Array<typeof groups[0]>> = Array.from({ length: workerCount }, () => []);
		const totalChunksPerWorker = new Array(workerCount).fill(0);

		for (const group of groups) {
			let minWorker = 0;
			let minChunks = totalChunksPerWorker[0];
			for (let w = 1; w < workerCount; w++) {
				if (totalChunksPerWorker[w] < minChunks) {
					minChunks = totalChunksPerWorker[w];
					minWorker = w;
				}
			}
			workerGroups[minWorker].push(group);
			totalChunksPerWorker[minWorker] += group.length;
		}

		// Build a mapping from flat result position back to original index
		const origIndices: number[] = [];
		for (const wGroups of workerGroups) {
			for (const group of wGroups) {
				for (const c of group) {
					origIndices.push(c.origIndex);
				}
			}
		}

		// Dispatch each worker's groups as a single batch
		const dispatchGroups: Array<Array<{ chunkX: number; chunkY: number; chunkZ: number }>> = [];
		for (const wGroups of workerGroups) {
			if (wGroups.length === 0) continue;
			const batch: Array<{ chunkX: number; chunkY: number; chunkZ: number }> = [];
			for (const group of wGroups) {
				for (const c of group) {
					batch.push({ chunkX: c.chunkX, chunkY: c.chunkY, chunkZ: c.chunkZ });
				}
			}
			dispatchGroups.push(batch);
		}

		return Promise.all(dispatchGroups.map((g) => this._dispatchBatch(g))).then(
			(parts) => {
				// Flatten parts in group order
				const flatResults = new Array<ChunkResult>(coords.length);
				let flatIdx = 0;
				for (const part of parts) {
					for (let i = 0; i < part.length; i++) {
						flatResults[flatIdx++] = part[i];
					}
				}

				// Reorder: flatResults[i] came from origIndices[i]-th input coord
				const results = new Array<ChunkResult>(coords.length);
				for (let i = 0; i < flatResults.length; i++) {
					results[origIndices[i]] = flatResults[i];
				}
				return results;
			},
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

	postRelight(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		blocks: Uint8Array,
	): Promise<Uint8Array> {
		if (this.terminated) {
			return Promise.reject(new Error("Chunk worker pool terminated"));
		}

		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			this.queue.push({
				id,
				kind: "relight",
				chunkX,
				chunkY,
				chunkZ,
				blocks,
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
		if (this.terminated) return;
		this.terminated = true;

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
