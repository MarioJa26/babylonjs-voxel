import { unpackBlockId } from "../Chunk/DataStructures/BlockEncoding";
import {
	FACE_ALL,
	FACE_NX,
	FACE_NZ,
	FACE_PX,
	FACE_PZ,
	type ShapeBox,
	type ShapeDefinition,
} from "./BlockShapes";

const FENCE_IDS = new Set<number>([50, 56]);

export function isFenceBlockId(blockId: number): boolean {
	return FENCE_IDS.has(blockId);
}

export function isFencePackedBlock(packed: number): boolean {
	return isFenceBlockId(unpackBlockId(packed));
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
	faceMask: FACE_ALL & ~FACE_NZ, // hide -Z face (at cell boundary z=0)
};

const ARM_SOUTH: ShapeBox = {
	min: [0.375, 0, 0.625],
	max: [0.625, 1, 1],
	faceMask: FACE_ALL & ~FACE_PZ, // hide +Z face (at cell boundary z=1)
};

const ARM_EAST: ShapeBox = {
	min: [0.625, 0, 0.375],
	max: [1, 1, 0.625],
	faceMask: FACE_ALL & ~FACE_PX, // hide +X face (at cell boundary x=1)
};

const ARM_WEST: ShapeBox = {
	min: [0, 0, 0.375],
	max: [0.375, 1, 0.625],
	faceMask: FACE_ALL & ~FACE_NX, // hide -X face (at cell boundary x=0)
};

const ARM_BOXES_BY_BIT: ShapeBox[] = [
	ARM_NORTH, // bit 0 = -Z
	ARM_SOUTH, // bit 1 = +Z
	ARM_EAST, // bit 2 = +X
	ARM_WEST, // bit 3 = -X
];

type GetBlockFn = (x: number, y: number, z: number) => number;

export function computeFenceNeighborMask(
	x: number,
	y: number,
	z: number,
	getBlock: GetBlockFn,
): number {
	let mask = 0;

	const north = getBlock(x, y, z - 1);
	if (north && isFenceBlockId(unpackBlockId(north))) mask |= NORTH;

	const south = getBlock(x, y, z + 1);
	if (south && isFenceBlockId(unpackBlockId(south))) mask |= SOUTH;

	const east = getBlock(x + 1, y, z);
	if (east && isFenceBlockId(unpackBlockId(east))) mask |= EAST;

	const west = getBlock(x - 1, y, z);
	if (west && isFenceBlockId(unpackBlockId(west))) mask |= WEST;

	return mask;
}

export function getFenceArmBoxes(mask: number): ShapeBox[] {
	const boxes: ShapeBox[] = [];
	for (let i = 0; i < 4; i++) {
		if (mask & (1 << i)) {
			boxes.push(ARM_BOXES_BY_BIT[i]);
		}
	}
	return boxes;
}

const shapeCache = new Map<number, ShapeDefinition>();

export function getFenceDynamicShape(mask: number): ShapeDefinition {
	let shape = shapeCache.get(mask);
	if (shape) return shape;

	// Post hides faces in directions where arms are present
	let postFaceMask = FACE_ALL;
	if (mask & NORTH) postFaceMask &= ~FACE_NZ;
	if (mask & SOUTH) postFaceMask &= ~FACE_PZ;
	if (mask & EAST) postFaceMask &= ~FACE_PX;
	if (mask & WEST) postFaceMask &= ~FACE_NX;

	const postBox: ShapeBox = {
		min: [0.375, 0, 0.375],
		max: [0.625, 1, 0.625],
		faceMask: postFaceMask,
	};

	const boxes: ShapeBox[] = [postBox];
	for (let i = 0; i < 4; i++) {
		if (mask & (1 << i)) {
			boxes.push(ARM_BOXES_BY_BIT[i]);
		}
	}

	shape = {
		name: "fence",
		boxes,
		rotateY: false,
		allowFlipY: false,
		usesSliceState: false,
	};

	shapeCache.set(mask, shape);
	return shape;
}
