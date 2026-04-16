import type { SavedChunkData } from "../../WorldStorage";
import type { Chunk } from "../Chunk";
import type { MeshData } from "../DataStructures/MeshData";

/**
 * Selected saved mesh payload.
 *
 * NOTE:
 * This shape is intentionally mutable so callers can reuse a scratch object
 * and avoid allocating a fresh wrapper on every lookup.
 */
export interface SelectedSavedMesh {
	opaque: MeshData | null;
	transparent: MeshData | null;
	lod: number;
}

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
 * - getSavedMeshForLod(...) should return references, not clones
 * - getAvailableMeshLods(...) should return a stable ascending readonly list
 */
export interface ChunkHydrationAdapter {
	/**
	 * Extract the voxel/light payload used by Chunk.loadFromStorage(...).
	 */
	getStoragePayload(savedData: SavedChunkData): HydrationStoragePayload;

	/**
	 * Return a saved mesh for a specific LOD if one exists, otherwise null.
	 */
	getSavedMeshForLod(
		savedData: SavedChunkData,
		lod: number,
	): {
		opaque: MeshData | null;
		transparent: MeshData | null;
	} | null;

	/**
	 * Return all LOD levels that may have persisted meshes on this saved record.
	 *
	 * IMPORTANT:
	 * This should be a stable ascending readonly list.
	 */
	getAvailableMeshLods(savedData: SavedChunkData): readonly number[];

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
 * - mesh selection for a desired LOD
 * - restoring block/light storage into a Chunk
 * - restoring serialized LOD cache if present
 *
 * OPTIMIZED VERSION:
 * - avoids array clone/sort work
 * - offers out-parameter APIs to avoid SelectedSavedMesh allocations
 */
export class ChunkHydration {
	public constructor(private readonly adapter: ChunkHydrationAdapter) {}

	/**
	 * Fill an existing SelectedSavedMesh object with the exact mesh for a given LOD.
	 *
	 * Returns true on success, false if no mesh exists for that LOD.
	 *
	 * This is the preferred low-allocation API.
	 */
	public tryGetSavedMeshForLod(
		savedData: SavedChunkData,
		lod: number,
		out: SelectedSavedMesh,
	): boolean {
		const mesh = this.adapter.getSavedMeshForLod(savedData, lod);
		if (!mesh) {
			return false;
		}

		out.opaque = mesh.opaque;
		out.transparent = mesh.transparent;
		out.lod = lod;
		return true;
	}

	/**
	 * Convenience wrapper that allocates a SelectedSavedMesh only when needed.
	 *
	 * Use tryGetSavedMeshForLod(...) in hot paths if you want to avoid wrapper allocation.
	 */
	public getSavedMeshForLod(
		savedData: SavedChunkData,
		lod: number,
	): SelectedSavedMesh | null {
		const mesh = this.adapter.getSavedMeshForLod(savedData, lod);
		if (!mesh) return null;

		return {
			opaque: mesh.opaque,
			transparent: mesh.transparent,
			lod,
		};
	}

	/**
	 * Internal low-allocation LOD selection.
	 *
	 * Strategy:
	 * 1) exact LOD match
	 * 2) nearest lower-detail LOD (higher number, e.g. 3 when requesting 2)
	 * 3) nearest higher-detail LOD (lower number, e.g. 1 when requesting 2)
	 *
	 * Assumes availableLods is already stable ascending.
	 */
	private pickBestAvailableLod(
		availableLods: readonly number[],
		desiredLod: number,
	): number {
		if (availableLods.length === 0) {
			return -1;
		}

		let exactLod = -1;
		let bestLowerDetail = Number.POSITIVE_INFINITY; // lod > desired
		let bestHigherDetail = Number.NEGATIVE_INFINITY; // lod < desired

		for (let i = 0; i < availableLods.length; i++) {
			const lod = availableLods[i];

			if (lod === desiredLod) {
				exactLod = lod;
				break;
			}

			if (lod > desiredLod && lod < bestLowerDetail) {
				bestLowerDetail = lod;
			} else if (lod < desiredLod && lod > bestHigherDetail) {
				bestHigherDetail = lod;
			}
		}

		if (exactLod !== -1) {
			return exactLod;
		}

		if (Number.isFinite(bestLowerDetail)) {
			return bestLowerDetail;
		}

		if (Number.isFinite(bestHigherDetail)) {
			return bestHigherDetail;
		}

		return -1;
	}

	/**
	 * Fill an existing SelectedSavedMesh object with the best available mesh
	 * for the desired LOD.
	 *
	 * Returns true on success, false if no saved mesh exists at all.
	 *
	 * This is the preferred low-allocation API.
	 */
	public tryPickBestSavedMesh(
		savedData: SavedChunkData,
		desiredLod: number,
		out: SelectedSavedMesh,
	): boolean {
		const availableLods = this.adapter.getAvailableMeshLods(savedData);
		const chosenLod = this.pickBestAvailableLod(availableLods, desiredLod);
		if (chosenLod === -1) {
			return false;
		}

		return this.tryGetSavedMeshForLod(savedData, chosenLod, out);
	}

	/**
	 * Convenience wrapper that allocates a SelectedSavedMesh only when needed.
	 *
	 * Use tryPickBestSavedMesh(...) in hot paths if you want to avoid wrapper allocation.
	 */
	public pickBestSavedMesh(
		savedData: SavedChunkData,
		desiredLod: number,
	): SelectedSavedMesh | null {
		const availableLods = this.adapter.getAvailableMeshLods(savedData);
		const chosenLod = this.pickBestAvailableLod(availableLods, desiredLod);
		if (chosenLod === -1) {
			return null;
		}

		return this.getSavedMeshForLod(savedData, chosenLod);
	}

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
		);

		const lodCache = this.adapter.getSerializedLodCache?.(savedData);
		if (lodCache !== undefined) {
			chunk.restoreLODMeshCache(lodCache);
		}

		this.adapter.onAfterHydrate?.(chunk, savedData);
	}

	/**
	 * Convenience wrapper for the main chunk-load path:
	 * - restore chunk storage
	 * - return the best saved mesh for the target LOD
	 *
	 * This wrapper is simple but allocates a SelectedSavedMesh if a mesh is found.
	 * In hot paths, call applyHydratedChunkFromSavedData(...) first and then
	 * tryPickBestSavedMesh(...) with a reusable scratch object.
	 */
	public applyLoadedChunkFromSavedData(
		chunk: Chunk,
		savedData: SavedChunkData,
		desiredLod: number,
		scheduleRemesh = false,
	): SelectedSavedMesh | null {
		this.applyHydratedChunkFromSavedData(chunk, savedData, scheduleRemesh);
		return this.pickBestSavedMesh(savedData, desiredLod);
	}

	/**
	 * Apply a selected saved mesh payload directly to the chunk.
	 *
	 * OPTIMIZATION:
	 * Skip redundant writes if the exact same mesh references are already assigned.
	 */
	public applySelectedMeshDataToChunk(
		chunk: Chunk,
		selectedMesh: SelectedSavedMesh | null,
	): void {
		const nextOpaque = selectedMesh?.opaque ?? null;
		const nextTransparent = selectedMesh?.transparent ?? null;

		if (
			chunk.opaqueMeshData === nextOpaque &&
			chunk.transparentMeshData === nextTransparent
		) {
			return;
		}

		chunk.opaqueMeshData = nextOpaque;
		chunk.transparentMeshData = nextTransparent;
	}
}
