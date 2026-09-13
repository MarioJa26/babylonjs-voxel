// ---------------------------------------------------------------------------
// LightTaskHandlers
//
// Per-worker handler for all Light* task messages.  Imported by
// chunk.worker.ts.  Owns the worker's local ChunkViewRegistry.
// ---------------------------------------------------------------------------

import type {
	InitLightSharedRequest,
	LightAddEmissionRequest,
	LightDirtyMessage,
	LightMutateBatchRequest,
	LightMutateRequest,
	LightPropagateDeferredRequest,
	LightRegisterChunkBatchRequest,
	LightRegisterChunkRequest,
	LightSetClosedFaceMaskRequest,
	LightSkyReconcileRequest,
	LightUnregisterChunkBatchRequest,
	LightUnregisterChunkRequest,
	LightUpdateChunkBuffersRequest,
} from "../DataStructures/WorkerMessageType";
import { WorkerTaskType } from "../DataStructures/WorkerMessageType";
import {
	LIGHT_HEADER_ROW_SIZE,
	MAX_HEADER_SLOTS,
	wrapLightHeader,
} from "./ChunkLightHeader";
import {
	addLightAt,
	applyClosedFaceMaskLUT,
	bumpLightVersion,
	type ChunkViewRegistry,
	createRegistry,
	DirtySlotSet,
	lightBlockReconcile,
	lightMutate,
	lightSkyReconcile,
	propagateDeferred,
	registerChunk,
	unregisterChunk,
	updateChunkBuffers,
} from "./LightCore";

type LightState = {
	registry: ChunkViewRegistry | null;
};

const state: LightState = { registry: null };

// PERF: worker-local reusable dirty-slot accumulator — avoids a per-message
// allocation in handleRegisterChunk / handleAddEmission / handleSkyReconcile.
// Safe because the worker is single-threaded and postDirty consumes the set
// synchronously before it is cleared again (mirrors LightCore's scratch pattern).
const _dirtyScratch = new DirtySlotSet();

// Pending LightMutate requests that arrived before the target chunk was
// registered.  Replayed in handleRegisterChunk once the chunk view exists.
const pendingMutations = new Map<bigint, LightMutateRequest[]>();
const MAX_PENDING_PER_CHUNK = 100;

// Pending deferred-light seed queues that arrived before the target chunk
// was registered (the main thread may post LightPropagateDeferred before
// LightRegisterChunk finishes).  Replayed in handleRegisterChunk once the
// chunk view exists, so the BFS refinement is never silently dropped.
const pendingDeferredSeeds = new Map<
	bigint,
	{ queue: Uint16Array; length: number }
>();
const MAX_PENDING_SEEDS = 256;

/**
 * Wrap a SharedArrayBuffer as the appropriate TypedArray view based on
 * its byte length.  Mirrors the (size, 1-or-2) layout used by Chunk.
 */
function viewForBuffer(
	sab: SharedArrayBuffer,
	bytesPerElement: 1 | 2,
	length: number,
): Uint8Array | Uint16Array {
	return bytesPerElement === 2
		? new Uint16Array(sab, 0, length)
		: new Uint8Array(sab, 0, length);
}
function getLoadedView(
	registry: ChunkViewRegistry,
	headerSlot: number,
	chunkId: bigint,
) {
	if (headerSlot < 0 || headerSlot >= MAX_HEADER_SLOTS) {
		return undefined;
	}

	const view = registry.bySlot[headerSlot];

	if (!view || view.chunkId !== chunkId || !view.isLoaded) {
		return undefined;
	}

	return view;
}

function ensureState(req: InitLightSharedRequest | null): ChunkViewRegistry {
	if (state.registry) return state.registry;
	if (!req) {
		throw new Error(
			"LightTaskHandlers invoked before InitLightShared; cannot build registry.",
		);
	}
	state.registry = createRegistry(wrapLightHeader(req.headerBuffer));
	return state.registry;
}

// PERF: bumps each slot's light version and fills the transfer array in a
// single Set iteration (callers previously iterated twice: once for the bump,
// once for the fill). The buffer is transferred zero-copy to the main thread;
// a per-message allocation is inherent without a return channel, so no pool.
function postDirty(
	seq: number,
	dirtySlots: DirtySlotSet,
	registry: ChunkViewRegistry,
): void {
	const count = dirtySlots.size;
	if (count === 0) return;

	const arr = new Uint32Array(count);
	let i = 0;

	// Direct iteration avoids Iterator object allocation overhead
	dirtySlots.forEach((slot) => {
		bumpLightVersion(registry, slot);
		arr[i++] = slot;
	});

	const msg: LightDirtyMessage = {
		type: WorkerTaskType.LightDirty,
		seq,
		dirtySlots: arr,
	};
	self.postMessage(msg, [arr.buffer]);
}

function handleInitLightShared(req: InitLightSharedRequest): void {
	ensureState(req);
	self.postMessage({ type: WorkerTaskType.InitLightShared });
}

