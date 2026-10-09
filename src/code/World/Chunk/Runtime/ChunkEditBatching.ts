import type { Chunk } from "../Chunk";

interface LightMutation {
	chunkId: bigint;
	headerSlot: number;
	x: number;
	y: number;
	z: number;
	oldPacked: number;
	newPacked: number;
	seq: number;
}

interface LightMutationBatch {
	chunkId: bigint;
	headerSlot: number;
	muts: Uint32Array;
	seq: number;
}

export interface ChunkLightPool {
	postLightMutate(request: LightMutation): void;
	postLightMutateBatch(request: LightMutationBatch): void;
	nextLightSeq(): number;
}

const MUTATION_WIDTH = 5;
const INITIAL_CAPACITY = 40;

class LightMutationBuffer {
	private data = new Uint32Array(INITIAL_CAPACITY);

	length = 0;

	push(
		x: number,
		y: number,
		z: number,
		oldPacked: number,
		newPacked: number,
	): void {
		const offset = this.length;
		const required = offset + MUTATION_WIDTH;

		if (required > this.data.length) {
			this.grow(required);
		}

		this.data[offset] = x;
		this.data[offset + 1] = y;
		this.data[offset + 2] = z;
		this.data[offset + 3] = oldPacked;
		this.data[offset + 4] = newPacked;
		this.length = required;
	}

	payload(): Uint32Array {
		return this.length === this.data.length
			? this.data
			: this.data.subarray(0, this.length);
	}

	private grow(required: number): void {
		let capacity = this.data.length;

		do {
			capacity *= 2;
		} while (capacity < required);

		const expanded = new Uint32Array(capacity);
		expanded.set(this.data);
		this.data = expanded;
	}
}

let dirtyChunks = new Set<Chunk>();
let pendingMutations = new Map<Chunk, LightMutationBuffer>();
let batchDepth = 0;

function flushPendingMutations(pool: ChunkLightPool | null): void {
	if (pendingMutations.size === 0) return;

	// Detach the current work before invoking external methods. Reentrant
	// mutations are collected in the new map for the next batch.
	const mutationsToFlush = pendingMutations;
	pendingMutations = new Map();

	if (pool === null) return;

	for (const [chunk, mutations] of mutationsToFlush) {
		pool.postLightMutateBatch({
			chunkId: chunk.id,
			headerSlot: chunk.lightHeaderSlot,
			muts: mutations.payload(),
			seq: pool.nextLightSeq(),
		});
	}
}

function remeshDirtyChunks(): void {
	if (dirtyChunks.size === 0) return;

	// Detach before calling chunk methods because they may synchronously mark
	// other chunks dirty.
	const chunksToRemesh = dirtyChunks;
	dirtyChunks = new Set();

	for (const chunk of chunksToRemesh) {
		if (!chunk.isLoaded) continue;

		chunk.clearCachedLODMeshes();
		chunk.scheduleRemesh(true);
	}
}

export function beginChunkEditBatch(): void {
	batchDepth++;
}

export function endChunkEditBatch(pool: ChunkLightPool | null): void {
	// Preserve the original underflow behavior without temporarily making
	// batchDepth negative.
	if (batchDepth === 0) return;

	batchDepth--;

	if (batchDepth !== 0) return;

	flushPendingMutations(pool);
	remeshDirtyChunks();
}

export function markChunkDirtyForRemesh(chunk: Chunk | null | undefined): void {
	if (chunk == null) return;

	if (batchDepth !== 0) {
		dirtyChunks.add(chunk);
		return;
	}

	chunk.clearCachedLODMeshes();
	chunk.scheduleRemesh(true);
}

export function recordLightMutation(
	chunk: Chunk,
	pool: ChunkLightPool | null,
	x: number,
	y: number,
	z: number,
	oldPacked: number,
	newPacked: number,
): void {
	if (batchDepth !== 0) {
		let mutations = pendingMutations.get(chunk);

		if (mutations === undefined) {
			mutations = new LightMutationBuffer();
			pendingMutations.set(chunk, mutations);
		}

		mutations.push(x, y, z, oldPacked, newPacked);
		return;
	}

	if (pool === null) return;

	pool.postLightMutate({
		chunkId: chunk.id,
		headerSlot: chunk.lightHeaderSlot,
		x,
		y,
		z,
		oldPacked,
		newPacked,
		seq: pool.nextLightSeq(),
	});
}

export function discardChunkEditState(chunk: Chunk): void {
	pendingMutations.delete(chunk);
	dirtyChunks.delete(chunk);
}
