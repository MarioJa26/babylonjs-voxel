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
import { PendingTaskKindType } from "./workerProtocol.ts";

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
			kind: PendingTaskKindType.SINGLE;
			chunkX: number;
			chunkY: number;
			chunkZ: number;
			recoveryAttempts: number;
			resolve: (result: ChunkResult) => void;
			reject: (error: Error) => void;
	  }
	| {
			id: number;
			kind: PendingTaskKindType.BATCH;
			coords: Array<{ chunkX: number; chunkY: number; chunkZ: number }>;
			recoveryAttempts: number;
			resolve: (results: ChunkResult[]) => void;
			reject: (error: Error) => void;
	  }
	| {
			id: number;
			kind: PendingTaskKindType.RELIGHT;
			chunkX: number;
			chunkY: number;
			chunkZ: number;
			blocks: Uint8Array;
			recoveryAttempts: number;
			resolve: (light: Uint8Array) => void;
			reject: (error: Error) => void;
	  };

type WorkerMessage =
	| {
			id: number;
			kind: PendingTaskKindType.SINGLE;
			blocks: Uint8Array;
			light: Uint8Array;
			palette?: number[];
			isUniform: boolean;
			uniformBlockId: number;
			hash: number;
	  }
	| { id: number; kind: PendingTaskKindType.BATCH; items: ChunkResult[] }
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

/** Max times a single task is requeued after worker crashes before failing. */
const MAX_TASK_RECOVERIES = 3;
/** Max worker recreations per window before the pool gives up (guards a
 * crash loop that would otherwise requeue forever and stall every batch). */
const MAX_RECREATIONS_PER_WINDOW = 8;
const CRASH_WINDOW_MS = 60_000;

/** Stable log label for a task kind (const enums erase to numbers). */
function pendingTaskKindLabel(kind: PendingTaskKindType): string {
	switch (kind) {
		case PendingTaskKindType.SINGLE:
			return "single";
		case PendingTaskKindType.BATCH:
			return "batch";
		case PendingTaskKindType.RELIGHT:
			return "relight";
	}
}

function resolvePoolSize(): number {
	const cpuCount = cpus().length;
	const workerBudget = Math.max(2, cpuCount - 1);
	return Math.max(2, Math.min(8, workerBudget));
}

export class ChunkWorkerPool {
	private workers: WorkerState[] = [];
	private workerByInstance = new Map<Worker, WorkerState>();
	private queue: PendingTask[] = [];
	private queueStart = 0; // index-based dequeue (avoids O(n) shift)
	private pendingTasks = new Map<number, PendingTask>();
	private nextId = 1;
	private seed = "default";
	private wasmEnabled = true;
	private initialized = false;
	private terminated = false;
	private crashCount = 0;
	private crashWindowStart = 0;
	private crashOverloaded = false;

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
		this.crashCount = 0;
		this.crashWindowStart = 0;
		this.crashOverloaded = false;
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
		const ws: WorkerState = { worker, busy: false };

		worker.on("message", (msg: WorkerMessage) => {
			this.handleWorkerMessage(worker, msg);
		});

		worker.on("error", (err) => {
			console.error("[ChunkWorkerPool] Worker error:", err);
			this.recoverWorker(worker);
		});

		worker.on("exit", (code) => {
			const existing = this.workerByInstance.get(worker);
			if (existing?.disposed) return; // intentional termination
			if (code !== 0) {
				console.error(`[ChunkWorkerPool] Worker exited with code ${code}`);
				this.recoverWorker(worker);
			}
		});