function handleSetClosedFaceMask(req: LightSetClosedFaceMaskRequest): void {
	if (!state.registry) return;
	const lut = new Uint8Array(req.maskBuffer);
	applyClosedFaceMaskLUT(lut);
	self.postMessage({ type: WorkerTaskType.LightSetClosedFaceMask });
}

type LightRegisterChunkFields = Omit<LightRegisterChunkRequest, "type">;

function registerChunkFields(fields: LightRegisterChunkFields): void {
	const registry = ensureState(null);

	const block_array = fields.blockSAB
		? viewForBuffer(
				fields.blockSAB,
				fields.blockStorageBytesPerElement,
				fields.blockSAB.byteLength / fields.blockStorageBytesPerElement,
			)
		: null;
	const palette = fields.paletteSAB
		? new Uint16Array(fields.paletteSAB, 0, fields.paletteSAB.byteLength / 2)
		: null;
	const light_array = new Uint8Array(
		fields.lightSAB,
		0,
		fields.lightSAB.byteLength,
	);

	registerChunk(registry, {
		chunkId: fields.chunkId,
		chunkX: fields.chunkX,
		chunkY: fields.chunkY,
		chunkZ: fields.chunkZ,
		headerSlot: fields.headerSlot,
		block_array,
		palette,
		light_array,
	});

	// Replay light mutations that arrived before this chunk was registered.
	const queue = pendingMutations.get(fields.chunkId);
	if (queue) {
		pendingMutations.delete(fields.chunkId);
		for (let i = 0; i < queue.length; i++) {
			handleMutate(queue[i]);
		}
	}

	// Replay the deferred-light BFS that arrived before registration.
	const dirty = _dirtyScratch;
	dirty.clear();

	const seedState = pendingDeferredSeeds.get(fields.chunkId);
	if (seedState && seedState.length > 0) {
		pendingDeferredSeeds.delete(fields.chunkId);
		propagateDeferred(registry, fields.headerSlot, seedState).forEach(
			(slot) => {
				dirty.add(slot);
			},
		);
	}

	// Reconcile block light after registration (cheap: border faces only).
	// The full-volume sky reconcile is skipped when the main thread flagged
	// the chunk for deferred lighting — that pipeline always ends with an
	// explicit LightSkyReconcile request, so scanning all 32k voxels here as
	// well doubles the most expensive pass on the light worker.
	lightBlockReconcile(registry, fields.headerSlot).forEach((slot) => {
		dirty.add(slot);
	});
	if (!fields.skipSkyReconcile) {
		lightSkyReconcile(registry, fields.headerSlot).forEach((slot) => {
			dirty.add(slot);
		});
	}

	if (dirty.size > 0) {
		postDirty(fields.seq, dirty, registry);
	}
}

function handleRegisterChunk(req: LightRegisterChunkRequest): void {
	registerChunkFields(req);
}

function handleRegisterChunkBatch(req: LightRegisterChunkBatchRequest): void {
	const chunks = req.chunks;
	for (let i = 0; i < chunks.length; i++) {
		registerChunkFields(chunks[i]);
	}
}

function handleUnregisterChunk(req: LightUnregisterChunkRequest): void {
	if (!state.registry) return;
	pendingMutations.delete(req.chunkId);
	pendingDeferredSeeds.delete(req.chunkId);
	unregisterChunk(state.registry, req.chunkId);
}

function handleUnregisterChunkBatch(
	req: LightUnregisterChunkBatchRequest,
): void {
	if (!state.registry) return;
	const ids = req.chunkIds;
	for (let i = 0; i < ids.length; i++) {
		const id = ids[i];
		pendingMutations.delete(id);
		pendingDeferredSeeds.delete(id);
		unregisterChunk(state.registry, id);
	}
}

function handleUpdateBuffers(req: LightUpdateChunkBuffersRequest): void {
	if (!state.registry) return;
	const block_array = req.blockSAB
		? viewForBuffer(
				req.blockSAB,
				req.blockStorageBytesPerElement,
				req.blockSAB.byteLength / req.blockStorageBytesPerElement,
			)
		: null;
	const palette = req.paletteSAB
		? new Uint16Array(req.paletteSAB, 0, req.paletteSAB.byteLength / 2)
		: null;
	const light_array = new Uint8Array(req.lightSAB, 0, req.lightSAB.byteLength);
	updateChunkBuffers(state.registry, req.headerSlot, {
		block_array: block_array as Uint8Array | Uint16Array | null,
		palette,
		light_array,
	});
}

