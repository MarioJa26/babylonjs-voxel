import {
	addToScene,
	createBox,
	createStandardMaterial,
	disposeMeshGpu,
	type Mesh,
	type SceneContext,
	type Vec3,
} from "@babylonjs/lite";
import { copyVec3, Quaternion } from "@/code/Lib/Math";
import type { ShapeDefinition } from "../Shape/BlockShapes";

export const enum Axis {
	X,
	Y,
	Z,
}

export type BlockShapeInfo = {
	shape: ShapeDefinition;
	rotation: number;
	/** For usesSliceState shapes (slab): 0 = bottom half, 1 = top half. */
	slice: number;
	/** For allowFlipY shapes (stairs): true = upside-down. */
	flipY: boolean;
};

type IsSolidBlockAt = (
	x: number,
	y: number,
	z: number,
) => BlockShapeInfo | null;

type VoxelAabbDebugOptions = {
	scene: SceneContext;
	name?: string;
	position?: Vec3;
	renderingGroupId?: number;
};

/**
 * Rotate a ShapeBox around the Y axis of the block cell (centre = 0.5, 0.5).
 * rotation: 0 = 0°, 1 = 90° CW, 2 = 180°, 3 = 270° CW (looking down -Y).
 */
function rotateShapeBoxY(
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
	rotation: number,
	out: [number, number, number, number, number, number],
): void {
	const steps = ((rotation % 4) + 4) % 4;

	let ax = minX,
		az = minZ,
		bx = maxX,
		bz = maxZ;

	for (let i = 0; i < steps; i++) {
		// 90° CW around centre (0.5, 0.5):  (x,z) → (1-z, x)
		const newAx = 1 - bz;
		const newAz = ax;
		const newBx = 1 - az;
		const newBz = bx;
		ax = Math.min(newAx, newBx);
		bx = Math.max(newAx, newBx);
		az = Math.min(newAz, newBz);
		bz = Math.max(newAz, newBz);
	}

	out[0] = ax;
	out[1] = minY;
	out[2] = az;
	out[3] = bx;
	out[4] = maxY;
	out[5] = bz;
}

// Module-level scratch to avoid allocations inside overlaps().
const _rotatedBox: [number, number, number, number, number, number] = [
	0, 0, 0, 0, 0, 0,
];

// Module-level scratch BlockShapeInfo — avoids per-voxel allocations in
// the isSolidBlockAt callback.  Safe because overlaps() consumes the
// result immediately (no retained references across frames).
export const _blockShapeInfoScratch: BlockShapeInfo = {
	shape: null as unknown as ShapeDefinition,
	rotation: 0,
	slice: 0,
	flipY: false,
};

/**
 * A block resolver returns the raw block id + state for a world coordinate, or
 * null when the cell should not be treated as collidable.  This indirection
 * lets callers feed the sampler from whichever source they have (world lookup,
 * a boat chunk's local storage, etc.) without duplicating the shape-decoding
 * logic below.
 */
export type VoxelBlockResolver = (
	x: number,
	y: number,
	z: number,
) => { blockId: number; blockState: number } | null;

export type VoxelBlockSamplerDeps = {
	getFenceDynamicShape: (mask: number) => ShapeDefinition;
	getShapeForBlockId: (blockId: number) => ShapeDefinition;
	isFenceBlockId: (blockId: number) => boolean;
	computeFenceNeighborMask: (
		x: number,
		y: number,
		z: number,
		getNeighborId: (wx: number, wy: number, wz: number) => number,
	) => number;
};

/**
 * Builds the `isSolidBlockAt` callback shared by every voxel collider
 * (player, boat, mob, dropped item).  The only thing that varies between
 * callers is how a (x,y,z) cell is resolved to a block id + state, so that
 * responsibility is delegated to `resolveBlock`.
 */
