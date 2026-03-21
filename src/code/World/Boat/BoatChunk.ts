import { Mesh, Observer, Scene, Vector3 } from "@babylonjs/core";
import {
  packBlockValue,
  unpackBlockId,
  unpackBlockState,
} from "../BlockEncoding";
import { Chunk } from "../Chunk/Chunk";
import { ChunkWorkerPool } from "../Chunk/ChunkWorkerPool";

export type BoatChunkBlock = {
  x: number;
  y: number;
  z: number;
  blockId: number;
  blockState?: number;
  packedBlock?: number;
  lightLevel?: number;
};

type ChunkCoords = {
  x: number;
  y: number;
  z: number;
};

export class BoatChunk {
  private static readonly CHUNK_COORD_BASE = 1_200_000;
  private static readonly CHUNK_COORD_GRID_WIDTH = 256;
  private static readonly CHUNK_COORD_SPACING = 4;
  private static nextChunkSlot = 0;

  #scene: Scene;
  #center: Vector3;
  #visualRoot: Mesh;
  #centerChunk: Chunk;
  #neighborChunks: Chunk[] = [];
  #beforeRenderObserver: Observer<Scene> | null = null;
  #attachedOpaqueMesh: Mesh | null = null;
  #attachedTransparentMesh: Mesh | null = null;

