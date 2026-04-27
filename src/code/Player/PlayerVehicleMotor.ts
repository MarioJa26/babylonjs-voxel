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
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { CustomBoat } from "../Entities/CustomBoat";
import type { Mount } from "../Entities/Mount";
import { BlockType, isCollidableBlock } from "../World/BlockType";
import { ChunkLoadingSystem } from "../World/Chunk/ChunkLoadingSystem";
import type { PlayerBodyControlState, SavedBodyPosition } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
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
};

export class PlayerVehicleMotor {
	readonly #scene: Scene;
	readonly #camera: PlayerCamera;
	readonly #controls: PlayerBodyControlState;
	readonly #getMount: () => Mount | null;

	#displayCapsule!: Mesh;
	#characterController!: SimpleCharacterController;
	#characterOrientation = Quaternion.Identity();
	#characterGravity = new Vector3(0, -18, 0);
	#movementLocked = false;
	#lockedPosition: Vector3 | null = null;
	readonly #zeroVelocity = Vector3.Zero();

	private state: PlayerState = PlayerState.IN_AIR;

	// ── Boat walking state ────────────────────────────────────────────────────
	//
	// When #collisionBoat is set, ALL physics runs in boat-local integer space:
	//
	//   #boatLocalPos  — player center in boat-local coords (authoritative)
	//   #boatLocalVel  — velocity in boat-local coords (authoritative)
	//
	// World space (voxelPosition / voxelVelocity) is only used for:
	//   - The single world→local conversion on boat entry
	//   - The single local→world flush at end-of-step (for rendering)
	//   - The water check (reads world blocks)
	//   - applySupportBoatMotion (tracks how the boat moved since last frame)
	//
	// There are ZERO mid-step world↔local conversions. Boat collision is
	// identical to terrain collision — plain AABB sweep on an integer grid.
	//
	#collisionBoat: CustomBoat | null = null;
	readonly #boatLocalPos = new Vector3(); // boat-local position
	readonly #boatLocalVel = new Vector3(); // boat-local velocity

	// Boat-local player center saved at END of each frame.
	// applySupportBoatMotion uses it to detect how the boat moved this frame.
	readonly #boatSupportLocal = new Vector3();
	#supportBoat: CustomBoat | null = null;
	#lastBoatSupportMs = 0;
	private readonly boatSupportGraceMs = 150;

	// Scratch vectors. Labels indicate which methods own them.
	readonly #tmp0 = new Vector3(); // flushToWorld, applyBoatMotion world point
	readonly #tmp1 = new Vector3(); // applyBoatMotion candidate
	readonly #tmp2 = new Vector3(); // updateSupportBoat probe
	readonly #tmp3 = new Vector3(); // updateSupportBoat local result
	readonly #tmp4 = new Vector3(); // sweep candidate
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
	// Slightly larger to absorb the float noise from the one world→local
	// matrix inversion that happens on boat entry.
	private readonly boatCollisionEpsilon = 0.003;
	private readonly swimSpeed = 4.0;
	private readonly swimAcceleration = 14;
	private readonly swimSinkSpeed = -2.2;
	private readonly swimRiseSpeed = 3.2;
	private readonly swimVerticalAcceleration = 18;
	private readonly swimHorizontalDrag = 0.97;
	private readonly stepUpHeight = 1.01;
	private readonly stepUpCooldown = 0.1;

	private readonly debugBoatMode = false;
	private readonly debugBoatProbeEnabled = false;
	#lastDebugBoatState = "";

