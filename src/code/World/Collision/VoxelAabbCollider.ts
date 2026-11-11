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
import { onGpuWorkDone } from "@/code/World/Light/liteGpuBuffer.js";
import type { ShapeDefinition } from "../Shape/BlockShapes";
import { BlockType, isPassThroughBlock } from "../Texture/BlockType";

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
	renderOrder?: number;
};

// Per-instance scratch BlockShapeInfo — avoids per-voxel allocations in
// the isSolidBlockAt callback. Safe because overlaps() consumes the
// result immediately (no retained references across frames).
// Module-level scratch for VoxelBlockResolver implementations — resolvers
// write their { blockId, blockState } pair here instead of allocating a fresh
// literal per collidable voxel. Safe because createVoxelColliderBlockSampler
// destructures the resolver result immediately.
//
// Carries the full ResolvedBlock shape so it can be handed straight to
// resolveBlockAtWorldCoordsInto as the `out` argument. That lets a collision
// sampler do one allocation-free voxel resolve instead of resolving into a
// throwaway object and copying the two fields across. Readers that only care
// about blockId/blockState are unaffected by the extra fields.
export const _voxelResolveScratch: {
	blockId: number;
	blockState: number;
	loaded: boolean;
	unloaded: boolean;
} = {
	blockId: 0,
	blockState: 0,
	loaded: false,
	unloaded: false,
};

/**
 * Shared "treat unloaded chunks as solid" sentinel for any voxel collider that
 * samples a streaming world (player, dropped item, mob, …).
 *
 * Samplers that want a held-up-by-streaming-terrain behavior should return
 * this from their `resolveBlock` callback when the underlying chunk is
 * missing, not loaded, or has no voxel data. The sampler will then translate
 * `BlockType.Cobble` through the standard `getShapeForBlockId` path so the
 * collider rests on a full cube until the real terrain loads in.
 *
 * Keep this ID-aligned with the player vehicle motor's historical fallback so
 * all non-player physics share the same held-up seam behavior. The pair is
 * passed by value so resolvers can return it directly (no per-call allocation
 * and no shared-state hazard — the sampler only reads the fields once).
 */
