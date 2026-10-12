import type { Chunk } from "../Chunk";
import { packCoords } from "../DataStructures/ChunkCoords";
import { forgetChunkRequest } from "../Loading/ChunkPipeline";

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

/*
 * Packed-coord keys of every chunk dirtied since the last drain, in insertion
 * order. Parallel to `dirtyChunks` but keyed by chunk id so callers can act on
 * a batch's footprint without holding Chunk references.
 */
let dirtyChunkIds: bigint[] = [];

/**
 * What one block mutation (or a batch of them) actually dirtied.
 *
 * PERF/RATIONALE: a mutation used to return nothing, so the only way to learn
 * its footprint was to observe which chunks later got remeshed — by which time
 * the information is useless for deciding HOW to remesh them. A consumer that
 * wants to schedule one remesh per merged group, or request ranged GPU
 * updates, has to rediscover the affected set itself.
 *
 * `connectivityChanged` matters because fences and other dynamic shapes need
 * their neighbour recomputed; a mutation that cannot affect connectivity can
 * skip that queue entirely.
 */
export interface BlockMutationResult {
	/**
	 * Packed coords of every dirtied chunk, deduplicated, including
	 * face-adjacent neighbours across chunk borders.
	 *
	 * Empty unless `beginMutationScope()` was active, which is what makes this
	 * allocation-free in the common single-edit case.
	 */
	affectedChunks: readonly bigint[];
	/** The mutation crossed a chunk border or triggered a light propagation. */
	lightingChanged: boolean;
	/** Dynamic connected geometry (fences, etc.) may have changed. */
	connectivityChanged: boolean;
	/**
	 * The caller cannot be told to rebuild everything.
	 *
	 * Reserved for the case where the mutation invalidates geometry that cannot
	 * be expressed as a bounded dirty range — currently never set, because the
	 * mesher always regenerates the whole group and only the UPLOAD is ranged.
	 * Kept so the shape is stable if that changes.
	 */
	fullRemeshRequired: boolean;
}

const EMPTY_CHUNK_IDS: readonly bigint[] = [];

const EMPTY_RESULT: BlockMutationResult = {
	affectedChunks: EMPTY_CHUNK_IDS,
	lightingChanged: false,
	connectivityChanged: false,
	fullRemeshRequired: false,
};

let mutationScopeDepth = 0;
let scopeLightingChanged = false;
let scopeConnectivityChanged = false;

/**
 * Begin collecting the dirty footprint of subsequent mutations.
 *
 * Nestable. Only the outermost scope produces a result. Without an active
 * scope, {@link markChunkDirtyForRemesh} returns the shared EMPTY_RESULT — so
 * the per-edit hot path allocates nothing.
 */
export function beginMutationScope(): void {
	mutationScopeDepth++;
}

/**
 * End a mutation scope and report what it dirtied.
 *
 * @returns The accumulated footprint, or the shared empty result when no scope
 *   was active.
 */
export function endMutationScope(): BlockMutationResult {
	if (mutationScopeDepth === 0) return EMPTY_RESULT;

	mutationScopeDepth--;

	if (mutationScopeDepth !== 0) return EMPTY_RESULT;

	const affected = dirtyChunkIds.length === 0 ? EMPTY_CHUNK_IDS : dirtyChunkIds;
	const lightingChanged = scopeLightingChanged;
	const connectivityChanged = scopeConnectivityChanged;

	// Detach before returning: the caller receives ownership of this array, and
	// a later mutation must not append into memory the caller still holds.
	dirtyChunkIds = [];
	scopeLightingChanged = false;
	scopeConnectivityChanged = false;

	return {
		affectedChunks: affected,
		lightingChanged,
		connectivityChanged,
		fullRemeshRequired: false,
	};
}

/** Record that the mutation in progress crossed a chunk border. */
export function noteMutationLightingChanged(): void {
	if (mutationScopeDepth !== 0) scopeLightingChanged = true;
}

/** Record that the mutation in progress may have changed dynamic connectivity. */
export function noteMutationConnectivityChanged(): void {
	if (mutationScopeDepth !== 0) scopeConnectivityChanged = true;
}

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

export function markChunkDirtyForRemesh(
	chunk: Chunk | null | undefined,
): BlockMutationResult {
	if (chunk == null) return EMPTY_RESULT;

	if (batchDepth !== 0) {
		dirtyChunks.add(chunk);

		// Packed COORDS, not `chunk.id`. The id is a pool identity that is
		// reused across chunk generations, so two different chunks in the same
		// batch could collide, and a consumer keying resident state by id would
		// read another chunk's tier.
		if (mutationScopeDepth !== 0) {
			dirtyChunkIds.push(packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ));
		}

		return EMPTY_RESULT;
	}

	chunk.clearCachedLODMeshes();
	chunk.scheduleRemesh(true);

	return EMPTY_RESULT;
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

	// Drop any in-flight latency pairing too. A chunk unloaded before it was
	// ever meshed would otherwise hold its entry until the stale reaper runs.
	forgetChunkRequest(packCoords(chunk.chunkX, chunk.chunkY, chunk.chunkZ));
}
