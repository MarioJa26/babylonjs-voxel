import { type SceneContext, type Vec3, vec3 } from "@babylonjs/lite";
import type { Mount } from "../Entities/Mount";
import { getFinalTerrainHeight } from "../Generation/TerrainHeightMap";
import { getBlockByWorldCoords } from "../World/Chunk/ChunkLoadingSystem";
import {
	Axis,
	type BlockShapeInfo,
	VoxelAabbCollider,
} from "../World/Collision/VoxelAabbCollider";
import { getShapeInfo } from "../World/MeshPipeline/core/BlockInfoCache";
import { FALLBACK_CUBE } from "../World/Shape/BlockShapes";
import { PlayerBodyControlState } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";

// Phase B (Lite) movement owner. Replaces the old core PlayerVehicle: it is
// driven by the `inputDirection` / jump / sprint / sneak / fly flags that
// WalkingControls writes, and resolves motion with the voxel AABB collider
// (the same full-cube probe used by the Phase A milestone). No Babylon mesh.

const SOLID_CUBE: BlockShapeInfo = {
	shape: FALLBACK_CUBE,
	rotation: 0,
	slice: 0,
	flipY: false,
};

const isSolidBlockAt = (
	x: number,
	y: number,
	z: number,
): BlockShapeInfo | null => {
	const packed = getBlockByWorldCoords(x, y, z);
	if (!packed) return null;
	const info = getShapeInfo(packed);
	if (!info?.isCube) return null;
	return SOLID_CUBE;
};

const PLAYER_HALF_EXTENTS = {
	x: 0.3,
	y: 0.9,
	z: 0.3,
	clone() {
		return { x: this.x, y: this.y, z: this.z };
	},
};

export class PlayerVehicle {
	public scene: SceneContext;
	public camera: PlayerCamera;
	public isMounted = false;
	public mount: Mount | null = null;

	private readonly controlState = new PlayerBodyControlState();
	#position: Vec3 & { copyFrom(v: Vec3): void };
	#collider = new VoxelAabbCollider(PLAYER_HALF_EXTENTS, isSolidBlockAt, 0.001);
	#velocity: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
	#grounded = false;
	#speed = 8;
	#movementLocked = false;
	#savedPosition: Vec3 | null = null;

	constructor(scene: SceneContext, camera: PlayerCamera) {
		this.scene = scene;
		this.camera = camera;
		const y = getFinalTerrainHeight(0, 0) + 2;
		this.#position = {
			x: 0,
			y,
			z: 0,
			copyFrom(v: Vec3) {
				this.x = v.x;
				this.y = v.y;
				this.z = v.z;
			},
		};
	}

	public get position(): Vec3 {
		return this.#position;
	}

	public get inputDirection(): Vec3 {
		return this.controlState.inputDirection;
	}

	public get wantJump(): number {
		return this.controlState.wantJump;
	}
	public set wantJump(value: number) {
		this.controlState.wantJump = value;
	}

	public get isSprinting(): boolean {
		return this.controlState.isSprinting;
	}
	public set isSprinting(value: boolean) {
		this.controlState.isSprinting = value;
	}

	public get isFlying(): boolean {
		return this.controlState.isFlying;
	}
	public set isFlying(value: boolean) {
		this.controlState.isFlying = value;
	}

	public get isJumpHeld(): boolean {
		return this.controlState.isJumpHeld;
	}
	public set isJumpHeld(value: boolean) {
		this.controlState.isJumpHeld = value;
	}

	public get isSneaking(): boolean {
		return this.controlState.isSneaking;
	}
	public set isSneaking(value: boolean) {
		this.controlState.isSneaking = value;
	}

	public get isClimbing(): boolean {
		return false;
	}

	public get isMovementLocked(): boolean {
		return this.#movementLocked;
	}

	public clearControlState(): void {
		this.controlState.reset();
	}

	public toggleFlying(): void {
		this.controlState.isFlying = !this.controlState.isFlying;
	}

	public lockMovementAtCurrentPosition(): void {
		this.#movementLocked = true;
		this.#savedPosition = {
			x: this.#position.x,
			y: this.#position.y,
			z: this.#position.z,
		};
	}

	public unlockMovement(): void {
		this.#movementLocked = false;
	}

	public getSavedPosition(): Vec3 {
		return this.#savedPosition
			? vec3(
					this.#savedPosition.x,
					this.#savedPosition.y,
					this.#savedPosition.z,
				)
			: vec3(0, 80, 0);
	}

	public restoreSavedPosition(position: unknown): boolean {
		if (!position || typeof position !== "object") return false;
		const p = position as { x: number; y: number; z: number };
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z))
			return false;
		this.#position.x = p.x;
		this.#position.y = p.y;
		this.#position.z = p.z;
		return true;
	}

	public setMount(mount: Mount | null): void {
		this.mount = mount;
	}

	public respawn(): void {
		this.#position.y =
			getFinalTerrainHeight(this.#position.x, this.#position.z) + 2;
		this.#velocity.x = 0;
		this.#velocity.y = 0;
		this.#velocity.z = 0;
		this.#grounded = false;
	}

	public update(deltaTime: number): void {
		if (this.#movementLocked) {
			this.camera.moveWithPlayer(this.#position, deltaTime / 1000);
			return;
		}

		const dt = deltaTime / 1000;
		const yaw = this.camera.cameraYaw;
		const fx = Math.sin(yaw);
		const fz = Math.cos(yaw);

		// WalkingControls writes inputDirection: .z = forward(+)/back(-),
		// .x = right(+)/left(-). Transform to world space using camera yaw.
		const inX = this.controlState.inputDirection.x;
		const inZ = this.controlState.inputDirection.z;
		let dx = inX * fz + inZ * fx;
		let dz = -inX * fx + inZ * fz;
		const len = Math.hypot(dx, dz);
		if (len > 0) {
			dx /= len;
			dz /= len;
		}

		const speed =
			(this.controlState.isSprinting ? this.#speed * 1.6 : this.#speed) *
			(this.controlState.isSneaking ? 0.4 : 1);

		this.#velocity.x = dx * speed;
		this.#velocity.z = dz * speed;

		if (this.controlState.isFlying) {
			this.#velocity.y = (this.controlState.inputDirection.y || 0) * speed;
		} else {
			this.#velocity.y -= 30 * dt;
			if (this.#grounded && this.controlState.isJumpHeld) {
				this.#velocity.y = 9;
				this.#grounded = false;
			}
		}

		this.#collider.moveAxis(
			this.#position as Vec3,
			this.#velocity as Vec3,
			Axis.X,
			this.#velocity.x * dt,
			0.1,
		);
		this.#collider.moveAxis(
			this.#position as Vec3,
			this.#velocity as Vec3,
			Axis.Z,
			this.#velocity.z * dt,
			0.1,
		);
		this.#collider.moveAxis(
			this.#position as Vec3,
			this.#velocity as Vec3,
			Axis.Y,
			this.#velocity.y * dt,
			0.1,
		);

		this.#grounded = this.#velocity.y === 0;

		this.camera.moveWithPlayer(this.#position, dt);
	}

	public updateCameraAndVisuals(deltaMs?: number): void {
		this.camera.moveWithPlayer(
			this.#position,
			deltaMs !== undefined ? deltaMs / 1000 : undefined,
		);
	}
}
