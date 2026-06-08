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
	bumpLightVersion,
	type ChunkViewRegistry,
	createRegistry,
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
}

function handleUnregisterChunk(req: LightUnregisterChunkRequest): void {
	if (!state.registry) return;
	pendingMutations.delete(req.chunkId);
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
	updateChunkBuffers(state.registry, req.chunkId, {
		block_array: block_array as Uint8Array | Uint16Array | null,
		palette,
		light_array,
	});
}

function handleMutate(req: LightMutateRequest): void {
	if (!state.registry) return;
	const view = state.registry.views.get(req.chunkId);
	if (!view || !view.isLoaded) {
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
		req.chunkId,
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
	const view = state.registry.views.get(req.chunkId);
	if (!view || !view.isLoaded) return;
	const dirty = new Set<number>();
	addLightAt(state.registry, view, req.x, req.y, req.z, req.level, dirty);
	for (const slot of dirty) bumpLightVersion(state.registry, slot);
	postDirty(req.seq, dirty);
}

function handleSkyReconcile(req: LightSkyReconcileRequest): void {
	if (!state.registry) return;
	const dirty = lightSkyReconcile(state.registry, req.chunkId);
	for (const slot of dirty) bumpLightVersion(state.registry, slot);
	postDirty(req.seq, dirty);
}

function handlePropagateDeferred(req: LightPropagateDeferredRequest): void {
	if (!state.registry) return;
	const dirty = propagateDeferred(state.registry, req.chunkId, {
		queue: req.seedQueue,
		length: req.seedLength,
	});
	for (const slot of dirty) bumpLightVersion(state.registry, slot);
	postDirty(req.seq, dirty);
}

export const LightTaskHandlers = {
	handleInitLightShared,
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
	},
	_getRegistryForTests(): ChunkViewRegistry | null {
		return state.registry;
	},
};

// Export a tiny runtime tag so the chunk.worker.ts switch can detect that
// this module is loaded and the header SAB is initialised.
export const LIGHT_HEADER_ROW_SIZE_EXPORT = LIGHT_HEADER_ROW_SIZE;
export const MAX_HEADER_SLOTS_EXPORT = MAX_HEADER_SLOTS;
