import { Chunk, getChunk } from "./Chunk";
import {
	type GenerateDistantTerrainRequest,
	type InitDistantTerrainSharedRequest,
	type InitLightSharedRequest,
	type LightAddEmissionRequest,
	type LightMutateRequest,
	type LightPropagateDeferredRequest,
	type LightSetClosedFaceMaskRequest,
	type LightSkyReconcileRequest,
	type MeshWorkerResponse,
	type RelightMeshRequest,
	type WorkerResponseData,
	WorkerTaskType,
} from "./DataStructures/WorkerMessageType";

// P2.4: Versioned cache entry for a decoded block border slab (see
// ChunkWorker._slabCache below). Validated against (generation, blockRevision)
// so disposed-and-recreated chunks (reused chunk ids) and block mutations can
// never serve stale borders.
type SlabCacheEntry = {
	generation: number;
	blockRevision: number;
	borders: (Uint16Array | undefined)[];
};

export class ChunkWorker {
	private terrainWorker: Worker; // terrain + distant terrain + light
	private voxelWorker: Worker; // voxel mesh

	private distantTerrainSharedInitialized = false;
	private lightSharedInitialized = false;

	// P2.4: Versioned cache of decoded block border slabs for palette-encoded
	// neighbor chunks. The palette nibble-decode in postFullRemesh is the most
	// expensive per-neighbor work of the dispatch, and it is pure re-decoding:
	// during light-propagation cascades the same chunk is remeshed repeatedly
	// while its BLOCK borders never change. Entries are validated against
	// (generation, blockRevision) — see Chunk's docs — and bounded by
	// _MAX_SLAB_CACHE_ENTRIES (LRU-ish: Map iteration order = insertion order,
	// oldest deleted first). Light borders are NOT cached: the light grid is a
	// worker-mutated SharedArrayBuffer with no reliable main-thread version.
	private readonly _slabCache = new Map<bigint, SlabCacheEntry>();
	private static readonly _MAX_SLAB_CACHE_ENTRIES = 64;

	// Reusable scratch for remesh dispatch — avoids per-call allocation of the
	// 26-neighbor arrays and their border slabs. The border/light SCRATCH
	// buffers are reused across calls to build up each neighbor's values
	// without allocating; what actually gets posted to the worker is a
	// right-sized *slice* of the valid portion (see postFullRemesh), never
	// the scratch buffer itself.
	private readonly _neighborScratch: (Uint16Array | undefined)[] = new Array(
		27,
	);
	private readonly _neighborLightScratch: (Uint8Array | undefined)[] =
		new Array(27);
	private static readonly _MAX_BORDER = Chunk.SIZE * Chunk.SIZE;
	private readonly _neighborBorderScratch: Uint16Array[] = Array.from(
		{ length: 27 },
		() => new Uint16Array(ChunkWorker._MAX_BORDER),
	);
	private readonly _neighborLightBorderScratch: Uint8Array[] = Array.from(
		{ length: 27 },
		() => new Uint8Array(ChunkWorker._MAX_BORDER),
	);
	// PERF: reused across postFullRemesh calls instead of allocating a fresh
	// Transferable[] every dispatch — same reasoning as _neighborScratch etc.
	private readonly _transferScratch: Transferable[] = [];

