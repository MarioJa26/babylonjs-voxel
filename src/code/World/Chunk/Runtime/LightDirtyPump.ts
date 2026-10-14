import type { Chunk } from "../Chunk";

export type LightDirtyHost = {
	resolveChunk(headerSlot: number): Chunk | undefined;
	tryRelight(chunk: Chunk): boolean;
	scheduleRemesh(chunk: Chunk, priority: boolean): void;
	schedulePump(): void;
	reportStats(processed: number, queueLength: number): void;
};

type LightDirtyEntry = {
	seq: number;
	dirtySlots: Uint32Array;
};

const LIGHT_DIRTY_EMPTY = new Uint32Array(0);
const LIGHT_DIRTY_BUDGET_MS = 4;
const LIGHT_DIRTY_TIME_CHECK_MASK = 15;
const LIGHT_DIRTY_COMPACT_THRESHOLD = 64;

export class LightDirtyPump {
	private queue: LightDirtyEntry[] = [];
	private readIdx = 0;
	private freeList: LightDirtyEntry[] = [];

	/**
	 * Header slot -> highest pending sequence number reported for that slot.
	 */
	private slotPendingSeq = new Map<number, number>();

	reportDirty(seq: number, dirtySlots: Uint32Array): void {
		const entry = this.freeList.pop();

		if (entry) {
			entry.seq = seq;
			entry.dirtySlots = dirtySlots;
			this.queue.push(entry);
			return;
		}

		this.queue.push({ seq, dirtySlots });
	}

	dropSlot(headerSlot: number): void {
		this.slotPendingSeq.delete(headerSlot);
	}

	process(host: LightDirtyHost): void {
		const queue = this.queue;
		const slotMap = this.slotPendingSeq;
		const startReadIdx = this.readIdx;
		const startTime = performance.now();

		let readIdx = startReadIdx;
		let processed = 0;

		while (readIdx < queue.length) {
			if (
				(processed & LIGHT_DIRTY_TIME_CHECK_MASK) === 0 &&
				performance.now() - startTime >= LIGHT_DIRTY_BUDGET_MS
			) {
				break;
			}

			const entry = queue[readIdx++];
			const slots = entry.dirtySlots;
			const seq = entry.seq;

			for (let i = 0; i < slots.length; i++) {
				const slot = slots[i];
				const previousSeq = slotMap.get(slot);

				if (previousSeq === undefined || seq > previousSeq) {
					slotMap.set(slot, seq);
				}
			}

			processed++;
		}

		this.readIdx = readIdx;

		/*
		 * Recycle only entries consumed during this invocation.
		 *
		 * Recycling from index zero would add previously recycled entries to
		 * the free-list again whenever the queue had not yet been compacted.
		 * That could let one envelope be reused for multiple queued reports.
		 */
		const freeList = this.freeList;

		for (let i = startReadIdx; i < readIdx; i++) {
			const entry = queue[i];
			entry.seq = 0;
			entry.dirtySlots = LIGHT_DIRTY_EMPTY;
			freeList.push(entry);
		}

		if (readIdx > LIGHT_DIRTY_COMPACT_THRESHOLD && readIdx * 2 > queue.length) {
			queue.copyWithin(0, readIdx);
			queue.length -= readIdx;
			readIdx = 0;
			this.readIdx = 0;
		}

		const remainingQueueLength = queue.length - readIdx;
		host.reportStats(processed, remainingQueueLength);

		if (remainingQueueLength > 0) {
			host.schedulePump();
		}

		for (const [slot] of slotMap) {
			const chunk = host.resolveChunk(slot);

			if (chunk === undefined) {
				slotMap.delete(slot);
				continue;
			}

			if (!chunk.isLoaded || chunk.isTerrainScheduled) {
				continue;
			}

			if (!host.tryRelight(chunk)) {
				host.scheduleRemesh(chunk, (chunk.lodLevel ?? 0) === 0);
			}

			slotMap.delete(slot);
		}
	}
}