export const UNLOADED_SOLID_RESOLVE: { blockId: number; blockState: number } = {
	blockId: BlockType.Cobble,
	blockState: 0,
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

	const neighborIdLookup = (wx: number, wy: number, wz: number): number => {
		const r = resolveBlock(wx, wy, wz);
		return r ? r.blockId : 0;
	};

	const blockShapeInfoScratch: BlockShapeInfo = {
		shape: null as unknown as ShapeDefinition,
		rotation: 0,
		slice: 0,
		flipY: false,
	};

	return (x, y, z): BlockShapeInfo | null => {
		const resolved = resolveBlock(x, y, z);
		if (resolved === null) return null;
		const { blockId, blockState: state } = resolved;

		if (isPassThroughBlock(blockId)) return null;

		if (isFenceBlockId(blockId)) {
			const mask = computeFenceNeighborMask(x, y, z, neighborIdLookup);
			blockShapeInfoScratch.shape = getFenceDynamicShape(mask);
			blockShapeInfoScratch.rotation = 0;
			blockShapeInfoScratch.slice = 0;
			blockShapeInfoScratch.flipY = false;
			return blockShapeInfoScratch;
		}

		const shape = getShapeForBlockId(blockId);
		blockShapeInfoScratch.shape = shape;
		blockShapeInfoScratch.rotation = shape.rotateY ? state & 3 : 0;
		blockShapeInfoScratch.slice = 0;
		blockShapeInfoScratch.flipY = shape.allowFlipY && (state & 4) !== 0;
		return blockShapeInfoScratch;
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
	const boxes = shape.boxes;
	const count = boxes.length;

	if (count === 0) {
		return false;
	}

	/*
	 * Move epsilon adjustment outside the shape-box loop. These six values
	 * remain constant for every box belonging to this voxel shape.
	 */
	const overlapMinX = aMinX + eps;
	const overlapMaxX = aMaxX - eps;
	const overlapMinY = aMinY + eps;
	const overlapMaxY = aMaxY - eps;
	const overlapMinZ = aMinZ + eps;
	const overlapMaxZ = aMaxZ - eps;

	const usesSliceState = shape.usesSliceState;
	const rotationY = shape.rotateY ? rotation & 3 : 0;

	/*
	 * Slice bounds are identical for all boxes of a sliced shape, so calculate
	 * them once rather than once per box.
	 */
	let slicedMinY = 0;
	let slicedMaxY = 0;

	if (usesSliceState) {
		slicedMinY = slice * 0.5;
		slicedMaxY = slicedMinY + 0.5;

		if (flipY) {
			const originalMinY = slicedMinY;
			slicedMinY = 1 - slicedMaxY;
			slicedMaxY = 1 - originalMinY;
		}
	}

	for (let i = 0; i < count; i++) {
		const box = boxes[i];

		const min = box.min;
		const max = box.max;

		let minY: number;
		let maxY: number;

		if (usesSliceState) {
			minY = slicedMinY;
			maxY = slicedMaxY;
		} else if (flipY) {
			minY = 1 - max[1];
			maxY = 1 - min[1];
		} else {
			minY = min[1];
			maxY = max[1];
		}

		const worldMinY = blockY + minY;
		const worldMaxY = blockY + maxY;

		/*
		 * Reject on Y first. For player and mob colliders this commonly removes
		 * stairs, fences and multi-box shapes before calculating rotated X/Z
		 * coordinates.
		 */
		if (overlapMaxY <= worldMinY || overlapMinY >= worldMaxY) {
			continue;
		}

		const minX = min[0];
		const minZ = min[2];
		const maxX = max[0];
		const maxZ = max[2];

		let worldMinX: number;
		let worldMaxX: number;
		let worldMinZ: number;
		let worldMaxZ: number;

		switch (rotationY) {
			case 1:
				worldMinX = blockX + 1 - maxZ;
				worldMaxX = blockX + 1 - minZ;
				worldMinZ = blockZ + minX;
				worldMaxZ = blockZ + maxX;
				break;

			case 2:
				worldMinX = blockX + 1 - maxX;
				worldMaxX = blockX + 1 - minX;
				worldMinZ = blockZ + 1 - maxZ;
				worldMaxZ = blockZ + 1 - minZ;
				break;

			case 3:
				worldMinX = blockX + minZ;
				worldMaxX = blockX + maxZ;
				worldMinZ = blockZ + 1 - maxX;
				worldMaxZ = blockZ + 1 - minX;
				break;

			default:
				worldMinX = blockX + minX;
				worldMaxX = blockX + maxX;
				worldMinZ = blockZ + minZ;
				worldMaxZ = blockZ + maxZ;
				break;
		}

		if (
			overlapMaxX > worldMinX &&
			overlapMinX < worldMaxX &&
			overlapMaxZ > worldMinZ &&
			overlapMinZ < worldMaxZ
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

	private readonly tmpPos = { x: 0, y: 0, z: 0 } as Vec3;
	private readonly tmpVoxelHit = { x: 0, y: 0, z: 0 };

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
		if (this.#debugMesh) return;

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
		if (this.#debugOptions) {
			this.#createDebugMesh(this.#debugOptions);
		}
	}

	/**
	 * Shared hot voxel scanner used by overlapsBox() and firstSolidVoxel().
	 * Returns true on the first actual shape overlap.
	 *
	 * If hitOut is provided, it is filled with the hit voxel coordinates.
	 */
	#scanSolidVoxel(
		position: Vec3,
		halfExtents: Vec3,
		hitOut?: { x: number; y: number; z: number },
	): boolean {
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

		const isSolidBlockAt = this.#isSolidBlockAt;

		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) {
				for (let z = z0; z <= z1; z++) {
					const info = isSolidBlockAt(x, y, z);

					if (
						info &&
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
						if (hitOut) {
							hitOut.x = x;
							hitOut.y = y;
							hitOut.z = z;
						}

						return true;
					}
				}
			}
		}

		return false;
	}

	public overlaps(position: Vec3): boolean {
		return this.#scanSolidVoxel(position, this.#halfExtents);
	}

	public overlapsXYZ(x: number, y: number, z: number): boolean {
		const p = this.tmpPos;
		p.x = x;
		p.y = y;
		p.z = z;

		return this.#scanSolidVoxel(p, this.#halfExtents);
	}

	/**
	 * Like `overlaps`, but with an explicit half-extent box.
	 */
	public overlapsBox(position: Vec3, halfExtents: Vec3): boolean {
		return this.#scanSolidVoxel(position, halfExtents);
	}

	/**
	 * Check if the AABB at the given position would overlap with a specific block.
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
		const halfExtents = this.#halfExtents;

		return testShapeBoxOverlap(
			position.x - halfExtents.x,
			position.x + halfExtents.x,
			position.y - halfExtents.y,
			position.y + halfExtents.y,
			position.z - halfExtents.z,
			position.z + halfExtents.z,
			eps,
			blockShape as ShapeDefinition,
			rotation,
			slice,
			flipY,
			blockX,
			blockY,
			blockZ,
		);
	}

	/**
	 * Returns the integer coordinates of the first solid voxel the box overlaps.
	 */
	public firstSolidVoxel(
		position: Vec3,
		halfExtents: Vec3,
	): { x: number; y: number; z: number } | null {
		const hit = this.tmpVoxelHit;

		if (!this.#scanSolidVoxel(position, halfExtents, hit)) {
			return null;
		}

		// Return a fresh object so callers can safely retain it.
		return {
			x: hit.x,
			y: hit.y,
			z: hit.z,
		};
	}

	/**
	 * Zero-allocation variant of firstSolidVoxel for callers that consume the
	 * result immediately. The returned object is shared scratch and is
	 * overwritten by the next call on ANY collider instance.
	 */
	public firstSolidVoxelScratch(
		position: Vec3,
		halfExtents: Vec3,
	): { x: number; y: number; z: number } | null {
		const hit = this.tmpVoxelHit;
		if (!this.#scanSolidVoxel(position, halfExtents, hit)) {
			return null;
		}
		return hit;
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
		let remaining = delta * dir;

		let x = position.x;
		let y = position.y;
		let z = position.z;

		while (remaining > 1e-8) {
			const step = remaining > stepSize ? stepSize : remaining;
			const move = step * dir;

			let nx = x;
			let ny = y;
			let nz = z;

			if (axis === Axis.X) {
				nx += move;
			} else if (axis === Axis.Y) {
				ny += move;
			} else {
				nz += move;
			}

			if (this.overlapsXYZ(nx, ny, nz)) {
				if (axis === Axis.X) {
					velocity.x = 0;
				} else if (axis === Axis.Y) {
					velocity.y = 0;
				} else {
					velocity.z = 0;
				}

				break;
			}

			x = nx;
			y = ny;
			z = nz;
			remaining -= step;
		}

		position.x = x;
		position.y = y;
		position.z = z;
	}

	public syncDebugMesh(position: Vec3): void {
		if (VoxelAabbCollider.#debugEnabled) {
			this.#ensureDebugMesh();
		}

		if (this.#debugMesh) {
			this.#debugMesh.position.copyFrom(position);
		}
	}

	public dispose(): void {
		VoxelAabbCollider.#debugColliders.delete(this);
		this.#disposeDebugMesh();
		this.#debugOptions = null;
	}

	#disposeDebugMesh(): void {
		if (!this.#debugMesh) return;

		const mesh = this.#debugMesh;
		this.#debugMesh = null;

		const engine = (this.#debugOptions?.scene?.surface as any)?.engine;

		if (engine) {
			void onGpuWorkDone(engine).then(() => disposeMeshGpu(mesh));
		} else {
			disposeMeshGpu(mesh);
		}
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
				collider.#disposeDebugMesh();
			}
		});
	}

	public set HalfExtents(halfExtents: Vec3) {
		this.#halfExtents = halfExtents;
	}
}
