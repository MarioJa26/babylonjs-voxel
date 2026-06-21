import {
	Color4,
	type Mesh,
	MeshBuilder,
	Quaternion,
	type Scene,
	StandardMaterial,
	Vector3,
} from "@babylonjs/core";
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
	scene: Scene;
	name?: string;
	position?: Vector3;
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
	#halfExtents: Vector3;
	#epsilon: number;
	#isSolidBlockAt: IsSolidBlockAt;
	#tmpCandidate = Vector3.Zero();
	#debugMesh: Mesh | null = null;
	#debugOptions: VoxelAabbDebugOptions | null = null;
	static #debugEnabled = false;
	static readonly #debugColliders = new Set<VoxelAabbCollider>();

	constructor(
		halfExtents: Vector3,
		isSolidBlockAt: IsSolidBlockAt,
		epsilon = 0.001,
		debugOptions?: VoxelAabbDebugOptions,
	) {
		this.#halfExtents = halfExtents.clone();
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
		if (this.#debugMesh && !this.#debugMesh.isDisposed()) {
			return;
		}
		const name = options.name ?? "voxelAabbDebug";
		this.#debugMesh = MeshBuilder.CreateBox(
			name,
			{
				width: this.#halfExtents.x * 2,
				height: this.#halfExtents.y * 2,
				depth: this.#halfExtents.z * 2,
			},
			options.scene,
		);
		this.#debugMesh.isPickable = false;
		this.#debugMesh.rotationQuaternion = Quaternion.Identity();
		if (typeof options.renderingGroupId === "number") {
			this.#debugMesh.renderingGroupId = options.renderingGroupId;
		}

		const material = new StandardMaterial(`${name}Mat`, options.scene);
		material.alpha = 0;
		material.disableLighting = true;
		this.#debugMesh.material = material;
		this.#debugMesh.isVisible = true;
		this.#debugMesh.enableEdgesRendering();
		this.#debugMesh.edgesWidth = 2;
		this.#debugMesh.edgesColor = new Color4(0.2, 1, 0.2, 1);
		if (options.position) {
			this.#debugMesh.position.copyFrom(options.position);
		}
	}

	#ensureDebugMesh(): void {
		if (!this.#debugOptions) return;
		this.#createDebugMesh(this.#debugOptions);
	}

	public overlaps(position: Vector3): boolean {
		const eps = this.#epsilon;

		const aMinX = position.x - this.#halfExtents.x;
		const aMaxX = position.x + this.#halfExtents.x;
		const aMinY = position.y - this.#halfExtents.y;
		const aMaxY = position.y + this.#halfExtents.y;
		const aMinZ = position.z - this.#halfExtents.z;
		const aMaxZ = position.z + this.#halfExtents.z;

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
		position: Vector3,
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

	public moveAxis(
		position: Vector3,
		velocity: Vector3,
		axis: Axis,
		delta: number,
		stepSize: number,
	): void {
		if (delta === 0) return;
		let remaining = delta;

		while (Math.abs(remaining) > 0) {
			const step =
				Math.abs(remaining) > stepSize
					? stepSize * Math.sign(remaining)
					: remaining;

			const candidate = this.#tmpCandidate;
			candidate.copyFrom(position);
			if (axis === Axis.X) candidate.x += step;
			else if (axis === Axis.Y) candidate.y += step;
			else candidate.z += step;

			if (this.overlaps(candidate)) {
				if (axis === Axis.X) velocity.x = 0;
				else if (axis === Axis.Y) velocity.y = 0;
				else velocity.z = 0;
				break;
			}

			position.copyFrom(candidate);
			remaining -= step;
		}
	}

	public syncDebugMesh(position: Vector3): void {
		if (VoxelAabbCollider.#debugEnabled) {
			this.#ensureDebugMesh();
		}
		if (!this.#debugMesh || this.#debugMesh.isDisposed()) return;
		this.#debugMesh.position.copyFrom(position);
	}

	public dispose(): void {
		VoxelAabbCollider.#debugColliders.delete(this);
		if (this.#debugMesh && !this.#debugMesh.isDisposed()) {
			this.#debugMesh.dispose();
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
			} else if (collider.#debugMesh && !collider.#debugMesh.isDisposed()) {
				collider.#debugMesh.dispose();
				collider.#debugMesh = null;
			}
		});
	}

	public set HalfExtents(halfExtents: Vector3) {
		this.#halfExtents.copyFrom(halfExtents);
	}
}
