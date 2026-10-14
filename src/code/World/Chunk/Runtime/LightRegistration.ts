import type { Chunk } from "../Chunk";
import type {
	LightRegisterChunkBatchRequest,
	VoxelRegisterChunkBatchRequest,
} from "../DataStructures/WorkerMessageType";

export type UnregisterSender = {
	postLightBatch(ids: bigint[]): void;
	postVoxelBatch(coords: Int32Array): void;
};

const UNREGISTER_FLUSH_THRESHOLD = 64;
const INITIAL_VOXEL_COORD_CAPACITY = 256;
const INITIAL_DRAIN_CHUNK_CAPACITY = 64;
const VALUES_PER_CHUNK = 3;

export class UnregisterCoalescer {
	private voxelCoords = new Int32Array(INITIAL_VOXEL_COORD_CAPACITY);
	private spareVoxelCoords: Int32Array<ArrayBuffer> | null = null;
	private voxelCount = 0;

	private lightIds: bigint[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly sender: UnregisterSender) {}

	enqueueLight(chunkId: bigint): void {
		this.lightIds.push(chunkId);

		if (this.lightIds.length >= UNREGISTER_FLUSH_THRESHOLD) {
			this.flush();
		} else {
			this.scheduleFlush();
		}
	}

	enqueueVoxel(chunkX: number, chunkY: number, chunkZ: number): void {
		const needed = this.voxelCount + VALUES_PER_CHUNK;
		let coords = this.voxelCoords;

		if (needed > coords.length) {
			let capacity = coords.length;

			while (capacity < needed) {
				capacity *= 2;
			}

			const grown = new Int32Array(capacity);
			grown.set(coords.subarray(0, this.voxelCount));

			this.voxelCoords = coords = grown;
		}

		const offset = this.voxelCount;
		coords[offset] = chunkX;
		coords[offset + 1] = chunkY;
		coords[offset + 2] = chunkZ;
		this.voxelCount = needed;

		if (this.voxelCount >= UNREGISTER_FLUSH_THRESHOLD * VALUES_PER_CHUNK) {
			this.flush();
		} else {
			this.scheduleFlush();
		}
	}

	flush(): void {
		const lightIds = this.lightIds;
		const voxelCount = this.voxelCount;

		if (lightIds.length === 0 && voxelCount === 0) {
			this.cancelScheduledFlush();
			return;
		}

		/*
		 * Detach both batches before calling the sender. This preserves the
		 * current batch if a sender callback synchronously enqueues more work.
		 */
		this.lightIds = [];
		this.voxelCount = 0;
		this.cancelScheduledFlush();

		let flushedVoxelCoords: Int32Array<ArrayBuffer> | null = null;

		if (voxelCount > 0) {
			flushedVoxelCoords = this.voxelCoords;

			const spare = this.spareVoxelCoords;
			this.spareVoxelCoords = null;

			this.voxelCoords =
				spare !== null && spare.length >= INITIAL_VOXEL_COORD_CAPACITY
					? spare
					: new Int32Array(
							Math.max(INITIAL_VOXEL_COORD_CAPACITY, flushedVoxelCoords.length),
						);
		}

		try {
			if (lightIds.length > 0) {
				this.sender.postLightBatch(lightIds);
			}

			if (flushedVoxelCoords !== null) {
				this.sender.postVoxelBatch(flushedVoxelCoords.subarray(0, voxelCount));
			}
		} finally {
			/*
			 * postMessage performs structured cloning synchronously, so the
			 * detached backing array can be retained for a later flush.
			 */
			if (
				flushedVoxelCoords !== null &&
				flushedVoxelCoords !== this.voxelCoords
			) {
				this.spareVoxelCoords = flushedVoxelCoords;
			}

			/*
			 * Reentrant enqueue calls may have added new work while sending
			 * the detached batches.
			 */
			if (this.lightIds.length > 0 || this.voxelCount > 0) {
				this.scheduleFlush();
			}
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) {
			return;
		}

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, 0);
	}

	private cancelScheduledFlush(): void {
		if (this.flushTimer === null) {
			return;
		}

		clearTimeout(this.flushTimer);
		this.flushTimer = null;
	}
}

export type LightRegistrationHost = {
	flushUnregisters(): void;
	nextSeq(): number;
	skipSkyReconcile(chunk: Chunk): boolean;

	postLightBatch(registrations: LightRegisterChunkBatchRequest["chunks"]): void;

	postVoxelBatch(batch: Omit<VoxelRegisterChunkBatchRequest, "type">): void;
};

export class LightRegistrationDrain {
	private chunks: Chunk[] = [];

	private readonly seen = new Set<bigint>();

