import { Ray, Vector3 } from "@babylonjs/core";
import { BlockType, isCollidableBlock } from "@/code/World/BlockType";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { FACE_ALL, getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
import { type Player, REACH_DISTANCE } from "../../Player";

export type BlockRaycastHit = {
	x: number;
	y: number;
	z: number;
	nx: number;
	ny: number;
	nz: number;
	t: number;
};

type FaceHit = { t: number; nx: number; ny: number; nz: number };

/** All results are written into these shared objects — callers must not retain references across frames. */
const _sharedHit: BlockRaycastHit = {
	x: 0,
	y: 0,
	z: 0,
	nx: 0,
	ny: 0,
	nz: 0,
	t: 0,
};
const _sharedFaceHit: FaceHit = { t: 0, nx: 0, ny: 0, nz: 0 };
const _sharedVec3 = new Vector3(0, 0, 0);
let _sharedRay: Ray | null = null;

function getForwardRay(player: Player, length: number): Ray {
	if (!_sharedRay) {
		_sharedRay = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 1);
	}
	player.playerCamera.playerCamera.getForwardRayToRef(_sharedRay, length);
	return _sharedRay;
}

function isTargetableBlock(blockId: number): boolean {
	return isCollidableBlock(blockId) || blockId === BlockType.GrassCross;
}

function isFullBlockShape(blockId: number, blockState: number): boolean {
	const slice = (blockState >> 3) & 7;
	if (slice !== 0) return false;
	const shape = getShapeForBlockId(blockId);
	if (shape.name === "cube") return true;
	if (!shape.usesSliceState || shape.boxes.length !== 1) return false;
	const box = shape.boxes[0];
	return (
		box.faceMask === FACE_ALL &&
		box.min[0] === 0 &&
		box.min[1] === 0 &&
		box.min[2] === 0 &&
		box.max[0] === 1 &&
		box.max[1] === 1 &&
		box.max[2] === 1
	);
}

/**
 * Ray–AABB slab intersection over a [tMin, tMax] segment.
 * Writes into _sharedFaceHit and returns it, or null on miss.
 */
function intersectRayAabb(
	ox: number,
	oy: number,
	oz: number,
	dx: number,
	dy: number,
	dz: number,
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
	tMin: number,
	tMax: number,
	fallbackNx: number,
	fallbackNy: number,
	fallbackNz: number,
): FaceHit | null {
	const eps = 1e-8;
	let t0 = tMin,
		t1 = tMax;
	let hitNx = 0,
		hitNy = 0,
		hitNz = 0;

	const origins = [ox, oy, oz];
	const dirs = [dx, dy, dz];
	const mins = [minX, minY, minZ];
	const maxs = [maxX, maxY, maxZ];

	for (let axis = 0; axis < 3; axis++) {
		const o = origins[axis],
			d = dirs[axis];
		const mn = mins[axis],
			mx = maxs[axis];

		if (Math.abs(d) < eps) {
			if (o < mn || o > mx) return null;
			continue;
		}

		const tToMin = (mn - o) / d;
		const tToMax = (mx - o) / d;
		let near = tToMin,
			far = tToMax;
		let nearNx = axis === 0 ? -1 : 0;
		let nearNy = axis === 1 ? -1 : 0;
		let nearNz = axis === 2 ? -1 : 0;

		if (tToMin > tToMax) {
			near = tToMax;
			far = tToMin;
			nearNx = -nearNx;
			nearNy = -nearNy;
			nearNz = -nearNz;
		}

		if (near > t0) {
			t0 = near;
			hitNx = nearNx;
			hitNy = nearNy;
			hitNz = nearNz;
		}
		if (far < t1) t1 = far;
		if (t0 > t1) return null;
	}

	if (t0 < tMin || t0 > tMax) return null;

	_sharedFaceHit.t = t0;
	_sharedFaceHit.nx =
		hitNx !== 0 || hitNy !== 0 || hitNz !== 0 ? hitNx : fallbackNx;
	_sharedFaceHit.ny =
		hitNx !== 0 || hitNy !== 0 || hitNz !== 0 ? hitNy : fallbackNy;
	_sharedFaceHit.nz =
		hitNx !== 0 || hitNy !== 0 || hitNz !== 0 ? hitNz : fallbackNz;
	return _sharedFaceHit;
}

