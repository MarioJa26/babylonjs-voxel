import type { Mesh } from "@babylonjs/core";
import { MeshData } from "./DataStructures/MeshData";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { TerrainHeightMap } from "../Generation/TerrainHeightMap";
import {
  packBlockValue,
  unpackBlockId,
  unpackBlockState,
} from "../BlockEncoding";

type LightNode = {
  chunk: Chunk;
  x: number;
  y: number;
  z: number;
  level: number;
};

export class Chunk {
  public readonly id: bigint;
  public static readonly SIZE = GenerationParams.CHUNK_SIZE;
  public static readonly SIZE2 = Chunk.SIZE * Chunk.SIZE;
  public static readonly SIZE3 = Chunk.SIZE * Chunk.SIZE * Chunk.SIZE;
  public static readonly chunkInstances = new Map<bigint, Chunk>();
  public isModified = false;
  // Persistent chunks are managed by systems outside world streaming
  // (e.g. movable boat chunks) and must never be auto-unloaded/saved.
  public isPersistent = false;

  public isDirty = false;
  public isLoaded = false;
  public isTerrainScheduled = false;
  public colliderDirty = true;

  private remeshQueued = false;
  private remeshQueuedPriority = false;

  public static onRequestRemesh:
    | ((chunk: Chunk, priority: boolean) => void)
    | null = null;

  private _block_array: Uint8Array | Uint16Array | null = null;
  private _isUniform = true;
  private _uniformBlockId = 0;
  private _palette: Uint16Array | null = null;

  #chunkY: number;
  #chunkX: number;
  #chunkZ: number;
  public mesh: Mesh | null = null;
  public transparentMesh: Mesh | null = null;
  public opaqueMeshData: MeshData | null = null;
  public transparentMeshData: MeshData | null = null;

  light_array: Uint8Array;

  public static readonly SKY_LIGHT_SHIFT = 4;
  public static readonly BLOCK_LIGHT_MASK = 0xf;
  private static readonly WATER_BLOCK_ID = 30;

  constructor(chunkX: number, chunkY: number, chunkZ: number) {
    this.#chunkX = chunkX;
    this.#chunkY = chunkY;
    this.#chunkZ = chunkZ;
    this.id = Chunk.packCoords(chunkX, chunkY, chunkZ);

    // Create zero-length buffers in a safe way:
    this.light_array = new Uint8Array(new SharedArrayBuffer(0));

    Chunk.chunkInstances.set(this.id, this);
  }

  get block_array(): Uint8Array | Uint16Array | null {
    return this._block_array;
  }

  get palette(): Uint16Array | null {
    return this._palette;
  }

  get isUniform(): boolean {
    return this._isUniform;
  }

  get uniformBlockId(): number {
    return this._uniformBlockId;
  }

  // Define blocks that emit light (Block ID -> Light Level)
  public static readonly LIGHT_EMISSION: Record<number, number> = {
    10: 15, // Example: Lava
    11: 15, // Example: Glowstone
    24: 15, //Lava
  };

  public static getLightEmission(blockId: number): number {
    return Chunk.LIGHT_EMISSION[blockId] || 0;
  }

  private getNibble(index: number): number {
    const arr = this._block_array as Uint8Array | null;
    if (!arr) return 0;

    const byte = arr[index >>> 1];
    return (index & 1) === 0 ? byte & 0x0f : (byte >>> 4) & 0x0f;
  }

  private setNibble(index: number, value: number): void {
    const arr = this._block_array as Uint8Array | null;
    if (!arr) return;

    const byteIndex = index >>> 1;
    const nibble = value & 0x0f;
    const byte = arr[byteIndex];

    arr[byteIndex] =
      (index & 1) === 0
        ? (byte & 0xf0) | nibble
        : (byte & 0x0f) | (nibble << 4);
  }

  public populate(
    blocks: Uint8Array | Uint16Array | null,
    palette: Uint16Array | null,
    isUniform: boolean,
    uniformBlockId: number,
    light_array?: Uint8Array,
    scheduleRemesh = true,
  ): void {
    this._isUniform = isUniform;
    this._uniformBlockId = uniformBlockId;
    this._palette = palette;
    this._block_array = blocks;

    if (light_array) {
      this.light_array = light_array;
    } else {
      this.initializeSunlight();
    }
    this.isLoaded = true;
    this.isTerrainScheduled = false; // Reset flag
    this.colliderDirty = true;
    if (scheduleRemesh) {
      this.scheduleRemesh();
      this.getNeighbor(-1, 0, 0)?.scheduleRemesh();
      this.getNeighbor(0, 0, -1)?.scheduleRemesh();
      this.getNeighbor(0, -1, 0)?.scheduleRemesh();
      this.getNeighbor(1, 0, 0)?.scheduleRemesh();
      this.getNeighbor(0, 0, 1)?.scheduleRemesh();
      this.getNeighbor(0, 1, 0)?.scheduleRemesh();
    }
  }

