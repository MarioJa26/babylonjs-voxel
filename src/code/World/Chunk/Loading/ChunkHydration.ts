import type { SavedChunkData } from "../../WorldStorage";
import type { Chunk } from "../Chunk";

/**
 * Normalized storage payload required to restore chunk voxel/light state.
 */
export interface HydrationStoragePayload {
	blocks: Uint8Array | Uint16Array | null;
	palette?: Uint16Array | null;
	isUniform?: boolean;
	uniformBlockId?: number;
	lightArray?: Uint8Array;
}

/**
 * Adapter so this helper does not need to know the exact SavedChunkData shape.
 *
 * PERFORMANCE CONTRACT:
 * - getStoragePayload(...) should return references, not clones
 */
export interface ChunkHydrationAdapter {
	/**
	 * Extract the voxel/light payload used by Chunk.loadFromStorage(...).
	 */
	getStoragePayload(savedData: SavedChunkData): HydrationStoragePayload;

	/**
	 * If your SavedChunkData stores serialized LOD cache data, return it here.
	 * Otherwise return undefined.
	 */
	getSerializedLodCache?(
		savedData: SavedChunkData,
	): ReturnType<Chunk["getSerializableLODMeshCache"]> | undefined;

	/**
	 * Optional post-hydration hook.
	 */
	onAfterHydrate?(chunk: Chunk, savedData: SavedChunkData): void;
}

/**
 * Encapsulates all "saved chunk data -> live chunk" logic:
 * - restoring block/light storage into a Chunk
 * - restoring serialized LOD cache if present
 *
 * Mesh data now lives in OPFS (not IDB) and is consulted directly by the
 * chunk-load path via the OPFS mesh cache, so no mesh-lookup adapter methods
 * are needed here.
 */
export class ChunkHydration {
	public constructor(private readonly adapter: ChunkHydrationAdapter) {}

	/**
	 * Hydrate the chunk's voxel/light storage from persisted data.
	 *
	 * IMPORTANT:
	 * The adapter should return references, not copies.
	 */
	public applyHydratedChunkFromSavedData(
		chunk: Chunk,
		savedData: SavedChunkData,
		scheduleRemesh = false,
	): void {
		const payload = this.adapter.getStoragePayload(savedData);

		chunk.loadFromStorage(
			payload.blocks,
			payload.palette,
			payload.isUniform,
			payload.uniformBlockId,
			payload.lightArray,
			scheduleRemesh,
			true,
		);

		const lodCache = this.adapter.getSerializedLodCache?.(savedData);
		if (lodCache !== undefined) {
			chunk.restoreLODMeshCache(lodCache);
		}

		this.adapter.onAfterHydrate?.(chunk, savedData);
	}
}