function raycastShapeInVoxel(
	ox: number,
	oy: number,
	oz: number,
	dx: number,
	dy: number,
	dz: number,
	vx: number,
	vy: number,
	vz: number,
	blockId: number,
	blockState: number,
	tEnter: number,
	tExit: number,
	fallbackNx: number,
	fallbackNy: number,
	fallbackNz: number,
): FaceHit | null {
	let bestT = Infinity;
	let bestNx = 0,
		bestNy = 0,
		bestNz = 0;

	for (const box of getTransformedShapeBoxes(blockId, blockState)) {
		const hit = intersectRayAabb(
			ox,
			oy,
			oz,
			dx,
			dy,
			dz,
			vx + box.min[0],
			vy + box.min[1],
			vz + box.min[2],
			vx + box.max[0],
			vy + box.max[1],
			vz + box.max[2],
			tEnter,
			tExit,
			fallbackNx,
			fallbackNy,
			fallbackNz,
		);
		if (hit && hit.t < bestT) {
			bestT = hit.t;
			bestNx = hit.nx;
			bestNy = hit.ny;
			bestNz = hit.nz;
		}
	}

	if (bestT === Infinity) return null;
	_sharedFaceHit.t = bestT;
	_sharedFaceHit.nx = bestNx;
	_sharedFaceHit.ny = bestNy;
	_sharedFaceHit.nz = bestNz;
	return _sharedFaceHit;
}

/**
 * DDA voxel traversal. Returns a shared hit object (valid until next call) or null.
 */