	private debugBoatState(tag: string): void {
		if (!this.debugBoatMode) return;

		const state = {
			tag,
			onBoat: this.isOnBoat(),
			collisionBoat: this.#collisionBoat
				? (this.#collisionBoat.boatMesh?.name ?? "boat")
				: null,
			supportBoat: this.#supportBoat
				? (this.#supportBoat.boatMesh?.name ?? "boat")
				: null,
			worldPos: {
				x: this.voxelPosition.x.toFixed(3),
				y: this.voxelPosition.y.toFixed(3),
				z: this.voxelPosition.z.toFixed(3),
			},
			worldVel: {
				x: this.voxelVelocity.x.toFixed(3),
				y: this.voxelVelocity.y.toFixed(3),
				z: this.voxelVelocity.z.toFixed(3),
			},
			boatLocalPos: {
				x: this.#boatLocalPos.x.toFixed(3),
				y: this.#boatLocalPos.y.toFixed(3),
				z: this.#boatLocalPos.z.toFixed(3),
			},
			boatLocalVel: {
				x: this.#boatLocalVel.x.toFixed(3),
				y: this.#boatLocalVel.y.toFixed(3),
				z: this.#boatLocalVel.z.toFixed(3),
			},
			grounded: this.voxelIsGrounded,
		};

		const serialized = JSON.stringify(state);
		if (serialized === this.#lastDebugBoatState) return;

		this.#lastDebugBoatState = serialized;
		console.log("[BoatState]", state);
	}

	private debugBoatProbe(
		boat: CustomBoat,
		worldProbe: Vector3,
		localProbe: Vector3,
		blockHereId: number,
		blockBelowId: number,
	): void {
		if (!this.debugBoatProbeEnabled) return;

		console.log("[BoatProbe]", {
			boat: boat.boatMesh?.name ?? "boat",
			worldProbe: {
				x: worldProbe.x.toFixed(3),
				y: worldProbe.y.toFixed(3),
				z: worldProbe.z.toFixed(3),
			},
			localProbe: {
				x: localProbe.x.toFixed(3),
				y: localProbe.y.toFixed(3),
				z: localProbe.z.toFixed(3),
			},
			cellHere: {
				x: Math.floor(localProbe.x),
				y: Math.floor(localProbe.y),
				z: Math.floor(localProbe.z),
			},
			cellBelow: {
				x: Math.floor(localProbe.x),
				y: Math.floor(localProbe.y) - 1,
				z: Math.floor(localProbe.z),
			},
			blockHereId,
			blockBelowId,
			blockHereSolid: isCollidableBlock(blockHereId),
			blockBelowSolid: isCollidableBlock(blockBelowId),
		});
	}

	constructor(options: PlayerVehicleMotorOptions) {
		this.#scene = options.scene;
		this.#camera = options.camera;
		this.#controls = options.controls;
		this.#getMount = options.getMount;

		this.voxelCollider = new VoxelAabbCollider(
			new Vector3(
				this.colliderHalfWidth,
				this.colliderHalfHeight,
				this.colliderHalfWidth,
			),
			(x, y, z) =>
				isCollidableBlock(ChunkLoadingSystem.getBlockByWorldCoords(x, y, z)),
			this.collisionEpsilon,
			{
				scene: this.#scene,
				name: "playerAABB",
				position: this.voxelPosition,
				renderingGroupId: 1,
			},
		);

		// Receives #boatLocalPos directly — integer block coords, no rotation.
		this.boatVoxelCollider = new VoxelAabbCollider(
			new Vector3(
				this.colliderHalfWidth,
				this.colliderHalfHeight,
				this.colliderHalfWidth,
			),
			(x, y, z) => {
				const chunk = this.#collisionBoat?.boatChunk;
				return chunk ? isCollidableBlock(chunk.getBlockLocal(x, y, z)) : false;
			},
			this.boatCollisionEpsilon,
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

	readonly #tmp5 = new Vector3();
	readonly #tmp6 = new Vector3();
	readonly #tmp7 = new Vector3();
	readonly #tmp8 = new Vector3();

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
	/**
	 * Nudge #boatLocalPos upward until it is clear of blocks.
	 * Resolves float noise from the one-time world→local inversion on entry.
	 */
	#resolveEntryOverlap(): void {
		if (!this.boatVoxelCollider.overlaps(this.#boatLocalPos)) return;
		const step = 0.1;
		for (let i = 0; i < 32; i++) {
			this.#boatLocalPos.y += step;
			if (!this.boatVoxelCollider.overlaps(this.#boatLocalPos)) return;
		}
		// Scan downward as fallback.
		this.#boatLocalPos.y -= 32 * step;
		for (let i = 0; i < 32; i++) {
			this.#boatLocalPos.y -= step;
			if (!this.boatVoxelCollider.overlaps(this.#boatLocalPos)) return;
		}
		// Give up — first sweep step will resolve it.
	}

	/** Write #boatLocalPos → voxelPosition. Called once at end of each step. */
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

	// ── Support boat (carry player with moving / rotating boat) ───────────────

	/**
	 * Apply motion the boat has done since last frame.
	 * Uses #boatSupportLocal saved at the END of the previous frame.
	 * Must be called BEFORE #updateSupportBoat overwrites #boatSupportLocal.
	 */
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
		// Only apply if destination is clear of terrain blocks.
		if (!this.voxelCollider.overlaps(this.#tmp1)) {
			this.voxelPosition.copyFrom(this.#tmp1);
		}
	}

	/**
	 * Probe for a solid boat block directly under the player's feet.
	 * Writes #supportBoat and saves #boatSupportLocal (player CENTER in local).
	 * Reads voxelPosition — must be called after #flushToWorld.
	 */
	#updateSupportBoat(): void {
		this.#supportBoat = null;

		const footY = this.voxelPosition.y - this.colliderHalfHeight - 0.1;
		const r = this.colliderHalfWidth * 0.75;
		const offsets: [number, number][] = [
			[0, 0],
			[r, 0],
			[-r, 0],
			[0, r],
			[0, -r],
		];

		const boats = CustomBoat.getActiveBoats();
		const ordered = this.#collisionBoat
			? [this.#collisionBoat, ...boats.filter((b) => b !== this.#collisionBoat)]
			: [...boats];

		// 1) Primary support test: solid voxel under feet
		for (const boat of ordered) {
			const chunk = boat.boatChunk;
			if (!chunk) continue;

			for (const [sx, sz] of offsets) {
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

					// Save player CENTER in local space for boat motion carry
					boat.worldToBoatChunkLocalPoint(
						this.voxelPosition,
						this.#boatSupportLocal,
					);

					return;
				}
			}
		}

		// 2) Fallback: if already near/inside the boat's OBB, keep support
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

	/**
	 * Enter / stay in / leave boat mode.
	 *
	 * CRITICAL: #boatLocalPos is NEVER re-derived from world here while already
	 * in boat mode. It is authoritative — re-deriving would inject matrix noise.
	 */
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

			this.debugBoatState("stay-on-boat");
			return;
		}

		if (
			this.#collisionBoat &&
			performance.now() - this.#lastBoatSupportMs <= this.boatSupportGraceMs
		) {
			this.debugBoatState("grace-period");
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

		this.debugBoatState("off-boat");
	}

	// ── Input ─────────────────────────────────────────────────────────────────

	/**
	 * Desired velocity for this frame.
	 *
	 * Terrain mode: world-space, camera-yaw rotated.
	 *   inputDirection.x = strafe (D=+1), .z = forward (W=+1)
	 *
	 * Boat mode: boat-local space.
	 *   Camera-yaw world direction is rotated by -boatYaw into local space.
	 *   Forward = camera forward projected onto boat's XZ plane.
	 *   This is correct: the player walks relative to the boat surface,
	 *   oriented by where they are looking.
	 */
	#getDesiredVelocity(speed: number, boatYaw: number | null): Vector3 {
		// Build camera-relative world-space direction.
		const worldDir = this.inputDirection
			.scale(speed)
			.applyRotationQuaternion(this.#characterOrientation);

		if (boatYaw === null) return worldDir;

		// Rotate into boat-local space.
		const local = new Vector3();
		this.#toBoatLocal(worldDir, boatYaw, local);
		return local;
	}

	// ── Sweep (shared by terrain and boat) ────────────────────────────────────

	/**
	 * Move `pos` along `axis` by `delta`, stopping at the first solid block.
	 * On collision, zeros the corresponding component of `vel`.
	 * Identical logic for terrain (world pos + voxelCollider) and boat
	 * (local pos + boatVoxelCollider) — no special cases needed.
	 */
	#sweepAxis(
		pos: Vector3,
		vel: Vector3,
		collider: VoxelAabbCollider,
		axis: Axis,
		delta: number,
	): void {
		if (delta === 0) return;
		let remaining = delta;
		while (Math.abs(remaining) > 0) {
			const step =
				Math.abs(remaining) > this.voxelStepSize
					? this.voxelStepSize * Math.sign(remaining)
					: remaining;

			this.#tmp4.copyFrom(pos);
			if (axis === Axis.X) this.#tmp4.x += step;
			else if (axis === Axis.Y) this.#tmp4.y += step;
			else this.#tmp4.z += step;

			if (collider.overlaps(this.#tmp4)) {
				// Zero only the axis that hit — never zero unrelated axes.
				if (axis === Axis.X) vel.x = 0;
				else if (axis === Axis.Y) vel.y = 0;
				else vel.z = 0;
				return;
			}
			pos.copyFrom(this.#tmp4);
			remaining -= step;
		}
	}

	/**
	 * Attempt to step up over a 1-block-high ledge.
	 * Tries each 0.25-unit height increment up to stepUpHeight.
	 */
	#attemptStepUp(
		pos: Vector3,
		vel: Vector3,
		collider: VoxelAabbCollider,
		axis: Axis.X | Axis.Z,
		delta: number,
	): boolean {
		// Check if forward is actually blocked.
		this.#tmp4.copyFrom(pos);
		if (axis === Axis.X) this.#tmp4.x += delta;
		else this.#tmp4.z += delta;
		if (!collider.overlaps(this.#tmp4)) {
			pos.copyFrom(this.#tmp4);
			return true;
		}

		for (let rise = 0.25; rise <= this.stepUpHeight; rise += 0.25) {
			// Step up.
			const up = this.#tmp4;
			up.copyFrom(pos);
			up.y += rise;
			if (collider.overlaps(up)) continue;

			// Step forward.
			const fwd = this.#tmp2; // safe to reuse — not in a probe loop here
			fwd.copyFrom(up);
			if (axis === Axis.X) fwd.x += delta;
			else fwd.z += delta;
			if (collider.overlaps(fwd)) continue;

			// Confirm there is ground under the forward position.
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
			Date.now() - this.lastStepUpTime > this.stepUpCooldown * 1000
		) {
			const saved = pos.clone();
			if (
				this.#attemptStepUp(pos, vel, collider, axis as Axis.X | Axis.Z, delta)
			)
				return;
			pos.copyFrom(saved);
		}
		this.#sweepAxis(pos, vel, collider, axis, delta);
	}

	#checkGrounded(pos: Vector3, collider: VoxelAabbCollider): boolean {
		const px = pos.x,
			py = pos.y - 0.08,
			pz = pos.z;
		const r = this.colliderHalfWidth * 0.75;
		const p = this.#tmp4;
		p.set(px, py, pz);
		if (collider.overlaps(p)) return true;
		p.set(px + r, py, pz);
		if (collider.overlaps(p)) return true;
		p.set(px - r, py, pz);
		if (collider.overlaps(p)) return true;
		p.set(px, py, pz + r);
		if (collider.overlaps(p)) return true;
		p.set(px, py, pz - r);
		if (collider.overlaps(p)) return true;
		return false;
	}
	#isInsideBoatObb(boat: CustomBoat): boolean {
		const mesh = boat.boatMesh;
		if (!mesh || mesh.isDisposed()) return false;

		const bbox = mesh.getBoundingInfo().boundingBox;

		// Player center in boat-mesh local space
		const inv = mesh.getWorldMatrix().clone().invert();
		const local = Vector3.TransformCoordinates(this.voxelPosition, inv);

		// Small grace margins so climbing / rotation doesn't instantly drop support
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
		// ── 1. Flush local → world (renders last frame's resolved position) ────
		this.#flushToWorld();

		// ── 2. Carry player with boat motion ────────────────────────────────────
		// Uses #boatSupportLocal from PREVIOUS frame — before it is overwritten.
		this.#applyBoatMotion();

		// ── 3. Detect support under feet ────────────────────────────────────────
		// Reads voxelPosition (world). Writes #supportBoat + #boatSupportLocal.
		this.#updateSupportBoat();

		// ── 4. Enter / stay in / leave boat mode ─────────────────────────────────
		// NEVER re-derives boatLocalPos from world if already on boat.
		this.#syncBoatMode();

		// Re-bind after syncBoatMode may have changed #collisionBoat.
		const nowOnBoat = this.isOnBoat();
		const activePos = nowOnBoat ? this.#boatLocalPos : this.voxelPosition;
		const activeVel = nowOnBoat ? this.#boatLocalVel : this.voxelVelocity;
		const activeCol = nowOnBoat ? this.boatVoxelCollider : this.voxelCollider;
		const activeBoatYaw = nowOnBoat ? this.#collisionBoat!.boatYaw : null;

		// ── 5. Grounded check ────────────────────────────────────────────────────
		this.voxelIsGrounded = this.#checkGrounded(activePos, activeCol);
		if (this.voxelIsGrounded && activeVel.y < 0) activeVel.y = 0;

		// ── 6. Desired input velocity ─────────────────────────────────────────────
		const isInWater = this.isInWater();
		const speed = isInWater
			? this.swimSpeed
			: this.voxelIsGrounded
				? this.onGroundSpeed
				: this.inAirSpeed;

		const desired = this.#getDesiredVelocity(speed, activeBoatYaw);

		if (
			this.isSprinting &&
			!isInWater &&
			this.voxelIsGrounded &&
			(this.inputDirection.x !== 0 || this.inputDirection.z !== 0)
		) {
			desired.scaleInPlace(this.sprintMultiplier);
		}

		// ── 7. Horizontal acceleration ────────────────────────────────────────────
		const curH = new Vector3(activeVel.x, 0, activeVel.z);
		const tgtH = new Vector3(desired.x, 0, desired.z);
		const accel = isInWater
			? this.swimAcceleration
			: this.voxelIsGrounded
				? this.accelRateGround
				: this.accelRateGround * 0.5;
		const nextH = this.accelerate(curH, tgtH, accel, deltaTime);
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

		// ── 8. Vertical velocity ──────────────────────────────────────────────────
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
				activeVel.y = Math.max(
					this.#characterGravity.length() * this.jumpHeight,
					activeVel.y,
				);
				this.voxelIsGrounded = false;
			}
			// Y gravity is the same in boat-local and world (no pitch/roll).
			activeVel.y += this.#characterGravity.y * deltaTime;
		}

		// ── 9. Sweep ──────────────────────────────────────────────────────────────
		// Terrain: sweeps world coords against world block grid.
		// Boat:    sweeps local coords against local block grid.
		// Identical code path — no special cases.
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

		// ── 10. Post-sweep grounded re-check ──────────────────────────────────────
		this.voxelIsGrounded = this.#checkGrounded(activePos, activeCol);
		if (this.voxelIsGrounded) {
			if (Math.abs(activeVel.y) < 0.1) activeVel.y = 0;
			else if (activeVel.y < 0) activeVel.y = 0;
		}

		// ── 11. Flush local → world ────────────────────────────────────────────────
		if (this.isOnBoat()) {
			this.#flushToWorld();
			// Save current local position for next frame's applyBoatMotion.
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
					this.voxelPosition.copyFrom(
						this.voxelPosition.add(dv.scale(deltaTime)),
					);
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
		const support = this.#characterController.checkSupport(
			deltaTime,
			new Vector3(0, -1, 0),
		);
		const dv = this.calculateDesiredVelocity(deltaTime, support);
		this.#characterController.setVelocity(dv);
		this.#characterController.integrate(
			deltaTime,
			support,
			this.#characterGravity,
		);
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
		const up = this.getUpVector();
		const spd = this.onGroundSpeed * 112.5;
		const dv = this.inputDirection
			.scale(spd)
			.applyRotationQuaternion(this.#characterOrientation);
		if (this.wantJump > 0) dv.addInPlace(up.scale(spd));
		if (this.isSprinting) dv.addInPlace(up.scale(-spd));
		const cur = this.getVelocityInternal();
		return dv.lengthSquared() < 0.01
			? cur.clone().scaleInPlace(this.deacceleration)
			: this.accelerate(cur, dv, this.accelRateGround, deltaTime);
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
		const up = this.getUpVector();
		const v = cur.clone();
		v.addInPlace(up.scale(-v.dot(up)));
		v.addInPlace(up.scale(cur.dot(up)));
		v.addInPlace(this.#characterGravity.scale(dt));
		return v;
	}

	private calculateOnGroundVelocity(
		cur: Vector3,
		si: CharacterSurfaceInfo,
	): Vector3 {
		const up = this.getUpVector();
		const dv = this.inputDirection
			.scale(this.onGroundSpeed)
			.applyRotationQuaternion(this.#characterOrientation);
		if (
			this.isSprinting &&
			(this.inputDirection.x !== 0 || this.inputDirection.z !== 0)
		)
			dv.scaleInPlace(this.sprintMultiplier);
		const v = cur.clone().subtract(si.averageSurfaceVelocity);
		const n = si.averageSurfaceNormal;
		if (n.dot(up) < this.minFloorNormalDot) return cur;
		return v
			.subtract(n.scale(v.dot(n)))
			.addInPlace(n.scale(this.penetrationRecoveryEps))
			.addInPlace(si.averageSurfaceVelocity);
	}

	private calculateJumpVelocity(cur: Vector3, prev: PlayerState): Vector3 {
		const up = this.getUpVector();
		const jumpSpd = Math.max(
			this.#characterGravity.length() * this.jumpHeight,
			cur.dot(up),
		);
		const dv = this.inputDirection
			.scale(this.onGroundSpeed)
			.applyRotationQuaternion(this.#characterOrientation);
		if (this.isSprinting) dv.scaleInPlace(this.sprintMultiplier);
		const v = up.scale(jumpSpd).add(dv);
		if (prev === PlayerState.IN_AIR) {
			v.addInPlace(
				this.#camera.playerCamera
					.getForwardRay()
					.direction.normalize()
					.scale(this.inAirSpeed * this.airJumpForwardBoost),
			);
		}
		return v;
	}

	private accelerate(
		cur: Vector3,
		tgt: Vector3,
		maxA: number,
		dt: number,
	): Vector3 {
		const d = tgt.subtract(cur);
		if (d.length() < 0.1) return cur.clone();
		return cur.add(d.normalize().scale(Math.min(d.length(), maxA * dt)));
	}

	private getUpVector(): Vector3 {
		return this.#characterGravity.normalizeToNew().scaleInPlace(-1);
	}

	private isInWater(): boolean {
		const pos = this.voxelPosition;
		const r = this.colliderHalfWidth * 0.9;
		for (const dy of [
			-this.colliderHalfHeight + 0.12,
			-this.colliderHalfHeight * 0.2,
			this.colliderHalfHeight * 0.2,
		]) {
			const y = pos.y + dy;
			for (const [dx, dz] of [
				[0, 0],
				[r, 0],
				[-r, 0],
				[0, r],
				[0, -r],
			] as [number, number][]) {
				if (
					ChunkLoadingSystem.getBlockByWorldCoords(
						pos.x + dx,
						y,
						pos.z + dz,
					) === BlockType.Water
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