	private drainIds = new BigInt64Array(INITIAL_DRAIN_CHUNK_CAPACITY);
	private drainCoords = new Int32Array(
		INITIAL_DRAIN_CHUNK_CAPACITY * VALUES_PER_CHUNK,
	);
	private drainMeta = new Uint32Array(
		INITIAL_DRAIN_CHUNK_CAPACITY * VALUES_PER_CHUNK,
	);

	get stagedCount(): number {
		return this.chunks.length;
	}

	stage(chunk: Chunk, fromChannel: boolean): void {
		/*
		 * Retain the existing public signature. The source flag was previously
		 * stored but never read during draining.
		 */
		void fromChannel;
		this.chunks.push(chunk);
	}

	drain(host: LightRegistrationHost): void {
		const chunks = this.chunks;
		const chunkCount = chunks.length;

		if (chunkCount === 0) {
			return;
		}

		/*
		 * Detach staged work first so reentrant stage() calls are queued for
		 * the next drain instead of being lost when this drain completes.
		 */
		this.chunks = [];

		host.flushUnregisters();

		const lightRegistrations: LightRegisterChunkBatchRequest["chunks"] = [];
		const voxelBlockSABs: (SharedArrayBuffer | null)[] = [];
		const voxelPaletteSABs: (SharedArrayBuffer | null)[] = [];
		const voxelLightSABs: (SharedArrayBuffer | null)[] = [];

		const seen = this.seen;
		seen.clear();

		let drainIds = this.drainIds;
		let drainCoords = this.drainCoords;
		let drainMeta = this.drainMeta;
		let registeredCount = 0;

		for (let i = 0; i < chunkCount; i++) {
			const chunk = chunks[i];
			const chunkId = chunk.id;

			if (seen.has(chunkId)) {
				continue;
			}

			seen.add(chunkId);

			if (registeredCount >= drainIds.length) {
				let newCapacity = drainIds.length * 2;

				while (newCapacity <= registeredCount) {
					newCapacity *= 2;
				}

				const newIds = new BigInt64Array(newCapacity);
				newIds.set(drainIds.subarray(0, registeredCount));
				this.drainIds = drainIds = newIds;

				const usedValues = registeredCount * VALUES_PER_CHUNK;

				const newCoords = new Int32Array(newCapacity * VALUES_PER_CHUNK);
				newCoords.set(drainCoords.subarray(0, usedValues));
				this.drainCoords = drainCoords = newCoords;

				const newMeta = new Uint32Array(newCapacity * VALUES_PER_CHUNK);
				newMeta.set(drainMeta.subarray(0, usedValues));
				this.drainMeta = drainMeta = newMeta;
			}

			const snapshot = chunk.getLightStorageSnapshot();
			const blockStorageBytesPerElement = snapshot.blockStorageBytesPerElement;

			const chunkX = chunk.chunkX;
			const chunkY = chunk.chunkY;
			const chunkZ = chunk.chunkZ;

			lightRegistrations.push({
				seq: host.nextSeq(),
				chunkId,
				chunkX,
				chunkY,
				chunkZ,
				headerSlot: chunk.lightHeaderSlot,
				blockSAB: snapshot.blockSAB,
				lightSAB: snapshot.lightSAB!,
				paletteSAB: snapshot.paletteSAB,
				blockStorageBytesPerElement,
				skipSkyReconcile: host.skipSkyReconcile(chunk),
			});

			const offset = registeredCount * VALUES_PER_CHUNK;

			drainIds[registeredCount] = chunkId;

			drainCoords[offset] = chunkX;
			drainCoords[offset + 1] = chunkY;
			drainCoords[offset + 2] = chunkZ;

			drainMeta[offset] = chunk.isUniform ? 1 : 0;
			drainMeta[offset + 1] = chunk.uniformBlockId;
			drainMeta[offset + 2] = blockStorageBytesPerElement;

			voxelBlockSABs.push(snapshot.blockSAB);
			voxelPaletteSABs.push(snapshot.paletteSAB);
			voxelLightSABs.push(snapshot.lightSAB);

			registeredCount++;
		}

		seen.clear();

		if (registeredCount === 0) {
			return;
		}

		host.postLightBatch(lightRegistrations);

		const usedValues = registeredCount * VALUES_PER_CHUNK;

		host.postVoxelBatch({
			chunkIds: drainIds.subarray(0, registeredCount),
			coords: drainCoords.subarray(0, usedValues),
			meta: drainMeta.subarray(0, usedValues),
			blockSABs: voxelBlockSABs,
			paletteSABs: voxelPaletteSABs,
			lightSABs: voxelLightSABs,
		});
	}
}