function raycastFirstBlock(
	player: Player,
	shouldHit: (x: number, y: number, z: number, blockId: number) => boolean,
): BlockRaycastHit | null {
	const ray = getForwardRay(player, REACH_DISTANCE);
	const ox = ray.origin.x,
		oy = ray.origin.y,
		oz = ray.origin.z;
	const dx = ray.direction.x,
		dy = ray.direction.y,
		dz = ray.direction.z;
	const maxDist = ray.length;
	if (!(maxDist > 0)) return null;

	let x = Math.floor(ox),
		y = Math.floor(oy),
		z = Math.floor(oz);

	const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
	const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
	const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

	const invDx = stepX === 0 ? Infinity : 1 / Math.abs(dx);
	const invDy = stepY === 0 ? Infinity : 1 / Math.abs(dy);
	const invDz = stepZ === 0 ? Infinity : 1 / Math.abs(dz);

	const boundX = stepX > 0 ? x + 1 : x;
	const boundY = stepY > 0 ? y + 1 : y;
	const boundZ = stepZ > 0 ? z + 1 : z;

	let tMaxX = stepX === 0 ? Infinity : (boundX - ox) / dx;
	let tMaxY = stepY === 0 ? Infinity : (boundY - oy) / dy;
	let tMaxZ = stepZ === 0 ? Infinity : (boundZ - oz) / dz;

	let t = 0,
		nx = 0,
		ny = 0,
		nz = 0;

	while (true) {
		if (tMaxX < tMaxY) {
			if (tMaxX < tMaxZ) {
				x += stepX;
				t = tMaxX;
				tMaxX += invDx;
				nx = -stepX;
				ny = 0;
				nz = 0;
			} else {
				z += stepZ;
				t = tMaxZ;
				tMaxZ += invDz;
				nx = 0;
				ny = 0;
				nz = -stepZ;
			}
		} else {
			if (tMaxY < tMaxZ) {
				y += stepY;
				t = tMaxY;
				tMaxY += invDy;
				nx = 0;
				ny = -stepY;
				nz = 0;
			} else {
				z += stepZ;
				t = tMaxZ;
				tMaxZ += invDz;
				nx = 0;
				ny = 0;
				nz = -stepZ;
			}
		}

		if (t > maxDist) return null;

		const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
		if (!shouldHit(x, y, z, blockId)) continue;

		const blockState = ChunkLoadingSystem.getBlockStateByWorldCoords(x, y, z);

		if (isFullBlockShape(blockId, blockState)) {
			_sharedHit.x = x;
			_sharedHit.y = y;
			_sharedHit.z = z;
			_sharedHit.nx = nx;
			_sharedHit.ny = ny;
			_sharedHit.nz = nz;
			_sharedHit.t = t;
			return _sharedHit;
		}

		const tExit = Math.min(tMaxX, tMaxY, tMaxZ, maxDist);
		const shapeHit = raycastShapeInVoxel(
			ox,
			oy,
			oz,
			dx,
			dy,
			dz,
			x,
			y,
			z,
			blockId,
			blockState,
			t,
			tExit,
			nx,
			ny,
			nz,
		);
		if (shapeHit) {
			_sharedHit.x = x;
			_sharedHit.y = y;
			_sharedHit.z = z;
			_sharedHit.nx = shapeHit.nx;
			_sharedHit.ny = shapeHit.ny;
			_sharedHit.nz = shapeHit.nz;
			_sharedHit.t = shapeHit.t;
			return _sharedHit;
		}
	}
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function pickTarget(player: Player): BlockRaycastHit | null {
	return raycastFirstBlock(player, (_x, _y, _z, id) => isTargetableBlock(id));
}

export function pickWaterTarget(player: Player): BlockRaycastHit | null {
	return raycastFirstBlock(player, (_x, _y, _z, id) => id === BlockType.Water);
}

export function pickBlock(player: Player): number | null {
	const hit = pickTarget(player);
	return hit
		? ChunkLoadingSystem.getBlockByWorldCoords(hit.x, hit.y, hit.z)
		: null;
}

/** Returns placement grid position (face-adjacent block), or null. */
export function getPlacementPosition(player: Player): Vector3 | null {
	const hit = raycastFirstBlock(player, (_x, _y, _z, id) =>
		isTargetableBlock(id),
	);
	if (!hit) return null;
	_sharedVec3.set(
		Math.floor(hit.x + hit.nx),
		Math.floor(hit.y + hit.ny),
		Math.floor(hit.z + hit.nz),
	);
	return _sharedVec3;
}

export type PlacementHit = {
	pos: Vector3;
	nx: number;
	ny: number;
	nz: number;
	hitFracX: number;
	hitFracY: number;
	hitFracZ: number;
};

const _sharedPlacementHit: PlacementHit = {
	pos: new Vector3(),
	nx: 0,
	ny: 0,
	nz: 0,
	hitFracX: 0,
	hitFracY: 0,
	hitFracZ: 0,
};

export function getPlacementHit(player: Player): PlacementHit | null {
	const hit = raycastFirstBlock(player, (_x, _y, _z, id) =>
		isTargetableBlock(id),
	);
	if (!hit) return null;

	const ray = getForwardRay(player, REACH_DISTANCE);
	const wx = ray.origin.x + ray.direction.x * hit.t;
	const wy = ray.origin.y + ray.direction.y * hit.t;
	const wz = ray.origin.z + ray.direction.z * hit.t;

	_sharedPlacementHit.pos.set(
		Math.floor(hit.x + hit.nx),
		Math.floor(hit.y + hit.ny),
		Math.floor(hit.z + hit.nz),
	);
	_sharedPlacementHit.nx = hit.nx;
	_sharedPlacementHit.ny = hit.ny;
	_sharedPlacementHit.nz = hit.nz;
	_sharedPlacementHit.hitFracX = wx - Math.floor(wx);
	_sharedPlacementHit.hitFracY = wy - Math.floor(wy);
	_sharedPlacementHit.hitFracZ = wz - Math.floor(wz);
	return _sharedPlacementHit;
}