  public loadFromStorage(
    blocks: Uint8Array | Uint16Array | null,
    palette: Uint16Array | null | undefined,
    isUniform: boolean | undefined,
    uniformBlockId: number | undefined,
    light_array?: Uint8Array,
    scheduleRemesh = true,
  ): void {
    if (isUniform && typeof uniformBlockId === "number") {
      this._isUniform = true;
      this._uniformBlockId = uniformBlockId;
      this._block_array = null;
      this._palette = null;
    } else if (palette && blocks instanceof Uint8Array) {
      this._isUniform = false;
      this._uniformBlockId = 0;
      this._palette = palette;
      this._block_array = blocks;
    } else if (blocks) {
      this._isUniform = false;
      this._uniformBlockId = 0;
      this._palette = null;
      this._block_array = blocks;
    } else {
      // Fallback to uniform air if data is missing/corrupt
      this._isUniform = true;
      this._uniformBlockId = 0;
      this._block_array = null;
      this._palette = null;
    }

    if (light_array) {
      this.light_array = light_array;
    } else {
      this.initializeSunlight();
    }

    this.isLoaded = true;
    this.isTerrainScheduled = false;
    this.colliderDirty = true;
    if (scheduleRemesh) {
      this.scheduleRemesh();
      this.getNeighbor(-1, 0, 0)?.scheduleRemesh();
      this.getNeighbor(0, 0, -1)?.scheduleRemesh();
      this.getNeighbor(0, -1, 0)?.scheduleRemesh();
      this.getNeighbor(1, 0, 0)?.scheduleRemesh();
      this.getNeighbor(0, 0, 1)?.scheduleRemesh();
      this.getNeighbor(0, 1, 0)?.scheduleRemesh();
    }
  }

  public unload(): void {
    if (!this.isLoaded) {
      return;
    }
    // Keep the mesh, but discard the heavy block and light data arrays to save memory.
    this._block_array = null;
    this._isUniform = true;
    this._uniformBlockId = 0;
    this._palette = null;
    this.light_array = new Uint8Array(new SharedArrayBuffer(0));
    this.isLoaded = false;
    this.isTerrainScheduled = false;
    this.isModified = false; // No longer considered modified as its data is gone.
    this.colliderDirty = true;
  }

  public initializeSunlight() {
    const queue: LightNode[] = [];
    const size = Chunk.SIZE;
    const topWorldY = this.#chunkY * size + size - 1;
    const aboveChunk = this.getNeighbor(0, 1, 0);

    if (this.light_array.length !== Chunk.SIZE3) {
      if (typeof SharedArrayBuffer !== "undefined") {
        this.light_array = new Uint8Array(new SharedArrayBuffer(Chunk.SIZE3));
      } else {
        this.light_array = new Uint8Array(Chunk.SIZE3);
      }
    }

    // Rebuild skylight while preserving block-light nibble
    for (let i = 0; i < Chunk.SIZE3; i++) {
      this.light_array[i] &= Chunk.BLOCK_LIGHT_MASK;
    }

    const chunkBaseX = this.#chunkX * size;
    const chunkBaseZ = this.#chunkZ * size;
    const hasLoadedAbove = !!aboveChunk?.isLoaded;

    for (let x = 0; x < size; x++) {
      const worldX = chunkBaseX + x;

      for (let z = 0; z < size; z++) {
        const worldZ = chunkBaseZ + z;
        let incomingSkyLight = 0;
        let sourceIsWater = false;

        if (hasLoadedAbove) {
          const aboveBlockPacked = aboveChunk!.getBlockPacked(x, 0, z);
          if (aboveChunk!.isTransparent(aboveBlockPacked, 1)) {
            incomingSkyLight = aboveChunk!.getSkyLight(x, 0, z);
            sourceIsWater = Chunk.isWaterBlock(unpackBlockId(aboveBlockPacked));
          }
        } else {
          const terrainHeight = TerrainHeightMap.getFinalTerrainHeight(
            worldX,
            worldZ,
          );

          // Conservative fallback when the chunk above is unavailable
          if (topWorldY >= terrainHeight - 48) {
            incomingSkyLight = 15;
          }
        }

        for (let y = size - 1; y >= 0; y--) {
          const idx = x + y * size + z * Chunk.SIZE2;
          const blockPacked = this.getBlockPacked(x, y, z);

          if (!this.isTransparent(blockPacked, 1)) {
            incomingSkyLight = 0;
            sourceIsWater = false;
            continue;
          }

          if (incomingSkyLight <= 0) {
            continue;
          }

          const thisIsWater = Chunk.isWaterBlock(unpackBlockId(blockPacked));
          const preservesFullSun =
            incomingSkyLight === 15 && !sourceIsWater && !thisIsWater;

          const cellSkyLight = preservesFullSun
            ? 15
            : Math.max(incomingSkyLight - 1, 0);

          if (cellSkyLight === 0) {
            incomingSkyLight = 0;
            sourceIsWater = thisIsWater;
            continue;
          }

          this.light_array[idx] =
            (this.light_array[idx] & Chunk.BLOCK_LIGHT_MASK) |
            (cellSkyLight << Chunk.SKY_LIGHT_SHIFT);

          queue.push({
            chunk: this,
            x,
            y,
            z,
            level: cellSkyLight,
          });

          incomingSkyLight = cellSkyLight;
          sourceIsWater = thisIsWater;
        }
      }
    }

    this.propagateLight(queue, true);
  }
  public getBlockLight(localX: number, localY: number, localZ: number): number {
    if (!this.isLoaded) return 0;
    return (
      this.light_array[localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2] &
      Chunk.BLOCK_LIGHT_MASK
    );
  }

