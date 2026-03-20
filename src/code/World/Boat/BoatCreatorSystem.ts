import {
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
  Vector4,
} from "@babylonjs/core";
import { CustomBoat } from "@/code/Entities/CustomBoat";
import { Player } from "@/code/Player/Player";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { BlockType } from "@/code/World/BlockType";
import { Map1 } from "@/code/Maps/Map1";
import { GenerationParams } from "@/code/World/Generation/NoiseAndParameters/GenerationParams";
import { BlockTextures } from "@/code/World/Texture/BlockTextures";
import { TextureAtlasFactory } from "@/code/World/Texture/TextureAtlasFactory";

type VoxelBlock = {
  x: number;
  y: number;
  z: number;
  blockId: number;
};

type VisualMode = "blocks" | "aabb";

export class BoatCreatorSystem {
  private static readonly FLOOD_DIRECTIONS: ReadonlyArray<[number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  // Expand this set with any additional block IDs that should be treated as hull.
  private static sourceBlockIds = new Set<number>([37]);
  private static maxFloodBlocks = 8192;
  private static visualMode: VisualMode = "blocks";
  private static readonly fallbackTile: [number, number] = [0, 0];
  private static atlasFallbackTexture: Texture | null = null;
  private static materialCache = new Map<number, StandardMaterial>();

  private static isAlive(
    value: { isDisposed?: boolean | (() => boolean) } | null | undefined,
  ): boolean {
    if (!value) return false;
    const disposedFlag = value.isDisposed;
    if (typeof disposedFlag === "function") {
      return !disposedFlag.call(value);
    }
    return disposedFlag !== true;
  }

  public static setSourceBlockIds(ids: Iterable<number>): void {
    this.sourceBlockIds = new Set<number>();
    for (const id of ids) {
      if (Number.isInteger(id) && id >= 0) this.sourceBlockIds.add(id);
    }
  }

  public static addSourceBlockId(id: number): void {
    if (!Number.isInteger(id) || id < 0) return;
    this.sourceBlockIds.add(id);
  }

  public static removeSourceBlockId(id: number): void {
    this.sourceBlockIds.delete(id);
  }

  public static getSourceBlockIds(): number[] {
    return [...this.sourceBlockIds.values()];
  }

  public static setVisualMode(mode: VisualMode): void {
    this.visualMode = mode;
  }

  public static tryCreateBoatFromMarker(
    player: Player,
    markerX: number,
    markerY: number,
    markerZ: number,
  ): boolean {
    const hullBlocks = this.collectConnectedHullBlocks(markerX, markerY, markerZ);
    if (hullBlocks.length === 0) return false;

    const bounds = this.computeBounds(hullBlocks);
    const { center, halfExtents } = bounds;
    const initialYaw = this.computeForwardYaw(bounds, markerX, markerZ);
    const scene = Map1.mainScene;
    const customVisual =
      this.visualMode === "blocks"
        ? this.buildHullVisualMesh(scene, hullBlocks, center)
        : undefined;

    // Consume source blocks and the marker block from the world.
    for (const block of hullBlocks) {
      ChunkLoadingSystem.setBlock(block.x, block.y, block.z, BlockType.Air, 0);
    }
    ChunkLoadingSystem.setBlock(markerX, markerY, markerZ, BlockType.Air, 0);

    const paddedHalfExtents = halfExtents.add(new Vector3(0.05, 0.05, 0.05));
    new CustomBoat(scene, player, GenerationParams.SEA_LEVEL, center, {
      collisionHalfExtents: paddedHalfExtents,
      customVisualRoot: customVisual,
      skipDefaultModel: true,
      initialYaw,
      customVisualLocalYaw: -initialYaw,
      blockCount: hullBlocks.length,
    });

    return true;
  }

  private static collectConnectedHullBlocks(
    markerX: number,
    markerY: number,
    markerZ: number,
  ): VoxelBlock[] {
    const queue: VoxelBlock[] = [];
    const visited = new Set<string>();
    const out: VoxelBlock[] = [];

    for (const [dx, dy, dz] of this.FLOOD_DIRECTIONS) {
      const nx = markerX + dx;
      const ny = markerY + dy;
      const nz = markerZ + dz;
      const neighborId = ChunkLoadingSystem.getBlockByWorldCoords(nx, ny, nz);
      if (!this.sourceBlockIds.has(neighborId)) continue;
      queue.push({ x: nx, y: ny, z: nz, blockId: neighborId });
    }

    while (queue.length > 0 && out.length < this.maxFloodBlocks) {
      const current = queue.pop()!;
      const key = `${current.x}|${current.y}|${current.z}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const blockId = ChunkLoadingSystem.getBlockByWorldCoords(
        current.x,
        current.y,
        current.z,
      );
      if (!this.sourceBlockIds.has(blockId)) continue;

      current.blockId = blockId;
      out.push(current);

      for (const [dx, dy, dz] of this.FLOOD_DIRECTIONS) {
        queue.push({
          x: current.x + dx,
          y: current.y + dy,
          z: current.z + dz,
          blockId,
        });
      }
    }

    return out;
  }

  private static computeBounds(blocks: VoxelBlock[]): {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    center: Vector3;
    halfExtents: Vector3;
  } {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (const block of blocks) {
      if (block.x < minX) minX = block.x;
      if (block.y < minY) minY = block.y;
      if (block.z < minZ) minZ = block.z;
      if (block.x > maxX) maxX = block.x;
      if (block.y > maxY) maxY = block.y;
      if (block.z > maxZ) maxZ = block.z;
    }

    const sizeX = maxX - minX + 1;
    const sizeY = maxY - minY + 1;
    const sizeZ = maxZ - minZ + 1;

    const halfExtents = new Vector3(sizeX * 0.5, sizeY * 0.5, sizeZ * 0.5);
    const center = new Vector3(
      minX + halfExtents.x,
      minY + halfExtents.y,
      minZ + halfExtents.z,
    );

    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      sizeX,
      sizeY,
      sizeZ,
      center,
      halfExtents,
    };
  }

  private static computeForwardYaw(
    bounds: {
      minX: number;
      minZ: number;
      maxX: number;
      maxZ: number;
      sizeX: number;
      sizeZ: number;
    },
    markerX: number,
    markerZ: number,
  ): number {
    // Long-side axis decides orientation axis, marker proximity to short edge
    // decides forward sign. Tie-breaker: prefer X axis and min edge.
    const useXAxis = bounds.sizeX >= bounds.sizeZ;

    if (useXAxis) {
      const markerCenterX = markerX + 0.5;
      const minEdge = bounds.minX;
      const maxEdge = bounds.maxX + 1;
      const distToMin = Math.abs(markerCenterX - minEdge);
      const distToMax = Math.abs(maxEdge - markerCenterX);
      const forwardPositiveX = distToMax < distToMin;
      return forwardPositiveX ? Math.PI * 0.5 : -Math.PI * 0.5;
    }

    const markerCenterZ = markerZ + 0.5;
    const minEdge = bounds.minZ;
    const maxEdge = bounds.maxZ + 1;
    const distToMin = Math.abs(markerCenterZ - minEdge);
    const distToMax = Math.abs(maxEdge - markerCenterZ);
    const forwardPositiveZ = distToMax < distToMin;
    return forwardPositiveZ ? 0 : Math.PI;
  }

  private static buildHullVisualMesh(
    scene: Scene,
    blocks: VoxelBlock[],
    center: Vector3,
  ): Mesh | undefined {
    if (blocks.length === 0) return undefined;

    const groups = new Map<number, VoxelBlock[]>();
    for (const block of blocks) {
      const list = groups.get(block.blockId);
      if (list) list.push(block);
      else groups.set(block.blockId, [block]);
    }

    const root = new Mesh("boatCreatorHullRoot", scene);
    root.isPickable = false;
    root.renderingGroupId = 1;

    for (const [blockId, groupedBlocks] of groups) {
      const hullMaterial = this.getAtlasMaterialForBlock(scene, blockId);
      const faceUV = this.getFaceUVForBlock(blockId);

      const parts: Mesh[] = [];
      for (let i = 0; i < groupedBlocks.length; i++) {
        const block = groupedBlocks[i];
        const part = MeshBuilder.CreateBox(
          `boatCreatorHullBlock_${blockId}_${i}`,
          { size: 1, faceUV },
          scene,
        );
        part.position.set(
          block.x + 0.5 - center.x,
          block.y + 0.5 - center.y,
          block.z + 0.5 - center.z,
        );
        part.material = hullMaterial;
        part.renderingGroupId = 1;
        parts.push(part);
      }

      if (parts.length === 1) {
        parts[0].parent = root;
        continue;
      }

      const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
      if (merged && merged instanceof Mesh) {
        merged.name = `boatCreatorHull_${blockId}`;
        merged.material = hullMaterial;
        merged.renderingGroupId = 1;
        merged.parent = root;
      }
    }

    if (root.getChildMeshes(false).length === 0) {
      root.dispose();
      return undefined;
    }

    return root;
  }

  private static getAtlasTexture(scene: Scene): Texture {
    const atlas = TextureAtlasFactory.getDiffuse();
    if (atlas) return atlas;
    if (this.isAlive(this.atlasFallbackTexture)) {
      return this.atlasFallbackTexture;
    }
    this.atlasFallbackTexture = new Texture(
      "/texture/diffuse_atlas.png",
      scene,
      false,
      true,
      Texture.NEAREST_SAMPLINGMODE,
    );
    return this.atlasFallbackTexture;
  }

  private static getAtlasMaterialForBlock(
    scene: Scene,
    blockId: number,
  ): StandardMaterial {
    const cached = this.materialCache.get(blockId);
    if (this.isAlive(cached)) return cached;

    const material = new StandardMaterial(`boatCreatorAtlasMat_${blockId}`, scene);
    material.diffuseTexture = this.getAtlasTexture(scene);
    material.specularColor.set(0, 0, 0);
    this.materialCache.set(blockId, material);
    return material;
  }

  private static getFaceUVForBlock(blockId: number): Vector4[] {
    const sideTile = this.getBlockTile(blockId, "side");
    const topTile = this.getBlockTile(blockId, "top");
    const bottomTile = this.getBlockTile(blockId, "bottom");
    const side = this.tileToUV(sideTile[0], sideTile[1]);
    const top = this.tileToUV(topTile[0], topTile[1]);
    const bottom = this.tileToUV(bottomTile[0], bottomTile[1]);
    return [side, side, side, side, top, bottom];
  }

  private static getBlockTile(
    blockId: number,
    face: "side" | "top" | "bottom",
  ): [number, number] {
    const def = BlockTextures[blockId];
    if (!def) return this.fallbackTile;

    const toPair = (value: number[] | undefined): [number, number] | null => {
      if (!value || value.length < 2) return null;
      return [value[0], value[1]];
    };

    const all = toPair(def.all);
    const side = toPair(def.side) ?? all;
    const top = toPair(def.top) ?? all ?? side;
    const bottom = toPair(def.bottom) ?? all ?? side;

    if (face === "top") return top ?? this.fallbackTile;
    if (face === "bottom") return bottom ?? this.fallbackTile;
    return side ?? this.fallbackTile;
  }

  private static tileToUV(tx: number, ty: number): Vector4 {
    const tileSize = TextureAtlasFactory.atlasTileSize;
    const pad = tileSize * 0.02;
    const u0 = tx * tileSize + pad;
    const v0 = 1 - (ty + 1) * tileSize + pad;
    const u1 = (tx + 1) * tileSize - pad;
    const v1 = 1 - ty * tileSize - pad;
    return new Vector4(u0, v0, u1, v1);
  }
}
