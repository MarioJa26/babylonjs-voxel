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
	blocks: Uint8Array;
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
			blocks: Uint8Array;
			light: Uint8Array;
			palette?: number[];
			isUniform: boolean;
			uniformBlockId: number;
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
	private workerByInstance = new Map<Worker, WorkerState>();
	private queue: PendingTask[] = [];
	private queueStart = 0;
	private pendingTasks = new Map<number, PendingTask>();
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
		for (let i = 0; i < poolSize; i++) {
			this.workers.push(this.createWorkerState());
		}

		this.initialized = true;
	}

	dispatch(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<ChunkResult> {
		const unavailable = this.getUnavailableError();
		if (unavailable) return Promise.reject(unavailable);

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
		if (coords.length === 0) return Promise.resolve([]);

		const unavailable = this.getUnavailableError();
		if (unavailable) return Promise.reject(unavailable);

		const maxGroup = ChunkWorkerPool.MAX_COLUMN_GROUP_SIZE;
		const n = coords.length;

		// Nested map avoids string keys and avoids the collision risk of packed
		// 32-bit numeric keys for large or negative chunk coordinates.
		const columnsByX = new Map<number, Map<number, number[]>>();

		for (let i = 0; i < n; i++) {
			const c = coords[i];

			let byZ = columnsByX.get(c.chunkX);
			if (!byZ) {
				byZ = new Map<number, number[]>();
				columnsByX.set(c.chunkX, byZ);
			}

			let indices = byZ.get(c.chunkZ);
			if (!indices) {
				indices = [];
				byZ.set(c.chunkZ, indices);
			}

			indices.push(i);
		}

		const groups: Array<{ indices: number[]; length: number }> = [];

		for (const byZ of columnsByX.values()) {
			for (const indices of byZ.values()) {
				if (indices.length > 1) {
					indices.sort((a, b) => coords[a].chunkY - coords[b].chunkY);
				}

				if (indices.length <= maxGroup) {
					groups.push({ indices, length: indices.length });
				} else {
					for (let i = 0; i < indices.length; i += maxGroup) {
						const end = Math.min(i + maxGroup, indices.length);
						const slice = indices.slice(i, end);
						groups.push({ indices: slice, length: slice.length });
					}
				}
			}
		}

		const workerCount = this.workers.length;
		const workerGroups: Array<Array<{ indices: number[]; length: number }>> =
			Array.from({ length: workerCount }, () => []);
		const totalChunksPerWorker = new Array<number>(workerCount).fill(0);

		for (const group of groups) {
			let minWorker = 0;
			let minChunks = totalChunksPerWorker[0];

			for (let w = 1; w < workerCount; w++) {
				const chunks = totalChunksPerWorker[w];
				if (chunks < minChunks) {
					minChunks = chunks;
					minWorker = w;
				}
			}

			workerGroups[minWorker].push(group);
			totalChunksPerWorker[minWorker] += group.length;
		}

		const origIndices = new Array<number>(n);
		const dispatchGroups: ChunkCoord[][] = [];

		let flatPos = 0;
		for (const wGroups of workerGroups) {
			if (wGroups.length === 0) continue;

			let totalLen = 0;
			for (const group of wGroups) totalLen += group.length;

			const batch = new Array<ChunkCoord>(totalLen);
			let batchPos = 0;

			for (const group of wGroups) {
				for (const idx of group.indices) {
					const c = coords[idx];

					origIndices[flatPos++] = idx;
					batch[batchPos++] = {
						chunkX: c.chunkX,
						chunkY: c.chunkY,
						chunkZ: c.chunkZ,
					};
				}
			}

			dispatchGroups.push(batch);
		}

		return Promise.all(
			dispatchGroups.map((group) => this._dispatchBatch(group)),
		).then((parts) => {
			const results = new Array<ChunkResult>(n);
			let resultPos = 0;

			for (const part of parts) {
				for (let i = 0; i < part.length; i++) {
					results[origIndices[resultPos++]] = part[i];
				}
			}

			return results;
		});
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
		if (unavailable) return Promise.reject(unavailable);

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
				neighborLight: neighborLight
					? (neighborLight as (Uint8Array | null)[]).slice()
					: undefined,
				resolve,
				reject,
			});
			this.processQueue();
		});
	}

	async terminate(): Promise<void> {
		if (this.terminated) return;

		this.terminated = true;
		this.rejectAllWork(new Error("Chunk worker pool terminated"));

		for (const ws of this.workers) {
			ws.disposed = true;
		}

		await Promise.all(this.workers.map((ws) => ws.worker.terminate()));

		this.workers = [];
		this.workerByInstance.clear();
		this.initialized = false;
	}

	get pendingCount(): number {
		return this.queue.length - this.queueStart + this.pendingTasks.size;
	}

	private _dispatchBatch(coords: ChunkCoord[]): Promise<ChunkResult[]> {
		const unavailable = this.getUnavailableError();
		if (unavailable) return Promise.reject(unavailable);

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
			if (existing?.disposed) return;

			if (code !== 0) {
				console.error(`[ChunkWorkerPool] Worker exited with code ${code}`);
				this.recoverWorker(worker);
			}
		});

		this.workerByInstance.set(worker, ws);
		return ws;
	}

	private handleWorkerMessage(worker: Worker, msg: WorkerMessage): void {
		const ws = this.workerByInstance.get(worker);

		// Ignore stale messages from a worker that was already recovered or
		// intentionally disposed. This prevents a late result from resolving a
		// task that has already been requeued to a replacement worker.
		if (!ws || ws.disposed) {
			return;
		}

		ws.busy = false;
		ws.activeTaskId = undefined;

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
				const ws = this.workers[i];
				if (!ws.busy && !ws.disposed) {
					freeWorker = ws;
					break;
				}
			}

			if (!freeWorker) {
				this.compactQueueIfNeeded();
				return;
			}

			const task = this.queue[this.queueStart++];

			freeWorker.busy = true;
			freeWorker.activeTaskId = task.id;
			this.pendingTasks.set(task.id, task);

			try {
				this.postTaskToWorker(freeWorker.worker, task);
			} catch (err) {
				freeWorker.busy = false;
				freeWorker.activeTaskId = undefined;
				this.pendingTasks.delete(task.id);

				task.reject(
					err instanceof Error
						? err
						: new Error(`Failed to post task to worker: ${String(err)}`),
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
			const buffer = task.blocks.buffer;
			const transferList = buffer instanceof SharedArrayBuffer ? [] : [buffer];

			// Only `blocks` is transferred — the mask and neighbor light arrays
			// are structured-cloned so they stay owned by the caller.
			worker.postMessage(
				{
					id: task.id,
					chunkX: task.chunkX,
					chunkY: task.chunkY,
					chunkZ: task.chunkZ,
					blocks: task.blocks,
					topSunlightMask: task.topSunlightMask,
					neighborLight: task.neighborLight,
					seed: this.seed,
					wasmEnabled: this.wasmEnabled,
				},
				transferList,
			);
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
		const ws = this.workerByInstance.get(deadWorker);
		if (!ws || ws.disposed) return;

		const wsIndex = this.workers.indexOf(ws);
		if (wsIndex < 0) return;

		ws.disposed = true;
		this.workers.splice(wsIndex, 1);
		this.workerByInstance.delete(deadWorker);

		if (ws.activeTaskId !== undefined) {
			const task = this.pendingTasks.get(ws.activeTaskId);
			if (task) {
				this.pendingTasks.delete(ws.activeTaskId);
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

		for (const ws of this.workers) {
			ws.disposed = true;
		}

		await Promise.all(this.workers.map((ws) => ws.worker.terminate()));

		this.workers = [];
		this.workerByInstance.clear();

		const poolSize = resolvePoolSize();
		for (let i = 0; i < poolSize; i++) {
			this.workers.push(this.createWorkerState());
		}
	}

	private requeueFront(task: PendingTask): void {
		if (this.queueStart > 0) {
			this.queue[--this.queueStart] = task;
		} else {
			this.queue.unshift(task);
		}
	}

	private rejectQueued(err: Error): void {
		for (let i = this.queueStart; i < this.queue.length; i++) {
			this.queue[i].reject(err);
		}

		this.queue = [];
		this.queueStart = 0;
	}

	private rejectAllWork(err: Error): void {
		this.rejectQueued(err);

		for (const task of this.pendingTasks.values()) {
			task.reject(err);
		}

		this.pendingTasks.clear();
	}

	private compactQueueIfNeeded(): void {
		if (this.queueStart === 0) return;

		if (this.queueStart >= this.queue.length) {
			this.queue = [];
			this.queueStart = 0;
			return;
		}

		// Avoid retaining already-dispatched task objects forever on long-lived
		// pools. Compact only after meaningful drift to avoid copying too often.
		if (this.queueStart > 1024 && this.queueStart * 2 >= this.queue.length) {
			this.queue = this.queue.slice(this.queueStart);
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
