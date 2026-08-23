import { addVec3InPlace, type Vec3, vec3 } from "@babylonjs/lite";
import {
	lengthSqVec3,
	Matrix,
	setVec3,
	transformCoordinatesVec3ToRef,
	transformNormalVec3ToRef,
	vec3Zero,
} from "@/code/Lib/Math";
import { BoatChunk } from "@/code/World/Boat/BoatChunk";
import { Chunk } from "@/code/World/Chunk/Chunk";
import {
	getBlockAndStateByWorldCoords,
	getTerrainBlockByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { getBlockStateByWorldCoords } from "@/code/World/Chunk/Loading/ChunkWorldMutations";
import {
	FACE_ALL,
	getCubeShapeIndex,
	getShapeByBlockId,
	getShapeForBlockId,
} from "@/code/World/Shape/BlockShapes";
import {
	getTransformedShapeBoxes,
	type ShapeBounds,
} from "@/code/World/Shape/BlockShapeTransforms";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import { DroppedItem } from "../../Inventory/DroppedItem";
import type { Player } from "../../Player";
import { REACH_DISTANCE } from "../../PlayerStats";

export type BlockRaycastHit = {
	x: number;
	y: number;
	z: number;
	nx: number;
	ny: number;
	nz: number;
	t: number;
	blockId: number;
	blockState: number;
	dynamicContext: unknown | null;
};

type FaceHit = { t: number; nx: number; ny: number; nz: number };

/** Minimal ray shape (Lite has no core `Ray`). */
type RayLike = { origin: Vec3; direction: Vec3; length: number };
const FULL_BLOCK_UNKNOWN = 0;
const FULL_BLOCK_NO = 1;
const FULL_BLOCK_YES = 2;
const _fullBlockBaseCache: number[] = [];

// Capture-free module-level fence neighbor lookup — a fresh closure used to
// be allocated for every fence voxel the DDA visited.
function fenceNeighborIdLookup(wx: number, wy: number, wz: number): number {
	return getBlockAndStateByWorldCoords(wx, wy, wz).blockId;
}

const CUBE_SHAPE_INDEX = getCubeShapeIndex();
/** All results are written into these shared objects — callers must not retain references across frames. */
const _sharedHit: BlockRaycastHit = {
	x: 0,
	y: 0,
	z: 0,
	nx: 0,
	ny: 0,
	nz: 0,
	t: 0,
	blockId: 0,
	blockState: 0,
	dynamicContext: null,
};
const _sharedTerrainHit: BlockRaycastHit = {
	x: 0,
	y: 0,
	z: 0,
	nx: 0,
	ny: 0,
	nz: 0,
	t: 0,
	blockId: 0,
	blockState: 0,
	dynamicContext: null,
};

const _sharedBoatHit: BlockRaycastHit = {
	x: 0,
	y: 0,
	z: 0,
	nx: 0,
	ny: 0,
	nz: 0,
	t: 0,
	blockId: 0,
	blockState: 0,
	dynamicContext: null,
};

const _sharedBestBoatHit: BlockRaycastHit = {
	x: 0,
	y: 0,
	z: 0,
	nx: 0,
	ny: 0,
	nz: 0,
	t: 0,
	blockId: 0,
	blockState: 0,
	dynamicContext: null,
};

const _sharedBestBoatContext: {
	kind: string;
	boatChunk: BoatChunk | null;
	localX: number;
	localY: number;
	localZ: number;
	localHitNx: number;
	localHitNy: number;
	localHitNz: number;
} = {
	kind: "boatChunk",
	boatChunk: null,
	localX: 0,
	localY: 0,
	localZ: 0,
	localHitNx: 0,
	localHitNy: 0,
	localHitNz: 0,
};

const _sharedFaceHit: FaceHit = { t: 0, nx: 0, ny: 0, nz: 0 };
const _sharedVec3 = vec3Zero();
const _sharedVec3b = vec3Zero();
const _sharedLocalOrigin = vec3Zero();
const _sharedLocalDir = vec3Zero();
const _sharedWorldNormal = vec3Zero();
const _sharedWorldCenter = vec3Zero();
const _sharedInvMatrix = new Matrix();
const _sharedWorldMatrix = new Matrix();
const _sharedBoatContext: {
	kind: string;
	boatChunk: BoatChunk | null;
	localX: number;
	localY: number;
	localZ: number;
	localHitNx: number;
	localHitNy: number;
	localHitNz: number;
} = {
	kind: "boatChunk",
	boatChunk: null,
	localX: 0,
	localY: 0,
	localZ: 0,
	localHitNx: 0,
	localHitNy: 0,
	localHitNz: 0,
};
let _sharedRay: RayLike | null = null;
function copyBlockRaycastHit(
	from: BlockRaycastHit,
	to: BlockRaycastHit,
): BlockRaycastHit {
	to.x = from.x;
	to.y = from.y;
	to.z = from.z;
	to.nx = from.nx;
	to.ny = from.ny;
	to.nz = from.nz;
	to.t = from.t;
	to.blockId = from.blockId;
	to.blockState = from.blockState;
	to.dynamicContext = from.dynamicContext;
	return to;
}
function copyBoatContext(
	from: typeof _sharedBoatContext,
	to: typeof _sharedBestBoatContext,
): void {
	to.kind = from.kind;
	to.boatChunk = from.boatChunk;
	to.localX = from.localX;
	to.localY = from.localY;
	to.localZ = from.localZ;
	to.localHitNx = from.localHitNx;
	to.localHitNy = from.localHitNy;
	to.localHitNz = from.localHitNz;
}
function getForwardRay(player: Player, length: number): RayLike {
	if (!_sharedRay) {
		_sharedRay = {
			origin: vec3Zero(),
			direction: vec3(0, 0, 1),
			length,
		};
	}
	const cam = player.playerCamera.playerCamera;
	const px = cam.position.x;
	const py = cam.position.y;
	const pz = cam.position.z;
	let dx = cam.target.x - px;
	let dy = cam.target.y - py;
	let dz = cam.target.z - pz;
	const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
	dx /= len;
	dy /= len;
	dz /= len;
	setVec3(_sharedRay.origin, px, py, pz);
	setVec3(_sharedRay.direction, dx, dy, dz);
	_sharedRay.length = length;
	return _sharedRay;
}

function isTargetableBlock(blockId: number): boolean {
	if (isCollidableBlock(blockId)) return true;

	switch (blockId) {
		case BlockType.GrassCross:
		case BlockType.SavannahGrassCross:
		case BlockType.Grass006Cross:
		case BlockType.Torch:
			return true;
		default:
			return false;
	}
}

function isFullBlockShape(blockId: number, blockState: number): boolean {
	// Slice variants are never treated as full blocks in the original logic.
	if (((blockState >> 3) & 7) !== 0) return false;

	const cached = _fullBlockBaseCache[blockId] || FULL_BLOCK_UNKNOWN;
	if (cached !== FULL_BLOCK_UNKNOWN) return cached === FULL_BLOCK_YES;

	let isFull = false;

	const shapeIndex = getShapeByBlockId()[blockId] ?? 0;
	if (shapeIndex === CUBE_SHAPE_INDEX) {
		isFull = true;
	} else {
		const shape = getShapeForBlockId(blockId);
		if (shape.usesSliceState && shape.boxes.length === 1) {
			const box = shape.boxes[0];
			isFull =
				box.faceMask === FACE_ALL &&
				box.min[0] === 0 &&
				box.min[1] === 0 &&
				box.min[2] === 0 &&
				box.max[0] === 1 &&
				box.max[1] === 1 &&
				box.max[2] === 1;
		}
	}

	_fullBlockBaseCache[blockId] = isFull ? FULL_BLOCK_YES : FULL_BLOCK_NO;
	return isFull;
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

	// X axis
	{
		const o = ox,
			d = dx,
			mn = minX,
			mx = maxX;
		if (Math.abs(d) < eps) {
			if (o < mn || o > mx) return null;
		} else {
			const tToMin = (mn - o) / d;
			const tToMax = (mx - o) / d;
			let near = tToMin,
				far = tToMax;
			let nearNx = -1,
				nearNy = 0,
				nearNz = 0;
			if (tToMin > tToMax) {
				near = tToMax;
				far = tToMin;
				nearNx = 1;
				nearNy = 0;
				nearNz = 0;
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
	}

	// Y axis
	{
		const o = oy,
			d = dy,
			mn = minY,
			mx = maxY;
		if (Math.abs(d) < eps) {
			if (o < mn || o > mx) return null;
		} else {
			const tToMin = (mn - o) / d;
			const tToMax = (mx - o) / d;
			let near = tToMin,
				far = tToMax;
			let nearNx = 0,
				nearNy = -1,
				nearNz = 0;
			if (tToMin > tToMax) {
				near = tToMax;
				far = tToMin;
				nearNx = 0;
				nearNy = 1;
				nearNz = 0;
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
	}

	// Z axis
	{
		const o = oz,
			d = dz,
			mn = minZ,
			mx = maxZ;
		if (Math.abs(d) < eps) {
			if (o < mn || o > mx) return null;
		} else {
			const tToMin = (mn - o) / d;
			const tToMax = (mx - o) / d;
			let near = tToMin,
				far = tToMax;
			let nearNx = 0,
				nearNy = 0,
				nearNz = -1;
			if (tToMin > tToMax) {
				near = tToMax;
				far = tToMin;
				nearNx = 0;
				nearNy = 0;
				nearNz = 1;
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

	let boxes: ShapeBounds[];
	if (isFenceBlockId(blockId)) {
		// Module-level lookup (no captures) — a fresh closure used to be
		// allocated per fence voxel the DDA visited.
		const mask = computeFenceNeighborMask(vx, vy, vz, fenceNeighborIdLookup);
		boxes = getFenceDynamicShape(mask).boxes;
	} else {
		boxes = getTransformedShapeBoxes(blockId, blockState);
	}

	for (const box of boxes) {
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

	const terrainHit = raycastFirstTerrainBlock(ray, shouldHit);
	if (terrainHit) {
		copyBlockRaycastHit(terrainHit, _sharedTerrainHit);
	}

	const boatHit = raycastFirstBoatBlock(ray, shouldHit);
	if (boatHit) {
		copyBlockRaycastHit(boatHit, _sharedBoatHit);
	}

	if (!terrainHit) return boatHit ? _sharedBoatHit : null;
	if (!boatHit) return _sharedTerrainHit;

	return _sharedBoatHit.t < _sharedTerrainHit.t
		? _sharedBoatHit
		: _sharedTerrainHit;
}

const enum DdaVisitResult {
	Hit,
	Skip,
	Stop,
}

function traceRayDda(
	ox: number,
	oy: number,
	oz: number,
	dx: number,
	dy: number,
	dz: number,
	startX: number,
	startY: number,
	startZ: number,
	tStart: number,
	maxDist: number,
	checkStart: boolean,
	visit: (
		x: number,
		y: number,
		z: number,
		t: number,
		nx: number,
		ny: number,
		nz: number,
		tExit: number,
	) => DdaVisitResult,
): void {
	const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
	const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
	const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

	const invDx = stepX === 0 ? Infinity : 1 / Math.abs(dx);
	const invDy = stepY === 0 ? Infinity : 1 / Math.abs(dy);
	const invDz = stepZ === 0 ? Infinity : 1 / Math.abs(dz);

	const boundX = stepX > 0 ? startX + 1 : startX;
	const boundY = stepY > 0 ? startY + 1 : startY;
	const boundZ = stepZ > 0 ? startZ + 1 : startZ;

	let tMaxX = stepX === 0 ? Infinity : (boundX - ox) / dx;
	let tMaxY = stepY === 0 ? Infinity : (boundY - oy) / dy;
	let tMaxZ = stepZ === 0 ? Infinity : (boundZ - oz) / dz;

	let x = startX,
		y = startY,
		z = startZ;
	let t = tStart,
		nx = 0,
		ny = 0,
		nz = 0;

	if (checkStart) {
		const tExit = Math.min(tMaxX, tMaxY, tMaxZ, maxDist);
		const r = visit(x, y, z, t, nx, ny, nz, tExit);
		if (r === DdaVisitResult.Hit || r === DdaVisitResult.Stop) return;
	}

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

		if (t > maxDist) return;

		const tExit = Math.min(tMaxX, tMaxY, tMaxZ, maxDist);
		const r = visit(x, y, z, t, nx, ny, nz, tExit);
		if (r === DdaVisitResult.Hit || r === DdaVisitResult.Stop) return;
	}
}

function raycastFirstTerrainBlock(
	ray: RayLike,
	shouldHit: (x: number, y: number, z: number, blockId: number) => boolean,
): BlockRaycastHit | null {
	const ox = ray.origin.x;
	const oy = ray.origin.y;
	const oz = ray.origin.z;
	const dx = ray.direction.x;
	const dy = ray.direction.y;
	const dz = ray.direction.z;
	const maxDist = ray.length;

	if (!(maxDist > 0)) return null;

	const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
	const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
	const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

	const invDx = stepX === 0 ? Infinity : 1 / Math.abs(dx);
	const invDy = stepY === 0 ? Infinity : 1 / Math.abs(dy);
	const invDz = stepZ === 0 ? Infinity : 1 / Math.abs(dz);

	let x = Math.floor(ox);
	let y = Math.floor(oy);
	let z = Math.floor(oz);

	const boundX = stepX > 0 ? x + 1 : x;
	const boundY = stepY > 0 ? y + 1 : y;
	const boundZ = stepZ > 0 ? z + 1 : z;

	let tMaxX = stepX === 0 ? Infinity : (boundX - ox) / dx;
	let tMaxY = stepY === 0 ? Infinity : (boundY - oy) / dy;
	let tMaxZ = stepZ === 0 ? Infinity : (boundZ - oz) / dz;

	let t = 0;
	let nx = 0;
	let ny = 0;
	let nz = 0;

	while (true) {
		// Preserve the original tie-breaking behavior from traceRayDda:
		// X only wins with strict X < Y and X < Z.
		// Y only wins with strict Y < Z in the else branch.
		// Z wins ties.
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

		const blockId = getTerrainBlockByWorldCoords(x, y, z);
		if (!shouldHit(x, y, z, blockId)) continue;

		const blockState = getBlockStateByWorldCoords(x, y, z);

		if (isFullBlockShape(blockId, blockState)) {
			_sharedHit.x = x;
			_sharedHit.y = y;
			_sharedHit.z = z;
			_sharedHit.nx = nx;
			_sharedHit.ny = ny;
			_sharedHit.nz = nz;
			_sharedHit.t = t;
			_sharedHit.blockId = blockId;
			_sharedHit.blockState = blockState;
			_sharedHit.dynamicContext = null;
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

		if (!shapeHit) continue;

		_sharedHit.x = x;
		_sharedHit.y = y;
		_sharedHit.z = z;
		_sharedHit.nx = shapeHit.nx;
		_sharedHit.ny = shapeHit.ny;
		_sharedHit.nz = shapeHit.nz;
		_sharedHit.t = shapeHit.t;
		_sharedHit.blockId = blockId;
		_sharedHit.blockState = blockState;
		_sharedHit.dynamicContext = null;
		return _sharedHit;
	}
}

function raycastFirstBoatBlock(
	ray: RayLike,
	shouldHit: (x: number, y: number, z: number, blockId: number) => boolean,
): BlockRaycastHit | null {
	let bestT = Infinity;
	let hasHit = false;

	for (const boatChunk of BoatChunk.getActiveChunks()) {
		if (!isBoatChunkInReach(ray, boatChunk)) continue;
		if (!raycastSingleBoatChunk(ray, boatChunk, shouldHit)) continue;
		if (_sharedHit.t >= bestT) continue;

		bestT = _sharedHit.t;
		hasHit = true;

		copyBoatContext(_sharedBoatContext, _sharedBestBoatContext);
		_sharedHit.dynamicContext = _sharedBestBoatContext;
		copyBlockRaycastHit(_sharedHit, _sharedBestBoatHit);
	}

	return hasHit ? _sharedBestBoatHit : null;
}

// Half-diagonal of the 32³ local chunk box (sqrt(3) * 16) — used to bound
// the chunk in world space without per-corner transforms.
const BOAT_CHUNK_HALF_DIAG = Math.sqrt(3) * (Chunk.SIZE / 2);

/**
 * Cheap world-space bounding-sphere reject that runs before the per-chunk
 * matrix inverse + local DDA in raycastSingleBoatChunk: transforms the
 * chunk's local box center by the (already-computed, free to read) world
 * matrix and tests the squared distance against (ray length + scaled
 * half-diagonal)². Rejects far-away boats with ~30 flops instead of a
 * matrix inverse.
 */
function isBoatChunkInReach(ray: RayLike, boatChunk: BoatChunk): boolean {
	const wm = boatChunk.visualRoot.worldMatrix;
	const cx = boatChunk.center.x;
	const cy = boatChunk.center.y;
	const cz = boatChunk.center.z;

	const lcx = Chunk.SIZE / 2 - cx;
	const lcy = Chunk.SIZE / 2 - cy;
	const lcz = Chunk.SIZE / 2 - cz;

	const ax = wm[0] * lcx + wm[4] * lcy + wm[8] * lcz + wm[12];
	const ay = wm[1] * lcx + wm[5] * lcy + wm[9] * lcz + wm[13];
	const az = wm[2] * lcx + wm[6] * lcy + wm[10] * lcz + wm[14];

	const scaleX = Math.hypot(wm[0], wm[1], wm[2]);
	const scaleY = Math.hypot(wm[4], wm[5], wm[6]);
	const scaleZ = Math.hypot(wm[8], wm[9], wm[10]);
	const radius = Math.max(scaleX, scaleY, scaleZ) * BOAT_CHUNK_HALF_DIAG;

	const toCx = ax - ray.origin.x;
	const toCy = ay - ray.origin.y;
	const toCz = az - ray.origin.z;

	let closestT =
		toCx * ray.direction.x + toCy * ray.direction.y + toCz * ray.direction.z;

	if (closestT < 0) {
		closestT = 0;
	} else if (closestT > ray.length) {
		closestT = ray.length;
	}

	const px = ray.origin.x + ray.direction.x * closestT;
	const py = ray.origin.y + ray.direction.y * closestT;
	const pz = ray.origin.z + ray.direction.z * closestT;

	const dx = ax - px;
	const dy = ay - py;
	const dz = az - pz;

	return dx * dx + dy * dy + dz * dz <= radius * radius;
}

function raycastSingleBoatChunk(
	ray: RayLike,
	boatChunk: BoatChunk,
	shouldHit: (x: number, y: number, z: number, blockId: number) => boolean,
): boolean {
	const visualRoot = boatChunk.visualRoot;
	const center = boatChunk.center;

	const wm = visualRoot.worldMatrix;
	const m = _sharedWorldMatrix.m;
	for (let i = 0; i < 16; i++) {
		m[i] = wm[i];
	}

	Matrix.InvertToRef(_sharedWorldMatrix, _sharedInvMatrix);

	transformCoordinatesVec3ToRef(
		ray.origin,
		_sharedInvMatrix,
		_sharedLocalOrigin,
	);
	addVec3InPlace(_sharedLocalOrigin, center);

	/*
	 * Keep the inverse-transformed direction unnormalized.
	 * This preserves t in world-ray units, so ray.length remains valid.
	 * Normalizing here changes the t scale and can make boat hits compare
	 * incorrectly against terrain hits.
	 */
	transformNormalVec3ToRef(ray.direction, _sharedInvMatrix, _sharedLocalDir);

	if (lengthSqVec3(_sharedLocalDir) <= 1e-8) return false;

	const dx = _sharedLocalDir.x;
	const dy = _sharedLocalDir.y;
	const dz = _sharedLocalDir.z;

	const boundsHit = intersectRayAabb(
		_sharedLocalOrigin.x,
		_sharedLocalOrigin.y,
		_sharedLocalOrigin.z,
		dx,
		dy,
		dz,
		0,
		0,
		0,
		Chunk.SIZE,
		Chunk.SIZE,
		Chunk.SIZE,
		0,
		ray.length,
		0,
		0,
		0,
	);
	if (!boundsHit) return false;

	const tStart = Math.max(0, boundsHit.t);
	const startEpsilon = 1e-6;

	setVec3(
		_sharedVec3,
		_sharedLocalOrigin.x + dx * (tStart + startEpsilon),
		_sharedLocalOrigin.y + dy * (tStart + startEpsilon),
		_sharedLocalOrigin.z + dz * (tStart + startEpsilon),
	);

	const x = Math.floor(_sharedVec3.x);
	const y = Math.floor(_sharedVec3.y);
	const z = Math.floor(_sharedVec3.z);

	if (!boatChunk.isInsideLocalBounds(x, y, z)) return false;

	let hitResult = false;

	traceRayDda(
		_sharedLocalOrigin.x,
		_sharedLocalOrigin.y,
		_sharedLocalOrigin.z,
		dx,
		dy,
		dz,
		x,
		y,
		z,
		tStart,
		ray.length,
		true,
		(lx, ly, lz, t, _nx, _ny, _nz, tExit) => {
			if (!boatChunk.isInsideLocalBounds(lx, ly, lz)) {
				return DdaVisitResult.Stop;
			}

			const blockId = boatChunk.getBlockLocal(lx, ly, lz);
			if (!shouldHit(lx, ly, lz, blockId)) return DdaVisitResult.Skip;

			const blockState = boatChunk.getBlockStateLocal(lx, ly, lz);

			let hitT = t;
			let hitNx = _nx;
			let hitNy = _ny;
			let hitNz = _nz;
			let hasHit = isFullBlockShape(blockId, blockState);

			if (!hasHit) {
				const shapeHit = raycastShapeInVoxel(
					_sharedLocalOrigin.x,
					_sharedLocalOrigin.y,
					_sharedLocalOrigin.z,
					dx,
					dy,
					dz,
					lx,
					ly,
					lz,
					blockId,
					blockState,
					t,
					tExit,
					_nx,
					_ny,
					_nz,
				);

				if (shapeHit) {
					hitT = shapeHit.t;
					hitNx = shapeHit.nx;
					hitNy = shapeHit.ny;
					hitNz = shapeHit.nz;
					hasHit = true;
				}
			}

			if (!hasHit) return DdaVisitResult.Skip;

			setVec3(_sharedWorldNormal, hitNx, hitNy, hitNz);
			transformNormalVec3ToRef(
				_sharedWorldNormal,
				_sharedWorldMatrix,
				_sharedVec3b,
			);

			const ax = Math.abs(_sharedVec3b.x);
			const ay = Math.abs(_sharedVec3b.y);
			const az = Math.abs(_sharedVec3b.z);

			let worldNx = 0;
			let worldNy = 0;
			let worldNz = 0;

			if (ax >= ay && ax >= az) {
				worldNx = _sharedVec3b.x >= 0 ? 1 : -1;
			} else if (ay >= ax && ay >= az) {
				worldNy = _sharedVec3b.y >= 0 ? 1 : -1;
			} else {
				worldNz = _sharedVec3b.z >= 0 ? 1 : -1;
			}

			boatChunk.localToWorldCenterToRef(lx, ly, lz, _sharedWorldCenter);

			_sharedHit.t = hitT;
			_sharedHit.x = Math.floor(_sharedWorldCenter.x);
			_sharedHit.y = Math.floor(_sharedWorldCenter.y);
			_sharedHit.z = Math.floor(_sharedWorldCenter.z);
			_sharedHit.nx = worldNx;
			_sharedHit.ny = worldNy;
			_sharedHit.nz = worldNz;
			_sharedHit.blockId = blockId;
			_sharedHit.blockState = blockState;
			_sharedHit.dynamicContext = _sharedBoatContext;

			_sharedBoatContext.boatChunk = boatChunk;
			_sharedBoatContext.localX = lx;
			_sharedBoatContext.localY = ly;
			_sharedBoatContext.localZ = lz;
			_sharedBoatContext.localHitNx = hitNx;
			_sharedBoatContext.localHitNy = hitNy;
			_sharedBoatContext.localHitNz = hitNz;

			hitResult = true;
			return DdaVisitResult.Hit;
		},
	);

	return hitResult;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function pickTarget(player: Player): BlockRaycastHit | null {
	return raycastFirstBlock(player, (_x, _y, _z, id) => isTargetableBlock(id));
}

/**
 * Returns the dropped item the player is currently looking at (crosshair ray),
 * or null. Picks the closest item whose AABB is hit by the look ray within
 * `REACH_DISTANCE`. Used by `Player.use()` (the E key) so the targeted item —
 * not merely the nearest one — is picked up.
 */
export function pickDroppedItem(player: Player): DroppedItem | null {
	const ray = getForwardRay(player, REACH_DISTANCE);
	const ox = ray.origin.x,
		oy = ray.origin.y,
		oz = ray.origin.z;
	const dx = ray.direction.x,
		dy = ray.direction.y,
		dz = ray.direction.z;

	let best: DroppedItem | null = null;
	let bestT = Infinity;

	for (const item of DroppedItem.activeItems) {
		const c = item.position;
		const h = item.halfExtent;
		const hit = intersectRayAabb(
			ox,
			oy,
			oz,
			dx,
			dy,
			dz,
			c.x - h,
			c.y - h,
			c.z - h,
			c.x + h,
			c.y + h,
			c.z + h,
			0,
			ray.length,
			0,
			0,
			0,
		);
		if (hit && hit.t < bestT) {
			bestT = hit.t;
			best = item;
		}
	}

	return best;
}

export function pickWaterTarget(player: Player): BlockRaycastHit | null {
	return raycastFirstBlock(player, (_x, _y, _z, id) => id === BlockType.Water);
}

export function pickBlock(player: Player): number | null {
	const hit = pickTarget(player);
	return hit ? hit.blockId : null;
}

/** Returns placement grid position (face-adjacent block), or null. */
export function getPlacementPosition(player: Player): Vec3 | null {
	const hit = raycastFirstBlock(player, (_x, _y, _z, id) =>
		isTargetableBlock(id),
	);
	if (!hit) return null;
	return setVec3(
		_sharedVec3,
		Math.floor(hit.x + hit.nx),
		Math.floor(hit.y + hit.ny),
		Math.floor(hit.z + hit.nz),
	);
}

export type PlacementHit = {
	pos: Vec3;
	nx: number;
	ny: number;
	nz: number;
	hitFracX: number;
	hitFracY: number;
	hitFracZ: number;
	dynamicContext?: unknown;
};

const _sharedPlacementHit: PlacementHit = {
	pos: vec3Zero(),
	nx: 0,
	ny: 0,
	nz: 0,
	hitFracX: 0,
	hitFracY: 0,
	hitFracZ: 0,
	dynamicContext: null,
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

	setVec3(
		_sharedPlacementHit.pos,
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
	_sharedPlacementHit.dynamicContext = hit.dynamicContext;
	return _sharedPlacementHit;
}
