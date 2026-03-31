import {
  BLOCK_ID_MASK,
  BLOCK_STATE_MASK,
  BLOCK_STATE_SHIFT,
} from "../../BlockEncoding";

export const BLOCK_TYPE = new Uint8Array(65536);
export const BLOCK_TYPE_TRANSPARENT = 1;

// 0 = opaque / air
for (const id of [30, 60, 61]) {
  BLOCK_TYPE[id] = BLOCK_TYPE_TRANSPARENT;
}

export const WATER_BLOCK_ID = 30;

export const BLOCK_PACK_MASK =
  BLOCK_ID_MASK | (BLOCK_STATE_MASK << BLOCK_STATE_SHIFT);

export const TRANSPARENT_FLAG = 1 << 16;
export const BACKFACE_FLAG = 1 << 17;
export const POS_SCALE = 4;

export const ROTATE_Y_FACE_MASK_1 = new Uint8Array(64);
export const ROTATE_Y_FACE_MASK_2 = new Uint8Array(64);
export const ROTATE_Y_FACE_MASK_3 = new Uint8Array(64);
export const FLIP_Y_FACE_MASK = new Uint8Array(64);

for (let mask = 0; mask < 64; mask++) {
  const px = (mask >> 0) & 1;
  const nx = (mask >> 1) & 1;
  const py = (mask >> 2) & 1;
  const ny = (mask >> 3) & 1;
  const pz = (mask >> 4) & 1;
  const nz = (mask >> 5) & 1;

  // One 90° CW rotation around Y:
  // +X -> +Z
  // +Z -> -X
  // -X -> -Z
  // -Z -> +X
  const rot1 =
    (nz << 0) | (pz << 1) | (py << 2) | (ny << 3) | (px << 4) | (nx << 5);

  ROTATE_Y_FACE_MASK_1[mask] = rot1;

  const px1 = (rot1 >> 0) & 1;
  const nx1 = (rot1 >> 1) & 1;
  const py1 = (rot1 >> 2) & 1;
  const ny1 = (rot1 >> 3) & 1;
  const pz1 = (rot1 >> 4) & 1;
  const nz1 = (rot1 >> 5) & 1;

  const rot2 =
    (nz1 << 0) | (pz1 << 1) | (py1 << 2) | (ny1 << 3) | (px1 << 4) | (nx1 << 5);

  ROTATE_Y_FACE_MASK_2[mask] = rot2;

  const px2 = (rot2 >> 0) & 1;
  const nx2 = (rot2 >> 1) & 1;
  const py2 = (rot2 >> 2) & 1;
  const ny2 = (rot2 >> 3) & 1;
  const pz2 = (rot2 >> 4) & 1;
  const nz2 = (rot2 >> 5) & 1;

  const rot3 =
    (nz2 << 0) | (pz2 << 1) | (py2 << 2) | (ny2 << 3) | (px2 << 4) | (nx2 << 5);

  ROTATE_Y_FACE_MASK_3[mask] = rot3;

  // Flip Y: swap +Y and -Y
  FLIP_Y_FACE_MASK[mask] =
    (px << 0) | (nx << 1) | (ny << 2) | (py << 3) | (pz << 4) | (nz << 5);
}
