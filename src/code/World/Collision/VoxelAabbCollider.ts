import {
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";

type Axis = "x" | "y" | "z";
type IsSolidBlockAt = (x: number, y: number, z: number) => boolean;
type VoxelAabbDebugOptions = {
  scene: Scene;
  name?: string;
  position?: Vector3;
  renderingGroupId?: number;
};

export class VoxelAabbCollider {
  #halfExtents: Vector3;
  #epsilon: number;
  #isSolidBlockAt: IsSolidBlockAt;
  #debugMesh: Mesh | null = null;
  static #debugEnabled = false;
  static readonly #debugColliders = new Set<VoxelAabbCollider>();

  constructor(
    halfExtents: Vector3,
    isSolidBlockAt: IsSolidBlockAt,
    epsilon = 0.001,
    debugOptions?: VoxelAabbDebugOptions,
  ) {
    this.#halfExtents = halfExtents.clone();
    this.#isSolidBlockAt = isSolidBlockAt;
    this.#epsilon = epsilon;
    if (debugOptions) {
      this.#createDebugMesh(debugOptions);
      VoxelAabbCollider.#debugColliders.add(this);
    }
  }

  #createDebugMesh(options: VoxelAabbDebugOptions): void {
    const name = options.name ?? "voxelAabbDebug";
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
    this.#debugMesh.material = material;
    this.#debugMesh.isVisible = true;
    this.#debugMesh.showBoundingBox = VoxelAabbCollider.#debugEnabled;
    if (options.position) {
      this.#debugMesh.position.copyFrom(options.position);
    }
  }

  public overlaps(position: Vector3): boolean {
    const minX = position.x - this.#halfExtents.x;
    const maxX = position.x + this.#halfExtents.x;
    const minY = position.y - this.#halfExtents.y;
    const maxY = position.y + this.#halfExtents.y;
    const minZ = position.z - this.#halfExtents.z;
    const maxZ = position.z + this.#halfExtents.z;

    const x0 = Math.floor(minX + this.#epsilon);
    const x1 = Math.floor(maxX - this.#epsilon);
    const y0 = Math.floor(minY + this.#epsilon);
    const y1 = Math.floor(maxY - this.#epsilon);
    const z0 = Math.floor(minZ + this.#epsilon);
    const z1 = Math.floor(maxZ - this.#epsilon);

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (this.#isSolidBlockAt(x, y, z)) {
            return true;
          }
        }
      }
    }

    return false;
  }

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

      const candidate = position.clone();
      if (axis === "x") candidate.x += step;
      else if (axis === "y") candidate.y += step;
      else candidate.z += step;

      if (this.overlaps(candidate)) {
        if (axis === "x") velocity.x = 0;
        else if (axis === "y") velocity.y = 0;
        else velocity.z = 0;
        break;
      }

      position.copyFrom(candidate);
      this.syncDebugMesh(position);
      remaining -= step;
    }
  }

  public syncDebugMesh(position: Vector3): void {
    if (!this.#debugMesh || this.#debugMesh.isDisposed()) return;
    this.#debugMesh.position.copyFrom(position);
  }

  public dispose(): void {
    VoxelAabbCollider.#debugColliders.delete(this);
    if (this.#debugMesh && !this.#debugMesh.isDisposed()) {
      this.#debugMesh.dispose();
    }
    this.#debugMesh = null;
  }

  public static toggleDebugEnabled(): void {
    VoxelAabbCollider.setDebugEnabled(!VoxelAabbCollider.#debugEnabled);
  }

  public static setDebugEnabled(enabled: boolean): void {
    VoxelAabbCollider.#debugEnabled = enabled;
    VoxelAabbCollider.#debugColliders.forEach((collider) => {
      if (collider.#debugMesh && !collider.#debugMesh.isDisposed()) {
        collider.#debugMesh.showBoundingBox = enabled;
      }
    });
  }
}
