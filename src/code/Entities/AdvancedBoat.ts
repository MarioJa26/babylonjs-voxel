import {
  Color3,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import { IUsable } from "../Inferface/IUsable";
import { Mount } from "./Mount";
import { MetadataContainer } from "./MetaDataContainer";
import { Player } from "../Player/Player";
import { PaddleBoatControls } from "../Player/Controls/PaddleBoatControls";
import { ChunkLoadingSystem } from "../World/Chunk/ChunkLoadingSystem";
import { BlockType, isCollidableBlock } from "../World/BlockType";
import { Axis, VoxelAabbCollider } from "@/code/World/Collision/VoxelAabbCollider";

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
    this.#boat.metadata.add("use", (player: Player) => this.use(player));

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
      (x, y, z) => {
        const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
        return isCollidableBlock(blockId);
      },
      this.#collisionEpsilon,
      {
        scene,
        name: "boatAABB",
        position: this.#boat.position,
        renderingGroupId: 1,
      },
    );
    this.#boat.onDisposeObservable.add(() => this.#voxelCollider.dispose());

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
    scene.registerBeforeRender(() => {
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
      this.#buoyancyPoints.forEach((localPoint) => {
        const worldPoint = Vector3.TransformCoordinates(
          localPoint,
          worldMatrix,
        );

        const submersion = this.getWaterSubmersionAtPoint(worldPoint);
        if (submersion > 0) {
          const buoyancyForce = submersion * totalBuoyancyMultiplier;
          const buoyancyVector = new Vector3(0, buoyancyForce, 0);

          this.applyForceAtPoint(buoyancyVector, worldPoint, dt);

          this.#submergedPoints++;
        }
      });

      // Water Resistance (Drag)
      if (this.#submergedPoints > 0) {
        const linearDamping = Math.pow(0.985, dt * 60);
        const angularDamping = Math.pow(0.92, dt * 60);
        this.#linearVelocity.scaleInPlace(linearDamping);
        this.#angularVelocity.scaleInPlace(angularDamping);
      } else {
        const airLinearDamping = Math.pow(0.995, dt * 60);
        const airAngularDamping = Math.pow(0.98, dt * 60);
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
    const linearAcceleration = force.scale(invMass);
    this.#linearVelocity.addInPlace(linearAcceleration.scale(dt));

    const lever = worldPoint.subtract(this.#boat.position);
    const torque = Vector3.Cross(lever, force).scale(
      this.#buoyancyTorqueScale * invMass * dt,
    );
    this.#angularVelocity.addInPlace(torque);
  }

  private integrateRotation(dt: number): void {
    const currentRotation =
      this.#boat.rotationQuaternion ?? Quaternion.Identity();
    const deltaRotation = Quaternion.RotationYawPitchRoll(
      this.#angularVelocity.y * dt,
      this.#lockPitch ? 0 : this.#angularVelocity.x * dt,
      this.#lockRoll ? 0 : this.#angularVelocity.z * dt,
    );
    const nextRotation = deltaRotation.multiply(currentRotation);
    nextRotation.normalize();
    const euler = nextRotation.toEulerAngles();
    if (this.#lockPitch) {
      euler.x = 0;
    }
    if (this.#lockRoll) {
      euler.z = 0;
    }
    this.#boat.rotationQuaternion = Quaternion.RotationYawPitchRoll(
      euler.y,
      euler.x,
      euler.z,
    );

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

    const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
    if (blockId !== BlockType.Water) {
      return 0;
    }

    const aboveBlockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y + 1, z);
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
    return this.#boat.position.clone();
  }
  public get mount(): Mount {
    return this.#mount;
  }
  public get submergedPoints(): number {
    return this.#submergedPoints;
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