  public getSkyLight(localX: number, localY: number, localZ: number): number {
    // TODO: Return time-adjusted light level if needed.
    if (!this.isLoaded) return 0;

    return (
      (this.light_array[localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2] >>
        Chunk.SKY_LIGHT_SHIFT) &
      Chunk.BLOCK_LIGHT_MASK
    );
  }

  public setBlockLight(x: number, y: number, z: number, level: number): void {
    const current = this.getLight(x, y, z);
    const skyBits = current & ~Chunk.BLOCK_LIGHT_MASK;
    this.setLight(x, y, z, skyBits | (level & Chunk.BLOCK_LIGHT_MASK));
  }

  public setSkyLight(x: number, y: number, z: number, level: number): void {
    const current = this.getLight(x, y, z);
    const blockBits = current & Chunk.BLOCK_LIGHT_MASK;
    this.setLight(
      x,
      y,
      z,
      blockBits | ((level & Chunk.BLOCK_LIGHT_MASK) << Chunk.SKY_LIGHT_SHIFT),
    );
  }

  public getBlock(localX: number, localY: number, localZ: number): number {
    const packed = this.getBlockPacked(localX, localY, localZ);
    return unpackBlockId(packed);
  }

  public getBlockState(localX: number, localY: number, localZ: number): number {
    const packed = this.getBlockPacked(localX, localY, localZ);
    return unpackBlockState(packed);
  }

  public getBlockPacked(
    localX: number,
    localY: number,
    localZ: number,
  ): number {
    if (!this.isLoaded) {
      return 0; // Unloaded chunks are treated as air for rendering/physics checks.
    }

    if (this._isUniform) {
      return this._uniformBlockId;
    }

    const index = localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2;

    if (this._palette) {
      return this._palette[this.getNibble(index)];
    }

    return this._block_array![index];
  }

