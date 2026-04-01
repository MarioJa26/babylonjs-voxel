/// <reference lib="webworker" />

import { WorldGenerator } from "../Generation/WorldGenerator";
import { GenerationParams } from "../Generation/NoiseAndParameters/GenerationParams";
import { MeshData } from "./DataStructures/MeshData";
import { WorkerInternalMeshData } from "./DataStructures/WorkerInternalMeshData";
import {
  WorkerTaskType,
  WorkerRequestData,
} from "./DataStructures/WorkerMessageType";
import { PaletteExpander } from "./DataStructures/PaletteExpander";
import { WorkerTaskHandlers } from "./Worker/WorkerTaskHandlers";
import { ChunkMeshBuilder } from "./Worker/ChunkMeshBuilder";

// ---------------------------------------------------------------------------
// Shared instances
// ---------------------------------------------------------------------------
const generator = new WorldGenerator(GenerationParams);
const paletteExpander = new PaletteExpander();

// ---------------------------------------------------------------------------
// Block compression
// ---------------------------------------------------------------------------
function compressBlocks(blocks: Uint8Array): {
  isUniform: boolean;
  uniformBlockId: number;
  palette: Uint16Array | null;
  packedBlocks: Uint8Array | Uint16Array | null;
} {
  const seen = new Uint8Array(65536);
  let uniqueCount = 0;
  const firstId = blocks[0];

  for (let i = 0; i < blocks.length; i++) {
    const id = blocks[i];
    if (!seen[id]) {
      seen[id] = 1;
      uniqueCount++;
      if (uniqueCount > 16) break;
    }
  }

  if (uniqueCount === 1) {
    return {
      isUniform: true,
      uniformBlockId: firstId,
      palette: null,
      packedBlocks: null,
    };
  }

  if (uniqueCount <= 16) {
    const palette = new Uint16Array(uniqueCount);
    let pi = 0;

    for (let id = 0; id < 65536 && pi < uniqueCount; id++) {
      if (seen[id]) {
        palette[pi++] = id;
      }
    }

    for (let i = 0; i < palette.length; i++) {
      seen[palette[i]] = i;
    }

    const len = (blocks.length + 1) >> 1;
    const buffer =
      typeof SharedArrayBuffer !== "undefined"
        ? new SharedArrayBuffer(len)
        : new ArrayBuffer(len);

    const packedArray = new Uint8Array(buffer);

    for (let i = 0; i < blocks.length; i++) {
      const nibble = seen[blocks[i]];
      const byteIndex = i >> 1;

      if (i & 1) {
        packedArray[byteIndex] =
          (packedArray[byteIndex] & 0x0f) | ((nibble & 0x0f) << 4);
      } else {
        packedArray[byteIndex] =
          (packedArray[byteIndex] & 0xf0) | (nibble & 0x0f);
      }
    }

    return {
      isUniform: false,
      uniformBlockId: 0,
      palette,
      packedBlocks: packedArray,
    };
  }

  return {
    isUniform: false,
    uniformBlockId: 0,
    palette: null,
    packedBlocks: blocks,
  };
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------
const onMessageHandler = (event: MessageEvent<WorkerRequestData>) => {
  const { type } = event.data;

  switch (type) {
    case WorkerTaskType.GenerateFullMesh: {
      WorkerTaskHandlers.handleGenerateFullMesh(event.data, {
        paletteExpander,
        meshBuilder: ChunkMeshBuilder,
        postFullMeshResult,
      });
      return;
    }

    case WorkerTaskType.GenerateTerrain: {
      const { payload, transferables } =
        WorkerTaskHandlers.handleGenerateTerrain(event.data, {
          generator,
          compressBlocks,
        });

      self.postMessage(
        {
          ...payload,
          type: WorkerTaskType.GenerateTerrain,
        },
        transferables,
      );
      return;
    }

    case WorkerTaskType.GenerateDistantTerrain: {
      const { payload, transferables } =
        WorkerTaskHandlers.handleGenerateDistantTerrain(event.data);

      self.postMessage(
        {
          ...payload,
          type: WorkerTaskType.GenerateDistantTerrain_Generated,
        },
        transferables,
      );
      return;
    }

    default:
      return;
  }
};

self.onmessage = onMessageHandler;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toTransferable(data: WorkerInternalMeshData): MeshData {
  return {
    faceDataA: data.faceDataA.finalArray,
    faceDataB: data.faceDataB.finalArray,
    faceDataC: data.faceDataC.finalArray,
    faceCount: data.faceCount,
  };
}

function postFullMeshResult(
  chunkId: bigint,
  lod: number,
  opaque: WorkerInternalMeshData,
  transparent: WorkerInternalMeshData,
) {
  const opaqueMeshData = toTransferable(opaque);
  const transparentMeshData = toTransferable(transparent);

  if (lod >= 3) {
    for (let i = 0; i < opaqueMeshData.faceDataC.length; i += 4) {
      opaqueMeshData.faceDataC[i] = 0;
    }
    for (let i = 0; i < transparentMeshData.faceDataC.length; i += 4) {
      transparentMeshData.faceDataC[i] = 0;
    }
  }

  self.postMessage(
    {
      chunkId,
      lod,
      type: WorkerTaskType.GenerateFullMesh,
      opaque: opaqueMeshData,
      transparent: transparentMeshData,
    },
    [
      opaqueMeshData.faceDataA.buffer,
      opaqueMeshData.faceDataB.buffer,
      opaqueMeshData.faceDataC.buffer,
      transparentMeshData.faceDataA.buffer,
      transparentMeshData.faceDataB.buffer,
      transparentMeshData.faceDataC.buffer,
    ],
  );
}
