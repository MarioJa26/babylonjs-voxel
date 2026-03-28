import { getShapeForBlockId } from "./BlockShapes";

export type ShapeBounds = {
  min: [number, number, number];
  max: [number, number, number];
};

const getSliceAxis = (rotation: number): number => {
  const sliceAxisRaw = rotation & 3;
  return sliceAxisRaw === 1 ? 0 : sliceAxisRaw === 2 ? 2 : 1;
};

const transformBox = (
  min: [number, number, number],
  max: [number, number, number],
  rotation: number,
  flipY: boolean,
): ShapeBounds => {
  let minX = min[0];
  let minY = min[1];
  let minZ = min[2];
  let maxX = max[0];
  let maxY = max[1];
  let maxZ = max[2];

  if (rotation !== 0) {
    const points: [number, number][] = [
      [minX, minZ],
      [minX, maxZ],
      [maxX, minZ],
      [maxX, maxZ],
    ];
    const rotated: [number, number][] = points.map(([x, z]) => {
      switch (rotation) {
        case 1:
          return [1 - z, x];
        case 2:
          return [1 - x, 1 - z];
        case 3:
          return [z, 1 - x];
        default:
          return [x, z];
      }
    });
    minX = Math.min(...rotated.map((p) => p[0]));
    maxX = Math.max(...rotated.map((p) => p[0]));
    minZ = Math.min(...rotated.map((p) => p[1]));
    maxZ = Math.max(...rotated.map((p) => p[1]));
  }

  if (flipY) {
    const newMinY = 1 - maxY;
    const newMaxY = 1 - minY;
    minY = newMinY;
    maxY = newMaxY;
  }

  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
};

const applySliceToBox = (
  min: [number, number, number],
  max: [number, number, number],
  state: number,
): ShapeBounds => {
  const slice = (state >> 3) & 7;
  if (slice === 0) return { min, max };

  const rotation = state & 7;
  const sliceAxis = getSliceAxis(rotation);
  const flip = (rotation & 4) !== 0;
  const heightScale = slice / 8;
  const outMin: [number, number, number] = [min[0], min[1], min[2]];
  const outMax: [number, number, number] = [max[0], max[1], max[2]];

  if (flip) {
    outMin[sliceAxis] = 1 - (1 - min[sliceAxis]) * heightScale;
    outMax[sliceAxis] = 1 - (1 - max[sliceAxis]) * heightScale;
  } else {
    outMin[sliceAxis] = min[sliceAxis] * heightScale;
    outMax[sliceAxis] = max[sliceAxis] * heightScale;
  }

  if (outMin[sliceAxis] > outMax[sliceAxis]) {
    const tmp = outMin[sliceAxis];
    outMin[sliceAxis] = outMax[sliceAxis];
    outMax[sliceAxis] = tmp;
  }

  return { min: outMin, max: outMax };
};

export const getTransformedShapeBoxes = (
  blockId: number,
  blockState: number,
): ShapeBounds[] => {
  const shape = getShapeForBlockId(blockId);
  const rotation = shape.rotateY ? blockState & 3 : 0;
  const flipY = shape.allowFlipY && (blockState & 4) !== 0;
  const boxes: ShapeBounds[] = [];

  for (const box of shape.boxes) {
    let transformed = transformBox(box.min, box.max, rotation, flipY);
    if (shape.usesSliceState) {
      transformed = applySliceToBox(
        transformed.min,
        transformed.max,
        blockState,
      );
    }

    if (
      transformed.max[0] <= transformed.min[0] ||
      transformed.max[1] <= transformed.min[1] ||
      transformed.max[2] <= transformed.min[2]
    ) {
      continue;
    }

    boxes.push(transformed);
  }

  return boxes;
};
