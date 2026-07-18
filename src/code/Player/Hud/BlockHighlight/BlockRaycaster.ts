import {
	lengthSqVec3,
	Matrix,
	setVec3,
	transformCoordinatesVec3ToRef,
	transformNormalVec3ToRef,
	vec3Zero,
} from "@babylonjs/core";
import {
	addVec3InPlace,
	scaleVec3InPlace,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { REACH_DISTANCE } from "@/code/Shared/Constants";
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
import type { Player } from "../../Player";

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
	const len = Math.hypot(dx, dy, dz) || 1;
	dx /= len;
	dy /= len;
	dz /= len;
	setVec3(_sharedRay.origin, px, py, pz);
	setVec3(_sharedRay.direction, dx, dy, dz);
	_sharedRay.length = length;
	return _sharedRay;
}

function isTargetableBlock(blockId: number): boolean {
	return (
		isCollidableBlock(blockId) ||
		blockId === BlockType.GrassCross ||
		blockId === BlockType.SavannahGrassCross
	);
}

function isFullBlockShape(blockId: number, blockState: number): boolean {
	const slice = (blockState >> 3) & 7;
	if (slice !== 0) return false;
	const shapeIndex = getShapeByBlockId()[blockId] ?? 0;
	if (shapeIndex === getCubeShapeIndex()) return true;
	const shape = getShapeForBlockId(blockId);
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
		const mask = computeFenceNeighborMask(vx, vy, vz, (wx, wy, wz) => {
			return getBlockAndStateByWorldCoords(wx, wy, wz).blockId;
		});
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
	const boatHit = raycastFirstBoatBlock(ray, shouldHit);
	if (!terrainHit) return boatHit;
	if (!boatHit) return terrainHit;
	return boatHit.t < terrainHit.t ? boatHit : terrainHit;
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
	const ox = ray.origin.x,
		oy = ray.origin.y,
		oz = ray.origin.z;
	const dx = ray.direction.x,
		dy = ray.direction.y,
		dz = ray.direction.z;
	const maxDist = ray.length;
	if (!(maxDist > 0)) return null;

	let hit = false;

	traceRayDda(
		ox,
		oy,
		oz,
		dx,
		dy,
		dz,
		Math.floor(ox),
		Math.floor(oy),
		Math.floor(oz),
		0,
		maxDist,
		false,
		(x, y, z, t, nx, ny, nz, tExit) => {
			const blockId = getTerrainBlockByWorldCoords(x, y, z);
			if (!shouldHit(x, y, z, blockId)) return DdaVisitResult.Skip;

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
				hit = true;
				return DdaVisitResult.Hit;
			}

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
				_sharedHit.blockId = blockId;
				_sharedHit.blockState = blockState;
				_sharedHit.dynamicContext = null;
				hit = true;
				return DdaVisitResult.Hit;
			}

			return DdaVisitResult.Skip;
		},
	);

	return hit ? _sharedHit : null;
}

function raycastFirstBoatBlock(
	ray: RayLike,
	shouldHit: (x: number, y: number, z: number, blockId: number) => boolean,
): BlockRaycastHit | null {
	let bestT = Infinity;
	let hasHit = false;

	for (const boatChunk of BoatChunk.getActiveChunks()) {
		if (!raycastSingleBoatChunk(ray, boatChunk, shouldHit)) continue;
		if (!hasHit || _sharedHit.t < bestT) {
			bestT = _sharedHit.t;
			hasHit = true;
		}
	}

	if (!hasHit) return null;

	_sharedHit.dynamicContext = _sharedBoatContext;
	return _sharedHit;
}

function raycastSingleBoatChunk(
	ray: RayLike,
	boatChunk: BoatChunk,
	shouldHit: (x: number, y: number, z: number, blockId: number) => boolean,
): boolean {
	const visualRoot = boatChunk.visualRoot;
	const center = boatChunk.center;

	const wm = visualRoot.worldMatrix;
	for (let i = 0; i < 16; i++) {
		_sharedWorldMatrix.m[i] = wm[i];
	}
	Matrix.InvertToRef(_sharedWorldMatrix, _sharedInvMatrix);

	transformCoordinatesVec3ToRef(
		ray.origin,
		_sharedInvMatrix,
		_sharedLocalOrigin,
	);
	addVec3InPlace(_sharedLocalOrigin, center);
	transformNormalVec3ToRef(ray.direction, _sharedInvMatrix, _sharedLocalDir);

	const localDirLen = lengthSqVec3(_sharedLocalDir);
	if (localDirLen <= 1e-8) return false;
	scaleVec3InPlace(_sharedLocalDir, 1 / localDirLen);

	const boundsHit = intersectRayAabb(
		_sharedLocalOrigin.x,
		_sharedLocalOrigin.y,
		_sharedLocalOrigin.z,
		_sharedLocalDir.x,
		_sharedLocalDir.y,
		_sharedLocalDir.z,
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
	setVec3(
		_sharedVec3,
		_sharedLocalOrigin.x + _sharedLocalDir.x * (tStart + 1e-6),
		_sharedLocalOrigin.y + _sharedLocalDir.y * (tStart + 1e-6),
		_sharedLocalOrigin.z + _sharedLocalDir.z * (tStart + 1e-6),
	);

	const x = Math.floor(_sharedVec3.x);
	const y = Math.floor(_sharedVec3.y);
	const z = Math.floor(_sharedVec3.z);

	if (!boatChunk.isInsideLocalBounds(x, y, z)) return false;

	const dx = _sharedLocalDir.x;
	const dy = _sharedLocalDir.y;
	const dz = _sharedLocalDir.z;

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
			if (!boatChunk.isInsideLocalBounds(lx, ly, lz))
				return DdaVisitResult.Stop;

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
			let worldNx = 0,
				worldNy = 0,
				worldNz = 0;
			if (ax >= ay && ax >= az) worldNx = _sharedVec3b.x >= 0 ? 1 : -1;
			else if (ay >= ax && ay >= az) worldNy = _sharedVec3b.y >= 0 ? 1 : -1;
			else worldNz = _sharedVec3b.z >= 0 ? 1 : -1;

			boatChunk.localToWorldCenterToRef(lx, ly, lz, _sharedWorldCenter);
			const wx = Math.floor(_sharedWorldCenter.x);
			const wy = Math.floor(_sharedWorldCenter.y);
			const wz = Math.floor(_sharedWorldCenter.z);

			_sharedHit.t = hitT;
			_sharedHit.x = wx;
			_sharedHit.y = wy;
			_sharedHit.z = wz;
			_sharedHit.nx = worldNx;
			_sharedHit.ny = worldNy;
			_sharedHit.nz = worldNz;
			_sharedHit.blockId = blockId;
			_sharedHit.blockState = blockState;
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
