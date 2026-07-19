// VoxelObbCollider.ts

import {
	addToScene,
	createBox,
	createStandardMaterial,
	disposeMeshGpu,
	type Mesh,
	type SceneContext,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { copyVec3, Quaternion, setVec3 } from "@/code/Lib/Math";
import { Axis } from "./VoxelAabbCollider";

type IsSolidBlockAt = (x: number, y: number, z: number) => boolean;

type VoxelObbDebugOptions = {
	scene: SceneContext;
	name?: string;
	position?: Vec3;
	renderingGroupId?: number;
};

/**
 * A yaw-only OBB collider meant for boats.
 * The OBB rotates around Y but keeps axis-aligned Y extents (flat hull assumption).
 *
 * Fully compatible with VoxelAabbCollider's moveAxis() interface.
 */
export class VoxelObbCollider {
	#halfExtents = vec3(0, 0, 0); // Local-space extents
	#centerOffset = vec3(0, 0, 0);
	// Local-space offset of OBB center from position
	#epsilon: number;
	#isSolidBlockAt: IsSolidBlockAt;

	#yaw = 0; // Boat yaw (radians)
	#rotX = vec3(0, 0, 0);
	// Rotated X axis vector
	#rotZ = vec3(0, 0, 0);
	// Rotated Z axis vector

	#tmpCandidate = vec3(0, 0, 0); // Temporary candidate vector
	#debugRot = Quaternion.Identity(); // Debug rotation vector
	#debugMesh: Mesh | null = null;
	#debugOptions: VoxelObbDebugOptions | null = null;

	static #debugEnabled = false;
	static readonly #debugColliders = new Set<VoxelObbCollider>();

	constructor(
		halfExtents: Vec3,
		isSolidBlockAt: IsSolidBlockAt,
		epsilon = 0.001,
		debugOptions?: VoxelObbDebugOptions,
	) {
		copyVec3(this.#halfExtents, halfExtents);
		this.#epsilon = epsilon;
		this.#isSolidBlockAt = isSolidBlockAt;

		if (debugOptions) {
			this.#debugOptions = debugOptions;
			VoxelObbCollider.#debugColliders.add(this);
			if (VoxelObbCollider.#debugEnabled) {
				this.#createDebugMesh(debugOptions);
			}
		}

		this.#updateRotAxes();
	}

	/** Set yaw in radians */
	public setYaw(yaw: number) {
		this.#yaw = yaw;
		this.#updateRotAxes();
	}

	public setHalfExtents(halfExtents: Vec3): void {
		copyVec3(this.#halfExtents, halfExtents);

		// Rebuild the debug wireframe so its dimensions match updated extents.
		if (this.#debugMesh) {
			disposeMeshGpu(this.#debugMesh);
			this.#debugMesh = null;
			if (VoxelObbCollider.#debugEnabled) {
				this.#ensureDebugMesh();
			}
		}
	}

	public setCenterOffset(offset: Vec3): void {
		copyVec3(this.#centerOffset, offset);
	}

	#updateRotAxes() {
		const c = Math.cos(this.#yaw);
		const s = Math.sin(this.#yaw);

		// RIGHT vector (local +X)
		setVec3(this.#rotX, c, 0, -s);

		// FORWARD vector (local +Z)
		setVec3(this.#rotZ, s, 0, c);
	}

	/** Create debug OBB wireframe */
	#createDebugMesh(options: VoxelObbDebugOptions): void {
		if (this.#debugMesh) {
			return;
		}
		const name = options.name ?? "voxelObbDebug";
		const size =
			((this.#halfExtents.x + this.#halfExtents.y + this.#halfExtents.z) * 2) /
			3;
		this.#debugMesh = createBox(options.scene.surface.engine, size);
		this.#debugMesh.name = name;
		this.#debugMesh.pickable = false;

		const material = createStandardMaterial();
		material.name = `${name}Mat`;
		material.alpha = 0;
		material.diffuseColor = [1, 0.2, 0.2];
		this.#debugMesh.material = material;
		addToScene(options.scene, this.#debugMesh);
		if (options.position) {
			this.#debugMesh.position.copyFrom(options.position);
		}
	}

	#ensureDebugMesh() {
		if (!this.#debugOptions) return;
		this.#createDebugMesh(this.#debugOptions);
	}

	/** Test if OBB intersects any solid voxel */
	public overlaps(position: Vec3): boolean {
		// OBB world axes
		const hx = this.#halfExtents.x;
		const hy = this.#halfExtents.y;
		const hz = this.#halfExtents.z;

		// Apply local-space center offset (rotate by yaw into world space)
		const px =
			position.x +
			this.#centerOffset.x * this.#rotX.x +
			this.#centerOffset.z * this.#rotZ.x;
		const py = position.y + this.#centerOffset.y;
		const pz =
			position.z +
			this.#centerOffset.x * this.#rotX.z +
			this.#centerOffset.z * this.#rotZ.z;

		// Expand into AABB to identify candidate voxels (coarse test)
		const extX = Math.abs(this.#rotX.x) * hx + Math.abs(this.#rotZ.x) * hz;
		const extZ = Math.abs(this.#rotX.z) * hx + Math.abs(this.#rotZ.z) * hz;

		const minX = px - extX;
		const maxX = px + extX;
		const minY = py - hy;
		const maxY = py + hy;
		const minZ = pz - extZ;
		const maxZ = pz + extZ;

		const x0 = Math.floor(minX + this.#epsilon);
		const x1 = Math.floor(maxX - this.#epsilon);
		const y0 = Math.floor(minY + this.#epsilon);
		const y1 = Math.floor(maxY - this.#epsilon);
		const z0 = Math.floor(minZ + this.#epsilon);
		const z1 = Math.floor(maxZ - this.#epsilon);

		// Fine test: test OBB penetration with voxel cubes
		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) {
				for (let z = z0; z <= z1; z++) {
					if (!this.#isSolidBlockAt(x, y, z)) continue;

					if (this.#obbIntersectsVoxel(px, py, pz, hx, hy, hz, x, y, z)) {
						return true;
					}
				}
			}
		}

		return false;
	}

	/** Simple separating-axis test for yaw-only OBB vs voxel cube */
	#obbIntersectsVoxel(
		px: number,
		py: number,
		pz: number,
		hx: number,
		hy: number,
		hz: number,
		vx: number,
		vy: number,
		vz: number,
	): boolean {
		const cx = vx + 0.5;
		const cy = vy + 0.5;
		const cz = vz + 0.5;

		// Relative position from OBB center to voxel center
		const rx = cx - px;
		const ry = cy - py;
		const rz = cz - pz;

		// Project voxel onto OBB axes
		const projX = Math.abs(rx * this.#rotX.x + rz * this.#rotX.z) <= hx + 0.5;
		const projZ = Math.abs(rx * this.#rotZ.x + rz * this.#rotZ.z) <= hz + 0.5;
		const projY = Math.abs(ry) <= hy + 0.5;

		return projX && projZ && projY;
	}

	/** Same API as AABB collider — used by boat physics */
	public moveAxis(
		position: Vec3,
		velocity: Vec3,
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

			const candidate = copyVec3(this.#tmpCandidate, position);

			if (axis === Axis.X) candidate.x += step;
			else if (axis === Axis.Y) candidate.y += step;
			else candidate.z += step;

			if (this.overlaps(candidate)) {
				// Stop movement along that axis
				if (axis === Axis.X) velocity.x = 0;
				else if (axis === Axis.Y) velocity.y = 0;
				else velocity.z = 0;
				return;
			}

			copyVec3(position, candidate);

			remaining -= step;
		}
	}

	public syncDebugMesh(position: any): void {
		if (VoxelObbCollider.#debugEnabled) {
			this.#ensureDebugMesh();
		}
		if (!this.#debugMesh) return;

		// Position at the offset center (rotate local offset into world space)
		this.#debugMesh.position.set(
			position.x +
				this.#centerOffset.x * this.#rotX.x +
				this.#centerOffset.z * this.#rotZ.x,
			position.y + this.#centerOffset.y,
			position.z +
				this.#centerOffset.x * this.#rotX.z +
				this.#centerOffset.z * this.#rotZ.z,
		);

		this.#debugRot.copyFrom(Quaternion.RotationYawPitchRoll(this.#yaw, 0, 0));
		this.#debugMesh.rotationQuaternion.copyFrom(this.#debugRot);
	}

	public dispose(): void {
		VoxelObbCollider.#debugColliders.delete(this);
		if (this.#debugMesh) {
			disposeMeshGpu(this.#debugMesh);
			this.#debugMesh = null;
		}
		this.#debugMesh = null;
		this.#debugOptions = null;
	}

	public static toggleDebugEnabled(): void {
		VoxelObbCollider.setDebugEnabled(!VoxelObbCollider.#debugEnabled);
	}

	public static setDebugEnabled(enabled: boolean): void {
		VoxelObbCollider.#debugEnabled = enabled;
		VoxelObbCollider.#debugColliders.forEach((collider) => {
			if (enabled) collider.#ensureDebugMesh();
			else if (collider.#debugMesh) {
				disposeMeshGpu(collider.#debugMesh);
				collider.#debugMesh = null;
			}
		});
	}
}