  constructor(scene: Scene, blocks: BoatChunkBlock[], center: Vector3) {
    this.#scene = scene;
    this.#center = center.clone();
    this.#visualRoot = new Mesh("boatChunkRoot", this.#scene);
    this.#visualRoot.isPickable = false;
    this.#visualRoot.renderingGroupId = 1;

    const chunkCoords = BoatChunk.allocateChunkCoords();
    this.#centerChunk = new Chunk(chunkCoords.x, chunkCoords.y, chunkCoords.z);
    this.#centerChunk.isPersistent = true;
    this.createNeighborChunks(chunkCoords);
    this.populateCenterChunk(blocks);
    this.populateNeighborChunks();

    this.#beforeRenderObserver = this.#scene.onBeforeRenderObservable.add(
      () => {
        this.#syncVisualMeshes();
      },
    );
    this.remesh();
  }

  private static allocateChunkCoords(): ChunkCoords {
    const slot = BoatChunk.nextChunkSlot++;
    const gx = slot % BoatChunk.CHUNK_COORD_GRID_WIDTH;
    const gz = Math.floor(slot / BoatChunk.CHUNK_COORD_GRID_WIDTH);
    return {
      x: BoatChunk.CHUNK_COORD_BASE + gx * BoatChunk.CHUNK_COORD_SPACING,
      y: 32,
      z: BoatChunk.CHUNK_COORD_BASE + gz * BoatChunk.CHUNK_COORD_SPACING,
    };
  }

  private createSharedBuffer(byteLength: number): ArrayBufferLike {
    if (typeof SharedArrayBuffer !== "undefined") {
      return new SharedArrayBuffer(byteLength);
    }
    return new ArrayBuffer(byteLength);
  }

  private createSkyLightArray(): Uint8Array {
    const light = new Uint8Array(this.createSharedBuffer(Chunk.SIZE3));
    light.fill(15 << Chunk.SKY_LIGHT_SHIFT);
    return light;
  }

  private isInsideChunkBounds(x: number, y: number, z: number): boolean {
    return (
      x >= 0 &&
      y >= 0 &&
      z >= 0 &&
      x < Chunk.SIZE &&
      y < Chunk.SIZE &&
      z < Chunk.SIZE
    );
  }

  private getIndex(x: number, y: number, z: number): number {
    return x + y * Chunk.SIZE + z * Chunk.SIZE2;
  }

  private createBlockArray(): Uint16Array {
    return new Uint16Array(this.createSharedBuffer(Chunk.SIZE3 * 2));
  }

  private createNeighborChunks(center: ChunkCoords): void {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const neighbor = new Chunk(
            center.x + dx,
            center.y + dy,
            center.z + dz,
          );
          neighbor.isPersistent = true;
          this.#neighborChunks.push(neighbor);
        }
      }
    }
  }

  private populateNeighborChunks(): void {
    for (const neighbor of this.#neighborChunks) {
      neighbor.populate(null, null, true, 0, this.createSkyLightArray(), false);
      neighbor.isModified = false;
    }
  }

  private populateCenterChunk(blocks: BoatChunkBlock[]): void {
    const blockArray = this.createBlockArray();
    const lightArray = this.createSkyLightArray();
    for (const block of blocks) {
      const bx = Math.floor(block.x);
      const by = Math.floor(block.y);
      const bz = Math.floor(block.z);
      if (!this.isInsideChunkBounds(bx, by, bz)) {
        continue;
      }

      const index = this.getIndex(bx, by, bz);
      const packed =
        typeof block.packedBlock === "number"
          ? block.packedBlock
          : packBlockValue(block.blockId, block.blockState ?? 0);
      blockArray[index] = packed;
      if (typeof block.lightLevel === "number") {
        lightArray[index] = block.lightLevel & 0xff;
      }
    }

    this.#centerChunk.populate(blockArray, null, false, 0, lightArray, false);
    this.#centerChunk.isModified = false;
  }

  private isAliveMesh(mesh: Mesh | null): mesh is Mesh {
    return !!mesh && !mesh.isDisposed();
  }

  private configureAttachedMesh(mesh: Mesh, transparent: boolean): void {
    if (mesh.isDisposed()) return;
    mesh.unfreezeWorldMatrix();
    // World chunks are static and use frozen bounds. Boat meshes move/rotate, so
    // keep bounds synced to transforms to avoid incorrect frustum culling.
    mesh.doNotSyncBoundingInfo = false;
    mesh.parent = this.#visualRoot;
    mesh.position.set(-this.#center.x, -this.#center.y, -this.#center.z);
    mesh.rotation.set(0, 0, 0);
    mesh.scaling.set(1, 1, 1);
    mesh.isPickable = true;
    // Keep transparent and opaque boat chunk meshes in the same rendering group
    // so depth from opaque is preserved for transparent pass.
    mesh.renderingGroupId = 1;
    mesh.metadata = this.#visualRoot.metadata;
  }

  private syncMeshRef(
    source: Mesh | null,
    attachedRef: Mesh | null,
    transparent: boolean,
  ): Mesh | null {
    if (!this.isAliveMesh(source)) {
      return null;
    }
    if (source === attachedRef) {
      return attachedRef;
    }
    this.configureAttachedMesh(source, transparent);
    return source;
  }

  private updateAttachedMeshTransform(mesh: Mesh | null): void {
    if (!this.isAliveMesh(mesh)) return;
    mesh.position.set(-this.#center.x, -this.#center.y, -this.#center.z);
  }

  #syncVisualMeshes(): void {
    this.#attachedOpaqueMesh = this.syncMeshRef(
      this.#centerChunk.mesh,
      this.#attachedOpaqueMesh,
      false,
    );
    this.#attachedTransparentMesh = this.syncMeshRef(
      this.#centerChunk.transparentMesh,
      this.#attachedTransparentMesh,
      true,
    );
    this.updateAttachedMeshTransform(this.#attachedOpaqueMesh);
    this.updateAttachedMeshTransform(this.#attachedTransparentMesh);
  }

  public remesh(priority = true): void {
    ChunkWorkerPool.getInstance().scheduleRemesh(this.#centerChunk, priority);
  }

  public attachTo(parent: Mesh): void {
    this.#visualRoot.parent = parent;
  }

  public getBlockLocal(x: number, y: number, z: number): number {
    if (!this.isInsideChunkBounds(x, y, z)) return 0;
    return this.#centerChunk.getBlock(x, y, z);
  }

  public getBlockStateLocal(x: number, y: number, z: number): number {
    if (!this.isInsideChunkBounds(x, y, z)) return 0;
    return this.#centerChunk.getBlockState(x, y, z);
  }

  public getBlockPackedLocal(x: number, y: number, z: number): number {
    if (!this.isInsideChunkBounds(x, y, z)) return 0;
    return this.#centerChunk.getBlockPacked(x, y, z);
  }

  public setBlockPackedLocal(
    x: number,
    y: number,
    z: number,
    packedBlock: number,
  ): void {
    const blockId = unpackBlockId(packedBlock);
    const blockState = unpackBlockState(packedBlock);
    this.setBlockLocal(x, y, z, blockId, blockState);
  }

  public setBlockLocal(
    x: number,
    y: number,
    z: number,
    blockId: number,
    blockState = 0,
  ): void {
    if (!this.isInsideChunkBounds(x, y, z)) return;
    this.#centerChunk.setBlock(x, y, z, blockId, blockState);
  }

  public setLightLocal(
    x: number,
    y: number,
    z: number,
    packedLight: number,
  ): void {
    if (!this.isInsideChunkBounds(x, y, z)) return;
    this.#centerChunk.setLight(x, y, z, packedLight & 0xff);
    this.#centerChunk.scheduleRemesh();
  }

  public worldToLocalBlock(worldPosition: Vector3): Vector3 {
    const inverse = this.#visualRoot.getWorldMatrix().clone().invert();
    const local = Vector3.TransformCoordinates(worldPosition, inverse);
    return new Vector3(
      Math.floor(local.x + this.#center.x),
      Math.floor(local.y + this.#center.y),
      Math.floor(local.z + this.#center.z),
    );
  }

  public localToWorldCenter(x: number, y: number, z: number): Vector3 {
    const localCenter = new Vector3(
      x + 0.5 - this.#center.x,
      y + 0.5 - this.#center.y,
      z + 0.5 - this.#center.z,
    );
    return Vector3.TransformCoordinates(
      localCenter,
      this.#visualRoot.getWorldMatrix(),
    );
  }

  public dispose(): void {
    if (this.#beforeRenderObserver) {
      this.#scene.onBeforeRenderObservable.remove(this.#beforeRenderObserver);
      this.#beforeRenderObserver = null;
    }

    this.#centerChunk.dispose();
    Chunk.chunkInstances.delete(this.#centerChunk.id);

    for (const neighborChunk of this.#neighborChunks) {
      neighborChunk.dispose();
      Chunk.chunkInstances.delete(neighborChunk.id);
    }
    this.#neighborChunks.length = 0;

    this.#visualRoot.dispose(false, true);
  }

  public get visualRoot(): Mesh {
    return this.#visualRoot;
  }

  public get center(): Vector3 {
    return this.#center.clone();
  }
}
