import { Chunk } from "../Chunk";
import { MeshData } from "../DataStructures/MeshData";
import type { SavedChunkData } from "../../WorldStorage";

/**
 * A selected mesh payload that can be applied to a chunk load path.
 */
export interface SelectedSavedMesh {
  opaque: MeshData | null;
  transparent: MeshData | null;
  lod: number;
}

/**
 * Normalized storage payload required to restore chunk voxel/light state.
 * This mirrors the general shape implied by Chunk.loadFromStorage(...)
 * without assuming exact SavedChunkData property names.
 */
export interface HydrationStoragePayload {
  blocks: Uint8Array | Uint16Array | null;
  palette?: Uint16Array | null;
  isUniform?: boolean;
  uniformBlockId?: number;
  lightArray?: Uint8Array;
}

/**
 * Adapter so this helper does not need to know the exact SavedChunkData shape yet.
 * You will wire this up from ChunkLoadingSystem later.
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
   * Example: [0, 1, 2, 3]
   */
  getAvailableMeshLods(savedData: SavedChunkData): number[];

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
 * This corresponds directly to the hydration-specific responsibilities currently
 * sitting in ChunkLoadingSystem.
 */
export class ChunkHydration {
  public constructor(private readonly adapter: ChunkHydrationAdapter) {}

  /**
   * Return the exact saved mesh for the requested LOD if present.
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
   * Picks the "best" available saved mesh for the desired LOD.
   *
   * Strategy:
   * 1) exact LOD match
   * 2) nearest lower-detail LOD (higher number, e.g. 3 when requesting 2)
   * 3) nearest higher-detail LOD (lower number, e.g. 1 when requesting 2)
   *
   * This keeps the policy deterministic and easy to reason about.
   */
  public pickBestSavedMesh(
    savedData: SavedChunkData,
    desiredLod: number,
  ): SelectedSavedMesh | null {
    const availableLods = [
      ...this.adapter.getAvailableMeshLods(savedData),
    ].sort((a, b) => a - b);

    if (availableLods.length === 0) {
      return null;
    }

    const exact = this.getSavedMeshForLod(savedData, desiredLod);
    if (exact) {
      return exact;
    }

    // Prefer a lower-detail fallback first (higher lod number)
    for (const lod of availableLods) {
      if (lod > desiredLod) {
        const mesh = this.getSavedMeshForLod(savedData, lod);
        if (mesh) return mesh;
      }
    }

    // Otherwise fall back to a higher-detail mesh (lower lod number)
    for (let i = availableLods.length - 1; i >= 0; i--) {
      const lod = availableLods[i];
      if (lod < desiredLod) {
        const mesh = this.getSavedMeshForLod(savedData, lod);
        if (mesh) return mesh;
      }
    }

    return null;
  }

  /**
   * Hydrate the chunk's voxel/light storage from persisted data.
   * This should be the direct replacement target for applyHydratedChunkFromSavedData(...).
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
   * The caller (later ChunkLoadingSystem) can decide whether to:
   * - apply returned mesh immediately
   * - prefer a transition mesh
   * - schedule a remesh instead
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
   * Optional helper if you want to stash selected saved mesh payload directly
   * onto the chunk before the render pipeline creates real Babylon meshes.
   */
  public applySelectedMeshDataToChunk(
    chunk: Chunk,
    selectedMesh: SelectedSavedMesh | null,
  ): void {
    if (!selectedMesh) {
      chunk.opaqueMeshData = null;
      chunk.transparentMeshData = null;
      return;
    }

    chunk.opaqueMeshData = selectedMesh.opaque;
    chunk.transparentMeshData = selectedMesh.transparent;
  }
}
