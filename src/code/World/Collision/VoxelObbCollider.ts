// VoxelObbCollider.ts
import {
	Color4,
	type Mesh,
	MeshBuilder,
	Quaternion,
	type Scene,
	StandardMaterial,
	Vector3,
} from "@babylonjs/core";

export enum Axis {
	X,
	Y,
	Z,
}

type IsSolidBlockAt = (x: number, y: number, z: number) => boolean;

type VoxelObbDebugOptions = {
	scene: Scene;
	name?: string;
	position?: Vector3;
	renderingGroupId?: number;
};

/**
 * A yaw-only OBB collider meant for boats.
 * The OBB rotates around Y but keeps axis-aligned Y extents (flat hull assumption).
 *
 * Fully compatible with VoxelAabbCollider's moveAxis() interface.
 */
export class VoxelObbCollider {
	#halfExtents: Vector3; // Local-space extents
	#epsilon: number;
	#isSolidBlockAt: IsSolidBlockAt;

	#yaw = 0; // Boat yaw (radians)
	#rotX = new Vector3(); // Rotated X axis vector
	#rotZ = new Vector3(); // Rotated Z axis vector

	#tmpCandidate = new Vector3();
	#debugMesh: Mesh | null = null;
	#debugOptions: VoxelObbDebugOptions | null = null;

	static #debugEnabled = false;
	static readonly #debugColliders = new Set<VoxelObbCollider>();

	constructor(
		halfExtents: Vector3,
		isSolidBlockAt: IsSolidBlockAt,
		epsilon = 0.001,
		debugOptions?: VoxelObbDebugOptions,
	) {
		this.#halfExtents = halfExtents.clone();
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

	#updateRotAxes() {
		const c = Math.cos(this.#yaw);
		const s = Math.sin(this.#yaw);

		// RIGHT vector (local +X)
		this.#rotX.set(c, 0, -s);

		// FORWARD vector (local +Z)
		this.#rotZ.set(s, 0, c);
	}

	/** Create debug OBB wireframe */
	#createDebugMesh(options: VoxelObbDebugOptions): void {
		if (this.#debugMesh && !this.#debugMesh.isDisposed()) {
			return;
		}
		const name = options.name ?? "voxelObbDebug";
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
		this.#debugMesh.edgesWidth = 3;
		this.#debugMesh.edgesColor = new Color4(1, 0.2, 0.2, 1);
		if (options.position) {
			this.#debugMesh.position.copyFrom(options.position);
		}
	}

	#ensureDebugMesh() {
		if (!this.#debugOptions) return;
		this.#createDebugMesh(this.#debugOptions);
	}

	/** Test if OBB intersects any solid voxel */
	public overlaps(position: Vector3): boolean {
		// OBB world axes
		const hx = this.#halfExtents.x;
		const hy = this.#halfExtents.y;
		const hz = this.#halfExtents.z;

		const px = position.x;
		const py = position.y;
		const pz = position.z;

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

			const candidate = this.#tmpCandidate.copyFrom(position);

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

			position.copyFrom(candidate);
			remaining -= step;
		}
	}

	public syncDebugMesh(position: Vector3): void {
		if (VoxelObbCollider.#debugEnabled) {
			this.#ensureDebugMesh();
		}
		if (!this.#debugMesh || this.#debugMesh.isDisposed()) return;

		this.#debugMesh.position.copyFrom(position);

		this.#debugMesh.rotationQuaternion = Quaternion.FromEulerAngles(
			0,
			this.#yaw,
			0,
		);
	}

	public dispose(): void {
		VoxelObbCollider.#debugColliders.delete(this);
		if (this.#debugMesh && !this.#debugMesh.isDisposed()) {
			this.#debugMesh.dispose();
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
			else if (collider.#debugMesh && !collider.#debugMesh.isDisposed()) {
				collider.#debugMesh.dispose();
				collider.#debugMesh = null;
			}
		});
	}
}