export function createVoxelColliderBlockSampler(
	resolveBlock: VoxelBlockResolver,
	deps: VoxelBlockSamplerDeps,
): (x: number, y: number, z: number) => BlockShapeInfo | null {
	const {
		getFenceDynamicShape,
		getShapeForBlockId,
		isFenceBlockId,
		computeFenceNeighborMask,
	} = deps;

	return (x, y, z): BlockShapeInfo | null => {
		const resolved = resolveBlock(x, y, z);
		if (resolved === null) return null;
		const { blockId, blockState: state } = resolved;

		if (isFenceBlockId(blockId)) {
			const mask = computeFenceNeighborMask(x, y, z, (wx, wy, wz) => {
				const r = resolveBlock(wx, wy, wz);
				return r ? r.blockId : 0;
			});
			_blockShapeInfoScratch.shape = getFenceDynamicShape(mask);
			_blockShapeInfoScratch.rotation = 0;
			_blockShapeInfoScratch.slice = 0;
			_blockShapeInfoScratch.flipY = false;
			return _blockShapeInfoScratch;
		}

		const shape = getShapeForBlockId(blockId);
		_blockShapeInfoScratch.shape = shape;
		_blockShapeInfoScratch.rotation = shape.rotateY ? state & 3 : 0;
		_blockShapeInfoScratch.slice = 0;
		_blockShapeInfoScratch.flipY = shape.allowFlipY && (state & 4) !== 0;
		return _blockShapeInfoScratch;
	};
}

// Module-level scratch for voxelStepUp — avoids per-call allocation.
const _stepUpForward: Vec3 = { x: 0, y: 0, z: 0 } as Vec3;
const _stepUpRise: Vec3 = { x: 0, y: 0, z: 0 } as Vec3;
const _stepUpGround: Vec3 = { x: 0, y: 0, z: 0 } as Vec3;

/**
 * Attempts to step the collider up over a low ledge while advancing `delta`
 * along `axis` (X or Z).  Returns true (and mutates `pos`) if a steppable path
 * was found, otherwise leaves `pos` untouched and returns false.
 *
 * Shared by PlayerVehicleMotor and NeutralMob, which previously carried
 * byte-near-identical copies of this routine.
 *
 * @param maxStepUp maximum height the collider may climb (in 0.25 steps).
 * @param onStep callback invoked with the new (post-step) position so the
 *   caller can zero its vertical velocity.
 */
export function voxelStepUp(
	collider: VoxelAabbCollider,
	pos: Vec3,
	axis: Axis.X | Axis.Z,
	delta: number,
	maxStepUp: number,
	onStep: (steppedPos: Vec3) => void,
): boolean {
	const fwd = _stepUpForward;
	copyVec3(fwd, pos);
	if (axis === Axis.X) fwd.x += delta;
	else fwd.z += delta;
	if (!collider.overlaps(fwd)) {
		copyVec3(pos, fwd);
		return true;
	}

	for (let rise = 0.25; rise <= maxStepUp; rise += 0.25) {
		const up = _stepUpRise;
		copyVec3(up, pos);
		up.y += rise;
		if (collider.overlaps(up)) continue;

		const fwd2 = _stepUpForward;
		copyVec3(fwd2, up);
		if (axis === Axis.X) fwd2.x += delta;
		else fwd2.z += delta;
		if (collider.overlaps(fwd2)) continue;

		const ground = _stepUpGround;
		copyVec3(ground, fwd2);
		ground.y -= 0.08;
		if (!collider.overlaps(ground)) continue;

		copyVec3(pos, fwd2);
		onStep(pos);
		return true;
	}
	return false;
}

