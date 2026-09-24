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

const WIDTH = 5;
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
		const required = this.length + WIDTH;
		if (required > this.data.length) this.grow(required);

		let offset = this.length;
		this.data[offset++] = x;
		this.data[offset++] = y;
		this.data[offset++] = z;
		this.data[offset++] = oldPacked;
		this.data[offset++] = newPacked;
		this.length = offset;
	}

	payload(): Uint32Array {
		return this.length === this.data.length
			? this.data
			: this.data.subarray(0, this.length);
	}

	private grow(required: number): void {
		let capacity = this.data.length || INITIAL_CAPACITY;
		while (capacity < required) capacity *= 2;
		const expanded = new Uint32Array(capacity);
		expanded.set(this.data);
		this.data = expanded;
	}
}

const dirtyChunks = new Set<Chunk>();
const pendingMutations = new Map<Chunk, LightMutationBuffer>();
let batchDepth = 0;

function flush(pool: ChunkLightPool | null): void {
	if (pool === null) {
		pendingMutations.clear();
		return;
	}

	for (const [chunk, mutations] of pendingMutations) {
		if (mutations.length === 0) continue;
		pool.postLightMutateBatch({
			chunkId: chunk.id,
			headerSlot: chunk.lightHeaderSlot,
			muts: mutations.payload(),
			seq: pool.nextLightSeq(),
		});
	}
	pendingMutations.clear();
}

export function beginChunkEditBatch(): void {
	batchDepth++;
}

export function endChunkEditBatch(pool: ChunkLightPool | null): void {
	const depth = --batchDepth;
	if (depth > 0) return;
	if (depth < 0) {
		batchDepth = 0;
		return;
	}

	flush(pool);
	if (dirtyChunks.size === 0) return;

	for (const chunk of dirtyChunks) {
		if (!chunk.isLoaded) continue;
		chunk.clearCachedLODMeshes();
		chunk.scheduleRemesh(true);
	}
	dirtyChunks.clear();
}

export function markChunkDirtyForRemesh(chunk: Chunk | null | undefined): void {
	if (chunk === null || chunk === undefined) return;
	if (batchDepth > 0) {
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
	if (batchDepth > 0) {
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
