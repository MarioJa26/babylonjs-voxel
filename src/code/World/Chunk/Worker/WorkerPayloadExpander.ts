import { PaletteExpander } from "../DataStructures/PaletteExpander";
import { GenerateFullMeshRequest } from "../DataStructures/WorkerMessageType";

export type ExpandedFullMeshContext = {
  request: GenerateFullMeshRequest;
  totalBlocks: number;
  needsUint16: boolean;
};

export class WorkerPayloadExpander {
  public static detectNeedsUint16(
    request: GenerateFullMeshRequest,
    paletteExpander: PaletteExpander,
  ): boolean {
    let needsUint16 = paletteExpander.isUint16(request.palette);

    if (!needsUint16 && typeof request.uniformBlockId === "number") {
      needsUint16 = request.uniformBlockId > 255;
    }

    if (!needsUint16 && request.neighborUniformIds) {
      for (let i = 0; i < request.neighborUniformIds.length; i++) {
        const v = request.neighborUniformIds[i];
        if (v !== undefined && v > 255) {
          needsUint16 = true;
          break;
        }
      }
    }

    return needsUint16;
  }

  public static expandCenterChunkPayload(
    request: GenerateFullMeshRequest,
    totalBlocks: number,
    needsUint16: boolean,
    paletteExpander: PaletteExpander,
  ): void {
    if (!request.block_array && typeof request.uniformBlockId === "number") {
      const uniformValue = request.uniformBlockId;
      request.block_array = needsUint16
        ? new Uint16Array(totalBlocks)
        : new Uint8Array(totalBlocks);
      request.block_array.fill(uniformValue);
      return;
    }

    if (request.palette && request.block_array instanceof Uint8Array) {
      request.block_array = paletteExpander.expandPalette(
        request.block_array,
        request.palette,
        totalBlocks,
      );
    }
  }

  public static expandNeighborPayloads(
    request: GenerateFullMeshRequest,
    totalBlocks: number,
    needsUint16: boolean,
    paletteExpander: PaletteExpander,
  ): void {
    const { neighbors, neighborUniformIds, neighborPalettes } = request;

    if (!neighborUniformIds) {
      return;
    }

    for (let i = 0; i < neighbors.length; i++) {
      const neighbor = neighbors[i];
      const uniformId = neighborUniformIds[i];
      const palette = neighborPalettes?.[i];

      if (
        (neighbor === undefined || neighbor === null) &&
        typeof uniformId === "number"
      ) {
        const expandedNeighbor = needsUint16
          ? new Uint16Array(totalBlocks)
          : new Uint8Array(totalBlocks);

        expandedNeighbor.fill(uniformId);
        neighbors[i] = expandedNeighbor;
        continue;
      }

      if (neighbor instanceof Uint8Array && palette) {
        neighbors[i] = paletteExpander.expandPalette(
          neighbor,
          palette,
          totalBlocks,
        );
      }
    }
  }

  public static expandFullMeshRequest(
    request: GenerateFullMeshRequest,
    paletteExpander: PaletteExpander,
  ): ExpandedFullMeshContext {
    const totalBlocks = request.chunk_size ** 3;
    const needsUint16 = this.detectNeedsUint16(request, paletteExpander);

    this.expandCenterChunkPayload(
      request,
      totalBlocks,
      needsUint16,
      paletteExpander,
    );

    this.expandNeighborPayloads(
      request,
      totalBlocks,
      needsUint16,
      paletteExpander,
    );

    return {
      request,
      totalBlocks,
      needsUint16,
    };
  }

  public static clearLargeReferences(request: GenerateFullMeshRequest): void {
    request.block_array = undefined;
    request.palette = undefined;

    for (let i = 0; i < request.neighbors.length; i++) {
      request.neighbors[i] = undefined;
    }

    if (request.neighborLights) {
      for (let i = 0; i < request.neighborLights.length; i++) {
        request.neighborLights[i] = undefined;
      }
    }

    if (request.neighborPalettes) {
      for (let i = 0; i < request.neighborPalettes.length; i++) {
        request.neighborPalettes[i] = undefined;
      }
    }
  }
}
