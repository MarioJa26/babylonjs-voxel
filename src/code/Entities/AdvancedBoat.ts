import {
	Color3,
	type Mesh,
	MeshBuilder,
	type Observer,
	Quaternion,
	type Scene,
	StandardMaterial,
	Vector3,
} from "@babylonjs/core";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import {
	_blockShapeInfoScratch,
	Axis,
	type BlockShapeInfo,
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
import { MetadataContainer } from "./MetadataContainer";
import { Mount } from "./Mount";

export class AdvancedBoat implements IUsable {
	#collisionHalfExtents = new Vector3(1.15, 0.6, 1.15);
	#boat!: Mesh;
	#mount: Mount;
	#buoyancyPoints: Vector3[] = [];
	#baseBuoyancyForce = 20;
	#mass = 10;
	#gravity = -9.81;
	#collisionStepSize = 0.25;
	#collisionEpsilon = 0.001;
	#buoyancyTorqueScale = 0.12;
	#lockRoll = true;
	#lockPitch = true;
	#linearVelocity = Vector3.Zero();
	#angularVelocity = Vector3.Zero();
	#voxelCollider!: VoxelAabbCollider;

	// Scratch vectors for per-frame physics (avoids allocation)
	readonly #_worldPt = Vector3.Zero();
	readonly #_buoyVec = Vector3.Zero();
	readonly #_accel = Vector3.Zero();
	readonly #_lever = Vector3.Zero();
	readonly #_torque = Vector3.Zero();
	readonly #_deltaRot = new Quaternion();
	readonly #_nextRot = new Quaternion();
	readonly #_euler = Vector3.Zero();

	#renderObserver: Observer<Scene> | null = null;

	static #boatControls: PaddleBoatControls;

	#submergedPoints = 0;

	constructor(
		scene: Scene,
		player: Player,
		waterLevel: number,
		position?: Vector3,
	) {
		this.createBoat(scene, position, waterLevel);

		this.#boat.metadata = new MetadataContainer();
		this.#boat.metadata.set("use", (player: Player) => this.use(player));

		this.setupBuoyancyPoints();
		this.setupAdvancedPhysics(scene);
		AdvancedBoat.#boatControls = new PaddleBoatControls(this, player);

		this.#mount = new Mount(this.#boat, AdvancedBoat.#boatControls);
	}

	private createBoat(
		scene: Scene,
		position: Vector3 | undefined,
		waterLevel: number,
	): void {
		// AABB collision hull used by the physics body.
		const boatHull = MeshBuilder.CreateBox(
			"boatHull",
			{
				width: this.#collisionHalfExtents.x * 2,
				height: this.#collisionHalfExtents.y * 2,
				depth: this.#collisionHalfExtents.z * 2,
			},
			scene,
		);

		boatHull.position = new Vector3(
			position?.x || 0,
			position?.y || waterLevel + 10,
			position?.z || 0,
		);

		const hullMaterial = new StandardMaterial("hullMat", scene);
		hullMaterial.diffuseColor = new Color3(0.8, 0.6, 0.2);
		boatHull.material = hullMaterial;
		boatHull.isPickable = true;
		boatHull.renderingGroupId = 1;

		// Set to false to see the physics shape during debugging, true to hide it
		boatHull.isVisible = false;
		boatHull.rotationQuaternion = Quaternion.Identity();
		this.#boat = boatHull;

		this.#voxelCollider = new VoxelAabbCollider(
			this.#collisionHalfExtents,
			(x, y, z): BlockShapeInfo | null => {
				const blockId = getBlockByWorldCoords(x, y, z);
				if (!isCollidableBlock(blockId)) return null;

				if (isFenceBlockId(blockId)) {
					const mask = computeFenceNeighborMask(x, y, z, (wx, wy, wz) => {
						return getBlockByWorldCoords(wx, wy, wz);
					});
					_blockShapeInfoScratch.shape = getFenceDynamicShape(mask);
					_blockShapeInfoScratch.rotation = 0;
					_blockShapeInfoScratch.slice = 0;
					_blockShapeInfoScratch.flipY = false;
					return _blockShapeInfoScratch;
				}

				const state = getBlockStateByWorldCoords(x, y, z);
				const shape = getShapeForBlockId(blockId);
				_blockShapeInfoScratch.shape = shape;
				_blockShapeInfoScratch.rotation = shape.rotateY ? state & 3 : 0;
				_blockShapeInfoScratch.slice = 0;
				_blockShapeInfoScratch.flipY = shape.allowFlipY && (state & 4) !== 0;
				return _blockShapeInfoScratch;
			},
			this.#collisionEpsilon,
			{
				scene,
				name: "boatAABB",
				position: this.#boat.position,
				renderingGroupId: 1,
			},
		);
		this.#boat.onDisposeObservable.add(() => {
			this.#voxelCollider.dispose();
			if (this.#renderObserver) {
				scene.onBeforeRenderObservable.remove(this.#renderObserver);
				this.#renderObserver = null;
			}
		});

		ImportMeshAsync("models/boat-row-small.glb", scene)
			.then((result) => {
				const root = result.meshes[0];
				root.parent = this.#boat;
				root.position.y = -0.45;

				result.meshes.forEach((m) => {
					m.isPickable = true;
					m.renderingGroupId = 1;
					m.metadata = this.#boat.metadata;
				});
			})
			.catch((err) => {
				console.error("Model failed to load:", err);
			});
	}

	private setupBuoyancyPoints(): void {
		// Keep buoyancy sample points inside the AABB hull.
		const y = -this.#collisionHalfExtents.y - 0.3;
		const outerX = this.#collisionHalfExtents.x * 0.85;
		const outerZ = this.#collisionHalfExtents.z * 0.85;
		const innerX = this.#collisionHalfExtents.x * 0.45;
		const innerZ = this.#collisionHalfExtents.z * 0.45;
		this.#buoyancyPoints = [
			new Vector3(-outerX, y, -outerZ), // Front left
			new Vector3(outerX, y, -outerZ), // Front right
			new Vector3(-outerX, y, outerZ), // Back left
			new Vector3(outerX, y, outerZ), // Back right
			new Vector3(0, y, 0), // Center
			new Vector3(-innerX, y, -innerZ),
			new Vector3(innerX, y, -innerZ),
			new Vector3(-innerX, y, innerZ),
			new Vector3(innerX, y, innerZ),
		];
	}

	private setupAdvancedPhysics(scene: Scene): void {
		this.#renderObserver = scene.onBeforeRenderObservable.add(() => {
			const dt = scene.getEngine().getDeltaTime() / 1000;
			if (dt <= 0) {
				return;
			}

			this.#submergedPoints = 0;
			const worldMatrix = this.#boat.getWorldMatrix();

			// Gravity is always applied, buoyancy counters it when submerged.
			this.#linearVelocity.y += this.#gravity * dt;

			// Calculate total buoyancy force needed based on player count
			const totalBuoyancyMultiplier = this.#baseBuoyancyForce;

			// Check each buoyancy point for submersion
			const pts = this.#buoyancyPoints;
			for (let i = 0; i < pts.length; i++) {
				Vector3.TransformCoordinatesToRef(pts[i], worldMatrix, this.#_worldPt);

				const submersion = this.getWaterSubmersionAtPoint(this.#_worldPt);
				if (submersion > 0) {
					const buoyancyForce = submersion * totalBuoyancyMultiplier;
					this.#_buoyVec.copyFromFloats(0, buoyancyForce, 0);

					this.applyForceAtPoint(this.#_buoyVec, this.#_worldPt, dt);

					this.#submergedPoints++;
				}
			}

			// Water Resistance (Drag)
			if (this.#submergedPoints > 0) {
				const linearDamping = 0.985 ** (dt * 60);
				const angularDamping = 0.92 ** (dt * 60);
				this.#linearVelocity.scaleInPlace(linearDamping);
				this.#angularVelocity.scaleInPlace(angularDamping);
			} else {
				const airLinearDamping = 0.995 ** (dt * 60);
				const airAngularDamping = 0.98 ** (dt * 60);
				this.#linearVelocity.scaleInPlace(airLinearDamping);
				this.#angularVelocity.scaleInPlace(airAngularDamping);
			}

			this.moveAxis(Axis.X, this.#linearVelocity.x * dt);
			this.moveAxis(Axis.Y, this.#linearVelocity.y * dt);
			this.moveAxis(Axis.Z, this.#linearVelocity.z * dt);
			this.integrateRotation(dt);

			this.#voxelCollider.syncDebugMesh(this.#boat.position);
		});
	}

	private applyForceAtPoint(
		force: Vector3,
		worldPoint: Vector3,
		dt: number,
	): void {
		const invMass = 1 / this.#mass;

		force.scaleToRef(invMass, this.#_accel);
		this.#_accel.scaleInPlace(dt);
		this.#linearVelocity.addInPlace(this.#_accel);

		worldPoint.subtractToRef(this.#boat.position, this.#_lever);
		Vector3.CrossToRef(this.#_lever, force, this.#_torque);
		this.#_torque.scaleInPlace(this.#buoyancyTorqueScale * invMass * dt);
		this.#angularVelocity.addInPlace(this.#_torque);
	}

	private integrateRotation(dt: number): void {
		if (!this.#boat.rotationQuaternion) {
			this.#boat.rotationQuaternion = new Quaternion();
		}
		const currentRotation = this.#boat.rotationQuaternion;
		Quaternion.RotationYawPitchRollToRef(
			this.#angularVelocity.y * dt,
			this.#lockPitch ? 0 : this.#angularVelocity.x * dt,
			this.#lockRoll ? 0 : this.#angularVelocity.z * dt,
			this.#_deltaRot,
		);
		this.#_deltaRot.multiplyToRef(currentRotation, this.#_nextRot);
		this.#_nextRot.normalize();
		this.#_nextRot.toEulerAnglesToRef(this.#_euler);
		if (this.#lockPitch) {
			this.#_euler.x = 0;
		}
		if (this.#lockRoll) {
			this.#_euler.z = 0;
		}
		Quaternion.RotationYawPitchRollToRef(
			this.#_euler.y,
			this.#_euler.x,
			this.#_euler.z,
			currentRotation,
		);
		this.#boat.rotationQuaternion = currentRotation;

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

	private getWaterSubmersionAtPoint(worldPoint: Vector3): number {
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

	public applyImpulse(impulse: Vector3, worldPoint: Vector3): void {
		this.applyForceAtPoint(impulse, worldPoint, 1);
	}

	public applyAngularImpulse(impulse: Vector3): void {
		const invMass = 1 / this.#mass;
		this.#angularVelocity.addInPlace(impulse.scale(invMass));
	}

	public get boatMesh(): Mesh {
		return this.#boat;
	}
	public get boatPosition(): Vector3 {
		return this.#boat.position;
	}
	public get mount(): Mount {
		return this.#mount;
	}
	public get submergedPoints(): number {
		return this.#submergedPoints;
	}

	public getBoatTopYToRef(out: Vector3): void {
		const boatBounds = this.#boat.getBoundingInfo();
		out.x = this.#boat.position.x;
		out.y = boatBounds.boundingBox.maximumWorld.y;
		out.z = this.#boat.position.z;
	}

	public getBoatTopY(): Vector3 {
		const boatBounds = this.#boat.getBoundingInfo();
		return new Vector3(
			this.#boat.position.x,
			boatBounds.boundingBox.maximumWorld.y,
			this.#boat.position.z,
		);
	}

	use(player: Player): void {
		this.#mount.mount(player);
	}
}
