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
import { onGpuWorkDone } from "@/code/World/Light/liteGpuBuffer.js";
import { Axis } from "./VoxelAabbCollider";

type IsSolidBlockAt = (x: number, y: number, z: number) => boolean;

type VoxelObbDebugOptions = {
	scene: SceneContext;
	name?: string;
	position?: Vec3;
	renderOrder?: number;
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
	public setYaw(yaw: number): void {
		if (yaw === this.#yaw) return;

		this.#yaw = yaw;
		this.#updateRotAxes();

		if (this.#debugMesh) {
			Quaternion.FromEulerAnglesToRef(0, yaw, 0, this.#debugRot);
			this.#debugMesh.rotationQuaternion.copyFrom(this.#debugRot);
		}
	}

	public setHalfExtents(halfExtents: Vec3): void {
		copyVec3(this.#halfExtents, halfExtents);

		if (this.#debugMesh) {
			this.#debugMesh.scaling.set(
				halfExtents.x * 2,
				halfExtents.y * 2,
				halfExtents.z * 2,
			);
		}
	}

	public setCenterOffset(offset: Vec3): void {
		copyVec3(this.#centerOffset, offset);
	}

	#updateRotAxes(): void {
		const c = Math.cos(this.#yaw);
		const s = Math.sin(this.#yaw);

		// Matches Matrix.RotationY() and transformCoordinatesVec3ToRef().
		setVec3(this.#rotX, c, 0, -s);
		setVec3(this.#rotZ, s, 0, c);
	}

	/** Create debug OBB wireframe */
	#createDebugMesh(options: VoxelObbDebugOptions): void {
		if (this.#debugMesh) return;

		const name = options.name ?? "voxelObbDebug";

		// Create a unit cube, then scale it to the full OBB dimensions.
		this.#debugMesh = createBox(options.scene.surface.engine, 1);
		this.#debugMesh.name = name;
		this.#debugMesh.pickable = false;
		this.#debugMesh.renderOrder = options.renderOrder ?? 1;

		this.#debugMesh.scaling.set(
			this.#halfExtents.x * 2,
			this.#halfExtents.y * 2,
			this.#halfExtents.z * 2,
		);

		Quaternion.FromEulerAnglesToRef(0, this.#yaw, 0, this.#debugRot);
		this.#debugMesh.rotationQuaternion.copyFrom(this.#debugRot);

		const material = createStandardMaterial();
		material.name = `${name}Mat`;
		material.alpha = 0.25;
		material.diffuseColor = [1, 0.2, 0.2];

		this.#debugMesh.material = material;
		addToScene(options.scene, this.#debugMesh);

		if (options.position) {
			this.syncDebugMesh(options.position);
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
		const rx = vx + 0.5 - px;
		const ry = vy + 0.5 - py;
		const rz = vz + 0.5 - pz;

		// Y remains axis-aligned.
		if (Math.abs(ry) > hy + 0.5 - this.#epsilon) {
			return false;
		}

		const rxX = this.#rotX.x;
		const rxZ = this.#rotX.z;
		const rzX = this.#rotZ.x;
		const rzZ = this.#rotZ.z;

		/*
		 * Test the two OBB axes. The voxel projection radius is the projection
		 * of its 0.5 x 0.5 horizontal half-extents onto each rotated axis.
		 */
		const distanceOnObbX = Math.abs(rx * rxX + rz * rxZ);
		const voxelRadiusOnObbX = 0.5 * Math.abs(rxX) + 0.5 * Math.abs(rxZ);

		if (distanceOnObbX > hx + voxelRadiusOnObbX - this.#epsilon) {
			return false;
		}

		const distanceOnObbZ = Math.abs(rx * rzX + rz * rzZ);
		const voxelRadiusOnObbZ = 0.5 * Math.abs(rzX) + 0.5 * Math.abs(rzZ);

		if (distanceOnObbZ > hz + voxelRadiusOnObbZ - this.#epsilon) {
			return false;
		}

		/*
		 * Test the voxel's world X and Z axes. These were missing from the
		 * previous implementation, so it was not a complete SAT test.
		 */
		const obbRadiusOnWorldX = hx * Math.abs(rxX) + hz * Math.abs(rzX);

		if (Math.abs(rx) > obbRadiusOnWorldX + 0.5 - this.#epsilon) {
			return false;
		}

		const obbRadiusOnWorldZ = hx * Math.abs(rxZ) + hz * Math.abs(rzZ);

		if (Math.abs(rz) > obbRadiusOnWorldZ + 0.5 - this.#epsilon) {
			return false;
		}

		return true;
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

		// delta's sign never changes across steps, so hoist direction and loop
		// on `remaining !== 0` (steps are exactly stepSize or remaining, which
		// converges to exactly 0).
		const dir = delta > 0 ? 1 : -1;
		let remaining = delta;
		while (remaining !== 0) {
			const absRem = remaining > 0 ? remaining : -remaining;
			const step = absRem > stepSize ? stepSize * dir : remaining;

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

	public syncDebugMesh(position: Vec3): void {
		if (VoxelObbCollider.#debugEnabled) {
			this.#ensureDebugMesh();
		}

		if (!this.#debugMesh) return;

		this.#debugMesh.position.set(
			position.x +
				this.#centerOffset.x * this.#rotX.x +
				this.#centerOffset.z * this.#rotZ.x,
			position.y + this.#centerOffset.y,
			position.z +
				this.#centerOffset.x * this.#rotX.z +
				this.#centerOffset.z * this.#rotZ.z,
		);

		Quaternion.FromEulerAnglesToRef(0, this.#yaw, 0, this.#debugRot);
		this.#debugMesh.rotationQuaternion.copyFrom(this.#debugRot);
	}

	public dispose(): void {
		VoxelObbCollider.#debugColliders.delete(this);
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
		VoxelObbCollider.setDebugEnabled(!VoxelObbCollider.#debugEnabled);
	}

	public static setDebugEnabled(enabled: boolean): void {
		VoxelObbCollider.#debugEnabled = enabled;
		VoxelObbCollider.#debugColliders.forEach((collider) => {
			if (enabled) collider.#ensureDebugMesh();
			else if (collider.#debugMesh) {
				collider.#disposeDebugMesh();
			}
		});
	}
}
