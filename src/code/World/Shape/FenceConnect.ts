import { unpackBlockId } from "../Chunk/DataStructures/BlockEncoding";
import {
	FACE_ALL,
	FACE_NX,
	FACE_NZ,
	FACE_PX,
	FACE_PZ,
	getShapeForBlockId,
	type ShapeBox,
	type ShapeDefinition,
} from "./BlockShapes";

export function isFenceBlockId(blockId: number): boolean {
	return getShapeForBlockId(blockId).name === "fence";
}

// Neighbor mask bits (world directions)
const NORTH = 1 << 0; // -Z
const SOUTH = 1 << 1; // +Z
const EAST = 1 << 2; // +X
const WEST = 1 << 3; // -X

// Arm boxes: extend from post edge to cell boundary, world-aligned
// faceMask hides the face at the cell boundary (neighbor's arm renders it instead)

const ARM_NORTH: ShapeBox = {
	min: [0.375, 0, 0],
	max: [0.625, 1, 0.375],
	// hide boundary face -Z and inner face touching post +Z
	faceMask: FACE_ALL & ~FACE_NZ & ~FACE_PZ,
};

const ARM_SOUTH: ShapeBox = {
	min: [0.375, 0, 0.625],
	max: [0.625, 1, 1],
	// hide boundary face +Z and inner face touching post -Z
	faceMask: FACE_ALL & ~FACE_PZ & ~FACE_NZ,
};

const ARM_EAST: ShapeBox = {
	min: [0.625, 0, 0.375],
	max: [1, 1, 0.625],
	// hide boundary face +X and inner face touching post -X
	faceMask: FACE_ALL & ~FACE_PX & ~FACE_NX,
};

const ARM_WEST: ShapeBox = {
	min: [0, 0, 0.375],
	max: [0.375, 1, 0.625],
	// hide boundary face -X and inner face touching post +X
	faceMask: FACE_ALL & ~FACE_NX & ~FACE_PX,
};

const FENCE_ARM_BOXES_BY_MASK: readonly ShapeBox[][] = (() => {
	const out: ShapeBox[][] = new Array(16);
	for (let mask = 0; mask < 16; mask++) {
		const boxes: ShapeBox[] = [];
		if (mask & NORTH) boxes.push(ARM_NORTH);
		if (mask & SOUTH) boxes.push(ARM_SOUTH);
		if (mask & EAST) boxes.push(ARM_EAST);
		if (mask & WEST) boxes.push(ARM_WEST);
		out[mask] = boxes;
	}
	return out;
})();

type GetBlockFn = (x: number, y: number, z: number) => number;

export function computeFenceNeighborMask(
	x: number,
	y: number,
	z: number,
	getBlock: GetBlockFn,
): number {
	let mask = 0;

	let b = getBlock(x, y, z - 1);
	if (b && isFenceBlockId(unpackBlockId(b))) mask |= NORTH;

	b = getBlock(x, y, z + 1);
	if (b && isFenceBlockId(unpackBlockId(b))) mask |= SOUTH;

	b = getBlock(x + 1, y, z);
	if (b && isFenceBlockId(unpackBlockId(b))) mask |= EAST;

	b = getBlock(x - 1, y, z);
	if (b && isFenceBlockId(unpackBlockId(b))) mask |= WEST;

	return mask;
}

export function getFenceArmBoxes(mask: number): ShapeBox[] {
	return FENCE_ARM_BOXES_BY_MASK[mask & 15] as ShapeBox[];
}

const FENCE_SHAPES_BY_MASK: readonly ShapeDefinition[] = (() => {
	const out: ShapeDefinition[] = new Array(16);
	for (let mask = 0; mask < 16; mask++) {
		let postFaceMask = FACE_ALL;
		if (mask & NORTH) postFaceMask &= ~FACE_NZ;
		if (mask & SOUTH) postFaceMask &= ~FACE_PZ;
		if (mask & EAST) postFaceMask &= ~FACE_PX;
		if (mask & WEST) postFaceMask &= ~FACE_NX;

		const boxes: ShapeBox[] = [
			{
				min: [0.375, 0, 0.375],
				max: [0.625, 1, 0.625],
				faceMask: postFaceMask,
			},
		];
		if (mask & NORTH) boxes.push(ARM_NORTH);
		if (mask & SOUTH) boxes.push(ARM_SOUTH);
		if (mask & EAST) boxes.push(ARM_EAST);
		if (mask & WEST) boxes.push(ARM_WEST);

		out[mask] = {
			name: "fence",
			boxes,
			rotateY: false,
			allowFlipY: false,
			usesSliceState: false,
		};
	}
	return out;
})();

export function getFenceDynamicShape(mask: number): ShapeDefinition {
	return FENCE_SHAPES_BY_MASK[mask & 15];
}
