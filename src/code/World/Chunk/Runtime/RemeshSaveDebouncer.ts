import { WorldStorage } from "../../WorldStorage";
import { Chunk } from "../Chunk";

const REMESH_SAVE_DEBOUNCE_MS = 500;

export class RemeshSaveDebouncer {
	private ids = new Set<bigint>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	queue(chunkId: bigint): void {
		this.ids.add(chunkId);

		/*
		 * True trailing-edge debounce: save 500 ms after the most recent
		 * queue() call, rather than 500 ms after the first call in a burst.
		 */
		if (this.timer !== null) {
			clearTimeout(this.timer);
		}

		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, REMESH_SAVE_DEBOUNCE_MS);
	}

	private flush(): void {
		if (this.ids.size === 0) {
			return;
		}

		/*
		 * Detach the current batch before resolving chunks. Any IDs queued
		 * during this flush remain in the new set for the next debounce cycle.
		 */
		const ids = this.ids;
		this.ids = new Set<bigint>();

		const chunksToSave: Chunk[] = [];

		for (const id of ids) {
			const chunk = Chunk.chunkInstances.get(id);

			if (chunk?.isLoaded && chunk?.needsPersistence()) {
				chunksToSave.push(chunk);
			}
		}

		if (chunksToSave.length === 0) {
			return;
		}

		void WorldStorage.saveChunks(chunksToSave).catch((error: unknown) => {
			console.error("Post-remesh chunk save failed:", error);
		});
	}
}
