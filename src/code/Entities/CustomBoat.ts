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
import { CustomBoatControls } from "../Player/Controls/CustomBoatControls";
import { ChunkLoadingSystem } from "../World/Chunk/ChunkLoadingSystem";
import { BlockType } from "../World/BlockType";
import {
  Axis,
  VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { BoatChunk } from "@/code/World/Boat/BoatChunk";

export type CustomBoatOptions = {
  collisionHalfExtents?: Vector3;
  customVisualRoot?: Mesh;
  skipDefaultModel?: boolean;
  initialYaw?: number;
  customVisualLocalYaw?: number;
  blockCount?: number;
  boatChunk?: BoatChunk;
};

export class CustomBoat implements IUsable {
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

  // Yaw is tracked separately so the physics hull (AABB) stays axis-aligned
  // while the visual rotates freely.
  #currentYaw = 0;

  static #boatControls: CustomBoatControls;
  #customVisualRoot?: Mesh;
  #boatChunk?: BoatChunk;
  #skipDefaultModel = false;
  #customVisualLocalYaw = 0;
  #angularResponseScale = 1;

  #submergedPoints = 0;

  constructor(
    scene: Scene,
    player: Player,
    waterLevel: number,
    position?: Vector3,
    options?: CustomBoatOptions,
  ) {
    if (options?.collisionHalfExtents) {
      this.#collisionHalfExtents = options.collisionHalfExtents.clone();
    }
    this.#customVisualRoot = options?.customVisualRoot;
    this.#boatChunk = options?.boatChunk;
    this.#skipDefaultModel = Boolean(options?.skipDefaultModel);
    if (typeof options?.initialYaw === "number") {
      this.#currentYaw = options.initialYaw;
    }
    if (typeof options?.customVisualLocalYaw === "number") {
      this.#customVisualLocalYaw = options.customVisualLocalYaw;
    }
    if (typeof options?.blockCount === "number" && options.blockCount > 1) {
      // Larger boats should be less twitchy. Inverse sqrt keeps big boats
      // steerable while still clearly reducing turn speed with size.
      this.#angularResponseScale = Math.max(
        0.08,
        1 / Math.sqrt(options.blockCount),
      );
    }
    this.createBoat(scene, position, waterLevel);

    this.#boat.metadata = new MetadataContainer();
    this.#boat.metadata.add("use", (player: Player) => this.use(player));
    if (this.#boatChunk) {
      this.#boat.metadata.add("boatChunk", this.#boatChunk);
      this.#boat.onDisposeObservable.add(() => this.#boatChunk?.dispose());
    }
    this.applyCustomVisualMetadata();

    this.setupBuoyancyPoints();
    this.setupAdvancedPhysics(scene);
    CustomBoat.#boatControls = new CustomBoatControls(this, player);

    this.#mount = new Mount(this.#boat, CustomBoat.#boatControls);
  }

  private createBoat(
    scene: Scene,
    position: Vector3 | undefined,
    waterLevel: number,
  ): void {
    // AABB collision hull used by the physics body.
    // The hull never rotates — it stays axis-aligned and is resized each frame
    // to the world-space AABB of the rotated boat extents.
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
    // Hull always stays at identity rotation — yaw lives in #currentYaw only.
    boatHull.rotationQuaternion = Quaternion.Identity();
    this.#boat = boatHull;

    this.#voxelCollider = new VoxelAabbCollider(
      this.#collisionHalfExtents,
      (x, y, z) => {
        const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
        return blockId !== BlockType.Air && blockId !== BlockType.Water;
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

    if (this.#customVisualRoot) {
      // Do NOT parent the visual to the hull — it is positioned/rotated manually
      // each frame so the AABB hull can stay axis-aligned.
      this.#customVisualRoot.position.copyFrom(boatHull.position);
      this.#customVisualRoot.rotationQuaternion =
        Quaternion.RotationYawPitchRoll(
          this.#currentYaw + this.#customVisualLocalYaw,
          0,
          0,
        );
      this.#customVisualRoot.scaling.set(1, 1, 1);
      return;
    }

    if (this.#skipDefaultModel) return;

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

  private applyCustomVisualMetadata(): void {
    if (!this.#customVisualRoot || !this.#boat.metadata) return;
    const meshes = [
      this.#customVisualRoot,
      ...this.#customVisualRoot.getChildMeshes(false),
    ];
    for (const mesh of meshes) {
      mesh.isPickable = true;
      mesh.renderingGroupId = 1;
      mesh.metadata = this.#boat.metadata;
    }
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

      // Buoyancy points are in local boat space — rotate them by current yaw
      // before transforming to world space, since the hull mesh no longer rotates.
      const cos = Math.cos(this.#currentYaw);
      const sin = Math.sin(this.#currentYaw);

      // Gravity is always applied, buoyancy counters it when submerged.
      this.#linearVelocity.y += this.#gravity * dt;

      // Check each buoyancy point for submersion
      this.#buoyancyPoints.forEach((localPoint) => {
        // Manually rotate the local point by current yaw (hull mesh is identity)
        const rotatedLocal = new Vector3(
          localPoint.x * cos - localPoint.z * sin,
          localPoint.y,
          localPoint.x * sin + localPoint.z * cos,
        );
        const worldPoint = this.#boat.position.add(rotatedLocal);

        const submersion = this.getWaterSubmersionAtPoint(worldPoint);
        if (submersion > 0) {
          const buoyancyForce = submersion * this.#baseBuoyancyForce;
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

      // Sync visual root position and yaw — the hull mesh never rotates
      if (this.#customVisualRoot) {
        this.#customVisualRoot.position.copyFrom(this.#boat.position);
        this.#customVisualRoot.rotationQuaternion =
          Quaternion.RotationYawPitchRoll(
            this.#currentYaw + this.#customVisualLocalYaw,
            0,
            0,
          );
      }

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
      this.#buoyancyTorqueScale * this.#angularResponseScale * invMass * dt,
    );
    this.#angularVelocity.addInPlace(torque);
  }

  private integrateRotation(dt: number): void {
    // Only yaw is integrated — stored in #currentYaw, not on the hull mesh.
    // The hull mesh stays at Quaternion.Identity() so the AABB stays axis-aligned.
    this.#currentYaw += this.#angularVelocity.y * dt;
    this.#angularVelocity.y *= 0.985;

    // Pitch and roll are locked — zero them out
    this.#angularVelocity.x = 0;
    this.#angularVelocity.z = 0;
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
    this.#angularVelocity.addInPlace(
      impulse.scale(invMass * this.#angularResponseScale),
    );
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
  public get currentYaw(): number {
    return this.#currentYaw;
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
