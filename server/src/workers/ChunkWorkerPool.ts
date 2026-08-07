/**
 * ChunkWorkerPool.ts — Manages a pool of Node.js worker threads for parallel
 * chunk generation. Handles task queuing, worker lifecycle, and crash recovery.
 */

import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

interface PendingTask {
	id: number;
	chunkX: number;
	chunkY: number;
	chunkZ: number;
	resolve: (result: { blocks: Uint8Array; light: Uint8Array }) => void;
	reject: (error: Error) => void;
}

type WorkerMessage =
	| { id: number; blocks: Uint8Array; light: Uint8Array }
	| { id: number; error: string };

interface WorkerState {
	worker: Worker;
	busy: boolean;
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
			const worker = this.createWorker();
			this.workers.push({ worker, busy: false });
		}

		this.initialized = true;
	}

	private createWorker(): Worker {
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
			if (code !== 0) {
				console.error(`[ChunkWorkerPool] Worker exited with code ${code}`);
				this.recoverWorker(worker);
			}
		});

		return worker;
	}

	private handleWorkerMessage(worker: Worker, msg: WorkerMessage): void {
		const ws = this.workers.find((w) => w.worker === worker);
		if (ws) ws.busy = false;

		const task = this.pendingTasks.get(msg.id);
		if (!task) return;

		this.pendingTasks.delete(msg.id);

		if ("error" in msg) {
			task.reject(new Error(msg.error));
		} else {
			task.resolve({ blocks: msg.blocks, light: msg.light });
		}

		this.processQueue();
	}

	private processQueue(): void {
		if (this.queue.length === 0) return;

		const freeWorker = this.workers.find((w) => !w.busy);
		if (!freeWorker) return;

		const task = this.queue.shift()!;
		freeWorker.busy = true;
		this.pendingTasks.set(task.id, task);

		freeWorker.worker.postMessage({
			id: task.id,
			seed: this.seed,
			wasmEnabled: this.wasmEnabled,
			chunkX: task.chunkX,
			chunkY: task.chunkY,
			chunkZ: task.chunkZ,
		});
	}

	dispatch(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
	): Promise<{ blocks: Uint8Array; light: Uint8Array }> {
		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			const task: PendingTask = { id, chunkX, chunkY, chunkZ, resolve, reject };
			this.queue.push(task);
			this.processQueue();
		});
	}

	dispatchAll(
		coords: Array<{ chunkX: number; chunkY: number; chunkZ: number }>,
	): Promise<Array<{ blocks: Uint8Array; light: Uint8Array }>> {
		return Promise.all(
			coords.map((c) => this.dispatch(c.chunkX, c.chunkY, c.chunkZ)),
		);
	}

	private recoverWorker(deadWorker: Worker): void {
		this.workers = this.workers.filter((w) => w.worker !== deadWorker);

		for (const [id, task] of this.pendingTasks) {
			if (this.queue.some((t) => t.id === id)) continue;
			task.reject(new Error("Worker crashed"));
		}
		this.pendingTasks.clear();

		const newWorker = this.createWorker();
		this.workers.push({ worker: newWorker, busy: false });
	}

	private async recreateWorkers(): Promise<void> {
		for (const ws of this.workers) {
			await ws.worker.terminate();
		}
		this.workers = [];
		this.pendingTasks.clear();

		const poolSize = resolvePoolSize();
		for (let i = 0; i < poolSize; i++) {
			const worker = this.createWorker();
			this.workers.push({ worker, busy: false });
		}
	}

	async terminate(): Promise<void> {
		await Promise.all(this.workers.map((w) => w.worker.terminate()));
		this.workers = [];
		this.pendingTasks.clear();
		this.queue = [];
		this.initialized = false;
	}

	get pendingCount(): number {
		return this.queue.length + this.pendingTasks.size;
	}
}
