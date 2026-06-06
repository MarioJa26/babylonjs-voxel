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
	bumpLightVersion,
	createRegistry,
	lightMutate,
	lightSkyReconcile,
	propagateDeferred,
	registerChunk,
	type ChunkView,
	type ChunkViewRegistry,
	unregisterChunk,
	updateChunkBuffers,
} from "./LightCore";

type LightState = {
	registry: ChunkViewRegistry | null;
};

const state: LightState = { registry: null };

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
}

function handleUnregisterChunk(req: LightUnregisterChunkRequest): void {
	if (!state.registry) return;
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
	const view: ChunkView | undefined = state.registry.views.get(req.chunkId);
	if (!view) return;
	const dirty = new Set<number>();
	// Inlined "addLightAt" without the queue.push so we don't need an
	// extra public export.
	const size = 32;
	const idx = req.x + req.y * size + req.z * size * size;
	const cur = view.light_array[idx]! & 0xf;
	if (req.level > cur) {
		const newByte = (view.light_array[idx]! & 0xf0) | req.level;
		view.light_array[idx] = newByte;
		dirty.add(view.headerSlot);
	}
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
	},
	_getRegistryForTests(): ChunkViewRegistry | null {
		return state.registry;
	},
};

// Export a tiny runtime tag so the chunk.worker.ts switch can detect that
// this module is loaded and the header SAB is initialised.
export const LIGHT_HEADER_ROW_SIZE_EXPORT = LIGHT_HEADER_ROW_SIZE;
export const MAX_HEADER_SLOTS_EXPORT = MAX_HEADER_SLOTS;
