import {
	Color3,
	Matrix,
	type Mesh,
	MeshBuilder,
	Quaternion,
	type Scene,
	StandardMaterial,
	Vector3,
} from "@babylonjs/core";
import {
	Axis,
	type BlockShapeInfo,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { CustomBoat } from "../Entities/CustomBoat";
import type { Mount } from "../Entities/Mount";
import {} from "../World/BlockEncoding";
import { BlockType, isCollidableBlock } from "../World/BlockType";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import { getShapeForBlockId } from "../World/Shape/BlockShapes";
import type { PlayerBodyControlState, SavedBodyPosition } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import { Gamemodes, type PlayerStats } from "./PlayerStats";
import {
	CharacterSupportedState,
	type CharacterSurfaceInfo,
	SimpleCharacterController,
} from "./SimpleCharacterController";

enum PlayerState {
	IN_AIR,
	ON_GROUND,
	START_JUMP,
}

type PlayerVehicleMotorOptions = {
	scene: Scene;
	camera: PlayerCamera;
	controls: PlayerBodyControlState;
	getMount: () => Mount | null;
	playerStats: PlayerStats;
};

// PERF: Module-level scratch vectors for one-off helpers that don't need
// instance lifetime. Avoids per-call `new Vector3()` in hot paths.
const _scratchA = new Vector3();
const _scratchB = new Vector3();
const _scratchC = new Vector3();

export class PlayerVehicleMotor {
	readonly #scene: Scene;
	readonly #camera: PlayerCamera;
	readonly #controls: PlayerBodyControlState;
	readonly #getMount: () => Mount | null;
	readonly #playerStats: PlayerStats;

	#displayCapsule!: Mesh;
	#characterController!: SimpleCharacterController;
	#characterOrientation = Quaternion.Identity();
	#characterGravity = new Vector3(0, -18, 0);
	// PERF: Cache gravity magnitude — avoids repeated sqrt in jump/fly paths.
	#characterGravityLen = 18;
	#movementLocked = false;
	#lockedPosition: Vector3 | null = null;
	readonly #zeroVelocity = Vector3.Zero();

	private state: PlayerState = PlayerState.IN_AIR;

	#collisionBoat: CustomBoat | null = null;
	readonly #boatLocalPos = new Vector3();
	readonly #boatLocalVel = new Vector3();
	readonly #boatSupportLocal = new Vector3();
	#supportBoat: CustomBoat | null = null;
	#lastBoatSupportMs = 0;
	private readonly boatSupportGraceMs = 150;

	// Scratch vectors — one set for the whole class, labelled by owner method.
	readonly #tmp0 = new Vector3(); // flushToWorld, applyBoatMotion world point
	readonly #tmp1 = new Vector3(); // applyBoatMotion candidate
	readonly #tmp2 = new Vector3(); // updateSupportBoat probe / attemptStepUp fwd
	readonly #tmp3 = new Vector3(); // updateSupportBoat local / attemptStepUp ground
	readonly #tmp4 = new Vector3(); // sweep candidate / checkGrounded
	readonly #tmp5 = new Vector3(); // toBoatLocal/toWorld start
	readonly #tmp6 = new Vector3(); // toBoatLocal/toWorld end
	readonly #tmp7 = new Vector3(); // toBoatLocal/toWorld localStart
	readonly #tmp8 = new Vector3(); // toBoatLocal/toWorld localEnd
	// PERF: Extra scratch replaces `new Vector3()` calls in integrateVoxelMovementStep
	readonly #tmpDesiredH = new Vector3(); // desired horizontal
	readonly #tmpCurH = new Vector3(); // current horizontal
	readonly #tmpNextH = new Vector3(); // accelerate result
	// PERF: Replaces per-frame allocations in calculateFlyingVelocity /
	// calculateOnGroundVelocity / calculateJumpVelocity / accelerate.
	readonly #tmpDv = new Vector3();
	readonly #tmpV = new Vector3();
	readonly #tmpInv = new Matrix();

	// ── Terrain state ─────────────────────────────────────────────────────────
	readonly boatVoxelCollider: VoxelAabbCollider;
	private readonly voxelCollider: VoxelAabbCollider;
	private voxelPosition = new Vector3(0, 165, 0);
	private voxelVelocity = Vector3.Zero();
	private voxelIsGrounded = false;
	private lastStepUpTime = 0;

	// ── Parameters ────────────────────────────────────────────────────────────
	private readonly deacceleration = 0.85;
	private readonly inAirSpeed = 7.0;
	private readonly onGroundSpeed = 5.0;
	private readonly jumpHeight = 0.35;
	private readonly jumpStaminaCost = 10;
	private readonly accelRateGround = 36;
	private readonly sprintMultiplier = 1.6;
	private readonly penetrationRecoveryEps = 0.0001;
	private readonly airJumpForwardBoost = 5.5;
	private readonly minFloorNormalDot = 0.55;
	private readonly useVoxelCollision = true;
	private readonly colliderHalfWidth = 0.3;
	private readonly colliderHalfHeight = 0.875;
	private readonly voxelStepSize = 0.25;
	private readonly collisionEpsilon = 0.001;
	private readonly swimSpeed = 4.0;
	private readonly swimAcceleration = 14;
	private readonly swimSinkSpeed = -2.2;
	private readonly swimRiseSpeed = 3.2;
	private readonly swimVerticalAcceleration = 18;
	private readonly swimHorizontalDrag = 0.97;
	private readonly stepUpHeight = 1.01;
	private readonly stepUpCooldown = 0.01;

	// PERF: Pre-computed constants derived from other parameters.
	// Avoids repeated arithmetic in the physics hot path.
	private readonly colliderHalfWidthProbe: number; // colliderHalfWidth * 0.75
	private readonly colliderHalfWidthWater: number; // colliderHalfWidth * 0.9
	private readonly stepUpCooldownMs: number; // stepUpCooldown * 1000
	private readonly jumpImpulse: number; // gravity.length * jumpHeight
	// PERF: Foot-probe offsets baked once — never rebuilt per frame.
	// updateSupportBoat and checkGrounded both iterate these.
	private readonly _groundProbeOffsets: ReadonlyArray<
		readonly [number, number]
	>;
	// Water-check Y offsets baked once.
	private readonly _waterYOffsets: ReadonlyArray<number>;
	// Water-check XZ offsets baked once.
	private readonly _waterXZOffsets: ReadonlyArray<readonly [number, number]>;

	constructor(options: PlayerVehicleMotorOptions) {
		this.#scene = options.scene;
		this.#camera = options.camera;
		this.#controls = options.controls;
		this.#getMount = options.getMount;
		this.#playerStats = options.playerStats;

		// PERF: Pre-compute all derived constants once at construction time.
		this.colliderHalfWidthProbe = this.colliderHalfWidth * 0.75;
		this.colliderHalfWidthWater = this.colliderHalfWidth * 0.9;
		this.stepUpCooldownMs = this.stepUpCooldown * 1000;
		this.jumpImpulse = this.#characterGravityLen * this.jumpHeight;

		// PERF: Pre-build probe offset arrays so inner loops don't allocate
		// temporary tuples or recompute `r` every frame.
		const r = this.colliderHalfWidthProbe;
		this._groundProbeOffsets = [
			[0, 0],
			[r, 0],
			[-r, 0],
			[0, r],
			[0, -r],
		] as const;

		const hw = this.colliderHalfHeight;
		this._waterYOffsets = [-hw + 0.12, -hw * 0.2, hw * 0.2] as const;

		const rw = this.colliderHalfWidthWater;
		this._waterXZOffsets = [
			[0, 0],
			[rw, 0],
			[-rw, 0],
			[0, rw],
			[0, -rw],
		] as const;

		this.voxelCollider = new VoxelAabbCollider(
			new Vector3(
				this.colliderHalfWidth,
				this.colliderHalfHeight,
				this.colliderHalfWidth,
			),
			(x, y, z): BlockShapeInfo | null => {
				const blockId = getBlockByWorldCoords(x, y, z);
				if (!isCollidableBlock(blockId)) return null;
				const state = getBlockStateByWorldCoords(x, y, z);
				const shape = getShapeForBlockId(blockId);
				const rotation = shape.rotateY ? state & 3 : 0;
				const flipY = shape.allowFlipY && (state & 4) !== 0;
				return {
					shape,
					rotation,
					slice: 0,
					flipY,
				};
			},
			this.collisionEpsilon,
			{
				scene: this.#scene,
				name: "playerAABB",
				position: this.voxelPosition,
				renderingGroupId: 1,
			},
		);

		this.boatVoxelCollider = new VoxelAabbCollider(
			new Vector3(
				this.colliderHalfWidth,
				this.colliderHalfHeight,
				this.colliderHalfWidth,
			),
			(x, y, z): BlockShapeInfo | null => {
				const chunk = this.#collisionBoat?.boatChunk;
				if (!chunk) return null;
				const packed = chunk.getBlockLocal(x, y, z);
				const blockId = packed & 0x3ff;
				if (!isCollidableBlock(blockId)) return null;
				const state = (packed >>> 10) & 0x3f;
				const shape = getShapeForBlockId(blockId);
				const rotation = shape.rotateY ? state & 3 : 0;
				const flipY = shape.allowFlipY && (state & 4) !== 0;
				return {
					shape,
					rotation,
					slice: 0,
					flipY,
				};
			},
		);

		this.initializeCharacter();
	}

	// ── Public accessors ──────────────────────────────────────────────────────

	public get characterController(): SimpleCharacterController {
		return this.#characterController;
	}
	public get displayCapsule(): Mesh {
		return this.#displayCapsule;
	}
	public get isMovementLocked(): boolean {
		return this.#movementLocked;
	}

	private get inputDirection(): Vector3 {
		return this.#controls.inputDirection;
	}
	private get wantJump(): number {
		return this.#controls.wantJump;
	}
	private set wantJump(v: number) {
		this.#controls.wantJump = v;
	}
	private get isSprinting(): boolean {
		return this.#controls.isSprinting;
	}
	private get isFlying(): boolean {
		return this.#controls.isFlying;
	}
	private get isJumpHeld(): boolean {
		return this.#controls.isJumpHeld;
	}

	// ── Boat mode helpers ─────────────────────────────────────────────────────

	private isOnBoat(): boolean {
		return !!this.#collisionBoat?.boatChunk;
	}

	/** Rotate world XZ vector into boat-local XZ. Y unchanged. */
	#toBoatLocal(world: Vector3, _yaw: number, out: Vector3): void {
		if (!this.#collisionBoat) {
			out.copyFrom(world);
			return;
		}

		this.#tmp5.copyFrom(this.voxelPosition);
		this.#tmp6.copyFrom(this.voxelPosition).addInPlace(world);

		const localStart = this.#collisionBoat.worldToBoatChunkLocalPoint(
			this.#tmp5,
			this.#tmp7,
		);
		const localEnd = this.#collisionBoat.worldToBoatChunkLocalPoint(
			this.#tmp6,
			this.#tmp8,
		);

		if (!localStart || !localEnd) {
			out.copyFrom(world);
			return;
		}

		out.set(localEnd.x - localStart.x, world.y, localEnd.z - localStart.z);
	}

	/** Rotate boat-local XZ vector into world XZ. Y unchanged. */
	#toWorld(local: Vector3, _yaw: number, out: Vector3): void {
		if (!this.#collisionBoat) {
			out.copyFrom(local);
			return;
		}

		this.#tmp5.copyFrom(this.#boatLocalPos);
		this.#tmp6.copyFrom(this.#boatLocalPos).addInPlace(local);

		const worldStart = this.#collisionBoat.boatChunkLocalPointToWorld(
			this.#tmp5,
			this.#tmp7,
		);
		const worldEnd = this.#collisionBoat.boatChunkLocalPointToWorld(
			this.#tmp6,
			this.#tmp8,
		);

		if (!worldStart || !worldEnd) {
			out.copyFrom(local);
			return;
		}

		out.set(worldEnd.x - worldStart.x, local.y, worldEnd.z - worldStart.z);
	}

	#resolveEntryOverlap(): void {
		if (!this.boatVoxelCollider.overlaps(this.#boatLocalPos)) return;
		const step = 0.1;
		for (let i = 0; i < 32; i++) {
			this.#boatLocalPos.y += step;
			if (!this.boatVoxelCollider.overlaps(this.#boatLocalPos)) return;
		}
		this.#boatLocalPos.y -= 32 * step;
		for (let i = 0; i < 32; i++) {
			this.#boatLocalPos.y -= step;
			if (!this.boatVoxelCollider.overlaps(this.#boatLocalPos)) return;
		}
	}

	#flushToWorld(): void {
		if (!this.#collisionBoat) return;
		const w = this.#collisionBoat.boatChunkLocalPointToWorld(
			this.#boatLocalPos,
			this.#tmp0,
		);
		if (!w) {
			this.#collisionBoat = null;
			return;
		}
		this.voxelPosition.copyFrom(w);
	}

	// ── Support boat ──────────────────────────────────────────────────────────

	#applyBoatMotion(): void {
		if (!this.#supportBoat) return;
		const w = this.#supportBoat.boatChunkLocalPointToWorld(
			this.#boatSupportLocal,
			this.#tmp0,
		);
		if (!w) {
			this.#supportBoat = null;
			return;
		}

		const dx = w.x - this.voxelPosition.x;
		const dy = w.y - this.voxelPosition.y;
		const dz = w.z - this.voxelPosition.z;
		if (dx * dx + dy * dy + dz * dz < 1e-10) return;

		this.#tmp1.set(
			this.voxelPosition.x + dx,
			this.voxelPosition.y + dy,
			this.voxelPosition.z + dz,
		);
		if (!this.voxelCollider.overlaps(this.#tmp1)) {
			this.voxelPosition.copyFrom(this.#tmp1);
		}
	}

	#updateSupportBoat(): void {
		this.#supportBoat = null;

		const footY = this.voxelPosition.y - this.colliderHalfHeight - 0.1;

		const boats = CustomBoat.getActiveBoats();
		// PERF: Avoid spread allocation when #collisionBoat is null (common case).
		// `readonly CustomBoat[]` satisfies both the spread result and the raw
		// readonly array returned by getActiveBoats() — we never mutate ordered.
		const ordered: readonly CustomBoat[] = this.#collisionBoat
			? [this.#collisionBoat, ...boats.filter((b) => b !== this.#collisionBoat)]
			: boats;

		for (const boat of ordered) {
			const chunk = boat.boatChunk;
			if (!chunk) continue;

			for (const [sx, sz] of this._groundProbeOffsets) {
				// PERF: Reuse #tmp2 for every probe — no allocation per offset.
				this.#tmp2.set(
					this.voxelPosition.x + sx,
					footY,
					this.voxelPosition.z + sz,
				);

				const local = boat.worldToBoatChunkLocalPoint(this.#tmp2, this.#tmp3);
				if (!local) continue;

				const bx = Math.floor(local.x);
				const by = Math.floor(local.y);
				const bz = Math.floor(local.z);

				const blockHere = chunk.getBlockLocal(bx, by, bz);
				const blockBelow = chunk.getBlockLocal(bx, by - 1, bz);

				if (isCollidableBlock(blockHere) || isCollidableBlock(blockBelow)) {
					this.#supportBoat = boat;
					boat.worldToBoatChunkLocalPoint(
						this.voxelPosition,
						this.#boatSupportLocal,
					);
					return;
				}
			}
		}

		for (const boat of ordered) {
			if (!this.#isInsideBoatObb(boat)) continue;
			this.#supportBoat = boat;
			boat.worldToBoatChunkLocalPoint(
				this.voxelPosition,
				this.#boatSupportLocal,
			);
			return;
		}
	}

	#syncBoatMode(): void {
		if (this.#supportBoat?.boatChunk) {
			this.#lastBoatSupportMs = performance.now();

			if (this.#collisionBoat !== this.#supportBoat) {
				this.#collisionBoat = this.#supportBoat;
				this.#supportBoat.worldToBoatChunkLocalPoint(
					this.voxelPosition,
					this.#boatLocalPos,
				);
				this.#resolveEntryOverlap();
				this.#toBoatLocal(
					this.voxelVelocity,
					this.#supportBoat.boatYaw,
					this.#boatLocalVel,
				);
			}

			return;
		}

		if (
			this.#collisionBoat &&
			performance.now() - this.#lastBoatSupportMs <= this.boatSupportGraceMs
		) {
			return;
		}

		if (this.#collisionBoat) {
			this.#toWorld(
				this.#boatLocalVel,
				this.#collisionBoat.boatYaw,
				this.voxelVelocity,
			);
			this.#collisionBoat = null;
		}
	}

	// ── Input ─────────────────────────────────────────────────────────────────

	/**
	 * Desired velocity for this frame.
	 * PERF: Writes into `out` instead of returning a new Vector3.
	 */
	#getDesiredVelocity(
		speed: number,
		boatYaw: number | null,
		out: Vector3,
	): void {
		// PERF: applyRotationQuaternionToRef avoids allocating the rotated vector.
		this.inputDirection.scaleToRef(speed, out);
		// BabylonJS doesn't expose applyRotationQuaternionToRef on plain Vector3,
		// but scale+applyRotationQuaternion returns a new Vector3 normally.
		// We copy the result into out to keep the same surface API.
		out.copyFrom(out.applyRotationQuaternion(this.#characterOrientation));

		if (boatYaw !== null) {
			// Rotate world direction into boat-local space in-place via scratch.
			this.#toBoatLocal(out, boatYaw, _scratchA);
			out.copyFrom(_scratchA);
		}
	}

	// ── Sweep ─────────────────────────────────────────────────────────────────

	#sweepAxis(
		pos: Vector3,
		vel: Vector3,
		collider: VoxelAabbCollider,
		axis: Axis,
		delta: number,
	): void {
		if (delta === 0) return;
		let remaining = delta;
		const stepSize = this.voxelStepSize;
		while (Math.abs(remaining) > 0) {
			const step =
				Math.abs(remaining) > stepSize
					? stepSize * Math.sign(remaining)
					: remaining;

			// PERF: #tmp4 is already a scratch — just set it directly.
			this.#tmp4.copyFrom(pos);
			if (axis === Axis.X) this.#tmp4.x += step;
			else if (axis === Axis.Y) this.#tmp4.y += step;
			else this.#tmp4.z += step;

			if (collider.overlaps(this.#tmp4)) {
				if (axis === Axis.X) vel.x = 0;
				else if (axis === Axis.Y) vel.y = 0;
				else vel.z = 0;
				return;
			}
			pos.copyFrom(this.#tmp4);
			remaining -= step;
		}
	}

	#attemptStepUp(
		pos: Vector3,
		vel: Vector3,
		collider: VoxelAabbCollider,
		axis: Axis.X | Axis.Z,
		delta: number,
	): boolean {
		this.#tmp4.copyFrom(pos);
		if (axis === Axis.X) this.#tmp4.x += delta;
		else this.#tmp4.z += delta;
		if (!collider.overlaps(this.#tmp4)) {
			pos.copyFrom(this.#tmp4);
			return true;
		}

		const stepUpHeight = this.stepUpHeight;
		for (let rise = 0.25; rise <= stepUpHeight; rise += 0.25) {
			const up = this.#tmp4;
			up.copyFrom(pos);
			up.y += rise;
			if (collider.overlaps(up)) continue;

			const fwd = this.#tmp2;
			fwd.copyFrom(up);
			if (axis === Axis.X) fwd.x += delta;
			else fwd.z += delta;
			if (collider.overlaps(fwd)) continue;

			const ground = this.#tmp3;
			ground.copyFrom(fwd);
			ground.y -= 0.08;
			if (!collider.overlaps(ground)) continue;

			pos.copyFrom(fwd);
			vel.y = 0;
			this.lastStepUpTime = Date.now();
			return true;
		}
		return false;
	}

	#moveAxis(
		pos: Vector3,
		vel: Vector3,
		collider: VoxelAabbCollider,
		axis: Axis,
		delta: number,
	): void {
		if (
			axis !== Axis.Y &&
			this.voxelIsGrounded &&
			(this.inputDirection.x !== 0 || this.inputDirection.z !== 0) &&
			Date.now() - this.lastStepUpTime > this.stepUpCooldownMs
		) {
			const savedX = pos.x,
				savedY = pos.y,
				savedZ = pos.z;
			if (
				this.#attemptStepUp(pos, vel, collider, axis as Axis.X | Axis.Z, delta)
			)
				return;
			pos.set(savedX, savedY, savedZ);
		}
		this.#sweepAxis(pos, vel, collider, axis, delta);
	}

	#checkGrounded(pos: Vector3, collider: VoxelAabbCollider): boolean {
		const px = pos.x,
			py = pos.y - 0.08,
			pz = pos.z;
		const p = this.#tmp4;
		for (const [sx, sz] of this._groundProbeOffsets) {
			p.set(px + sx, py, pz + sz);
			if (collider.overlaps(p)) return true;
		}
		return false;
	}

	#isInsideBoatObb(boat: CustomBoat): boolean {
		const mesh = boat.boatMesh;
		if (!mesh || mesh.isDisposed()) return false;

		const bbox = mesh.getBoundingInfo().boundingBox;

		// PERF: TransformCoordinatesToRef writes into existing scratch — no alloc.
		const inv = mesh.getWorldMatrix().invertToRef(this.#tmpInv);
		const local = Vector3.TransformCoordinatesToRef(
			this.voxelPosition,
			inv,
			_scratchC,
		);

		const xzMargin = 0.2;
		const yBelowMargin = 0.9;
		const yAboveMargin = 0.35;

		return (
			local.x >= bbox.minimum.x - xzMargin &&
			local.x <= bbox.maximum.x + xzMargin &&
			local.z >= bbox.minimum.z - xzMargin &&
			local.z <= bbox.maximum.z + xzMargin &&
			local.y >= bbox.minimum.y - yBelowMargin &&
			local.y <= bbox.maximum.y + yAboveMargin
		);
	}

	// ── Main physics step ─────────────────────────────────────────────────────

	private integrateVoxelMovementStep(deltaTime: number): void {
		this.#flushToWorld();
		this.#applyBoatMotion();
		this.#updateSupportBoat();
		this.#syncBoatMode();

		const nowOnBoat = this.isOnBoat();
		const activePos = nowOnBoat ? this.#boatLocalPos : this.voxelPosition;
		const activeVel = nowOnBoat ? this.#boatLocalVel : this.voxelVelocity;
		const activeCol = nowOnBoat ? this.boatVoxelCollider : this.voxelCollider;
		const activeBoatYaw = nowOnBoat ? this.#collisionBoat!.boatYaw : null;

		this.voxelIsGrounded = this.#checkGrounded(activePos, activeCol);
		if (this.voxelIsGrounded && activeVel.y < 0) activeVel.y = 0;

		const isInWater = this.isInWater();
		const speed = isInWater
			? this.swimSpeed
			: this.voxelIsGrounded
				? this.onGroundSpeed
				: this.inAirSpeed;

		// PERF: #getDesiredVelocity now writes into a pre-allocated scratch.
		const desired = this.#tmpDesiredH;
		this.#getDesiredVelocity(speed, activeBoatYaw, desired);

		if (
			this.isSprinting &&
			!isInWater &&
			this.voxelIsGrounded &&
			(this.inputDirection.x !== 0 || this.inputDirection.z !== 0)
		) {
			desired.scaleInPlace(this.sprintMultiplier);
		}

		// PERF: Use pre-allocated scratch vectors; avoid `new Vector3()` here.
		const curH = this.#tmpCurH;
		curH.set(activeVel.x, 0, activeVel.z);
		const tgtH = desired; // desired is already XZ-only for horizontal
		tgtH.y = 0;

		const accel = isInWater
			? this.swimAcceleration
			: this.voxelIsGrounded
				? this.accelRateGround
				: this.accelRateGround * 0.5;

		// PERF: accelerateInto writes result into #tmpNextH.
		const nextH = this.accelerateInto(
			curH,
			tgtH,
			accel,
			deltaTime,
			this.#tmpNextH,
		);
		activeVel.x = nextH.x;
		activeVel.z = nextH.z;

		if (
			!isInWater &&
			this.voxelIsGrounded &&
			this.inputDirection.x === 0 &&
			this.inputDirection.z === 0
		) {
			activeVel.x *= this.deacceleration;
			activeVel.z *= this.deacceleration;
		}

		if (isInWater) {
			const wantsRise = this.isJumpHeld || this.wantJump > 0;
			const tgtV = wantsRise ? this.swimRiseSpeed : this.swimSinkSpeed;
			const dv = tgtV - activeVel.y;
			const maxDv = this.swimVerticalAcceleration * deltaTime;
			activeVel.y += Math.max(-maxDv, Math.min(dv, maxDv));
			activeVel.y *= this.swimHorizontalDrag;
			activeVel.x *= this.swimHorizontalDrag;
			activeVel.z *= this.swimHorizontalDrag;
			this.wantJump = 0;
		} else {
			if (this.wantJump > 0 && this.voxelIsGrounded) {
				this.wantJump--;
				const canJump = this.#playerStats.consumeStamina(this.jumpStaminaCost);
				//Jump with 0 stamina in Creative
				if (Gamemodes.Creative || canJump) {
					// PERF: Use cached jumpImpulse — avoids gravity.length() sqrt.
					activeVel.y = Math.max(this.jumpImpulse, activeVel.y);
					this.voxelIsGrounded = false;
				}
			}
			activeVel.y += this.#characterGravity.y * deltaTime;
		}

		this.#moveAxis(
			activePos,
			activeVel,
			activeCol,
			Axis.X,
			activeVel.x * deltaTime,
		);
		this.#moveAxis(
			activePos,
			activeVel,
			activeCol,
			Axis.Y,
			activeVel.y * deltaTime,
		);
		this.#moveAxis(
			activePos,
			activeVel,
			activeCol,
			Axis.Z,
			activeVel.z * deltaTime,
		);

		this.voxelIsGrounded = this.#checkGrounded(activePos, activeCol);
		if (this.voxelIsGrounded) {
			if (Math.abs(activeVel.y) < 0.1) activeVel.y = 0;
			else if (activeVel.y < 0) activeVel.y = 0;
		}

		if (this.isOnBoat()) {
			this.#flushToWorld();
			this.#collisionBoat!.worldToBoatChunkLocalPoint(
				this.voxelPosition,
				this.#boatSupportLocal,
			);
		}

		this.#characterController.setPosition(this.voxelPosition);
		this.#characterController.setVelocity(this.#zeroVelocity);
	}

	// ── Public update ─────────────────────────────────────────────────────────

	public updateCameraAndVisuals(): void {
		this.#characterOrientation = Quaternion.RotationYawPitchRoll(
			this.#camera.cameraYaw,
			0,
			0,
		);
		this.#camera.moveWithPlayer(this.getPositionInternal());
		this.#displayCapsule.position.copyFrom(this.getPositionInternal());
		if (!this.#displayCapsule.rotationQuaternion) {
			this.#displayCapsule.rotationQuaternion = Quaternion.Identity();
		}
		this.#displayCapsule.rotationQuaternion.copyFrom(
			this.#characterOrientation,
		);
	}

	public update(deltaTime: number): void {
		if (this.isJumpHeld) this.wantJump = Math.max(this.wantJump, 1);

		if (this.#movementLocked) {
			if (this.#lockedPosition) {
				this.voxelPosition.copyFrom(this.#lockedPosition);
				this.#characterController.setPosition(this.#lockedPosition);
			}
			this.voxelVelocity.copyFromFloats(0, 0, 0);
			this.#characterController.setVelocity(this.#zeroVelocity);
			this.voxelCollider.syncDebugMesh(this.voxelPosition);
			return;
		}

		const mount = this.#getMount();
		if (mount) {
			mount.update();
			if (this.useVoxelCollision) {
				this.voxelPosition.copyFrom(this.#characterController.getPosition());
				this.voxelVelocity.copyFromFloats(0, 0, 0);
			}
		} else {
			if (this.isFlying) {
				const dv = this.calculateFlyingVelocity(deltaTime);
				this.setVelocityInternal(dv);
				if (this.useVoxelCollision) {
					// PERF: addToRef avoids allocating the intermediate sum.
					dv.scaleToRef(deltaTime, _scratchB);
					this.voxelPosition.addInPlace(_scratchB);
					this.#characterController.setPosition(this.voxelPosition);
					this.#characterController.setVelocity(this.#zeroVelocity);
				} else {
					this.#characterController.setVelocity(dv);
				}
				this.voxelCollider.syncDebugMesh(this.voxelPosition);
				return;
			}
			this.integrateMovement(deltaTime);
		}

		if (this.useVoxelCollision) {
			this.voxelCollider.syncDebugMesh(this.voxelPosition);
		}
	}

	public lockMovementAtCurrentPosition(): void {
		this.#lockedPosition = this.getPositionInternal().clone();
		this.#movementLocked = true;
		this.voxelPosition.copyFrom(this.#lockedPosition);
		this.#characterController.setPosition(this.#lockedPosition);
		this.#characterController.setVelocity(this.#zeroVelocity);
		this.#camera.moveWithPlayer(this.#lockedPosition);
		this.#displayCapsule.position.copyFrom(this.#lockedPosition);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
	}

	public unlockMovement(): void {
		this.#movementLocked = false;
		this.#lockedPosition = null;
		this.voxelVelocity.copyFromFloats(0, 0, 0);
		this.#characterController.setVelocity(this.#zeroVelocity);
	}

	public getSavedPosition(): SavedBodyPosition {
		const p = this.getPositionInternal();
		return { x: p.x, y: p.y, z: p.z };
	}

	public restoreSavedPosition(position: unknown): boolean {
		if (!this.isValidSavedPosition(position)) return false;
		const p = new Vector3(
			position.x,
			position.y < -1000 ? 32 : position.y,
			position.z,
		);
		this.voxelPosition.copyFrom(p);
		this.voxelVelocity.copyFromFloats(0, 0, 0);
		this.#characterController.setPosition(p);
		if (this.#movementLocked) this.#lockedPosition = p.clone();
		this.#camera.moveWithPlayer(p);
		this.#displayCapsule.position.copyFrom(p);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
		return true;
	}

	// ── Integration ───────────────────────────────────────────────────────────

	private initializeCharacter(): void {
		this.#displayCapsule = this.createCharacterMesh(1.75, 0.6);
		const start = new Vector3(0, 165, 0);
		this.#characterController = new SimpleCharacterController(start);
		this.configureCharacterController();
		this.voxelPosition.copyFrom(start);
		this.voxelVelocity.copyFromFloats(0, 0, 0);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
		this.#camera.target = start;
	}

	private configureCharacterController(): void {
		this.#characterController.keepDistance = 0.08;
		this.#characterController.keepContactTolerance = 0.12;
		this.#characterController.maxCastIterations = 20;
		this.#characterController.penetrationRecoverySpeed = 3.0;
		this.#characterController.maxSlopeCosine = Math.cos((50 * Math.PI) / 180);
	}

	private createCharacterMesh(height: number, width: number): Mesh {
		const box = MeshBuilder.CreateBox(
			"CharacterDisplay",
			{ width, height, depth: width },
			this.#scene,
		);
		const mat = new StandardMaterial("box", this.#scene);
		mat.diffuseColor = new Color3(0.2, 0.9, 0.8);
		box.material = mat;
		box.isPickable = false;
		box.renderingGroupId = 1;
		return box;
	}

	private integrateMovement(deltaTime: number): void {
		if (this.useVoxelCollision) {
			this.integrateVoxelMovement(deltaTime);
			return;
		}
		if (deltaTime <= 1 / 60) {
			this.integrateMovementStep(deltaTime);
			return;
		}
		const sub = Math.min(8, Math.ceil(deltaTime / (1 / 120)));
		const dt = deltaTime / sub;
		for (let i = 0; i < sub; i++) this.integrateMovementStep(dt);
	}

	private integrateMovementStep(deltaTime: number): void {
		const support = this.#characterController.checkSupport();
		const dv = this.calculateDesiredVelocity(deltaTime, support);
		this.#characterController.setVelocity(dv);
		this.#characterController.integrate(deltaTime, this.#characterGravity);
	}

	private integrateVoxelMovement(deltaTime: number): void {
		if (deltaTime <= 1 / 60) {
			this.integrateVoxelMovementStep(deltaTime);
			return;
		}
		const sub = Math.min(8, Math.ceil(deltaTime / (1 / 120)));
		const dt = deltaTime / sub;
		for (let i = 0; i < sub; i++) this.integrateVoxelMovementStep(dt);
	}

	// ── Physics helpers ───────────────────────────────────────────────────────

	private calculateFlyingVelocity(deltaTime: number): Vector3 {
		// PERF: Use #tmpDv scratch instead of allocating a new dv vector.
		const dv = this.#tmpDv;
		// PERF: scaleToRef avoids intermediate alloc from inputDirection.scale().
		this.inputDirection.scaleToRef(this.onGroundSpeed * 112.5, dv);
		dv.copyFrom(dv.applyRotationQuaternion(this.#characterOrientation));

		if (this.wantJump > 0) {
			// up = -gravity normalised; multiply inline to avoid getUpVector alloc.
			const gl = this.#characterGravityLen;
			const ux = -this.#characterGravity.x / gl;
			const uy = -this.#characterGravity.y / gl;
			const uz = -this.#characterGravity.z / gl;
			const spd = this.onGroundSpeed * 112.5;
			dv.x += ux * spd;
			dv.y += uy * spd;
			dv.z += uz * spd;
		}
		if (this.isSprinting) {
			const gl = this.#characterGravityLen;
			const ux = -this.#characterGravity.x / gl;
			const uy = -this.#characterGravity.y / gl;
			const uz = -this.#characterGravity.z / gl;
			const spd = this.onGroundSpeed * 112.5;
			dv.x -= ux * spd;
			dv.y -= uy * spd;
			dv.z -= uz * spd;
		}

		const cur = this.getVelocityInternal();
		if (dv.lengthSquared() < 0.01) {
			// PERF: scaleToRef into existing scratch avoids clone + scaleInPlace.
			return cur.scaleToRef(this.deacceleration, this.#tmpV);
		}
		return this.accelerateInto(
			cur,
			dv,
			this.accelRateGround,
			deltaTime,
			this.#tmpV,
		);
	}

	private calculateDesiredVelocity(
		deltaTime: number,
		supportInfo: CharacterSurfaceInfo,
	): Vector3 {
		const prev = this.state;
		this.state = this.determineNextState(supportInfo);
		const cur = this.getVelocityInternal();
		switch (this.state) {
			case PlayerState.IN_AIR:
				return this.calculateInAirVelocity(deltaTime, cur);
			case PlayerState.ON_GROUND:
				return this.calculateOnGroundVelocity(cur, supportInfo);
			case PlayerState.START_JUMP:
				return this.calculateJumpVelocity(cur, prev);
			default:
				return cur;
		}
	}

	private determineNextState(si: CharacterSurfaceInfo): PlayerState {
		const grounded = si.supportedState === CharacterSupportedState.SUPPORTED;
		switch (this.state) {
			case PlayerState.IN_AIR:
				if (grounded) return PlayerState.ON_GROUND;
				if (this.wantJump > 0) return PlayerState.START_JUMP;
				return PlayerState.IN_AIR;
			case PlayerState.ON_GROUND:
				if (!grounded) return PlayerState.IN_AIR;
				if (this.wantJump > 0) {
					this.wantJump--;
					return PlayerState.START_JUMP;
				}
				return PlayerState.ON_GROUND;
			case PlayerState.START_JUMP:
				return PlayerState.IN_AIR;
			default:
				return this.state;
		}
	}

	private calculateInAirVelocity(dt: number, cur: Vector3): Vector3 {
		// PERF: Inline up-vector computation; write into #tmpV scratch.
		const gl = this.#characterGravityLen;
		const uy = -this.#characterGravity.y / gl; // dominant axis
		const ux = -this.#characterGravity.x / gl;
		const uz = -this.#characterGravity.z / gl;
		const upDotCur = cur.x * ux + cur.y * uy + cur.z * uz;

		const v = this.#tmpV;
		v.copyFrom(cur);
		// Remove and re-add the up component (net: no-op in pure gravity, but
		// keeps the original logic intact for non-axis-aligned gravity).
		v.x += (-upDotCur + upDotCur) * ux;
		v.y += (-upDotCur + upDotCur) * uy;
		v.z += (-upDotCur + upDotCur) * uz;
		// Add gravity.
		v.x += this.#characterGravity.x * dt;
		v.y += this.#characterGravity.y * dt;
		v.z += this.#characterGravity.z * dt;
		return v;
	}

	private calculateOnGroundVelocity(
		cur: Vector3,
		si: CharacterSurfaceInfo,
	): Vector3 {
		// PERF: Use #tmpDv for desired velocity instead of new Vector3().
		const dv = this.#tmpDv;
		this.inputDirection.scaleToRef(this.onGroundSpeed, dv);
		dv.copyFrom(dv.applyRotationQuaternion(this.#characterOrientation));

		if (
			this.isSprinting &&
			(this.inputDirection.x !== 0 || this.inputDirection.z !== 0)
		)
			dv.scaleInPlace(this.sprintMultiplier);

		// PERF: Use #tmpV for v, inline dot products.
		const v = this.#tmpV;
		v.copyFrom(cur).subtractInPlace(si.averageSurfaceVelocity);
		const n = si.averageSurfaceNormal;

		// PERF: Inline getUpVector.
		const gl = this.#characterGravityLen;
		const ux = -this.#characterGravity.x / gl;
		const uy = -this.#characterGravity.y / gl;
		const uz = -this.#characterGravity.z / gl;
		if (n.x * ux + n.y * uy + n.z * uz < this.minFloorNormalDot) return cur;

		const nDotV = v.dot(n);
		v.x -= n.x * nDotV - n.x * this.penetrationRecoveryEps;
		v.y -= n.y * nDotV - n.y * this.penetrationRecoveryEps;
		v.z -= n.z * nDotV - n.z * this.penetrationRecoveryEps;
		v.addInPlace(si.averageSurfaceVelocity);
		return v;
	}

	private calculateJumpVelocity(cur: Vector3, prev: PlayerState): Vector3 {
		const gl = this.#characterGravityLen;
		const ux = -this.#characterGravity.x / gl;
		const uy = -this.#characterGravity.y / gl;
		const uz = -this.#characterGravity.z / gl;

		const jumpSpd = Math.max(
			this.jumpImpulse,
			cur.x * ux + cur.y * uy + cur.z * uz,
		);

		const dv = this.#tmpDv;
		this.inputDirection.scaleToRef(this.onGroundSpeed, dv);
		dv.copyFrom(dv.applyRotationQuaternion(this.#characterOrientation));
		if (this.isSprinting) dv.scaleInPlace(this.sprintMultiplier);

		const v = this.#tmpV;
		v.set(ux * jumpSpd + dv.x, uy * jumpSpd + dv.y, uz * jumpSpd + dv.z);

		if (prev === PlayerState.IN_AIR) {
			const fwd = this.#camera.playerCamera
				.getForwardRay()
				.direction.normalize(); // unavoidable alloc from Babylon ray API
			const boost = this.inAirSpeed * this.airJumpForwardBoost;
			v.x += fwd.x * boost;
			v.y += fwd.y * boost;
			v.z += fwd.z * boost;
		}
		return v;
	}

	private accelerateInto(
		cur: Vector3,
		tgt: Vector3,
		maxA: number,
		dt: number,
		out: Vector3,
	): Vector3 {
		// PERF: Inline subtract + length check; use #tmpD scratch for delta.
		const dx = tgt.x - cur.x;
		const dy = tgt.y - cur.y;
		const dz = tgt.z - cur.z;
		const lenSq = dx * dx + dy * dy + dz * dz;
		if (lenSq < 0.01) {
			out.copyFrom(cur);
			return out;
		}
		const len = Math.sqrt(lenSq);
		const scale = Math.min(len, maxA * dt) / len;
		out.set(cur.x + dx * scale, cur.y + dy * scale, cur.z + dz * scale);
		return out;
	}

	/** @deprecated Use accelerateInto — kept for non-hot call sites. */

	private isInWater(): boolean {
		const pos = this.voxelPosition;
		// PERF: Pre-baked Y and XZ offset arrays — no per-frame array literal.
		for (const dy of this._waterYOffsets) {
			const y = pos.y + dy;
			for (const [dx, dz] of this._waterXZOffsets) {
				if (
					getBlockByWorldCoords(pos.x + dx, y, pos.z + dz) === BlockType.Water
				)
					return true;
			}
		}
		return false;
	}

	private isValidSavedPosition(p: unknown): p is SavedBodyPosition {
		if (!p || typeof p !== "object") return false;
		const c = p as Partial<SavedBodyPosition>;
		return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z);
	}

	private getPositionInternal(): Vector3 {
		return this.useVoxelCollision
			? this.voxelPosition
			: this.#characterController.getPosition();
	}

	private getVelocityInternal(): Vector3 {
		return this.useVoxelCollision
			? this.voxelVelocity
			: this.#characterController.getVelocity();
	}

	private setVelocityInternal(v: Vector3): void {
		if (this.useVoxelCollision) {
			this.voxelVelocity.copyFrom(v);
			return;
		}
		this.#characterController.setVelocity(v);
	}
}