	// Pre-allocated message objects for light dispatch — avoids spread allocation per call.
	readonly #lightMutateMsg: LightMutateRequest = {
		type: WorkerTaskType.LightMutate,
		chunkId: 0n,
		headerSlot: 0,
		x: 0,
		y: 0,
		z: 0,
		oldPacked: 0,
		newPacked: 0,
		seq: 0,
	};
	readonly #lightEmissionMsg: LightAddEmissionRequest = {
		type: WorkerTaskType.LightAddEmission,
		chunkId: 0n,
		headerSlot: 0,
		x: 0,
		y: 0,
		z: 0,
		level: 0,
		seq: 0,
	};
	readonly #lightSkyReconcileMsg: LightSkyReconcileRequest = {
		type: WorkerTaskType.LightSkyReconcile,
		chunkId: 0n,
		headerSlot: 0,
		seq: 0,
	};
	readonly #lightPropagateMsg: LightPropagateDeferredRequest = {
		type: WorkerTaskType.LightPropagateDeferred,
		chunkId: 0n,
		headerSlot: 0,
		seedQueue: new Uint16Array(0),
		seedLength: 0,
		seq: 0,
	};

	// PERF: same "preallocate + mutate fields" pattern as the light messages
	// above, applied to the voxel-mesh remesh dispatch. postMessage performs
	// structured clone synchronously before returning, so mutating this
	// object again on the next call (after the previous postMessage already
	// returned) is safe — it's the same reasoning already relied on for
	// #lightMutateMsg etc. Saves one object allocation per remesh dispatch.
	readonly #voxelMeshMsg: {
		type: WorkerTaskType.GenerateFullMesh;
		chunkId: bigint;
		meshRevision: number;
		lod: number;
		chunk_size: number;
		block_array: Uint8Array | Uint16Array | null;
		uniformBlockId: number | undefined;
		palette: Uint8Array | Uint16Array | null | undefined;
		light_array: Uint8Array | undefined;
		neighbors: (Uint16Array | undefined)[];
		neighborLights: (Uint8Array | undefined)[];
		generation: number;
		blockRevision: number;
	} = {
		type: WorkerTaskType.GenerateFullMesh,
		chunkId: 0n,
		meshRevision: 0,
		lod: 0,
		chunk_size: Chunk.SIZE,
		block_array: new Uint8Array(0),
		uniformBlockId: undefined,
		palette: undefined,
		light_array: undefined,
		neighbors: this._neighborScratch,
		neighborLights: this._neighborLightScratch,
		generation: -1,
		blockRevision: -1,
	};

	readonly #relightMeshMsg: RelightMeshRequest = {
		type: WorkerTaskType.RelightMesh,
		chunkId: 0n,
		meshRevision: 0,
		lod: 0,
		chunk_size: Chunk.SIZE,
		generation: -1,
		blockRevision: -1,
		light_array: new Uint8Array(0),
		neighborLights: this._neighborLightScratch,
	};

	constructor(
		workerIndex: number,
		onMessageTerrain: (event: MessageEvent<WorkerResponseData>) => void,
		onMessageMesh: (event: MessageEvent<MeshWorkerResponse>) => void,
	) {
		// Terrain / distant terrain / lighting worker
		this.terrainWorker = new Worker(
			new URL("./chunk.worker.ts", import.meta.url),
			{ type: "module", name: `chunk-terrain-${workerIndex}` },
		);
		this.terrainWorker.onmessage = onMessageTerrain;

		// Voxel mesh worker
		this.voxelWorker = new Worker(
			new URL("./voxel.worker.ts", import.meta.url),
			{ type: "module", name: `chunk-voxel-${workerIndex}` },
		);
		this.voxelWorker.onmessage = (e) => onMessageMesh(e);
	}

	public setOnError(handler: (ev: ErrorEvent | Event) => void): void {
		this.terrainWorker.onerror = handler;
		this.voxelWorker.onerror = handler;
	}

	public terminate(): void {
		this.distantTerrainSharedInitialized = false;
		this.terrainWorker.terminate();
		this.voxelWorker.terminate();
	}

	private static readonly _REMESH_OFFSETS: readonly {
		readonly dx: number;
		readonly dy: number;
		readonly dz: number;
		readonly faceIdx: number;
	}[] = (() => {
		const out: { dx: number; dy: number; dz: number; faceIdx: number }[] = [];
		for (let z = -1; z <= 1; z++) {
			for (let y = -1; y <= 1; y++) {
				for (let x = -1; x <= 1; x++) {
					if (x === 0 && y === 0 && z === 0) continue;
					const nz = (x !== 0 ? 1 : 0) + (y !== 0 ? 1 : 0) + (z !== 0 ? 1 : 0);
					let faceIdx = -1;
					if (nz === 1)
						faceIdx =
							x === 1
								? 0
								: x === -1
									? 1
									: y === 1
										? 2
										: y === -1
											? 3
											: z === 1
												? 4
												: 5;
					out.push({ dx: x, dy: y, dz: z, faceIdx });
				}
			}
		}
		return out;
	})();

	public postFullRemesh(chunk: Chunk, forcedLod?: number): void {
		const neighbors = this._neighborScratch;
		const cx = chunk.chunkX;
		const cy = chunk.chunkY;
		const cz = chunk.chunkZ;
		const size = Chunk.SIZE;
		const size2 = size * size;

		for (let i = 0; i < ChunkWorker._REMESH_OFFSETS.length; i++) {
			const { dx, dy, dz } = ChunkWorker._REMESH_OFFSETS[i];
			// Number-keyed lookup instead of Chunk.chunkInstances (BigInt-keyed).
			// Also removes a fresh packCoords() BigInt alloc for all 20 edge/corner
			// offsets — same cost class as the neighborIds laziness fix, just
			// unapplied here previously.
			const neighbor = getChunk(cx + dx, cy + dy, cz + dz);

			if (!neighbor?.isLoaded || !neighbor.hasVoxelData) {
				neighbors[i] = undefined;
				continue;
			}

			// Border-only halo: the worker only ever reads the 1-voxel-thick
			// slab of each neighbor that touches the center chunk (size^2 for
			// face neighbors, thinner for edges/corners) to fill its (size+2)^3
			// padded grid.
			const xCount = dx === 0 ? size : 1;
			const yCount = dy === 0 ? size : 1;
			const zCount = dz === 0 ? size : 1;
			const total = xCount * yCount * zCount;
			const border = this._neighborBorderScratch[i];
			const lxStart = dx < 0 ? size - 1 : 0;
			const lyStart = dy < 0 ? size - 1 : 0;
			const lzStart = dz < 0 ? size - 1 : 0;
			const nArr = neighbor.block_array;
			const nPalette = neighbor.palette;

			if (neighbor.isUniform) {
				// PERF: the whole border is one repeated block id — skip the
				// triple-nested loop entirely for uniform chunks (very common:
				// all-air, all-stone, etc).
				border.fill(neighbor.uniformBlockId, 0, total);
			} else if (nArr && nArr.length > 0) {
				if (nPalette && nPalette.length > 1) {
					// P2.4: 4-bit nibble-packed palette storage — the expensive
					// decode. Reuse the cached decoded border when the
					// neighbor's block content hasn't changed.
					const cached = this._getCachedSlab(neighbor, i, total);
					if (cached) {
						border.set(cached, 0);
					} else {
						// 4-bit nibble-packed palette storage — must decode per voxel,
						// but when dx === 0 the run is a full contiguous `size`-length
						// row starting at an even index (size is always a power of
						// two), so we can decode both nibbles of each packed byte in
						// one iteration instead of one nibble at a time.
						const packed = nArr as Uint8Array;
						let ci = 0;
						for (let bz = 0; bz < zCount; bz++) {
							const nlz = lzStart + bz;
							for (let by = 0; by < yCount; by++) {
								const nly = lyStart + by;
								const rowBase = nly * size + nlz * size2;
								if (dx === 0) {
									let idx = rowBase; // lxStart is 0 when dx === 0
									for (let bx = 0; bx < xCount; bx += 2) {
										const byte = packed[idx >>> 1];
										border[ci++] = nPalette[byte & 0x0f] ?? 0;
										border[ci++] = nPalette[(byte >>> 4) & 0x0f] ?? 0;
										idx += 2;
									}
								} else {
									for (let bx = 0; bx < xCount; bx++) {
										const idx = lxStart + bx + rowBase;
										const byte = packed[idx >>> 1];
										const pIdx =
											(idx & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
										border[ci++] = nPalette[pIdx] ?? 0;
									}
								}
							}
						}
						this._putCachedSlab(neighbor, i, border.slice(0, total));
					}
				} else {
					// Dense storage (no palette packing) — indices are always
					// in-bounds of nArr, so no `?? 0` guard is needed.
					const dense = nArr as Uint16Array | Uint8Array;
					let ci = 0;
					for (let bz = 0; bz < zCount; bz++) {
						const nlz = lzStart + bz;
						for (let by = 0; by < yCount; by++) {
							const nly = lyStart + by;
							const rowBase = nly * size + nlz * size2;
							if (dx === 0) {
								// Full contiguous row — bulk copy instead of a
								// per-voxel scalar loop.
								border.set(dense.subarray(rowBase, rowBase + xCount), ci);
								ci += xCount;
							} else {
								for (let bx = 0; bx < xCount; bx++) {
									border[ci++] = dense[lxStart + bx + rowBase];
								}
							}
						}
					}
				}
			} else {
				border.fill(0, 0, total);
			}

			// PERF: this must be `.slice()`, not `.subarray()`. A subarray is
			// a *view* onto the same backing ArrayBuffer as the scratch
			// buffer (size^2 elements); structured clone serializes the full
			// [[ViewedArrayBuffer]] of a TypedArray, not just the windowed
			// range, so a subarray view here would still clone the entire
			// scratch buffer on every one of the 26 postMessage sends. .slice
			// allocates a new, right-sized buffer so edges (size elements)
			// and corners (1 element) actually clone cheaply instead of the
			// full size^2 scratch buffer (up to 4096 elements for size=64).
			neighbors[i] = border.slice(0, total);
		}

		const neighborLights = this.buildNeighborLightBorders(cx, cy, cz);

		const msg = this.#voxelMeshMsg;
		msg.chunkId = chunk.id;
		msg.meshRevision = chunk.meshRevision;
		msg.lod = forcedLod ?? chunk.lodLevel ?? 0;
		msg.chunk_size = size;
		msg.generation = chunk.generation;
		msg.blockRevision = chunk.blockRevision;

		// PERF: transfer the payload buffers instead of structured-cloning.
		// The chunk's own arrays (block_array/light_array/palette) are owned and
		// reused, so we ship TRANSFERABLE COPIES and detach those copies — the
		// worker receives them zero-copy (no receive-side clone). The neighbor
		// border slabs were already .slice()'d above, so transfer those directly.
		// Reuse the hoisted _transferScratch instead of a fresh Transferable[].
		const transfer = this._transferScratch;
		transfer.length = 0;

		const centerBlocks = chunk.block_array;
		if (centerBlocks) {
			const blockCopy = centerBlocks.slice();
			msg.block_array = blockCopy;
			transfer.push(blockCopy.buffer);
		} else {
			msg.block_array = null;
		}

		msg.uniformBlockId = chunk.isUniform ? chunk.uniformBlockId : undefined;

		if (chunk.palette?.length) {
			const paletteCopy = chunk.palette.slice();
			msg.palette = paletteCopy;
			transfer.push(paletteCopy.buffer);
		} else {
			msg.palette = chunk.palette;
		}

		if (chunk.light_array) {
			const lightCopy = chunk.light_array.slice();
			msg.light_array = lightCopy;
			transfer.push(lightCopy.buffer);
		} else {
			msg.light_array = undefined;
		}

		// neighbors / neighborLights already point at this._neighborScratch /
		// this._neighborLightScratch (each already a fresh .slice() copy).
		for (let i = 0; i < neighbors.length; i++) {
			const n = neighbors[i];
			if (n) transfer.push(n.buffer);
		}
		if (neighborLights) {
			for (let i = 0; i < neighborLights.length; i++) {
				const nl = neighborLights[i];
				if (nl) transfer.push(nl.buffer);
			}
		}

		this.voxelWorker.postMessage(msg, transfer);
	}

	/**
	 * Extract the 1-voxel-thick light border slabs of all 26 neighbors into
	 * right-sized .slice() copies (see the slice-vs-subarray note in
	 * postFullRemesh). Light borders are NOT slab-cached: the light grid is
	 * worker-mutated with no reliable main-thread version.
	 */
	private buildNeighborLightBorders(
		cx: number,
		cy: number,
		cz: number,
	): (Uint8Array | undefined)[] {
		const neighborLights = this._neighborLightScratch;
		const size = Chunk.SIZE;
		const size2 = size * size;

		for (let i = 0; i < ChunkWorker._REMESH_OFFSETS.length; i++) {
			const { dx, dy, dz } = ChunkWorker._REMESH_OFFSETS[i];
			const neighbor = getChunk(cx + dx, cy + dy, cz + dz);

			if (!neighbor?.isLoaded || !neighbor.hasVoxelData) {
				neighborLights[i] = undefined;
				continue;
			}

			const xCount = dx === 0 ? size : 1;
			const yCount = dy === 0 ? size : 1;
			const zCount = dz === 0 ? size : 1;
			const total = xCount * yCount * zCount;
			const lxStart = dx < 0 ? size - 1 : 0;
			const lyStart = dy < 0 ? size - 1 : 0;
			const lzStart = dz < 0 ? size - 1 : 0;

			const nLight = neighbor.light_array;
			if (nLight) {
				const lb = this._neighborLightBorderScratch[i];
				let li = 0;
				for (let bz = 0; bz < zCount; bz++) {
					const nlz = lzStart + bz;
					for (let by = 0; by < yCount; by++) {
						const nly = lyStart + by;
						const rowBase = nly * size + nlz * size2;
						if (dx === 0) {
							lb.set(nLight.subarray(rowBase, rowBase + xCount), li);
							li += xCount;
						} else {
							for (let bx = 0; bx < xCount; bx++) {
								lb[li++] = nLight[lxStart + bx + rowBase];
							}
						}
					}
				}
				neighborLights[i] = lb.slice(0, total);
			} else {
				neighborLights[i] = undefined;
			}
		}

		return neighborLights;
	}

	/**
	 * Light-only remesh dispatch (T2-8). Sends only the center light array and
	 * the 26 neighbor light borders; the worker reuses its cached block grid,
	 * so the block-border extraction, block/palette copies and their transfers
	 * are skipped entirely. Falls back to a full remesh on cache miss.
	 */
	public postRelightMesh(chunk: Chunk): void {
		const msg = this.#relightMeshMsg;
		msg.chunkId = chunk.id;
		msg.meshRevision = chunk.meshRevision;
		msg.lod = chunk.lodLevel ?? 0;
		msg.chunk_size = Chunk.SIZE;
		msg.generation = chunk.generation;
		msg.blockRevision = chunk.blockRevision;

		const transfer = this._transferScratch;
		transfer.length = 0;

		const lightArray = chunk.light_array;
		if (lightArray) {
			const lightCopy = lightArray.slice();
			msg.light_array = lightCopy;
			transfer.push(lightCopy.buffer);
		} else {
			msg.light_array = new Uint8Array(0);
		}

		const neighborLights = this.buildNeighborLightBorders(
			chunk.chunkX,
			chunk.chunkY,
			chunk.chunkZ,
		);
		msg.neighborLights = neighborLights;
		for (const nl of neighborLights) {
			if (nl) transfer.push(nl.buffer);
		}

		this.voxelWorker.postMessage(msg, transfer);
	}

	// ---------------------------------------------------------------------
	// P2.4: versioned block-border slab cache
	// ---------------------------------------------------------------------

	private _getCachedSlab(
		neighbor: Chunk,
		slot: number,
		total: number,
	): Uint16Array | undefined {
		const entry = this._slabCache.get(neighbor.id);
		if (
			!entry ||
			entry.generation !== neighbor.generation ||
			entry.blockRevision !== neighbor.blockRevision
		) {
			return undefined;
		}
		const border = entry.borders[slot];
		return border && border.length === total ? border : undefined;
	}

	private _putCachedSlab(
		neighbor: Chunk,
		slot: number,
		border: Uint16Array,
	): void {
		let entry = this._slabCache.get(neighbor.id);
		if (
			!entry ||
			entry.generation !== neighbor.generation ||
			entry.blockRevision !== neighbor.blockRevision
		) {
			if (this._slabCache.size >= ChunkWorker._MAX_SLAB_CACHE_ENTRIES) {
				// Map preserves insertion order → first key is the oldest.
				const oldest = this._slabCache.keys().next();
				if (!oldest.done) this._slabCache.delete(oldest.value);
			}
			entry = {
				generation: neighbor.generation,
				blockRevision: neighbor.blockRevision,
				borders: new Array(27),
			};
			this._slabCache.set(neighbor.id, entry);
		}
		entry.borders[slot] = border;
	}

	// Terrain generation stays on terrainWorker
	public postTerrainGeneration(
		chunk: Chunk,
		deferLighting: boolean = true,
	): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.GenerateTerrain,
			chunkId: chunk.id,
			chunkX: chunk.chunkX,
			chunkY: chunk.chunkY,
			chunkZ: chunk.chunkZ,
			deferLighting,
		});
	}

	// ---------------------------------------------------------------------
	// One-time SharedArrayBuffer init for distant terrain
	// Call this BEFORE the first distant terrain generation request.
	// ---------------------------------------------------------------------
	public initDistantTerrainShared(
		positionsBuffer: SharedArrayBuffer,
		normalsBuffer: SharedArrayBuffer,
		surfaceTilesBuffer: SharedArrayBuffer,
		radius: number,
		gridStep: number,
	): void {
		const message: InitDistantTerrainSharedRequest = {
			type: WorkerTaskType.InitDistantTerrainShared,
			positionsBuffer,
			normalsBuffer,
			surfaceTilesBuffer,
			radius,
			gridStep,
		};

		// SharedArrayBuffer is shared, not transferred.
		this.terrainWorker.postMessage(message);
		this.distantTerrainSharedInitialized = true;
	}

	// Distant terrain generation also stays on terrainWorker
	// No oldData, no transferables, no large typed-array payloads.
	public postGenerateDistantTerrain(
		requestId: number,
		centerChunkX: number,
		centerChunkZ: number,
		radius: number,
		gridStep: number,
		renderDistance: number,
	): void {
		if (!this.distantTerrainSharedInitialized) {
			throw new Error(
				"ChunkWorker.postGenerateDistantTerrain called before initDistantTerrainShared().",
			);
		}
		const message: GenerateDistantTerrainRequest = {
			type: WorkerTaskType.GenerateDistantTerrain,
			requestId,
			centerChunkX,
			centerChunkZ,
			radius,
			gridStep,
			renderDistance,
		};

		this.terrainWorker.postMessage(message);
	}

	// ---------------------------------------------------------------------
	// Light-task post helpers.  The terrain worker (chunk.worker.ts) owns
	// the light registry and BFS, and the post helpers simply forward
	// messages.  SharedArrayBuffers for chunk state are not transferred —
	// they live for the lifetime of the page and are referenced by all
	// workers via the registration messages posted by the pool.
	// ---------------------------------------------------------------------

	public initWorkerChannel(port: MessagePort): void {
		this.terrainWorker.postMessage(
			{ type: WorkerTaskType.InitWorkerChannel, port },
			[port],
		);
	}

	public initLightShared(headerBuffer: SharedArrayBuffer): void {
		if (this.lightSharedInitialized) return;
		const message: InitLightSharedRequest = {
			type: WorkerTaskType.InitLightShared,
			headerBuffer,
		};
		this.terrainWorker.postMessage(message);
		this.lightSharedInitialized = true;
	}

	public postLightSetClosedFaceMask(maskBuffer: SharedArrayBuffer): void {
		const message: LightSetClosedFaceMaskRequest = {
			type: WorkerTaskType.LightSetClosedFaceMask,
			maskBuffer,
		};
		this.terrainWorker.postMessage(message);
	}

	public postLightRegisterChunk(req: {
		seq: number;
		chunkId: bigint;
		chunkX: number;
		chunkY: number;
		chunkZ: number;
		headerSlot: number;
		blockSAB: SharedArrayBuffer | null;
		lightSAB: SharedArrayBuffer | null;
		paletteSAB: SharedArrayBuffer | null;
		blockStorageBytesPerElement: 1 | 2;
	}): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightRegisterChunk,
			...req,
		});
	}

	public postLightUnregisterChunk(chunkId: bigint): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightUnregisterChunk,
			chunkId,
		});
	}

	public postLightUpdateBuffers(req: {
		chunkId: bigint;
		headerSlot: number;
		blockSAB: SharedArrayBuffer | null;
		paletteSAB: SharedArrayBuffer | null;
		lightSAB: SharedArrayBuffer | null;
		blockStorageBytesPerElement: 1 | 2;
	}): void {
		this.terrainWorker.postMessage({
			type: WorkerTaskType.LightUpdateChunkBuffers,
			...req,
		});
	}

	public postLightMutate(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		oldPacked: number;
		newPacked: number;
		seq: number;
	}): void {
		const msg = this.#lightMutateMsg;
		msg.chunkId = req.chunkId;
		msg.headerSlot = req.headerSlot;
		msg.x = req.x;
		msg.y = req.y;
		msg.z = req.z;
		msg.oldPacked = req.oldPacked;
		msg.newPacked = req.newPacked;
		msg.seq = req.seq;
		this.terrainWorker.postMessage(msg);
	}

	public postLightAddEmission(req: {
		chunkId: bigint;
		headerSlot: number;
		x: number;
		y: number;
		z: number;
		level: number;
		seq: number;
	}): void {
		const msg = this.#lightEmissionMsg;
		msg.chunkId = req.chunkId;
		msg.headerSlot = req.headerSlot;
		msg.x = req.x;
		msg.y = req.y;
		msg.z = req.z;
		msg.level = req.level;
		msg.seq = req.seq;
		this.terrainWorker.postMessage(msg);
	}

	public postLightSkyReconcile(req: {
		chunkId: bigint;
		headerSlot: number;
		seq: number;
	}): void {
		const msg = this.#lightSkyReconcileMsg;
		msg.chunkId = req.chunkId;
		msg.headerSlot = req.headerSlot;
		msg.seq = req.seq;
		this.terrainWorker.postMessage(msg);
	}

	public postLightPropagateDeferred(req: {
		chunkId: bigint;
		headerSlot: number;
		seedQueue: Uint16Array;
		seedLength: number;
		seq: number;
	}): void {
		const msg = this.#lightPropagateMsg;
		msg.chunkId = req.chunkId;
		msg.headerSlot = req.headerSlot;
		msg.seedQueue = req.seedQueue;
		msg.seedLength = req.seedLength;
		msg.seq = req.seq;
		// PERF: the seed queue is exclusively owned by the caller (the pool
		// deletes its deferredLightingSeedStates entry before posting), so it
		// is transferred instead of structured-cloned — otherwise postMessage
		// would copy up to 6144 Uint16s a second time.
		this.terrainWorker.postMessage(msg, [req.seedQueue.buffer]);
	}
}
