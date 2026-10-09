import type { SavedChunkData } from "../../WorldStorage";
import type { Chunk } from "../Chunk";

/**
 * Normalized storage payload required to restore chunk voxel/light state.
 *
 * Typed-array fields must reference the persisted data directly rather than
 * cloned arrays.
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
 * - getStoragePayload(...) must return references, not clones.
 * - Optional restoration hooks should avoid copying large typed arrays.
 */
export interface ChunkHydrationAdapter {
	/**
	 * Extract the voxel/light payload used by Chunk.loadFromStorage(...).
	 */
	getStoragePayload(savedData: SavedChunkData): HydrationStoragePayload;

	/**
	 * Return serialized LOD cache data when it is stored in SavedChunkData.
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
 * Encapsulates all persisted-data-to-live-chunk hydration logic:
 * - restores block and light storage
 * - restores serialized LOD cache data when available
 *
 * Mesh data lives in OPFS and is handled by the chunk-load path through the
 * OPFS mesh cache, so this adapter does not perform mesh lookups.
 */
export class ChunkHydration {
	public constructor(private readonly adapter: ChunkHydrationAdapter) {}

	/**
	 * Hydrate a chunk's voxel/light storage from persisted data.
	 *
	 * The adapter must return references rather than copies.
	 */
	public applyHydratedChunkFromSavedData(
		chunk: Chunk,
		savedData: SavedChunkData,
		scheduleRemesh = false,
	): void {
		const adapter = this.adapter;
		const { blocks, palette, isUniform, uniformBlockId, lightArray } =
			adapter.getStoragePayload(savedData);

		chunk.loadFromStorage(
			blocks,
			palette,
			isUniform,
			uniformBlockId,
			lightArray,
			scheduleRemesh,
			true,
		);

		const lodCache = adapter.getSerializedLodCache?.(savedData);
		if (lodCache !== undefined) {
			chunk.restoreLODMeshCache(lodCache);
		}

		adapter.onAfterHydrate?.(chunk, savedData);
	}
}
