// MeshPipeline/core/FaceEmitter.ts

import { POS_SCALE } from "../../Chunk/Worker/ChunkMesherConstants";
import { BlockTextures } from "../../Texture/BlockTextures";
import {
  EmitQuadParams,
  MaterialType,
  WorkerInternalMeshData,
} from "../types/MeshTypes";
import { getMaterialTintBucket } from "./ShapePipeline";

export function emitQuad(
  out: WorkerInternalMeshData,
  params: EmitQuadParams,
): void {
  const {
    x,
    y,
    z,
    axis,
    width,
    height,
    blockId,
    isBackFace,
    light,
    ao,
    faceName,
    materialType,
    flip,
    diagonal = 0,
  } = params;

  const tex = BlockTextures[blockId];
  if (!tex) return;

  const tile = tex[faceName] ?? tex.all;
  if (!tile) return;

  const tx = tile[0];
  const ty = tile[1];

  const axisFace = axis * 2 + (isBackFace ? 1 : 0);

  const isWater =
    materialType === MaterialType.WaterOrGlass && blockId === 30 ? 1 : 0;

  const diagEnabled = diagonal !== 0 ? 1 : 0;
  const diagVariant = diagonal === 2 ? 1 : 0;

  const meta =
    (flip ? 1 : 0) |
    ((materialType & 0x3) << 1) |
    (isWater << 3) |
    (diagEnabled << 4) |
    (diagVariant << 5);

  const tint = getMaterialTintBucket(blockId);

  const sx = Math.round(x * POS_SCALE);
  const sy = Math.round(y * POS_SCALE);
  const sz = Math.round(z * POS_SCALE);
  const sw = Math.round(width * POS_SCALE);
  const sh = Math.round(height * POS_SCALE);

  out.faceDataA.push4(sx, sy, sz, axisFace);
  out.faceDataB.push4(sw, sh, tx, ty);
  out.faceDataC.push4(ao, light, tint, meta);

  out.faceCount++;
}