function testShapeBoxOverlap(
	aMinX: number,
	aMaxX: number,
	aMinY: number,
	aMaxY: number,
	aMinZ: number,
	aMaxZ: number,
	eps: number,
	shape: ShapeDefinition,
	rotation: number,
	slice: number,
	flipY: boolean,
	blockX: number,
	blockY: number,
	blockZ: number,
): boolean {
	const needsRotation = shape.rotateY && rotation !== 0;

	for (const box of shape.boxes) {
		let minY = box.min[1];
		let maxY = box.max[1];

		if (shape.usesSliceState) {
			const offset = slice * 0.5;
			minY = offset;
			maxY = offset + 0.5;
		}

		if (flipY) {
			const flippedMin = 1 - maxY;
			const flippedMax = 1 - minY;
			minY = flippedMin;
			maxY = flippedMax;
		}

		let bMinX: number, bMinY: number, bMinZ: number;
		let bMaxX: number, bMaxY: number, bMaxZ: number;

		if (needsRotation) {
			rotateShapeBoxY(
				box.min[0],
				minY,
				box.min[2],
				box.max[0],
				maxY,
				box.max[2],
				rotation,
				_rotatedBox,
			);
			bMinX = blockX + _rotatedBox[0];
			bMinY = blockY + _rotatedBox[1];
			bMinZ = blockZ + _rotatedBox[2];
			bMaxX = blockX + _rotatedBox[3];
			bMaxY = blockY + _rotatedBox[4];
			bMaxZ = blockZ + _rotatedBox[5];
		} else {
			bMinX = blockX + box.min[0];
			bMinY = blockY + minY;
			bMinZ = blockZ + box.min[2];
			bMaxX = blockX + box.max[0];
			bMaxY = blockY + maxY;
			bMaxZ = blockZ + box.max[2];
		}

		if (
			aMaxX - eps > bMinX &&
			aMinX + eps < bMaxX &&
			aMaxY - eps > bMinY &&
			aMinY + eps < bMaxY &&
			aMaxZ - eps > bMinZ &&
			aMinZ + eps < bMaxZ
		) {
			return true;
		}
	}
	return false;
}

export class VoxelAabbCollider {
	#halfExtents: Vec3;
	#epsilon: number;
	#isSolidBlockAt: IsSolidBlockAt;
	#debugMesh: Mesh | null = null;
	#debugOptions: VoxelAabbDebugOptions | null = null;
	static #debugEnabled = false;
	static readonly #debugColliders = new Set<VoxelAabbCollider>();

	constructor(
		halfExtents: Vec3,
		isSolidBlockAt: IsSolidBlockAt,
		epsilon = 0.001,
		debugOptions?: VoxelAabbDebugOptions,
	) {
		this.#halfExtents = halfExtents;
		this.#isSolidBlockAt = isSolidBlockAt;
		this.#epsilon = epsilon;
		if (debugOptions) {
			this.#debugOptions = debugOptions;
			VoxelAabbCollider.#debugColliders.add(this);
			if (VoxelAabbCollider.#debugEnabled) {
				this.#createDebugMesh(debugOptions);
			}
		}
	}

