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
import type { Observer } from "@babylonjs/core/Misc/observable";

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

// ===========================
// Types & Options
// ===========================
export type CustomBoatOptions = {
  collisionHalfExtents?: Vector3;
  customVisualRoot?: Mesh;
  skipDefaultModel?: boolean;
  initialYaw?: number;
  customVisualLocalYaw?: number;
  blockCount?: number;
  boatChunk?: BoatChunk;
};

// ===========================
// CustomBoat
// ===========================
export class CustomBoat implements IUsable {
  // ---------------------------
  // Tunables / Config (centralized)
  // ---------------------------
  #cfg = {
    mass: 10, // kg (effective)
    gravity: -9.81, // m/s^2
    baseBuoyancyForce: 20, // upward force per fully-submerged point
    torqueScale: 0.12, // how strongly off-center forces induce yaw torque
    collisionStepSize: 0.25, // voxel sweep step
    collisionEpsilon: 0.001, // voxel penetration tolerance
    damping: {
      waterLinear: 0.985, // per-frame factor @ 60 fps (exponentiated by dt*60)
      waterAngular: 0.92,
      airLinear: 0.995,
      airAngular: 0.98,
    },
    dtClamp: { min: 1 / 600, max: 1 / 24 }, // clamp dt to avoid spikes/tunneling
  } as const;

  // ---------------------------
  // Core State
  // ---------------------------
  #collisionHalfExtents = new Vector3(1.15, 0.6, 1.15);
  #boat!: Mesh; // AABB hull mesh (never rotates)
  #voxelCollider!: VoxelAabbCollider;

  #mount!: Mount;
  static #boatControls: CustomBoatControls;

  // Visual override
  #customVisualRoot?: Mesh;
  #customVisualLocalYaw = 0; // local visual offset (yaw only)
  #skipDefaultModel = false;

  // Boat chunk (optional)
  #boatChunk?: BoatChunk;

  // Physics State
  #currentYaw = 0; // tracked separately from hull rotation
  #linearVelocity = Vector3.Zero();
  #angularVelocity = Vector3.Zero();
  #angularResponseScale = 1; // scaled down for larger boats

  // Buoyancy sampling
  #buoyancyPoints: Vector3[] = [];
  #submergedPoints = 0;

  // Update hook
  #beforeRenderObs?: Observer<Scene>;

  // Reusable temp vectors (reduce GC)
  #tmpWorldPoint = new Vector3();
  #tmpTorque = new Vector3();
  #tmpLever = new Vector3();

  constructor(
    scene: Scene,
    player: Player,
    waterLevel: number,
    position?: Vector3,
    options?: CustomBoatOptions,
  ) {
    // 1) Options → State
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
      // Inverse sqrt scaling for larger crafts (less twitchy but steerable)
      this.#angularResponseScale = Math.max(
        0.08,
        1 / Math.sqrt(options.blockCount),
      );
    }

    // 2) Create hull & collider
    this.#boat = this.#createHull(scene, position, waterLevel);
    this.#voxelCollider = this.#createCollider(scene, this.#boat);

    // 3) Metadata & chunk lifecycle
    this.#boat.metadata = new MetadataContainer();
    this.#boat.metadata.add("use", (p: Player) => this.use(p));

    if (this.#boatChunk) {
      this.#boat.metadata.add("boatChunk", this.#boatChunk);
      this.#boat.onDisposeObservable.add(() => this.#boatChunk?.dispose());
    }

    // 4) Visuals: custom or default
    if (this.#customVisualRoot) {
      this.#attachCustomVisual(this.#customVisualRoot);
      this.#applyCustomVisualMetadata(this.#customVisualRoot);
    } else if (!this.#skipDefaultModel) {
      this.#loadDefaultModel(scene).catch((err) =>
        console.error("Model failed to load:", err),
      );
    }

    // 5) Buoyancy sampling points
    this.#buildBuoyancyPoints();

    // 6) Controls & Mount
    CustomBoat.#boatControls = new CustomBoatControls(this, player);
    this.#mount = new Mount(this.#boat, CustomBoat.#boatControls);

    // 7) Update loop
    this.#beforeRenderObs = scene.onBeforeRenderObservable.add(() =>
      this.#tick(scene),
    );

    // 8) Clean up when hull is disposed
    this.#boat.onDisposeObservable.add(() => this.dispose(scene));
  }

  // ---------------------------
  // Construction helpers
  // ---------------------------
  #createHull(
    scene: Scene,
    position: Vector3 | undefined,
    waterLevel: number,
  ): Mesh {
    const hull = MeshBuilder.CreateBox(
      "boatHull",
      {
        width: this.#collisionHalfExtents.x * 2,
        height: this.#collisionHalfExtents.y * 2,
        depth: this.#collisionHalfExtents.z * 2,
      },
      scene,
    );

    hull.position.set(
      position?.x ?? 0,
      position?.y ?? waterLevel + 10,
      position?.z ?? 0,
    );

    const hullMaterial = new StandardMaterial("hullMat", scene);
    hullMaterial.diffuseColor = new Color3(0.8, 0.6, 0.2);
    hull.material = hullMaterial;

    hull.isPickable = true;
    hull.renderingGroupId = 1;

    // Hide the hull by default; keep for debug if needed
    hull.isVisible = false;

    // The hull never rotates — yaw is tracked separately to keep AABB aligned
    hull.rotationQuaternion = Quaternion.Identity();

    return hull;
  }

  #createCollider(scene: Scene, hull: Mesh): VoxelAabbCollider {
    const collider = new VoxelAabbCollider(
      this.#collisionHalfExtents,
      (x, y, z) => {
        const id = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
        return id !== BlockType.Air && id !== BlockType.Water;
      },
      this.#cfg.collisionEpsilon,
      {
        scene,
        name: "boatAABB",
        position: hull.position,
        renderingGroupId: 1,
      },
    );

    hull.onDisposeObservable.add(() => collider.dispose());
    return collider;
  }

  async #loadDefaultModel(scene: Scene): Promise<void> {
    // NOTE: Keeping your original ImportMeshAsync usage for compatibility.
    // If needed, the canonical Babylon call is: SceneLoader.ImportMeshAsync("", "models/", "boat-row-small.glb", scene)
    const result = await ImportMeshAsync("models/boat-row-small.glb", scene);
    const root = result.meshes[0];

    // Parent to hull so it inherits position (yaw still independent via visualRoot path)
    root.parent = this.#boat;
    root.position.y = -0.45;

    // Make meshes pickable and share metadata
    for (const m of result.meshes) {
      m.isPickable = true;
      m.renderingGroupId = 1;
      m.metadata = this.#boat.metadata;
    }
  }

  #attachCustomVisual(visual: Mesh): void {
    // Not parented — we drive transform manually each frame (yaw independence)
    visual.position.copyFrom(this.#boat.position);
    visual.rotationQuaternion = Quaternion.RotationYawPitchRoll(
      this.#currentYaw + this.#customVisualLocalYaw,
      0,
      0,
    );
    visual.scaling.set(1, 1, 1);
  }

  #applyCustomVisualMetadata(root: Mesh): void {
    const meshes = [root, ...root.getChildMeshes(false)];
    for (const mesh of meshes) {
      mesh.isPickable = true;
      mesh.renderingGroupId = 1;
      mesh.metadata = this.#boat.metadata;
    }
  }

  #buildBuoyancyPoints(): void {
    // Keep sample points inside AABB hull
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

  // ---------------------------
  // Frame Update
  // ---------------------------
  #tick(scene: Scene): void {
    // Get dt in seconds, clamp for numerical stability
    let dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;
    dt = Math.min(Math.max(dt, this.#cfg.dtClamp.min), this.#cfg.dtClamp.max);

    this.#submergedPoints = 0;

    // Precompute yaw rotation for local buoyancy points
    const cos = Math.cos(this.#currentYaw);
    const sin = Math.sin(this.#currentYaw);

    // Gravity
    this.#linearVelocity.y += this.#cfg.gravity * dt;

    // Buoyancy force per point (rotate local → world, no hull rotation)
    for (let i = 0; i < this.#buoyancyPoints.length; i++) {
      const lp = this.#buoyancyPoints[i];
      const rx = lp.x * cos - lp.z * sin;
      const rz = lp.x * sin + lp.z * cos;

      this.#tmpWorldPoint.set(
        this.#boat.position.x + rx,
        this.#boat.position.y + lp.y,
        this.#boat.position.z + rz,
      );

      const submersion = this.#getWaterSubmersionAtPoint(this.#tmpWorldPoint);
      if (submersion > 0) {
        const buoyancy = submersion * this.#cfg.baseBuoyancyForce;
        // Upward force at the point
        this.#applyForceAtPoint(0, buoyancy, 0, this.#tmpWorldPoint, dt);
        this.#submergedPoints++;
      }
    }

    // Drag (water vs air)
    if (this.#submergedPoints > 0) {
      const l = Math.pow(this.#cfg.damping.waterLinear, dt * 60);
      const a = Math.pow(this.#cfg.damping.waterAngular, dt * 60);
      this.#linearVelocity.scaleInPlace(l);
      this.#angularVelocity.scaleInPlace(a);
    } else {
      const l = Math.pow(this.#cfg.damping.airLinear, dt * 60);
      const a = Math.pow(this.#cfg.damping.airAngular, dt * 60);
      this.#linearVelocity.scaleInPlace(l);
      this.#angularVelocity.scaleInPlace(a);
    }

    // Integrate translation axis by axis (voxel collider resolves)
    this.#moveAxis(Axis.X, this.#linearVelocity.x * dt);
    this.#moveAxis(Axis.Y, this.#linearVelocity.y * dt);
    this.#moveAxis(Axis.Z, this.#linearVelocity.z * dt);

    // Integrate rotation (yaw only, hull AABB stays axis-aligned)
    this.#integrateRotation(dt);

    // Sync custom visual (if any)
    if (this.#customVisualRoot) {
      this.#customVisualRoot.position.copyFrom(this.#boat.position);
      this.#customVisualRoot.rotationQuaternion =
        Quaternion.RotationYawPitchRoll(
          this.#currentYaw + this.#customVisualLocalYaw,
          0,
          0,
        );
    }

    // Debug collider (if enabled)
    this.#voxelCollider.syncDebugMesh(this.#boat.position);
  }

  // ---------------------------
  // Low-level physics helpers
  // ---------------------------
  #applyForceAtPoint(
    fx: number,
    fy: number,
    fz: number,
    worldPoint: Vector3,
    dt: number,
  ): void {
    const invMass = 1 / this.#cfg.mass;

    // Linear
    this.#linearVelocity.x += fx * invMass * dt;
    this.#linearVelocity.y += fy * invMass * dt;
    this.#linearVelocity.z += fz * invMass * dt;

    // Angular (torque around center)
    this.#tmpLever.copyFrom(worldPoint).subtractInPlace(this.#boat.position);
    // torque = lever x force
    this.#tmpTorque.set(
      this.#tmpLever.y * fz - this.#tmpLever.z * fy,
      this.#tmpLever.z * fx - this.#tmpLever.x * fz,
      this.#tmpLever.x * fy - this.#tmpLever.y * fx,
    );

    const torqueScale =
      this.#cfg.torqueScale * this.#angularResponseScale * invMass * dt;

    this.#angularVelocity.addInPlace(this.#tmpTorque.scaleInPlace(torqueScale));
  }

  #integrateRotation(dt: number): void {
    // Yaw only
    this.#currentYaw += this.#angularVelocity.y * dt;
    // Light yaw damping
    this.#angularVelocity.y *= 0.985;

    // Lock pitch/roll
    this.#angularVelocity.x = 0;
    this.#angularVelocity.z = 0;

    // Normalize yaw to [-PI, PI] to keep numbers bounded
    if (this.#currentYaw > Math.PI || this.#currentYaw < -Math.PI) {
      this.#currentYaw =
        ((this.#currentYaw + Math.PI) % (2 * Math.PI)) - Math.PI;
    }
  }

  #moveAxis(axis: Axis, delta: number): void {
    this.#voxelCollider.moveAxis(
      this.#boat.position,
      this.#linearVelocity,
      axis,
      delta,
      this.#cfg.collisionStepSize,
    );
  }

  #getWaterSubmersionAtPoint(worldPoint: Vector3): number {
    const x = Math.floor(worldPoint.x);
    const y = Math.floor(worldPoint.y);
    const z = Math.floor(worldPoint.z);

    const blockId = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
    if (blockId !== BlockType.Water) return 0;

    const above = ChunkLoadingSystem.getBlockByWorldCoords(x, y + 1, z);
    if (above === BlockType.Water) return 1;

    const top = y + 1;
    // linear submersion from voxel bottom->top
    return Math.max(0, Math.min(1, top - worldPoint.y));
  }

  // ---------------------------
  // Public API (preserved)
  // ---------------------------
  public applyImpulse(impulse: Vector3, worldPoint: Vector3): void {
    this.#applyForceAtPoint(impulse.x, impulse.y, impulse.z, worldPoint, 1);
  }

  public applyAngularImpulse(impulse: Vector3): void {
    const invMass = 1 / this.#cfg.mass;
    this.#angularVelocity.addInPlace(
      impulse.scaleInPlace(invMass * this.#angularResponseScale),
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
    const info = this.#boat.getBoundingInfo();
    return new Vector3(
      this.#boat.position.x,
      info.boundingBox.maximumWorld.y,
      this.#boat.position.z,
    );
  }

  public use(player: Player): void {
    this.#mount.mount(player);
  }

  // ---------------------------
  // Extras / Lifecycle
  // ---------------------------
  public setAngularResponseScale(scale: number): void {
    this.#angularResponseScale = Math.max(0.01, scale);
  }

  public dispose(scene: Scene): void {
    if (this.#beforeRenderObs) {
      scene.onBeforeRenderObservable.remove(this.#beforeRenderObs);
      this.#beforeRenderObs = undefined;
    }
    // Colliders and chunk are already tied to hull disposal; ensure hull goes away
    if (!this.#boat.isDisposed()) {
      this.#boat.dispose(false, true);
    }
  }
}
