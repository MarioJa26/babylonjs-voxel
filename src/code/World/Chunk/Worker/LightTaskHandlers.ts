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
	LightMutateRequest,
	LightPropagateDeferredRequest,
	LightRegisterChunkRequest,
	LightSetClosedFaceMaskRequest,
	LightSkyReconcileRequest,
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

function postDirty(seq: number, dirtySlots: Set<number>): void {
	if (dirtySlots.size === 0) return;
	const arr = new Uint32Array(dirtySlots.size);
	let i = 0;
	for (const slot of dirtySlots) {
		arr[i++] = slot;
	}
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

function handleRegisterChunk(req: LightRegisterChunkRequest): void {
	const registry = ensureState(null);

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

	registerChunk(registry, {
		chunkId: req.chunkId,
		chunkX: req.chunkX,
		chunkY: req.chunkY,
		chunkZ: req.chunkZ,
		headerSlot: req.headerSlot,
		block_array,
		palette,
		light_array,
	});

	// Replay light mutations that arrived before this chunk was registered.
	const queue = pendingMutations.get(req.chunkId);
	if (queue) {
		pendingMutations.delete(req.chunkId);
		for (const mutation of queue) {
			handleMutate(mutation);
		}
	}

	// Replay the deferred-light BFS that arrived before registration, so the
	// refinement is never dropped.  Runs before the reconciles so they see
	// the post-BFS light values (same order as the normal pump path).
	const dirty = new Set<number>();
	const seedState = pendingDeferredSeeds.get(req.chunkId);
	if (seedState && seedState.length > 0) {
		pendingDeferredSeeds.delete(req.chunkId);
		for (const slot of propagateDeferred(registry, req.headerSlot, seedState)) {
			dirty.add(slot);
		}
	}

	// Reconcile both block and sky light after registration.
	// Catches propagation that was skipped earlier because this chunk
	// was not visible in the worker registry yet.
	for (const slot of lightBlockReconcile(registry, req.headerSlot)) {
		dirty.add(slot);
	}
	for (const slot of lightSkyReconcile(registry, req.headerSlot)) {
		dirty.add(slot);
	}
	if (dirty.size > 0) {
		for (const slot of dirty) bumpLightVersion(registry, slot);
		postDirty(req.seq, dirty);
	}
}

function handleUnregisterChunk(req: LightUnregisterChunkRequest): void {
	if (!state.registry) return;
	pendingMutations.delete(req.chunkId);
	pendingDeferredSeeds.delete(req.chunkId);
	unregisterChunk(state.registry, req.chunkId);
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
	if (!state.registry) return;
	const view =
		req.headerSlot >= 0 && req.headerSlot < MAX_HEADER_SLOTS
			? state.registry.bySlot[req.headerSlot]
			: undefined;
	if (!view || view.chunkId !== req.chunkId || !view.isLoaded) {
		// Chunk not yet registered (mid-terrain-generation); replay later.
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
		state.registry,
		req.headerSlot,
		req.x,
		req.y,
		req.z,
		req.oldPacked,
		req.newPacked,
	);
	for (const slot of dirty) bumpLightVersion(state.registry, slot);
	postDirty(req.seq, dirty);
}

function handleAddEmission(req: LightAddEmissionRequest): void {
	if (!state.registry) return;
	const view =
		req.headerSlot >= 0 && req.headerSlot < MAX_HEADER_SLOTS
			? state.registry.bySlot[req.headerSlot]
			: undefined;
	if (!view || view.chunkId !== req.chunkId || !view.isLoaded) return;
	const dirty = new Set<number>();
	addLightAt(state.registry, view, req.x, req.y, req.z, req.level, dirty);
	for (const slot of dirty) bumpLightVersion(state.registry, slot);
	postDirty(req.seq, dirty);
}

function handleSkyReconcile(req: LightSkyReconcileRequest): void {
	if (!state.registry) return;
	const dirty = new Set<number>();
	for (const slot of lightSkyReconcile(state.registry, req.headerSlot)) {
		dirty.add(slot);
	}
	for (const slot of lightBlockReconcile(state.registry, req.headerSlot)) {
		dirty.add(slot);
	}
	for (const slot of dirty) bumpLightVersion(state.registry, slot);
	postDirty(req.seq, dirty);
}

function handlePropagateDeferred(req: LightPropagateDeferredRequest): void {
	if (!state.registry) return;
	const view =
		req.headerSlot >= 0 && req.headerSlot < MAX_HEADER_SLOTS
			? state.registry.bySlot[req.headerSlot]
			: undefined;
	if (!view || view.chunkId !== req.chunkId || !view.isLoaded) {
		// Chunk not yet registered (registration may still be waiting on
		// worker-to-worker channel data); replay later in handleRegisterChunk.
		if (pendingDeferredSeeds.size < MAX_PENDING_SEEDS) {
			pendingDeferredSeeds.set(req.chunkId, {
				queue: req.seedQueue,
				length: req.seedLength,
			});
		}
		return;
	}
	const dirty = propagateDeferred(state.registry, req.headerSlot, {
		queue: req.seedQueue,
		length: req.seedLength,
	});
	for (const slot of dirty) bumpLightVersion(state.registry, slot);
	postDirty(req.seq, dirty);
}

export const LightTaskHandlers = {
	handleInitLightShared,
	handleSetClosedFaceMask,
	handleRegisterChunk,
	handleUnregisterChunk,
	handleUpdateBuffers,
	handleMutate,
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