	#createDebugMesh(options: VoxelAabbDebugOptions): void {
		if (this.#debugMesh) {
			return;
		}
		const name = options.name ?? "voxelAabbDebug";
		const size =
			((this.#halfExtents.x + this.#halfExtents.y + this.#halfExtents.z) * 2) /
			3;
		this.#debugMesh = createBox(options.scene.surface.engine, size);
		this.#debugMesh.name = name;
		this.#debugMesh.pickable = false;
		this.#debugMesh.rotationQuaternion.copyFrom(Quaternion.Identity());
		const material = createStandardMaterial();
		material.name = `${name}Mat`;
		material.alpha = 0;
		material.diffuseColor = [0.2, 1, 0.2];
		this.#debugMesh.material = material;
		addToScene(options.scene, this.#debugMesh);
		if (options.position) {
			this.#debugMesh.position.copyFrom(options.position);
		}
	}

	#ensureDebugMesh(): void {
		if (!this.#debugOptions) return;
		this.#createDebugMesh(this.#debugOptions);
	}

	public overlaps(position: Vec3): boolean {
		return this.overlapsBox(position, this.#halfExtents);
	}
	private tmpPos = { x: 0, y: 0, z: 0 } as Vec3;
	public overlapsXYZ(x: number, y: number, z: number): boolean {
		const p = this.tmpPos;
		p.x = x;
		p.y = y;
		p.z = z;
		return this.overlapsBox(p, this.#halfExtents);
	}

	/**
	 * Like `overlaps`, but with an explicit (possibly smaller/larger) half-extent
	 * box. Lets callers probe sub-regions of the body — e.g. a thin foot slab to
	 * detect floor, or a side slab to detect wall contact — without allocating a
	 * second collider.
	 */
	public overlapsBox(position: Vec3, halfExtents: Vec3): boolean {
		const eps = this.#epsilon;

		const aMinX = position.x - halfExtents.x;
		const aMaxX = position.x + halfExtents.x;
		const aMinY = position.y - halfExtents.y;
		const aMaxY = position.y + halfExtents.y;
		const aMinZ = position.z - halfExtents.z;
		const aMaxZ = position.z + halfExtents.z;

		const x0 = Math.floor(aMinX + eps);
		const x1 = Math.floor(aMaxX - eps);
		const y0 = Math.floor(aMinY + eps);
		const y1 = Math.floor(aMaxY - eps);
		const z0 = Math.floor(aMinZ + eps);
		const z1 = Math.floor(aMaxZ - eps);

		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) {
				for (let z = z0; z <= z1; z++) {
					const info = this.#isSolidBlockAt(x, y, z);
					if (!info) continue;

					if (
						testShapeBoxOverlap(
							aMinX,
							aMaxX,
							aMinY,
							aMaxY,
							aMinZ,
							aMaxZ,
							eps,
							info.shape,
							info.rotation,
							info.slice,
							info.flipY,
							x,
							y,
							z,
						)
					) {
						return true;
					}
				}
			}
		}
		return false;
	}

	/**
	 * Check if the AABB at the given position would overlap with a specific block.
	 * This uses the same collision logic as overlaps(), but only checks one block.
	 */
	public wouldOverlapBlock(
		position: Vec3,
		blockX: number,
		blockY: number,
		blockZ: number,
		blockShape: {
			boxes: Array<{
				min: [number, number, number];
				max: [number, number, number];
			}>;
			rotateY: boolean;
			usesSliceState: boolean;
		},
		rotation: number,
		slice: number,
		flipY: boolean,
	): boolean {
		const eps = this.#epsilon;

		const aMinX = position.x - this.#halfExtents.x;
		const aMaxX = position.x + this.#halfExtents.x;
		const aMinY = position.y - this.#halfExtents.y;
		const aMaxY = position.y + this.#halfExtents.y;
		const aMinZ = position.z - this.#halfExtents.z;
		const aMaxZ = position.z + this.#halfExtents.z;

		const info: BlockShapeInfo = {
			shape: blockShape as ShapeDefinition,
			rotation,
			slice,
			flipY,
		};

		const { shape, rotation: rot, slice: sl, flipY: fy } = info;
		const needsRotation = shape.rotateY && rot !== 0;

		for (const box of shape.boxes) {
			const minX = box.min[0];
			let minY = box.min[1];
			const minZ = box.min[2];
			const maxX = box.max[0];
			let maxY = box.max[1];
			const maxZ = box.max[2];

			if (shape.usesSliceState) {
				const offset = sl * 0.5;
				minY = offset;
				maxY = offset + 0.5;
			}

			if (fy) {
				const flippedMin = 1 - maxY;
				const flippedMax = 1 - minY;
				minY = flippedMin;
				maxY = flippedMax;
			}

			let bMinX: number, bMinY: number, bMinZ: number;
			let bMaxX: number, bMaxY: number, bMaxZ: number;

			if (needsRotation) {
				rotateShapeBoxY(minX, minY, minZ, maxX, maxY, maxZ, rot, _rotatedBox);
				bMinX = blockX + _rotatedBox[0];
				bMinY = blockY + _rotatedBox[1];
				bMinZ = blockZ + _rotatedBox[2];
				bMaxX = blockX + _rotatedBox[3];
				bMaxY = blockY + _rotatedBox[4];
				bMaxZ = blockZ + _rotatedBox[5];
			} else {
				bMinX = blockX + minX;
				bMinY = blockY + minY;
				bMinZ = blockZ + minZ;
				bMaxX = blockX + maxX;
				bMaxY = blockY + maxY;
				bMaxZ = blockZ + maxZ;
			}

			if (
				aMaxX - eps > bMinX &&
				aMinX + eps < bMaxX &&
				aMaxY - eps > bMinY &&
				aMinY + eps < bMaxY &&
				aMaxZ - eps > bMinZ &&
				aMinZ + eps < bMaxZ
			) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Like `overlapsBox`, but returns the integer coordinates of the first solid
	 * voxel the box overlaps (or null). Lets callers reason about *which* block
	 * was hit — e.g. to test what's above/below the contacted block — without
	 * re-deriving the voxel from a probe center (which is fragile at column
	 * boundaries).
	 */
	public firstSolidVoxel(
		position: Vec3,
		halfExtents: Vec3,
	): { x: number; y: number; z: number } | null {
		const eps = this.#epsilon;

		const aMinX = position.x - halfExtents.x;
		const aMaxX = position.x + halfExtents.x;
		const aMinY = position.y - halfExtents.y;
		const aMaxY = position.y + halfExtents.y;
		const aMinZ = position.z - halfExtents.z;
		const aMaxZ = position.z + halfExtents.z;

		const x0 = Math.floor(aMinX + eps);
		const x1 = Math.floor(aMaxX - eps);
		const y0 = Math.floor(aMinY + eps);
		const y1 = Math.floor(aMaxY - eps);
		const z0 = Math.floor(aMinZ + eps);
		const z1 = Math.floor(aMaxZ - eps);

		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) {
				for (let z = z0; z <= z1; z++) {
					const info = this.#isSolidBlockAt(x, y, z);
					if (!info) continue;

					if (
						testShapeBoxOverlap(
							aMinX,
							aMaxX,
							aMinY,
							aMaxY,
							aMinZ,
							aMaxZ,
							eps,
							info.shape,
							info.rotation,
							info.slice,
							info.flipY,
							x,
							y,
							z,
						)
					) {
						return { x, y, z };
					}
				}
			}
		}
		return null;
	}

	public moveAxis(
		position: Vec3,
		velocity: Vec3,
		axis: Axis,
		delta: number,
		stepSize: number,
	): void {
		if (delta === 0) return;

		const dir = delta > 0 ? 1 : -1;
		let remaining = Math.abs(delta);

		// pre-read position
		let x = position.x;
		let y = position.y;
		let z = position.z;

		while (remaining > 1e-8) {
			const step = remaining > stepSize ? stepSize : remaining;
			const move = step * dir;

			let nx = x;
			let ny = y;
			let nz = z;

			if (axis === Axis.X) nx += move;
			else if (axis === Axis.Y) ny += move;
			else nz += move;

			if (this.overlapsXYZ(nx, ny, nz)) {
				if (axis === Axis.X) velocity.x = 0;
				else if (axis === Axis.Y) velocity.y = 0;
				else velocity.z = 0;
				break;
			}

			// commit move
			x = nx;
			y = ny;
			z = nz;

			remaining -= step;
		}

		// write back once (important!)
		position.x = x;
		position.y = y;
		position.z = z;
	}

	public syncDebugMesh(position: Vec3): void {
		if (VoxelAabbCollider.#debugEnabled) {
			this.#ensureDebugMesh();
		}
		if (!this.#debugMesh) return;
		this.#debugMesh.position.copyFrom(position);
	}

	public dispose(): void {
		VoxelAabbCollider.#debugColliders.delete(this);
		if (this.#debugMesh) {
			disposeMeshGpu(this.#debugMesh);
			this.#debugMesh = null;
		}
		this.#debugMesh = null;
		this.#debugOptions = null;
	}

	public static toggleDebugEnabled(): void {
		VoxelAabbCollider.setDebugEnabled(!VoxelAabbCollider.#debugEnabled);
	}

	public static setDebugEnabled(enabled: boolean): void {
		VoxelAabbCollider.#debugEnabled = enabled;
		VoxelAabbCollider.#debugColliders.forEach((collider) => {
			if (enabled) {
				collider.#ensureDebugMesh();
			} else if (collider.#debugMesh) {
				disposeMeshGpu(collider.#debugMesh);
				collider.#debugMesh = null;
			}
		});
	}

	public set HalfExtents(halfExtents: Vec3) {
		this.#halfExtents = halfExtents;
	}
}
