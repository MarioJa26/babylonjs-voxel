import { type SceneContext, type Vec3, vec3 } from "@babylonjs/lite";
import type { Mount } from "../Entities/Mount";
import { getFinalTerrainHeight } from "../Generation/TerrainHeightMap";
import { vec3Zero } from "../Lib/Math";
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
	return info?.isCube ? SOLID_CUBE : null;
};

const PLAYER_HALF_EXTENTS = {
	x: 0.3,
	y: 0.9,
	z: 0.3,
	clone() {
		return { x: this.x, y: this.y, z: this.z };
	},
};

type MutableVec3 = Vec3 & {
	copyFrom(v: Vec3): void;
};

export class PlayerVehicle {
	public scene: SceneContext;
	public camera: PlayerCamera;
	public isMounted = false;
	public mount: Mount | null = null;

	private readonly controlState = new PlayerBodyControlState();

	#position: MutableVec3;
	#collider = new VoxelAabbCollider(PLAYER_HALF_EXTENTS, isSolidBlockAt, 0.001);
	#velocity: Vec3 = vec3Zero();

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
			copyFrom(v: Vec3): void {
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

		const p = this.#position;
		this.#savedPosition = {
			x: p.x,
			y: p.y,
			z: p.z,
		};
	}

	public unlockMovement(): void {
		this.#movementLocked = false;
	}

	public getSavedPosition(): Vec3 {
		const saved = this.#savedPosition;
		return saved ? vec3(saved.x, saved.y, saved.z) : vec3(0, 80, 0);
	}

	public restoreSavedPosition(position: unknown): boolean {
		if (position === null || typeof position !== "object") return false;

		const p = position as { x?: unknown; y?: unknown; z?: unknown };

		if (
			typeof p.x !== "number" ||
			typeof p.y !== "number" ||
			typeof p.z !== "number" ||
			!Number.isFinite(p.x) ||
			!Number.isFinite(p.y) ||
			!Number.isFinite(p.z)
		) {
			return false;
		}

		const pos = this.#position;
		pos.x = p.x;
		pos.y = p.y;
		pos.z = p.z;

		return true;
	}

	public setMount(mount: Mount | null): void {
		this.mount = mount;
	}

	public respawn(): void {
		const pos = this.#position;
		const velocity = this.#velocity;

		pos.y = getFinalTerrainHeight(pos.x, pos.z) + 2;

		velocity.x = 0;
		velocity.y = 0;
		velocity.z = 0;

		this.#grounded = false;
	}

	public update(deltaTime: number): void {
		const dt = deltaTime * 0.001;
		const pos = this.#position;

		if (this.#movementLocked) {
			this.camera.moveWithPlayer(pos, dt);
			return;
		}

		const input = this.controlState.inputDirection;
		const inX = input.x;
		const inZ = input.z;

		let dx = 0;
		let dz = 0;

		if (inX !== 0 || inZ !== 0) {
			const yaw = this.camera.cameraYaw;
			const sinYaw = Math.sin(yaw);
			const cosYaw = Math.cos(yaw);

			dx = inX * cosYaw + inZ * sinYaw;
			dz = inZ * cosYaw - inX * sinYaw;

			const lenSq = dx * dx + dz * dz;
			if (lenSq > 0) {
				const invLen = 1 / Math.sqrt(lenSq);
				dx *= invLen;
				dz *= invLen;
			}
		}

		let speed = this.#speed;

		if (this.controlState.isSprinting) {
			speed *= 1.6;
		}

		if (this.controlState.isSneaking) {
			speed *= 0.4;
		}

		const velocity = this.#velocity;
		velocity.x = dx * speed;
		velocity.z = dz * speed;

		if (this.controlState.isFlying) {
			velocity.y = input.y ? input.y * speed : 0;
		} else {
			velocity.y -= 30 * dt;

			if (this.#grounded && this.controlState.isJumpHeld) {
				velocity.y = 9;
				this.#grounded = false;
			}
		}

		this.#collider.moveAxis(pos, velocity, Axis.X, velocity.x * dt, 0.1);
		this.#collider.moveAxis(pos, velocity, Axis.Z, velocity.z * dt, 0.1);
		this.#collider.moveAxis(pos, velocity, Axis.Y, velocity.y * dt, 0.1);

		this.#grounded = velocity.y === 0;

		this.camera.moveWithPlayer(pos, dt);
	}

	public updateCameraAndVisuals(deltaMs?: number): void {
		this.camera.moveWithPlayer(
			this.#position,
			deltaMs === undefined ? undefined : deltaMs * 0.001,
		);
	}
}