  public setBlock(
    localX: number,
    localY: number,
    localZ: number,
    blockId: number,
    state = 0,
  ): void {
    if (!this.isLoaded) {
      console.warn(
        "Attempted to set block on an unloaded chunk. Action ignored.",
      );
      return;
    }

    const index = localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2;
    const packedBlock = packBlockValue(blockId, state);
    let oldPacked = 0;

    if (this._isUniform) {
      oldPacked = this._uniformBlockId;
      if (oldPacked === packedBlock) return;

      // Expand Uniform -> Palette
      this._isUniform = false;
      this._palette = new Uint16Array([this._uniformBlockId]);
      // If the new block is different, add it to palette
      let newIndex = 0;
      if (this._palette[0] !== packedBlock) {
        const expandedPalette = new Uint16Array(2);
        expandedPalette[0] = this._palette[0];
        expandedPalette[1] = packedBlock;
        this._palette = expandedPalette;
        newIndex = 1;
      }

      this._block_array = new Uint8Array(
        new SharedArrayBuffer(Chunk.SIZE3 / 2),
      );
      this._block_array.fill(0); // All blocks default to index 0 (old uniform id)
      this.setNibble(index, newIndex);
    } else if (this._palette) {
      const paletteIndex = this.getNibble(index);
      oldPacked = this._palette[paletteIndex];
      if (oldPacked === packedBlock) return;

      let newPaletteIndex = this._palette.indexOf(packedBlock);
      if (newPaletteIndex === -1) {
        if (this._palette.length < 16) {
          // Add to palette
          newPaletteIndex = this._palette.length;
          const expandedPalette = new Uint16Array(this._palette.length + 1);
          expandedPalette.set(this._palette);
          expandedPalette[newPaletteIndex] = packedBlock;
          this._palette = expandedPalette;
          this.setNibble(index, newPaletteIndex);
        } else {
          // Palette full -> Expand to Raw
          const newArray = new Uint16Array(
            new SharedArrayBuffer(Chunk.SIZE3 * 2),
          );
          for (let i = 0; i < Chunk.SIZE3; i++) {
            newArray[i] = this._palette[this.getNibble(i)];
          }
          newArray[index] = packedBlock;
          this._block_array = newArray;
          this._palette = null;
        }
      } else {
        this.setNibble(index, newPaletteIndex);
      }
    } else {
      // Raw Array: Upgrade to Uint16Array if needed
      if (packedBlock > 255 && this._block_array instanceof Uint8Array) {
        const newArray = new Uint16Array(
          new SharedArrayBuffer(Chunk.SIZE3 * 2),
        );
        newArray.set(this._block_array);
        this._block_array = newArray;
      }
      oldPacked = this._block_array![index];
      if (oldPacked === packedBlock) return;
      this._block_array![index] = packedBlock;
    }

    const oldBlockLight = this.getBlockLight(localX, localY, localZ);
    const oldSkyLight = this.getSkyLight(localX, localY, localZ);
    const oldBlockId = unpackBlockId(oldPacked);
    const newBlockId = unpackBlockId(packedBlock);
    const oldWasTransparent = this.isTransparent(oldPacked);
    const newIsTransparent = this.isTransparent(packedBlock);
    const oldWasSkyTransparent = this.isTransparent(oldPacked, 1);
    const newIsSkyTransparent = this.isTransparent(packedBlock, 1);

    // Handle Block Light
    if (oldBlockLight > 0) {
      this.removeLight(localX, localY, localZ, false);
    } else if (newIsTransparent) {
      this.updateLightFromNeighbors(localX, localY, localZ, false);
    }

    // Handle Sky Light
    if (oldSkyLight > 0) {
      this.removeLight(localX, localY, localZ, true);
    } else if (newIsSkyTransparent) {
      this.updateLightFromNeighbors(localX, localY, localZ, true);
    }
    if (oldWasSkyTransparent && !newIsSkyTransparent && oldSkyLight > 0) {
      this.cutSkyLightBelow(localX, localY, localZ);
    }

    const emission = Chunk.getLightEmission(newBlockId);
    if (emission > 0) {
      this.addLight(localX, localY, localZ, emission);
    }

    this.isModified = true;
    this.colliderDirty = true;
    this.scheduleRemesh(true);

    // If the block is on a boundary, the neighbor chunk must also be remeshed.
    if (localX === 0) {
      this.getNeighbor(-1, 0, 0)?.scheduleRemesh(true);
    } else if (localX === Chunk.SIZE - 1) {
      this.getNeighbor(1, 0, 0)?.scheduleRemesh(true);
    }
    if (localY === 0) {
      this.getNeighbor(0, -1, 0)?.scheduleRemesh(true);
    } else if (localY === Chunk.SIZE - 1) {
      this.getNeighbor(0, 1, 0)?.scheduleRemesh(true);
    }
    if (localZ === 0) {
      this.getNeighbor(0, 0, -1)?.scheduleRemesh(true);
    } else if (localZ === Chunk.SIZE - 1) {
      this.getNeighbor(0, 0, 1)?.scheduleRemesh(true);
    }
  }

  public deleteBlock(localX: number, localY: number, localZ: number): void {
    this.setBlock(localX, localY, localZ, 0);
  }

  public getLight(localX: number, localY: number, localZ: number): number {
    if (!this.isLoaded) {
      return 0; // Unloaded chunks are dark.
    }
    return this.light_array[
      localX + localY * Chunk.SIZE + localZ * Chunk.SIZE2
    ];
  }

