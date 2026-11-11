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
	#halfExtents = vec3(0, 0, 0);
	#centerOffset = vec3(0, 0, 0);

	#epsilon: number;
	#isSolidBlockAt: IsSolidBlockAt;

	#yaw = 0;

	// Rotated local axes in world space.
	#rotX = vec3(1, 0, 0);
	#rotZ = vec3(0, 0, 1);

	// Cached absolute axis components.
	#absRotXX = 1;
	#absRotXZ = 0;
	#absRotZX = 0;
	#absRotZZ = 1;

	// Cached SAT radii.
	#voxelRadiusOnObbX = 0.5;
	#voxelRadiusOnObbZ = 0.5;
	#obbRadiusOnWorldX = 0;
	#obbRadiusOnWorldZ = 0;

	#tmpCandidate = vec3(0, 0, 0);

	#debugRot = Quaternion.Identity();
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

		this.#updateRotAxes();

		if (debugOptions) {
			this.#debugOptions = debugOptions;
			VoxelObbCollider.#debugColliders.add(this);

			if (VoxelObbCollider.#debugEnabled) {
				this.#createDebugMesh(debugOptions);
			}
		}
	}

	/** Set yaw in radians. */
	public setYaw(yaw: number): void {
		if (yaw === this.#yaw) {
			return;
		}

		this.#yaw = yaw;
		this.#updateRotAxes();

		if (this.#debugMesh) {
			Quaternion.FromEulerAnglesToRef(0, yaw, 0, this.#debugRot);

			this.#debugMesh.rotationQuaternion.copyFrom(this.#debugRot);
		}
	}

	public setHalfExtents(halfExtents: Vec3): void {
		copyVec3(this.#halfExtents, halfExtents);
		this.#updateCachedRadii();

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
		const cosine = Math.cos(this.#yaw);
		const sine = Math.sin(this.#yaw);

		// Matches Matrix.RotationY().
		setVec3(this.#rotX, cosine, 0, -sine);
		setVec3(this.#rotZ, sine, 0, cosine);

		this.#absRotXX = Math.abs(cosine);
		this.#absRotXZ = Math.abs(sine);
		this.#absRotZX = this.#absRotXZ;
		this.#absRotZZ = this.#absRotXX;

		this.#updateCachedRadii();
	}

	#updateCachedRadii(): void {
		const hx = this.#halfExtents.x;
		const hz = this.#halfExtents.z;

		this.#voxelRadiusOnObbX = 0.5 * (this.#absRotXX + this.#absRotXZ);

		this.#voxelRadiusOnObbZ = 0.5 * (this.#absRotZX + this.#absRotZZ);

		this.#obbRadiusOnWorldX = hx * this.#absRotXX + hz * this.#absRotZX;

		this.#obbRadiusOnWorldZ = hx * this.#absRotXZ + hz * this.#absRotZZ;
	}

	#createDebugMesh(options: VoxelObbDebugOptions): void {
		if (this.#debugMesh) {
			return;
		}

		const name = options.name ?? "voxelObbDebug";
		const mesh = createBox(options.scene.surface.engine, 1);

		mesh.name = name;
		mesh.pickable = false;
		mesh.renderOrder = options.renderOrder ?? 1;

		mesh.scaling.set(
			this.#halfExtents.x * 2,
			this.#halfExtents.y * 2,
			this.#halfExtents.z * 2,
		);

		Quaternion.FromEulerAnglesToRef(0, this.#yaw, 0, this.#debugRot);

		mesh.rotationQuaternion.copyFrom(this.#debugRot);

		const material = createStandardMaterial();
		material.name = `${name}Mat`;
		material.alpha = 0.25;
		material.diffuseColor = [1, 0.2, 0.2];

		mesh.material = material;

		this.#debugMesh = mesh;
		addToScene(options.scene, mesh);

		if (options.position) {
			this.syncDebugMesh(options.position);
		}
	}

	#ensureDebugMesh(): void {
		if (this.#debugOptions) {
			this.#createDebugMesh(this.#debugOptions);
		}
	}

	/** Test whether the OBB intersects any solid voxel. */
	public overlaps(position: Vec3): boolean {
		const halfExtents = this.#halfExtents;
		const centerOffset = this.#centerOffset;

		const hx = halfExtents.x;
		const hy = halfExtents.y;
		const hz = halfExtents.z;

		const rotXX = this.#rotX.x;
		const rotXZ = this.#rotX.z;
		const rotZX = this.#rotZ.x;
		const rotZZ = this.#rotZ.z;

		const px = position.x + centerOffset.x * rotXX + centerOffset.z * rotZX;

		const py = position.y + centerOffset.y;

		const pz = position.z + centerOffset.x * rotXZ + centerOffset.z * rotZZ;

		/*
		 * These are also the OBB projection radii onto the world X/Z axes,
		 * already cached for the SAT tests.
		 */
		const extX = this.#obbRadiusOnWorldX;
		const extZ = this.#obbRadiusOnWorldZ;
		const epsilon = this.#epsilon;

		const x0 = Math.floor(px - extX + epsilon);
		const x1 = Math.floor(px + extX - epsilon);
		const y0 = Math.floor(py - hy + epsilon);
		const y1 = Math.floor(py + hy - epsilon);
		const z0 = Math.floor(pz - extZ + epsilon);
		const z1 = Math.floor(pz + extZ - epsilon);

		const isSolidBlockAt = this.#isSolidBlockAt;

		const maxYDistance = hy + 0.5 - epsilon;

		const maxDistanceOnObbX = hx + this.#voxelRadiusOnObbX - epsilon;

		const maxDistanceOnObbZ = hz + this.#voxelRadiusOnObbZ - epsilon;

		const maxDistanceOnWorldX = extX + 0.5 - epsilon;

		const maxDistanceOnWorldZ = extZ + 0.5 - epsilon;

		for (let y = y0; y <= y1; y++) {
			const relativeY = y + 0.5 - py;

			/*
			 * Normally guaranteed by the coarse bounds, but retaining this
			 * check preserves the SAT behavior around epsilon boundaries.
			 */
			if (Math.abs(relativeY) > maxYDistance) {
				continue;
			}

			for (let x = x0; x <= x1; x++) {
				const relativeX = x + 0.5 - px;

				if (Math.abs(relativeX) > maxDistanceOnWorldX) {
					continue;
				}

				for (let z = z0; z <= z1; z++) {
					if (!isSolidBlockAt(x, y, z)) {
						continue;
					}

					const relativeZ = z + 0.5 - pz;

					if (Math.abs(relativeZ) > maxDistanceOnWorldZ) {
						continue;
					}

					const distanceOnObbX = Math.abs(
						relativeX * rotXX + relativeZ * rotXZ,
					);

					if (distanceOnObbX > maxDistanceOnObbX) {
						continue;
					}

					const distanceOnObbZ = Math.abs(
						relativeX * rotZX + relativeZ * rotZZ,
					);

					if (distanceOnObbZ > maxDistanceOnObbZ) {
						continue;
					}

					return true;
				}
			}
		}

		return false;
	}

	/** Same API as VoxelAabbCollider, used by boat physics. */
	public moveAxis(
		position: Vec3,
		velocity: Vec3,
		axis: Axis,
		delta: number,
		stepSize: number,
	): void {
		if (delta === 0) {
			return;
		}

		/*
		 * Prevent a non-terminating loop if a caller accidentally supplies
		 * zero or a negative step size.
		 */
		if (!(stepSize > 0)) {
			throw new RangeError(
				"VoxelObbCollider.moveAxis: stepSize must be greater than zero",
			);
		}

		const direction = delta > 0 ? 1 : -1;
		let remaining = Math.abs(delta);

		let x = position.x;
		let y = position.y;
		let z = position.z;

		const candidate = this.#tmpCandidate;

		while (remaining > 1e-8) {
			const distance = remaining > stepSize ? stepSize : remaining;

			const movement = distance * direction;

			candidate.x = x;
			candidate.y = y;
			candidate.z = z;

			if (axis === Axis.X) {
				candidate.x += movement;
			} else if (axis === Axis.Y) {
				candidate.y += movement;
			} else {
				candidate.z += movement;
			}

			if (this.overlaps(candidate)) {
				if (axis === Axis.X) {
					velocity.x = 0;
				} else if (axis === Axis.Y) {
					velocity.y = 0;
				} else {
					velocity.z = 0;
				}

				break;
			}

			x = candidate.x;
			y = candidate.y;
			z = candidate.z;
			remaining -= distance;
		}

		position.x = x;
		position.y = y;
		position.z = z;
	}

	public syncDebugMesh(position: Vec3): void {
		if (VoxelObbCollider.#debugEnabled) {
			this.#ensureDebugMesh();
		}

		const mesh = this.#debugMesh;

		if (!mesh) {
			return;
		}

		const centerOffset = this.#centerOffset;

		mesh.position.set(
			position.x +
				centerOffset.x * this.#rotX.x +
				centerOffset.z * this.#rotZ.x,
			position.y + centerOffset.y,
			position.z +
				centerOffset.x * this.#rotX.z +
				centerOffset.z * this.#rotZ.z,
		);

		/*
		 * setYaw() already updates the quaternion. Recalculating it here on
		 * every debug synchronization is unnecessary.
		 */
	}

	public dispose(): void {
		VoxelObbCollider.#debugColliders.delete(this);
		this.#disposeDebugMesh();
		this.#debugOptions = null;
	}

	#disposeDebugMesh(): void {
		const mesh = this.#debugMesh;

		if (!mesh) {
			return;
		}

		this.#debugMesh = null;

		const engine = (
			this.#debugOptions?.scene?.surface as
				| {
						engine?: Parameters<typeof onGpuWorkDone>[0];
				  }
				| undefined
		)?.engine;

		if (engine) {
			void onGpuWorkDone(engine).then(() => {
				disposeMeshGpu(mesh);
			});
		} else {
			disposeMeshGpu(mesh);
		}
	}

	public static toggleDebugEnabled(): void {
		VoxelObbCollider.setDebugEnabled(!VoxelObbCollider.#debugEnabled);
	}

	public static setDebugEnabled(enabled: boolean): void {
		if (enabled === VoxelObbCollider.#debugEnabled) {
			return;
		}

		VoxelObbCollider.#debugEnabled = enabled;

		for (const collider of VoxelObbCollider.#debugColliders) {
			if (enabled) {
				collider.#ensureDebugMesh();
			} else {
				collider.#disposeDebugMesh();
			}
		}
	}
}
