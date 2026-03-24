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

import { Axis } from "@/code/World/Collision/VoxelAabbCollider";
import { BoatChunk } from "@/code/World/Boat/BoatChunk";
import { VoxelObbCollider } from "../World/Collision/VoxelObbCollider";

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
  // Tunables / Config
  // ---------------------------
  #cfg = {
    mass: 10,
    gravity: -9.81,
    baseBuoyancyForce: 20,
    torqueScale: 0.12,
    collisionStepSize: 0.25,
    collisionEpsilon: 0.01,
    damping: {
      waterLinear: 0.985,
      waterAngular: 0.92,
      airLinear: 0.995,
      airAngular: 0.98,
    },
    dtClamp: { min: 1 / 600, max: 1 / 24 },
  } as const;

  // ---------------------------
  // Core State
  // ---------------------------
  #collisionHalfExtents = new Vector3(1.15, 0.6, 1.15);
  #boat!: Mesh;
  #voxelCollider!: VoxelObbCollider;

  #mount!: Mount;
  static #boatControls: CustomBoatControls;

  #customVisualRoot?: Mesh;
  #customVisualLocalYaw = 0;
  #skipDefaultModel = false;

  #boatChunk?: BoatChunk;

  #currentYaw = 0;
  #linearVelocity = Vector3.Zero();
  #angularVelocity = Vector3.Zero();
  #angularResponseScale = 1;

  #buoyancyPoints: Vector3[] = [];
  #submergedPoints = 0;

  #beforeRenderObs?: Observer<Scene>;

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
    // 1) Options
    if (options?.collisionHalfExtents) {
      this.#collisionHalfExtents = options.collisionHalfExtents.clone();
    }
    this.#customVisualRoot = options?.customVisualRoot;
    this.#boatChunk = options?.boatChunk;
    this.#skipDefaultModel = Boolean(options?.skipDefaultModel);

    if (typeof options?.initialYaw === "number")
      this.#currentYaw = options.initialYaw;
    if (typeof options?.customVisualLocalYaw === "number")
      this.#customVisualLocalYaw = options.customVisualLocalYaw;

    if (typeof options?.blockCount === "number" && options.blockCount > 1) {
      this.#angularResponseScale = Math.max(
        0.08,
        1 / Math.sqrt(options.blockCount),
      );
    }

    // 2) Create hull & collider
    this.#boat = this.#createHull(scene, position, waterLevel);

    this.#voxelCollider = new VoxelObbCollider(
      this.#collisionHalfExtents,
      (x, y, z) => {
        const id = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
        return id !== BlockType.Air && id !== BlockType.Water;
      },
      this.#cfg.collisionEpsilon,
      {
        scene,
        name: "boatOBB",
        position: this.#boat.position,
        renderingGroupId: 1,
      },
    );

    // 3) Metadata
    this.#boat.metadata = new MetadataContainer();
    this.#boat.metadata.add("use", (p: Player) => this.use(p));

    if (this.#boatChunk) {
      this.#boat.metadata.add("boatChunk", this.#boatChunk);
      this.#boat.onDisposeObservable.add(() => this.#boatChunk?.dispose());
    }

    // 4) Visuals
    if (this.#customVisualRoot) {
      this.#attachCustomVisual(this.#customVisualRoot);
      this.#applyCustomVisualMetadata(this.#customVisualRoot);
    } else if (!this.#skipDefaultModel) {
      this.#loadDefaultModel(scene).catch((err) =>
        console.error("Model failed:", err),
      );
    }

    // 5) Buoyancy points
    this.#buildBuoyancyPoints();

    // 6) Controls
    CustomBoat.#boatControls = new CustomBoatControls(this, player);
    this.#mount = new Mount(this.#boat, CustomBoat.#boatControls);

    // 7) Tick loop
    this.#beforeRenderObs = scene.onBeforeRenderObservable.add(() =>
      this.#tick(scene),
    );

    // 8) Cleanup
    this.#boat.onDisposeObservable.add(() => this.dispose(scene));
  }

  // ---------------------------
  // Construction
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

    const mat = new StandardMaterial("hullMat", scene);
    mat.diffuseColor = new Color3(0.8, 0.6, 0.2);
    hull.material = mat;

    hull.isPickable = true;
    hull.renderingGroupId = 1;

    hull.isVisible = false;
    hull.rotationQuaternion = Quaternion.Identity();

    return hull;
  }

  async #loadDefaultModel(scene: Scene): Promise<void> {
    const result = await ImportMeshAsync("models/boat-row-small.glb", scene);
    const root = result.meshes[0];
    root.parent = this.#boat;
    root.position.y = -0.45;

    for (const m of result.meshes) {
      m.isPickable = true;
      m.renderingGroupId = 1;
      m.metadata = this.#boat.metadata;
    }
  }

  #attachCustomVisual(visual: Mesh): void {
    visual.position.copyFrom(this.#boat.position);
    visual.rotationQuaternion = Quaternion.RotationYawPitchRoll(
      this.#currentYaw + this.#customVisualLocalYaw,
      0,
      0,
    );
    visual.scaling.set(1, 1, 1);
  }

  #applyCustomVisualMetadata(root: Mesh): void {
    for (const mesh of [root, ...root.getChildMeshes(false)]) {
      mesh.isPickable = true;
      mesh.renderingGroupId = 1;
      mesh.metadata = this.#boat.metadata;
    }
  }

  #buildBuoyancyPoints(): void {
    const y = -this.#collisionHalfExtents.y - 0.3;
    const ox = this.#collisionHalfExtents.x * 0.85;
    const oz = this.#collisionHalfExtents.z * 0.85;
    const ix = this.#collisionHalfExtents.x * 0.45;
    const iz = this.#collisionHalfExtents.z * 0.45;

    this.#buoyancyPoints = [
      new Vector3(-ox, y, -oz),
      new Vector3(ox, y, -oz),
      new Vector3(-ox, y, oz),
      new Vector3(ox, y, oz),
      new Vector3(0, y, 0),
      new Vector3(-ix, y, -iz),
      new Vector3(ix, y, -iz),
      new Vector3(-ix, y, iz),
      new Vector3(ix, y, iz),
    ];
  }

  // ---------------------------
  // Tick
  // ---------------------------
  #tick(scene: Scene): void {
    let dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;
    dt = Math.min(Math.max(dt, this.#cfg.dtClamp.min), this.#cfg.dtClamp.max);

    this.#submergedPoints = 0;

    const cos = Math.cos(this.#currentYaw);
    const sin = Math.sin(this.#currentYaw);

    this.#linearVelocity.y += this.#cfg.gravity * dt;

    for (const lp of this.#buoyancyPoints) {
      const rx = lp.x * cos - lp.z * sin;
      const rz = lp.x * sin + lp.z * cos;

      this.#tmpWorldPoint.set(
        this.#boat.position.x + rx,
        this.#boat.position.y + lp.y,
        this.#boat.position.z + rz,
      );

      const sub = this.#getWaterSubmersionAtPoint(this.#tmpWorldPoint);
      if (sub > 0) {
        this.#applyForceAtPoint(
          0,
          sub * this.#cfg.baseBuoyancyForce,
          0,
          this.#tmpWorldPoint,
          dt,
        );
        this.#submergedPoints++;
      }
    }

    // Drag
    {
      const d =
        this.#submergedPoints > 0
          ? this.#cfg.damping.waterLinear
          : this.#cfg.damping.airLinear;
      const ad =
        this.#submergedPoints > 0
          ? this.#cfg.damping.waterAngular
          : this.#cfg.damping.airAngular;

      this.#linearVelocity.scaleInPlace(Math.pow(d, dt * 60));
      this.#angularVelocity.scaleInPlace(Math.pow(ad, dt * 60));
    }

    // Move
    this.#moveAxis(Axis.X, this.#linearVelocity.x * dt);
    this.#moveAxis(Axis.Y, this.#linearVelocity.y * dt);
    this.#moveAxis(Axis.Z, this.#linearVelocity.z * dt);

    // Rotate
    this.#integrateRotation(dt);

    // Sync visuals (if any)
    if (this.#customVisualRoot) {
      this.#customVisualRoot.position.copyFrom(this.#boat.position);
      this.#customVisualRoot.rotationQuaternion =
        Quaternion.RotationYawPitchRoll(
          this.#currentYaw + this.#customVisualLocalYaw,
          0,
          0,
        );
    }

    // Always update collider orientation
    this.#voxelCollider.setYaw(this.#currentYaw);

    // Debug
    this.#voxelCollider.syncDebugMesh(this.#boat.position);
  }

  // ---------------------------
  // Helpers
  // ---------------------------
  #applyForceAtPoint(
    fx: number,
    fy: number,
    fz: number,
    worldPoint: Vector3,
    dt: number,
  ) {
    const invMass = 1 / this.#cfg.mass;

    this.#linearVelocity.x += fx * invMass * dt;
    this.#linearVelocity.y += fy * invMass * dt;
    this.#linearVelocity.z += fz * invMass * dt;

    this.#tmpLever.copyFrom(worldPoint).subtractInPlace(this.#boat.position);

    this.#tmpTorque.set(
      this.#tmpLever.y * fz - this.#tmpLever.z * fy,
      this.#tmpLever.z * fx - this.#tmpLever.x * fz,
      this.#tmpLever.x * fy - this.#tmpLever.y * fx,
    );

    const ts =
      this.#cfg.torqueScale * this.#angularResponseScale * invMass * dt;
    this.#angularVelocity.addInPlace(this.#tmpTorque.scaleInPlace(ts));
  }

  #integrateRotation(dt: number) {
    this.#currentYaw += this.#angularVelocity.y * dt;
    this.#angularVelocity.y *= 0.985;

    this.#angularVelocity.x = 0;
    this.#angularVelocity.z = 0;

    if (this.#currentYaw > Math.PI || this.#currentYaw < -Math.PI) {
      this.#currentYaw =
        ((this.#currentYaw + Math.PI) % (2 * Math.PI)) - Math.PI;
    }
  }

  #moveAxis(axis: Axis, delta: number) {
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

    const id = ChunkLoadingSystem.getBlockByWorldCoords(x, y, z);
    if (id !== BlockType.Water) return 0;

    const above = ChunkLoadingSystem.getBlockByWorldCoords(x, y + 1, z);
    if (above === BlockType.Water) return 1;

    return Math.max(0, Math.min(1, y + 1 - worldPoint.y));
  }

  // ---------------------------
  // Public API
  // ---------------------------
  public applyImpulse(impulse: Vector3, point: Vector3) {
    this.#applyForceAtPoint(impulse.x, impulse.y, impulse.z, point, 1);
  }

  public applyAngularImpulse(impulse: Vector3) {
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
    const b = this.#boat.getBoundingInfo();
    return new Vector3(
      this.#boat.position.x,
      b.boundingBox.maximumWorld.y,
      this.#boat.position.z,
    );
  }

  public use(player: Player): void {
    this.#mount.mount(player);
  }

  // ---------------------------
  // Cleanup
  // ---------------------------
  public dispose(scene: Scene): void {
    if (this.#beforeRenderObs) {
      scene.onBeforeRenderObservable.remove(this.#beforeRenderObs);
      this.#beforeRenderObs = undefined;
    }

    if (!this.#boat.isDisposed()) {
      this.#boat.dispose(false, true);
    }
  }
}
