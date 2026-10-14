// ---------------------------------------------------------------------------
// RemeshHeap: binary min-heap over remesh priority (extracted from
// ChunkWorkerPool — Step 1 of the God-class split).
//
// Owns the heap array + position index + priority flags. The pool keeps its
// separate `pendingRemeshMap` staging buffer; this class only stores entries
// that have been flushed into the dispatchable queue.
// ---------------------------------------------------------------------------
import type { Chunk } from "../Chunk";

export class RemeshHeap {
	private heap: Chunk[] = [];
	private positions = new Map<Chunk, number>();
	private priorities = new Map<Chunk, boolean>();

	get length(): number {
		return this.heap.length;
	}

	has(chunk: Chunk): boolean {
		return this.priorities.has(chunk);
	}

	getPriority(chunk: Chunk): boolean | undefined {
		return this.priorities.get(chunk);
	}

	deletePriority(chunk: Chunk): void {
		this.priorities.delete(chunk);
	}

	private static comparePriority(
		aChunk: Chunk,
		aPriority: boolean,
		bChunk: Chunk,
		bPriority: boolean,
	): number {
		if (aPriority !== bPriority) return aPriority ? -1 : 1;
		const aLod = aChunk.lodLevel ?? 0;
		const bLod = bChunk.lodLevel ?? 0;
		if (aLod !== bLod) return aLod - bLod;
		if (aChunk.isModified !== bChunk.isModified)
			return aChunk.isModified ? -1 : 1;
		return 0;
	}

	private swap(i: number, j: number): void {
		const a = this.heap[i];
		const b = this.heap[j];
		this.heap[i] = b;
		this.heap[j] = a;
		this.positions.set(b, i);
		this.positions.set(a, j);
	}

	private less(i: number, j: number): boolean {
		const a = this.heap[i];
		const b = this.heap[j];
		const aPriority = this.priorities.get(a) ?? false;
		const bPriority = this.priorities.get(b) ?? false;
		return RemeshHeap.comparePriority(a, aPriority, b, bPriority) < 0;
	}

	private siftUp(i: number): void {
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (!this.less(i, parent)) break;
			this.swap(i, parent);
			i = parent;
		}
	}

	private siftDown(i: number): void {
		const n = this.heap.length;
		while (true) {
			const left = i * 2 + 1;
			const right = left + 1;
			let smallest = i;
			if (left < n && this.less(left, smallest)) smallest = left;
			if (right < n && this.less(right, smallest)) smallest = right;
			if (smallest === i) break;
			this.swap(i, smallest);
			i = smallest;
		}
	}

	private pushInternal(chunk: Chunk): void {
		const idx = this.heap.length;
		this.heap.push(chunk);
		this.positions.set(chunk, idx);
		this.siftUp(idx);
	}

	pop(): Chunk | undefined {
		const n = this.heap.length;
		if (n === 0) return undefined;
		const top = this.heap[0];
		this.positions.delete(top);
		const last = this.heap.pop()!;
		if (n > 1) {
			this.heap[0] = last;
			this.positions.set(last, 0);
			this.siftDown(0);
		}
		return top;
	}

	// O(log n) removal of an arbitrary chunk (used by chunk disposal so a
	// disposed chunk's reference is dropped immediately instead of lingering
	// as a tombstone until it's naturally dequeued). Also drops the priority
	// flag so `has()` goes false in one call.
	remove(chunk: Chunk): void {
		const idx = this.positions.get(chunk);
		if (idx === undefined) {
			// Still drop a stale priority flag if the heap entry is gone but
			// the flag lingered (defensive; callers historically deleted both).
			this.priorities.delete(chunk);
			return;
		}
		this.positions.delete(chunk);
		this.priorities.delete(chunk);
		const last = this.heap.pop()!;
		if (idx < this.heap.length) {
			this.heap[idx] = last;
			this.positions.set(last, idx);
			// The replacement could violate the heap property in either
			// direction relative to its new position, so try both.
			this.siftDown(idx);
			this.siftUp(idx);
		}
	}

	insert(chunk: Chunk, priority: boolean): void {
		const existing = this.priorities.get(chunk);
		if (existing !== undefined) {
			if (priority && !existing) {
				this.priorities.set(chunk, true);
				const idx = this.positions.get(chunk);
				// Priority went false -> true, which can only move the chunk
				// closer to the root, so sift-up alone suffices.
				if (idx !== undefined) this.siftUp(idx);
			}
			return;
		}
		this.priorities.set(chunk, priority);
		this.pushInternal(chunk);
	}
}
