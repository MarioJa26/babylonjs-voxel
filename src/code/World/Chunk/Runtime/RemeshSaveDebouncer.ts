import { WorldStorage } from "../../WorldStorage";
import { Chunk } from "../Chunk";

const REMESH_SAVE_DEBOUNCE_MS = 500;

export class RemeshSaveDebouncer {
	/*
	 * Two reusable sets let flush() detach the active batch without allocating
	 * a new Set each time. queue() always writes into pendingIds.
	 */
	private pendingIds = new Set<bigint>();
	private flushingIds = new Set<bigint>();

	private timer: ReturnType<typeof setTimeout> | null = null;

	/*
	 * Allocated once per debouncer instance instead of creating a closure on
	 * every queue() call.
	 */
	private readonly onTimer = (): void => {
		this.timer = null;
		this.flush();
	};

	queue(chunkId: bigint): void {
		this.pendingIds.add(chunkId);

		/*
		 * Preserve true trailing-edge debounce. Every call moves the save
		 * deadline to 500 ms after the most recent remesh.
		 */
		if (this.timer !== null) {
			clearTimeout(this.timer);
		}

		this.timer = setTimeout(this.onTimer, REMESH_SAVE_DEBOUNCE_MS);
	}

	/**
	 * Remove a disposed chunk from both the pending and currently detached
	 * batches.
	 */
	delete(chunkId: bigint): void {
		this.pendingIds.delete(chunkId);
		this.flushingIds.delete(chunkId);

		if (this.pendingIds.size !== 0 || this.timer === null) {
			return;
		}

		clearTimeout(this.timer);
		this.timer = null;
	}

	private flush(): void {
		if (this.pendingIds.size === 0) {
			return;
		}

		/*
		 * Swap reusable sets. New queue() calls now write into an empty set,
		 * while this flush owns a stable detached batch.
		 */
		const ids = this.pendingIds;
		this.pendingIds = this.flushingIds;
		this.flushingIds = ids;

		const chunksToSave: Chunk[] = [];

		for (const id of ids) {
			const chunk = Chunk.chunkInstances.get(id);

			if (chunk !== undefined && chunk.isLoaded && chunk.needsPersistence()) {
				chunksToSave.push(chunk);
			}
		}

		/*
		 * Release bigint entries before starting asynchronous persistence.
		 * The store receives the chunk array, not this ID set.
		 */
		ids.clear();

		if (chunksToSave.length === 0) {
			return;
		}

		void WorldStorage.saveChunks(chunksToSave).catch((error: unknown) => {
			console.error("Post-remesh chunk save failed:", error);
		});
	}

	/**
	 * Immediately starts persistence for the current pending batch.
	 */
	flushNow(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		this.flush();
	}

	/**
	 * Cancel all queued persistence work.
	 */
	clear(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		this.pendingIds.clear();
		this.flushingIds.clear();
	}

	get pendingCount(): number {
		return this.pendingIds.size;
	}
}