  public setLight(x: number, y: number, z: number, level: number) {
    if (!this.isLoaded) {
      return;
    }
    const idx = x + y * Chunk.SIZE + z * Chunk.SIZE2;
    if (this.light_array[idx] !== level) {
      this.light_array[idx] = level;
      this.isModified = true;
    }
  }

  /**
   * Propagates light from a queue of light sources.
   */

  public propagateLight(queue: LightNode[], isSkyLight = true): void {
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      const chunk = node.chunk;
      const x = node.x;
      const y = node.y;
      const z = node.z;

      // Always re-read the stored level instead of trusting queued data.
      const level = isSkyLight
        ? chunk.getSkyLight(x, y, z)
        : chunk.getBlockLight(x, y, z);

      if (level <= 0) continue;

      const sourceBlockPacked = chunk.getBlockPacked(x, y, z);
      const sourceBlockId = unpackBlockId(sourceBlockPacked);
      const sourceEmits = Chunk.getLightEmission(sourceBlockId) > 0;

      // 6 cardinal directions:
      // 0: +X, 1: -X, 2: +Y, 3: -Y, 4: +Z, 5: -Z
      for (let dirIndex = 0; dirIndex < 6; dirIndex++) {
        let dx = 0;
        let dy = 0;
        let dz = 0;
        let axis = 0;
        let isDown = 0;
        let dir = 1;

        switch (dirIndex) {
          case 0: // +X
            dx = 1;
            axis = 0;
            dir = 1;
            break;
          case 1: // -X
            dx = -1;
            axis = 0;
            dir = -1;
            break;
          case 2: // +Y
            dy = 1;
            axis = 1;
            dir = 1;
            break;
          case 3: // -Y
            dy = -1;
            axis = 1;
            isDown = 1;
            dir = -1;
            break;
          case 4: // +Z
            dz = 1;
            axis = 2;
            dir = 1;
            break;
          case 5: // -Z
            dz = -1;
            axis = 2;
            dir = -1;
            break;
        }

        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;

        let targetChunk: Chunk | undefined = chunk;
        let tx = nx;
        let ty = ny;
        let tz = nz;

        // Resolve cross-chunk X boundary
        if (tx < 0) {
          targetChunk = targetChunk.getNeighbor(-1, 0, 0);
          tx = Chunk.SIZE - 1;
        } else if (tx >= Chunk.SIZE) {
          targetChunk = targetChunk.getNeighbor(1, 0, 0);
          tx = 0;
        }

        // Resolve cross-chunk Y boundary
        if (targetChunk && ty < 0) {
          targetChunk = targetChunk.getNeighbor(0, -1, 0);
          ty = Chunk.SIZE - 1;
        } else if (targetChunk && ty >= Chunk.SIZE) {
          targetChunk = targetChunk.getNeighbor(0, 1, 0);
          ty = 0;
        }

        // Resolve cross-chunk Z boundary
        if (targetChunk && tz < 0) {
          targetChunk = targetChunk.getNeighbor(0, 0, -1);
          tz = Chunk.SIZE - 1;
        } else if (targetChunk && tz >= Chunk.SIZE) {
          targetChunk = targetChunk.getNeighbor(0, 0, 1);
          tz = 0;
        }

        if (!targetChunk) continue;

        const targetBlockPacked = targetChunk.getBlockPacked(tx, ty, tz);

        // Source-side face transparency:
        // For sky light, source must be transparent in that direction.
        // For block light, an emitting source can emit through itself even if not transparent.
        const sourceAllows = isSkyLight
          ? chunk.isTransparent(sourceBlockPacked, axis, dir)
          : sourceEmits || chunk.isTransparent(sourceBlockPacked, axis, dir);

        if (!sourceAllows) continue;

        // Target-side face must accept light from this direction.
        if (!targetChunk.isTransparent(targetBlockPacked, axis, dir)) continue;

        const currentLevel = isSkyLight
          ? targetChunk.getSkyLight(tx, ty, tz)
          : targetChunk.getBlockLight(tx, ty, tz);

        const preservesFullSun =
          isSkyLight &&
          isDown === 1 &&
          level === 15 &&
          !Chunk.isWaterBlock(sourceBlockId) &&
          !Chunk.isWaterBlock(unpackBlockId(targetBlockPacked));

        let nextLevel = preservesFullSun ? 15 : level - 1;
        if (nextLevel <= 0) continue;

        if (currentLevel < nextLevel) {
          if (isSkyLight) {
            targetChunk.setSkyLight(tx, ty, tz, nextLevel);
          } else {
            targetChunk.setBlockLight(tx, ty, tz, nextLevel);
          }

          targetChunk.scheduleRemesh();
          queue.push({
            chunk: targetChunk,
            x: tx,
            y: ty,
            z: tz,
            level: nextLevel,
          });
        }
      }
    }
  }

  public updateLightFromNeighbors(
    x: number,
    y: number,
    z: number,
    isSkyLight = false,
  ) {
    if (!this.isLoaded) return;

    const queue: LightNode[] = [];
    const targetBlockPacked = this.getBlockPacked(x, y, z);

    for (let dirIndex = 0; dirIndex < 6; dirIndex++) {
      let dx = 0;
      let dy = 0;
      let dz = 0;
      let axis = 0;
      let dir = 1;

      switch (dirIndex) {
        case 0: // +X neighbor
          dx = 1;
          axis = 0;
          dir = -1;
          break;
        case 1: // -X neighbor
          dx = -1;
          axis = 0;
          dir = 1;
          break;
        case 2: // +Y neighbor
          dy = 1;
          axis = 1;
          dir = -1;
          break;
        case 3: // -Y neighbor
          dy = -1;
          axis = 1;
          dir = 1;
          break;
        case 4: // +Z neighbor
          dz = 1;
          axis = 2;
          dir = -1;
          break;
        case 5: // -Z neighbor
          dz = -1;
          axis = 2;
          dir = 1;
          break;
      }

      let sourceChunk: Chunk | undefined = this;
      let sx = x + dx;
      let sy = y + dy;
      let sz = z + dz;

      // Resolve X boundary
      if (sx < 0) {
        sourceChunk = sourceChunk.getNeighbor(-1, 0, 0);
        sx = Chunk.SIZE - 1;
      } else if (sx >= Chunk.SIZE) {
        sourceChunk = sourceChunk.getNeighbor(1, 0, 0);
        sx = 0;
      }

      // Resolve Y boundary
      if (sourceChunk && sy < 0) {
        sourceChunk = sourceChunk.getNeighbor(0, -1, 0);
        sy = Chunk.SIZE - 1;
      } else if (sourceChunk && sy >= Chunk.SIZE) {
        sourceChunk = sourceChunk.getNeighbor(0, 1, 0);
        sy = 0;
      }

      // Resolve Z boundary
      if (sourceChunk && sz < 0) {
        sourceChunk = sourceChunk.getNeighbor(0, 0, -1);
        sz = Chunk.SIZE - 1;
      } else if (sourceChunk && sz >= Chunk.SIZE) {
        sourceChunk = sourceChunk.getNeighbor(0, 0, 1);
        sz = 0;
      }

      if (!sourceChunk) continue;

      const sourceBlockPacked = sourceChunk.getBlockPacked(sx, sy, sz);
      const sourceBlockId = unpackBlockId(sourceBlockPacked);
      const sourceEmits = Chunk.getLightEmission(sourceBlockId) > 0;

      const sourceAllows = isSkyLight
        ? sourceChunk.isTransparent(sourceBlockPacked, axis, dir)
        : sourceEmits ||
          sourceChunk.isTransparent(sourceBlockPacked, axis, dir);

      if (!sourceAllows) continue;

      if (!this.isTransparent(targetBlockPacked, axis, dir)) continue;

      const level = isSkyLight
        ? sourceChunk.getSkyLight(sx, sy, sz)
        : sourceChunk.getBlockLight(sx, sy, sz);

      if (level <= 0) continue;

      queue.push({
        chunk: sourceChunk,
        x: sx,
        y: sy,
        z: sz,
        level,
      });
    }

    if (queue.length > 0) {
      this.propagateLight(queue, isSkyLight);
    }
  }

  private isTransparent(
    blockPacked: number,
    axis?: number,
    dir?: number,
  ): boolean {
    // 0: Air, 30: Water, 60/61: Glass variants
    const id = unpackBlockId(blockPacked);
    if (id === 0 || id === 30 || id === 60 || id === 61) {
      return true;
    }

    const state = unpackBlockState(blockPacked);
    const slice = (state >> 3) & 7;

    // No slice metadata => full opaque block
    if (slice === 0) {
      return false;
    }

    // Generic transparency query (non-face-specific)
    if (axis === undefined) {
      return true;
    }

    const rotation = state & 7;
    const sliceAxisRaw = rotation & 3;

    // Encoded axis mapping:
    // raw 1 => X, raw 2 => Z, everything else => Y
    const sliceAxis = sliceAxisRaw === 1 ? 0 : sliceAxisRaw === 2 ? 2 : 1;

    // Query axis does not match the slab's closed/open axis => open
    if (sliceAxis !== axis) {
      return true;
    }

    // Without a direction we conservatively treat directional slabs as opaque
    if (dir === undefined) {
      return false;
    }

    // flip=false closes +dir face, flip=true closes -dir face
    const flip = (rotation & 4) !== 0;
    const closedDir = flip ? -1 : 1;

    return dir !== closedDir;
  }

  private static isWaterBlock(blockId: number): boolean {
    return unpackBlockId(blockId) === Chunk.WATER_BLOCK_ID;
  }

  private cutSkyLightBelow(
    localX: number,
    localY: number,
    localZ: number,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let targetChunk: Chunk | undefined = this;
    const tx = localX;
    let ty = localY - 1;
    const tz = localZ;

    if (ty < 0) {
      targetChunk = targetChunk.getNeighbor(0, -1, 0);
      ty = Chunk.SIZE - 1;
    }
    if (!targetChunk?.isLoaded) return;

    const belowBlockId = targetChunk.getBlockPacked(tx, ty, tz);
    if (!targetChunk.isTransparent(belowBlockId, 1)) return;

    if (targetChunk.getSkyLight(tx, ty, tz) > 0) {
      targetChunk.removeLight(tx, ty, tz, true);
    }
  }
  public addLight(x: number, y: number, z: number, level: number) {
    if (!this.isLoaded) return;

    level &= Chunk.BLOCK_LIGHT_MASK;
    if (level <= 0) return;

    const current = this.getBlockLight(x, y, z);
    if (current >= level) {
      return;
    }

    this.setBlockLight(x, y, z, level);
    this.propagateLight([{ chunk: this, x, y, z, level }], false);
  }

  public removeLight(x: number, y: number, z: number, isSkyLight = false) {
    const startLevel = isSkyLight
      ? this.getSkyLight(x, y, z)
      : this.getBlockLight(x, y, z);

    if (startLevel === 0) return;

    const queue: LightNode[] = [];
    const propagateQueue: LightNode[] = [];
    const remeshChunks = new Set<Chunk>();

    queue.push({ chunk: this, x, y, z, level: startLevel });

    if (isSkyLight) this.setSkyLight(x, y, z, 0);
    else this.setBlockLight(x, y, z, 0);

    remeshChunks.add(this);

    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      const chunk = node.chunk;
      const cx = node.x;
      const cy = node.y;
      const cz = node.z;
      const level = node.level;

      const sourceBlockPacked = chunk.getBlockPacked(cx, cy, cz);
      const sourceBlockId = unpackBlockId(sourceBlockPacked);

      for (let dirIndex = 0; dirIndex < 6; dirIndex++) {
        let dx = 0;
        let dy = 0;
        let dz = 0;
        let axis = 0;
        let isDown = 0;
        let dir = 1;

        switch (dirIndex) {
          case 0: // +X
            dx = 1;
            axis = 0;
            dir = 1;
            break;
          case 1: // -X
            dx = -1;
            axis = 0;
            dir = -1;
            break;
          case 2: // +Y
            dy = 1;
            axis = 1;
            dir = 1;
            break;
          case 3: // -Y
            dy = -1;
            axis = 1;
            isDown = 1;
            dir = -1;
            break;
          case 4: // +Z
            dz = 1;
            axis = 2;
            dir = 1;
            break;
          case 5: // -Z
            dz = -1;
            axis = 2;
            dir = -1;
            break;
        }

        let targetChunk: Chunk | undefined = chunk;
        let tx = cx + dx;
        let ty = cy + dy;
        let tz = cz + dz;

        // Resolve X boundary
        if (tx < 0) {
          targetChunk = targetChunk.getNeighbor(-1, 0, 0);
          tx = Chunk.SIZE - 1;
        } else if (tx >= Chunk.SIZE) {
          targetChunk = targetChunk.getNeighbor(1, 0, 0);
          tx = 0;
        }

        // Resolve Y boundary
        if (targetChunk && ty < 0) {
          targetChunk = targetChunk.getNeighbor(0, -1, 0);
          ty = Chunk.SIZE - 1;
        } else if (targetChunk && ty >= Chunk.SIZE) {
          targetChunk = targetChunk.getNeighbor(0, 1, 0);
          ty = 0;
        }

        // Resolve Z boundary
        if (targetChunk && tz < 0) {
          targetChunk = targetChunk.getNeighbor(0, 0, -1);
          tz = Chunk.SIZE - 1;
        } else if (targetChunk && tz >= Chunk.SIZE) {
          targetChunk = targetChunk.getNeighbor(0, 0, 1);
          tz = 0;
        }

        if (!targetChunk) continue;

        const targetBlockPacked = targetChunk.getBlockPacked(tx, ty, tz);

        // If the neighbor block itself cannot contain/pass light on this face,
        // it cannot be part of the removable light graph.
        if (!targetChunk.isTransparent(targetBlockPacked, axis, dir)) {
          continue;
        }

        const neighborLight = isSkyLight
          ? targetChunk.getSkyLight(tx, ty, tz)
          : targetChunk.getBlockLight(tx, ty, tz);

        const preservesFullSun =
          isSkyLight &&
          isDown === 1 &&
          level === 15 &&
          !Chunk.isWaterBlock(sourceBlockId) &&
          !Chunk.isWaterBlock(unpackBlockId(targetBlockPacked));

        const isDependent =
          neighborLight !== 0 &&
          (neighborLight < level || (preservesFullSun && neighborLight === 15));

        if (isDependent) {
          if (isSkyLight) targetChunk.setSkyLight(tx, ty, tz, 0);
          else targetChunk.setBlockLight(tx, ty, tz, 0);

          remeshChunks.add(targetChunk);

          queue.push({
            chunk: targetChunk,
            x: tx,
            y: ty,
            z: tz,
            level: neighborLight,
          });
        } else if (neighborLight >= level) {
          // This neighbor may still act as an alternate source and needs
          // re-propagation after the dependent flood removal finishes.
          propagateQueue.push({
            chunk: targetChunk,
            x: tx,
            y: ty,
            z: tz,
            level: neighborLight,
          });
        }
      }
    }

    for (const chunk of remeshChunks) {
      chunk.scheduleRemesh();
    }

    this.propagateLight(propagateQueue, isSkyLight);
  }

  public scheduleRemesh(priority = false): void {
    if (!this.isLoaded) {
      return; // Cannot remesh an unloaded chunk.
    }

    this.isDirty = true;

    if (priority) {
      this.remeshQueuedPriority = true;
    }

    if (this.remeshQueued) {
      return;
    }

    this.remeshQueued = true;

    requestAnimationFrame(() => {
      this.remeshQueued = false;

      const queuedPriority = this.remeshQueuedPriority;
      this.remeshQueuedPriority = false;

      Chunk.onRequestRemesh?.(this, queuedPriority);
    });
  }

  get chunkX(): number {
    return this.#chunkX;
  }
  get chunkY(): number {
    return this.#chunkY;
  }
  get chunkZ(): number {
    return this.#chunkZ;
  }

  public getNeighbor(dx: number, dy: number, dz: number): Chunk | undefined {
    return Chunk.getChunk(
      this.#chunkX + dx,
      this.#chunkY + dy,
      this.#chunkZ + dz,
    );
  }

  public static getChunk(
    chunkX: number,
    chunkY: number,
    chunkZ: number,
  ): Chunk | undefined {
    const key = Chunk.packCoords(chunkX, chunkY, chunkZ);
    return Chunk.chunkInstances.get(key);
  }

  // --- Coordinate Packing for BigInt Keys ---
  private static readonly BITS = 21n; // 21 bits allows for coordinates up to ~1 million
  private static readonly MASK = (1n << this.BITS) - 1n;
  private static readonly Y_SHIFT = this.BITS;
  private static readonly Z_SHIFT = this.BITS * 2n;

  public static packCoords(x: number, y: number, z: number): bigint {
    const xBig = BigInt(x) & this.MASK;
    const yBig = (BigInt(y) & this.MASK) << this.Y_SHIFT;
    const zBig = (BigInt(z) & this.MASK) << this.Z_SHIFT;
    return xBig | yBig | zBig;
  }

  public dispose(): void {
    this.mesh?.dispose();
    this.transparentMesh?.dispose();
    this.mesh = null;
    this.transparentMesh = null;
    this.opaqueMeshData = null;
    this.transparentMeshData = null;
    // Also clear data arrays and mark as unloaded for complete cleanup
    this._block_array = null;
    this._isUniform = true;
    this._uniformBlockId = 0;
    this._palette = null;
    this.light_array = new Uint8Array(new SharedArrayBuffer(0));
    this.isLoaded = false;
    this.isTerrainScheduled = false;
    this.colliderDirty = true;
  }
}