		this.workerByInstance.set(worker, ws);
		return ws;
	}

	private handleWorkerMessage(worker: Worker, msg: WorkerMessage): void {
		// O(1) lookup instead of linear scan through workers array.
		const ws = this.workerByInstance.get(worker);
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
			const queueDepth = this.queue.length - this.queueStart;
			console.error(
				`[ChunkWorkerPool] worker error (task ${pendingTaskKindLabel(task.kind)} id=${task.id}): ${msg.error}` +
					` [pending=${this.pendingTasks.size} queued=${queueDepth} workers=${this.workers.length}]`,
			);
			task.reject(new Error(msg.error));
		} else if (task.kind === PendingTaskKindType.RELIGHT) {
			if ("light" in msg && !("kind" in msg)) {
				task.resolve(msg.light);
			} else {
				task.reject(new Error("Mismatched relight response"));
			}
		} else if (
			task.kind === PendingTaskKindType.SINGLE &&
			"kind" in msg &&
			msg.kind === PendingTaskKindType.SINGLE
		) {
			task.resolve({
				blocks: msg.blocks,
				light: msg.light,
				palette: msg.palette,
				isUniform: msg.isUniform,
				uniformBlockId: msg.uniformBlockId,
				hash: msg.hash,
			});
		} else if (
			task.kind === PendingTaskKindType.BATCH &&
			"kind" in msg &&
			msg.kind === PendingTaskKindType.BATCH
		) {
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
			for (let i = this.queueStart; i < this.queue.length; i++) {
				this.queue[i].reject(err);
			}
			this.queue = [];
			this.queueStart = 0;
			return;
		}

		// Crash-overload guard: too many worker crashes recently means the
		// worker binary is broken, not transient — stop requeueing and fail
		// everything fast instead of stalling every batch until client timeout.
		if (this.crashOverloaded) {
			if (Date.now() - this.crashWindowStart >= CRASH_WINDOW_MS) {
				this.crashOverloaded = false;
				this.crashCount = 0;
				this.crashWindowStart = 0;
			} else {
				const err = new Error(
					"Chunk worker crash overload — generation aborted",
				);
				this.rejectAllQueuedAndPending(err);
				return;
			}
		}

		// Dispatch as many tasks as there are free workers and queued tasks.
		// Uses index-based dequeue (queueStart++) instead of shift() which
		// is O(n) due to array re-indexing.
		for (;;) {
			if (this.queueStart >= this.queue.length) return;

			// Find a free worker — iterate workers array (bounded by pool
			// size, typically 4-8) instead of scanning the queue.
			let freeWorker: WorkerState | null = null;
			for (let i = 0; i < this.workers.length; i++) {
				if (!this.workers[i].busy) {
					freeWorker = this.workers[i];
					break;
				}
			}
			if (!freeWorker) return;

			const task = this.queue[this.queueStart++];
			freeWorker.busy = true;
			freeWorker.activeTaskId = task.id;
			this.pendingTasks.set(task.id, task);

			if (task.kind === PendingTaskKindType.SINGLE) {
				freeWorker.worker.postMessage({
					id: task.id,
					kind: PendingTaskKindType.SINGLE,
					seed: this.seed,
					wasmEnabled: this.wasmEnabled,
					chunkX: task.chunkX,
					chunkY: task.chunkY,
					chunkZ: task.chunkZ,
				});
			} else if (task.kind === PendingTaskKindType.RELIGHT) {
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
						seed: this.seed,
						wasmEnabled: this.wasmEnabled,
					},
					transferList,
				);
			} else {
				freeWorker.worker.postMessage({
					id: task.id,
					kind: PendingTaskKindType.BATCH,
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
				kind: PendingTaskKindType.SINGLE,
				chunkX,
				chunkY,
				chunkZ,
				recoveryAttempts: 0,
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
		const n = coords.length;

		// Track original indices for result reordering. Use a flat array
		// instead of N spread-objects to avoid per-element allocation.
		const origIndices = new Array<number>(n);
		for (let i = 0; i < n; i++) origIndices[i] = i;

		// Group by column key (chunkX, chunkZ) using a numeric packed key
		// instead of string template literals — avoids N string allocations.
		// Keys are encoded as chunkX * 0x100000 + (chunkZ & 0xfffff) to
		// avoid collisions for coords in the ±512K range.
		const columnMap = new Map<number, number[]>(); // packedKey → list of indices
		for (let i = 0; i < n; i++) {
			const c = coords[i];
			const colKey = (c.chunkX * 0x100000 + (c.chunkZ & 0xfffff)) | 0;
			let col = columnMap.get(colKey);
			if (!col) {
				col = [];
				columnMap.set(colKey, col);
			}
			col.push(i);
		}

		// Build groups from column indices, sorted by chunkY within each column.
		const groups: Array<{ indices: number[]; length: number }> = [];
		for (const indices of columnMap.values()) {
			// Sort indices by chunkY
			if (indices.length > 1) {
				indices.sort((a, b) => coords[a].chunkY - coords[b].chunkY);
			}
			if (indices.length <= maxGroup) {
				groups.push({ indices, length: indices.length });
			} else {
				for (let i = 0; i < indices.length; i += maxGroup) {
					const slice = indices.slice(i, i + maxGroup);
					groups.push({ indices: slice, length: slice.length });
				}
			}
		}

		// Distribute groups across workers via least-loaded assignment.
		const workerCount = Math.max(1, this.workers.length);
		const workerGroups: Array<Array<{ indices: number[]; length: number }>> =
			Array.from({ length: workerCount }, () => []);
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

		// Build origIndices mapping in group order (for result reordering).
		// Overwrite origIndices in-place — we no longer need the original
		// 0..n-1 order.
		let pos = 0;
		for (const wGroups of workerGroups) {
			for (const group of wGroups) {
				for (const idx of group.indices) {
					origIndices[pos++] = idx;
				}
			}
		}

		// Build dispatch batches: one coord array per worker.
		const dispatchGroups: Array<
			Array<{ chunkX: number; chunkY: number; chunkZ: number }>
		> = [];
		for (const wGroups of workerGroups) {
			if (wGroups.length === 0) continue;
			let totalLen = 0;
			for (const g of wGroups) totalLen += g.length;
			const batch = new Array<{
				chunkX: number;
				chunkY: number;
				chunkZ: number;
			}>(totalLen);
			let bPos = 0;
			for (const group of wGroups) {
				for (const idx of group.indices) {
					const c = coords[idx];
					batch[bPos++] = {
						chunkX: c.chunkX,
						chunkY: c.chunkY,
						chunkZ: c.chunkZ,
					};
				}
			}
			dispatchGroups.push(batch);
		}

		return Promise.all(dispatchGroups.map((g) => this._dispatchBatch(g))).then(
			(parts) => {
				// Write results directly into final positions, skipping the
				// flatResults intermediate array. origIndices[pos] tells us
				// which input coord the result at flat position `pos` belongs to.
				const results = new Array<ChunkResult>(n);
				let flatIdx = 0;
				for (const part of parts) {
					for (let i = 0; i < part.length; i++) {
						results[origIndices[flatIdx++]] = part[i];
					}
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
				kind: PendingTaskKindType.BATCH,
				coords,
				recoveryAttempts: 0,
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
				kind: PendingTaskKindType.RELIGHT,
				chunkX,
				chunkY,
				chunkZ,
				blocks,
				recoveryAttempts: 0,
				resolve,
				reject,
			});
			this.processQueue();
		});
	}

	private recoverWorker(deadWorker: Worker): void {
		const ws = this.workerByInstance.get(deadWorker);
		if (!ws) return; // already recovered (error + exit can double-fire)
		if (ws.disposed) return; // intentional termination
		const wsIndex = this.workers.indexOf(ws);
		if (wsIndex < 0) return;
		this.workers.splice(wsIndex, 1);
		this.workerByInstance.delete(deadWorker);

		// Crash-rate accounting: reset the window when it has elapsed, then
		// count this crash. Beyond the cap we stop recreating workers and fail
		// all queued/pending work — a crash loop must not stall batches
		// forever (clients would time out at 30s and the region never loads).
		const now = Date.now();
		if (now - this.crashWindowStart >= CRASH_WINDOW_MS) {
			this.crashWindowStart = now;
			this.crashCount = 0;
		}
		this.crashCount++;

		if (this.crashCount >= MAX_RECREATIONS_PER_WINDOW) {
			this.crashOverloaded = true;
			console.error(
				`[ChunkWorkerPool] ${this.crashCount} worker crashes within ${CRASH_WINDOW_MS}ms — ` +
					`aborting all queued/pending chunk work (workers will resume after the window)`,
			);
			this.rejectAllQueuedAndPending(
				new Error("Chunk worker crash overload — generation aborted"),
			);
			return;
		}

		// Requeue the dead worker's in-flight task so its work is redone —
		// but cap retries per task so one poison chunk can't loop forever.
		if (ws.activeTaskId !== undefined) {
			const task = this.pendingTasks.get(ws.activeTaskId);
			if (task) {
				this.pendingTasks.delete(ws.activeTaskId);
				if (task.recoveryAttempts + 1 < MAX_TASK_RECOVERIES) {
					task.recoveryAttempts++;
					// Use unshift to requeue at the front (priority for recovered tasks).
					this.queue.unshift(task);
					this.queueStart = 0;
				} else {
					console.error(
						`[ChunkWorkerPool] task ${pendingTaskKindLabel(task.kind)} id=${task.id} exceeded ` +
							`${MAX_TASK_RECOVERIES} recovery attempts — failing it`,
					);
					task.reject(
						new Error(
							`Chunk task failed after ${MAX_TASK_RECOVERIES} worker recoveries`,
						),
					);
				}
			}
		}

		this.workers.push(this.createWorkerState());
		this.processQueue();
	}

	private rejectAllQueuedAndPending(error: Error): void {
		for (let i = this.queueStart; i < this.queue.length; i++) {
			this.queue[i].reject(error);
		}
		for (const task of this.pendingTasks.values()) task.reject(error);
		this.queue = [];
		this.queueStart = 0;
		this.pendingTasks.clear();
	}

	private async recreateWorkers(): Promise<void> {
		// Settle all queued + in-flight work (seed changed → results invalid).
		const err = new Error("Seed changed — chunk generation aborted");
		for (let i = this.queueStart; i < this.queue.length; i++) {
			this.queue[i].reject(err);
		}
		for (const task of this.pendingTasks.values()) task.reject(err);
		this.queue = [];
		this.queueStart = 0;
		this.pendingTasks.clear();

		for (const ws of this.workers) {
			ws.disposed = true;
			await ws.worker.terminate();
		}
		this.workers = [];
		this.workerByInstance.clear();

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
		for (let i = this.queueStart; i < this.queue.length; i++) {
			this.queue[i].reject(err);
		}
		for (const task of this.pendingTasks.values()) task.reject(err);
		this.queue = [];
		this.queueStart = 0;
		this.pendingTasks.clear();

		for (const ws of this.workers) {
			ws.disposed = true;
		}
		await Promise.all(this.workers.map((w) => w.worker.terminate()));
		this.workers = [];
		this.workerByInstance.clear();
		this.initialized = false;
	}

	get pendingCount(): number {
		return this.queue.length - this.queueStart + this.pendingTasks.size;
	}
}