function handleMutate(req: LightMutateRequest): void {
	const registry = state.registry;
	if (!registry) return;

	const view = getLoadedView(registry, req.headerSlot, req.chunkId);

	if (!view) {
		let queue = pendingMutations.get(req.chunkId);

		if (!queue) {
			queue = [];
			pendingMutations.set(req.chunkId, queue);
		}

		if (queue.length < MAX_PENDING_PER_CHUNK) {
			queue.push(req);
		}

		return;
	}

	const dirty = lightMutate(
		registry,
		req.headerSlot,
		req.x,
		req.y,
		req.z,
		req.oldPacked,
		req.newPacked,
	);

	postDirty(req.seq, dirty, registry);
}

/**
 * Batched variant of handleMutate: runs the same lightMutate core per entry
 * and merges dirty slots into a single LightDirty reply. lightMutate
 * returns shared scratch (cleared per call), so each result is copied into
 * the batch accumulator before the next iteration. Entries for a chunk
 * whose view is not loaded fall back to the pendingMutations replay queue
 * with the same cap as single requests.
 */
export function handleMutateBatch(req: LightMutateBatchRequest): void {
	const registry = state.registry;
	if (!registry) return;

	const muts = req.muts;
	const view = getLoadedView(registry, req.headerSlot, req.chunkId);

	if (!view) {
		let queue = pendingMutations.get(req.chunkId);

		if (!queue) {
			queue = [];
			pendingMutations.set(req.chunkId, queue);
		}

		for (
			let i = 0;
			i + 4 < muts.length && queue.length < MAX_PENDING_PER_CHUNK;
			i += 5
		) {
			queue.push({
				type: WorkerTaskType.LightMutate,
				chunkId: req.chunkId,
				headerSlot: req.headerSlot,
				x: muts[i],
				y: muts[i + 1],
				z: muts[i + 2],
				oldPacked: muts[i + 3],
				newPacked: muts[i + 4],
				seq: req.seq,
			});
		}

		return;
	}

	_dirtyScratch.clear();
	for (let i = 0; i + 4 < muts.length; i += 5) {
		const dirty = lightMutate(
			registry,
			req.headerSlot,
			muts[i],
			muts[i + 1],
			muts[i + 2],
			muts[i + 3],
			muts[i + 4],
		);
		dirty.forEach((slot) => _dirtyScratch.add(slot));
	}

	postDirty(req.seq, _dirtyScratch, registry);
}
function handleAddEmission(req: LightAddEmissionRequest): void {
	const registry = state.registry;
	if (!registry) return;

	const view = getLoadedView(registry, req.headerSlot, req.chunkId);

	if (!view) return;

	const dirty = _dirtyScratch;
	dirty.clear();

	addLightAt(registry, view, req.x, req.y, req.z, req.level, dirty);

	postDirty(req.seq, dirty, registry);
}

function handleSkyReconcile(req: LightSkyReconcileRequest): void {
	if (!state.registry) return;
	const dirty = _dirtyScratch;
	dirty.clear();
	// forEach, not for..of: iterating DirtySlotSet allocates an iterator
	// object per loop (it ships forEach precisely to avoid that).
	lightSkyReconcile(state.registry, req.headerSlot).forEach((slot) => {
		dirty.add(slot);
	});
	lightBlockReconcile(state.registry, req.headerSlot).forEach((slot) => {
		dirty.add(slot);
	});
	postDirty(req.seq, dirty, state.registry);
}

function handlePropagateDeferred(req: LightPropagateDeferredRequest): void {
	const registry = state.registry;
	if (!registry) return;

	const view = getLoadedView(registry, req.headerSlot, req.chunkId);

	if (!view) {
		if (pendingDeferredSeeds.size < MAX_PENDING_SEEDS) {
			pendingDeferredSeeds.set(req.chunkId, {
				queue: req.seedQueue,
				length: req.seedLength,
			});
		}
		return;
	}

	const dirty = propagateDeferred(registry, req.headerSlot, {
		queue: req.seedQueue,
		length: req.seedLength,
	});

	postDirty(req.seq, dirty, registry);
}

export const LightTaskHandlers = {
	handleInitLightShared,
	handleSetClosedFaceMask,
	handleRegisterChunk,
	handleRegisterChunkFields: registerChunkFields,
	handleRegisterChunkBatch,
	handleUnregisterChunk,
	handleUnregisterChunkBatch,
	handleUpdateBuffers,
	handleMutate,
	handleMutateBatch,
	handleAddEmission,
	handleSkyReconcile,
	handlePropagateDeferred,
	// Test-only helpers — not used from chunk.worker.ts at runtime.
	_resetStateForTests(): void {
		state.registry = null;
		pendingMutations.clear();
		pendingDeferredSeeds.clear();
	},
	_getRegistryForTests(): ChunkViewRegistry | null {
		return state.registry;
	},
};

// Export a tiny runtime tag so the chunk.worker.ts switch can detect that
// this module is loaded and the header SAB is initialised.
export const LIGHT_HEADER_ROW_SIZE_EXPORT = LIGHT_HEADER_ROW_SIZE;
export const MAX_HEADER_SLOTS_EXPORT = MAX_HEADER_SLOTS;
