import {
	addToScene,
	createBox,
	createStandardMaterial,
	crossVec3ToRef,
	type Mesh,
	onBeforeRender,
	type SceneContext,
	scaleVec3InPlace,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import {
	Matrix,
	Quaternion,
	setVec3,
	transformCoordinatesVec3ToRef,
} from "@/code/Lib/Math";
import {
	Axis,
	createVoxelColliderBlockSampler,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import type { IUsable } from "../Interface/IUsable";
import { PaddleBoatControls } from "../Player/Controls/PaddleBoatControls";
import type { Player } from "../Player/Player";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import { getShapeForBlockId } from "../World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "../World/Shape/FenceConnect";
import { BlockType, isCollidableBlock } from "../World/Texture/BlockType";
import { Mount } from "./Mount";

export class AdvancedBoat implements IUsable {
	#collisionHalfExtents = vec3(1.15, 0.6, 1.15);
	#boat!: Mesh;
	#mount: Mount;
	#buoyancyPoints: Vec3[] = [];
	#baseBuoyancyForce = 20;
	#mass = 10;
	#gravity = -9.81;
	#collisionStepSize = 0.25;
	#collisionEpsilon = 0.001;
	#buoyancyTorqueScale = 0.12;
	#lockRoll = true;
	#lockPitch = true;
	#linearVelocity = vec3(0, 0, 0);
	#angularVelocity = vec3(0, 0, 0);
	#voxelCollider!: VoxelAabbCollider;

	// Scratch vectors for per-frame physics (avoids allocation)
	readonly #_worldPt = vec3(0, 0, 0);
	readonly #_buoyVec = vec3(0, 0, 0);
	readonly #_accel = vec3(0, 0, 0);
	readonly #_lever = vec3(0, 0, 0);
	readonly #_torque = vec3(0, 0, 0);
	readonly #_deltaRot = new Quaternion();
	readonly #_nextRot = new Quaternion();
	readonly #_currentRot = new Quaternion();
	readonly #_rotQuat = new Quaternion();
	readonly #_rotMat = new Matrix();
	readonly #_euler = vec3(0, 0, 0);

	static #boatControls: PaddleBoatControls;

	#submergedPoints = 0;
	public currentYaw = 0;

	constructor(
		SceneContext: SceneContext,
		player: Player,
		waterLevel: number,
		position?: Vec3,
	) {
		this.createBoat(SceneContext, position, waterLevel);

		const md: Record<string, unknown> = {};
		md.use = (player: Player) => this.use(player);
		this.#boat.metadata = md;

		this.setupBuoyancyPoints();
		this.setupAdvancedPhysics(SceneContext);
		AdvancedBoat.#boatControls = new PaddleBoatControls(this, player);

		this.#mount = new Mount(this.#boat, AdvancedBoat.#boatControls);
	}

	private createBoat(
		scene: SceneContext,
		position: Vec3 | undefined,
		waterLevel: number,
	): void {
		// AABB collision hull used by the physics body.
		const size =
			((this.#collisionHalfExtents.x +
				this.#collisionHalfExtents.y +
				this.#collisionHalfExtents.z) *
				2) /
			3;
		const boatHull = createBox(scene.surface.engine, size);
		boatHull.name = "boatHull";

		boatHull.position.set(
			position?.x || 0,
			position?.y || waterLevel + 10,
			position?.z || 0,
		);

		const hullMaterial = createStandardMaterial();
		hullMaterial.name = "hullMat";
		hullMaterial.diffuseColor = [0.8, 0.6, 0.2];
		boatHull.material = hullMaterial;
		boatHull.pickable = true;

		boatHull.rotationQuaternion.copyFrom(Quaternion.Identity());
		addToScene(scene, boatHull);
		this.#boat = boatHull;

		this.#voxelCollider = new VoxelAabbCollider(
			this.#collisionHalfExtents,
			createVoxelColliderBlockSampler(
				(x, y, z) => {
					const blockId = getBlockByWorldCoords(x, y, z);
					if (!isCollidableBlock(blockId)) return null;
					return { blockId, blockState: getBlockStateByWorldCoords(x, y, z) };
				},
				{
					getFenceDynamicShape,
					getShapeForBlockId,
					isFenceBlockId,
					computeFenceNeighborMask,
				},
			),
			this.#collisionEpsilon,
			{
				scene,
				name: "boatAABB",
				position: this.#boat.position,
				renderOrder: 1,
			},
		);
	}

	private setupBuoyancyPoints(): void {
		// Keep buoyancy sample points inside the AABB hull.
		const y = -this.#collisionHalfExtents.y - 0.3;
		const outerX = this.#collisionHalfExtents.x * 0.85;
		const outerZ = this.#collisionHalfExtents.z * 0.85;
		const innerX = this.#collisionHalfExtents.x * 0.45;
		const innerZ = this.#collisionHalfExtents.z * 0.45;
		this.#buoyancyPoints = [
			vec3(-outerX, y, -outerZ), // Front left
			vec3(outerX, y, -outerZ), // Front right
			vec3(-outerX, y, outerZ), // Back left
			vec3(outerX, y, outerZ), // Back right
			vec3(0, y, 0), // Center
			vec3(-innerX, y, -innerZ),
			vec3(innerX, y, -innerZ),
			vec3(-innerX, y, innerZ),
			vec3(innerX, y, innerZ),
		];
	}

	private setupAdvancedPhysics(scene: SceneContext): void {
		onBeforeRender(scene, (deltaMs: number) => {
			const dt = deltaMs / 1000;
			if (dt <= 0) {
				return;
			}

			this.#submergedPoints = 0;
			{
				const rq = this.#boat.rotationQuaternion;
				this.#_rotQuat.set(rq.x, rq.y, rq.z, rq.w);
			}
			Quaternion.ToRotationMatrixToRef(this.#_rotQuat, this.#_rotMat);
			const rotMat = this.#_rotMat;

			// Gravity is always applied, buoyancy counters it when submerged.
			this.#linearVelocity.y += this.#gravity * dt;

			// Calculate total buoyancy force needed based on player count
			const totalBuoyancyMultiplier = this.#baseBuoyancyForce;

			// Check each buoyancy point for submersion
			const pts = this.#buoyancyPoints;
			for (let i = 0; i < pts.length; i++) {
				transformCoordinatesVec3ToRef(pts[i], rotMat, this.#_worldPt);
				this.#_worldPt.x += this.#boat.position.x;
				this.#_worldPt.y += this.#boat.position.y;
				this.#_worldPt.z += this.#boat.position.z;

				const submersion = this.getWaterSubmersionAtPoint(this.#_worldPt);
				if (submersion > 0) {
					const buoyancyForce = submersion * totalBuoyancyMultiplier;
					setVec3(this.#_buoyVec, 0, buoyancyForce, 0);

					this.applyForceAtPoint(this.#_buoyVec, this.#_worldPt, dt);

					this.#submergedPoints++;
				}
			}

			// Water Resistance (Drag)
			if (this.#submergedPoints > 0) {
				const linearDamping = 0.985 ** (dt * 60);
				const angularDamping = 0.92 ** (dt * 60);

				scaleVec3InPlace(this.#linearVelocity, linearDamping);
				scaleVec3InPlace(this.#angularVelocity, angularDamping);
			} else {
				const airLinearDamping = 0.995 ** (dt * 60);
				const airAngularDamping = 0.98 ** (dt * 60);

				scaleVec3InPlace(this.#linearVelocity, airLinearDamping);
				scaleVec3InPlace(this.#angularVelocity, airAngularDamping);
			}

			this.moveAxis(Axis.X, this.#linearVelocity.x * dt);
			this.moveAxis(Axis.Y, this.#linearVelocity.y * dt);
			this.moveAxis(Axis.Z, this.#linearVelocity.z * dt);
			this.integrateRotation(dt);

			this.#voxelCollider.syncDebugMesh(this.#boat.position);
		});
	}

	private applyForceAtPoint(force: Vec3, worldPoint: Vec3, dt: number): void {
		const invMass = 1 / this.#mass;
		const accelerationScale = invMass * dt;

		setVec3(
			this.#_accel,
			force.x * accelerationScale,
			force.y * accelerationScale,
			force.z * accelerationScale,
		);

		this.#linearVelocity.x += this.#_accel.x;
		this.#linearVelocity.y += this.#_accel.y;
		this.#linearVelocity.z += this.#_accel.z;

		setVec3(
			this.#_lever,
			worldPoint.x - this.#boat.position.x,
			worldPoint.y - this.#boat.position.y,
			worldPoint.z - this.#boat.position.z,
		);

		crossVec3ToRef(this.#_lever, force, this.#_torque);

		const torqueScale = this.#buoyancyTorqueScale * invMass * dt;

		this.#angularVelocity.x += this.#_torque.x * torqueScale;
		this.#angularVelocity.y += this.#_torque.y * torqueScale;
		this.#angularVelocity.z += this.#_torque.z * torqueScale;
	}

	private integrateRotation(dt: number): void {
		{
			const rq = this.#boat.rotationQuaternion;
			this.#_currentRot.set(rq.x, rq.y, rq.z, rq.w);
		}
		Quaternion.FromEulerAnglesToRef(
			this.#lockPitch ? 0 : this.#angularVelocity.x * dt,
			this.#angularVelocity.y * dt,
			this.#lockRoll ? 0 : this.#angularVelocity.z * dt,
			this.#_deltaRot,
		);
		this.#_deltaRot.multiplyToRef(this.#_currentRot, this.#_nextRot);
		this.#_nextRot.normalize();

		Quaternion.ToRotationMatrixToRef(this.#_nextRot, this.#_rotMat);
		this.#_rotMat.toEulerAnglesToRef(this.#_euler);

		if (this.#lockPitch) {
			this.#_euler.x = 0;
		}
		if (this.#lockRoll) {
			this.#_euler.z = 0;
		}
		Quaternion.FromEulerAnglesToRef(
			this.#_euler.x,
			this.#_euler.y,
			this.#_euler.z,
			this.#_currentRot,
		);
		this.#boat.rotationQuaternion.copyFrom(this.#_currentRot);

		if (this.#lockPitch) {
			this.#angularVelocity.x = 0;
		} else {
			this.#angularVelocity.x *= 0.985;
		}
		if (this.#lockRoll) {
			this.#angularVelocity.z = 0;
		} else {
			this.#angularVelocity.z *= 0.985;
		}
	}

	private moveAxis(axis: Axis, delta: number): void {
		this.#voxelCollider.moveAxis(
			this.#boat.position,
			this.#linearVelocity,
			axis,
			delta,
			this.#collisionStepSize,
		);
	}

	private getWaterSubmersionAtPoint(worldPoint: Vec3): number {
		const x = Math.floor(worldPoint.x);
		const y = Math.floor(worldPoint.y);
		const z = Math.floor(worldPoint.z);

		const blockId = getBlockByWorldCoords(x, y, z);
		if (blockId !== BlockType.Water) {
			return 0;
		}

		const aboveBlockId = getBlockByWorldCoords(x, y + 1, z);
		if (aboveBlockId === BlockType.Water) {
			return 1;
		}

		const topOfWaterVoxel = y + 1;
		return Math.max(0, Math.min(1, topOfWaterVoxel - worldPoint.y));
	}

	public applyImpulse(impulse: Vec3, worldPoint: Vec3): void {
		this.applyForceAtPoint(impulse, worldPoint, 1);
	}

	public applyAngularImpulse(impulse: Vec3): void {
		const invMass = 1 / this.#mass;

		this.#angularVelocity.x += impulse.x * invMass;
		this.#angularVelocity.y += impulse.y * invMass;
		this.#angularVelocity.z += impulse.z * invMass;
	}

	public get boatMesh(): Mesh {
		return this.#boat;
	}
	public get boatPosition(): Vec3 {
		return vec3(
			this.#boat.position.x,
			this.#boat.position.y,
			this.#boat.position.z,
		);
	}
	public getBoatPositionToRef(out: Vec3): void {
		out.x = this.#boat.position.x;
		out.y = this.#boat.position.y;
		out.z = this.#boat.position.z;
	}
	public get mount(): Mount {
		return this.#mount;
	}
	public get submergedPoints(): number {
		return this.#submergedPoints;
	}

	public getBoatTopYToRef(out: Vec3): void {
		out.x = this.#boat.position.x;
		out.y = this.#boat.boundMax
			? this.#boat.boundMax[1]
			: this.#boat.position.y;
		out.z = this.#boat.position.z;
	}

	public getBoatTopY(): Vec3 {
		return vec3(
			this.#boat.position.x,
			this.#boat.boundMax ? this.#boat.boundMax[1] : this.#boat.position.y,
			this.#boat.position.z,
		);
	}

	use(player: Player): void {
		this.#mount.mount(player);
	}
}
