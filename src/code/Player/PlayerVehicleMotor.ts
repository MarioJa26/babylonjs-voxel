import {
	addToScene,
	addVec3InPlace,
	createStandardMaterial,
	type EngineContext,
	type Mesh,
	type SceneContext,
	scaleVec3InPlace,
	scaleVec3ToRef,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { copyVec3, lengthSqVec3, Quaternion, setVec3 } from "@/code/Lib/Math";
import { worldToChunkCoord } from "@/code/Lib/VoxelMath";
import {
	Axis,
	createVoxelColliderBlockSampler,
	VoxelAabbCollider,
	voxelStepUp,
} from "@/code/World/Collision/VoxelAabbCollider";
import { CustomBoat } from "../Entities/CustomBoat";
import type { Mount } from "../Entities/Mount";
import type { BoatChunk } from "../World/Boat/BoatChunk";
import { getChunk } from "../World/Chunk/Chunk";
import {
	getBlockAndStateByWorldCoords,
	getBlockByWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import { getShapeForBlockId } from "../World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "../World/Shape/FenceConnect";
import { getSpawnPosition, isSpawnPrepared } from "../World/SpawnPoint";
import { BlockType, isCollidableBlock } from "../World/Texture/BlockType";
import type { IPlayerBody, PlayerBodyControlState } from "./PlayerBody";
import type { PlayerCamera } from "./PlayerCamera";
import {
	applyPlayerSkin,
	createPlayerRigMesh,
	ensureWorldRigLights,
} from "./PlayerModel";
import { Gamemodes, type PlayerStats } from "./PlayerStats";
import { SimpleCharacterController } from "./SimpleCharacterController";

type PlayerVehicleMotorOptions = {
	scene: SceneContext;
	engine: EngineContext;
	camera: PlayerCamera;
	controls: PlayerBodyControlState;
	playerStats: PlayerStats;
};

// PERF: Module-level scratch vectors for one-off helpers that don't need
// instance lifetime. Avoids per-call `{ x: 0, y: 0, z: 0 }` in hot paths.
const _scratchA: Vec3 = vec3(0, 0, 0);
const _scratchB: Vec3 = vec3(0, 0, 0);
const _scratchC: Vec3 = vec3(0, 0, 0);

// PERF: Inline quaternion rotation to avoid `applyRotationQuaternion`
// allocating a new Vector3 on every call. Uses the standard Hamilton product.
function _rotateVec3ByQuat(
	vx: number,
	vy: number,
	vz: number,
	qx: number,
	qy: number,
	qz: number,
	qw: number,
	out: Vec3,
): void {
	const ix = qw * vx + qy * vz - qz * vy;
	const iy = qw * vy + qz * vx - qx * vz;
	const iz = qw * vz + qx * vy - qy * vx;
	const iw = -qx * vx - qy * vy - qz * vz;
	out.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
	out.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
	out.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}

// Sentinel returned by the player's collision sampler for probes whose chunk
// is not yet loaded: a solid, full-cube block so the player is held up by
// unloaded terrain instead of falling through the world while chunks stream in.
const _unloadedSolid: { blockId: number; blockState: number } = {
	blockId: BlockType.Cobble,
	blockState: 0,
};

// True when the chunk containing the given world coordinate is present and has
// voxel data. Used to gate collision: an unloaded chunk is treated as solid so
// the player never falls through terrain that hasn't streamed in.
function isChunkLoadedAtWorldCoords(
	worldX: number,
	worldY: number,
	worldZ: number,
): boolean {
	const chunk = getChunk(
		worldToChunkCoord(worldX),
		worldToChunkCoord(worldY),
		worldToChunkCoord(worldZ),
	);
	return !!chunk && chunk.isLoaded && chunk.hasVoxelData;
}

export class PlayerVehicleMotor implements IPlayerBody {
	readonly scene: SceneContext;
	readonly #engine: EngineContext;
	readonly #camera: PlayerCamera;
	readonly #controls: PlayerBodyControlState;
	readonly #playerStats: PlayerStats;
	public mount: Mount | null = null;
	public isMounted = false;

	#displayCapsule!: Mesh;
	#characterController!: SimpleCharacterController;
	#characterOrientation = Quaternion.Identity();
	#characterGravity: Vec3 = vec3(0, -18, 0);
	// PERF: Cache gravity magnitude — avoids repeated sqrt in jump/fly paths.
	#characterGravityLen = 18;
	// PERF: Pre-computed gravity up vector — avoids 12 divisions per physics step.
	readonly #upX = -this.#characterGravity.x / this.#characterGravityLen;
	#previousSneaking = false;
	readonly #tmpHalfExtents: Vec3 = vec3(0, 0, 0);
	readonly #upY = -this.#characterGravity.y / this.#characterGravityLen;
	readonly #upZ = -this.#characterGravity.z / this.#characterGravityLen;
	#movementLocked = false;
	#lockedPosition: Vec3 | null = null;
	// Set when a saved position was restored from local storage (or the
	// server's SpawnPosition) — tells the loading gate not to teleport the
	// player over it.
	#savedPositionRestored = false;
	readonly #zeroVelocity: Vec3 = vec3(0, 0, 0);

	#collisionBoat: CustomBoat | null = null;
	readonly #boatLocalPos: Vec3 = vec3(0, 0, 0);
	readonly #boatLocalVel: Vec3 = vec3(0, 0, 0);
	readonly #boatSupportLocal: Vec3 = vec3(0, 0, 0);
	#supportBoat: CustomBoat | null = null;
	#lastBoatSupportMs = 0;
	private readonly boatSupportGraceMs = 150;

	// Scratch vectors — one set for the whole class, labelled by owner method.
	#tmp0: Vec3 = vec3(0, 0, 0); // flushToWorld, applyBoatMotion world point
	#tmp1: Vec3 = vec3(0, 0, 0); // applyBoatMotion candidate
	#tmp2: Vec3 = vec3(0, 0, 0); // updateSupportBoat probe / attemptStepUp fwd
	#tmp3: Vec3 = vec3(0, 0, 0); // updateSupportBoat local / attemptStepUp ground
	#tmp4: Vec3 = vec3(0, 0, 0); // sweep candidate / checkGrounded
	#tmp5: Vec3 = vec3(0, 0, 0); // toBoatLocal/toWorld start
	#tmp6: Vec3 = vec3(0, 0, 0); // toBoatLocal/toWorld end
	#tmp7: Vec3 = vec3(0, 0, 0); // toBoatLocal/toWorld localStart
	#tmp8: Vec3 = vec3(0, 0, 0); // toBoatLocal/toWorld localEnd
	// PERF: Extra scratch replaces `{ x: 0, y: 0, z: 0 }` calls in integrateVoxelMovementStep
	readonly #tmpDesiredH: Vec3 = vec3(0, 0, 0); // desired horizontal
	readonly #tmpCurH: Vec3 = vec3(0, 0, 0); // current horizontal
	readonly #tmpNextH: Vec3 = vec3(0, 0, 0); // accelerate result
	// PERF: Replaces per-frame allocations in calculateFlyingVelocity /
	// accelerate.
	readonly #tmpDv: Vec3 = vec3(0, 0, 0);
	readonly #tmpV: Vec3 = vec3(0, 0, 0);
	readonly #tmpProbe: Vec3 = vec3(0, 0, 0); // #checkGrounded / #checkWallContact

	// ── Terrain state ─────────────────────────────────────────────────────────
	readonly boatVoxelCollider: VoxelAabbCollider;
	private readonly voxelCollider: VoxelAabbCollider;
	private voxelPosition: Vec3 = vec3(0, 165, 0);
	private voxelVelocity: Vec3 = vec3(0, 0, 0);
	private voxelIsGrounded = false;
	private prevJumpHeld = false;
	#isClimbing = false;
	private lastStepUpTime = 0;
	private now = 0;
	// Cached per-frame environment queries (reused across substeps).
	private frameIsInWater = false;
	// Scratch outputs of #checkWallContactInto (avoids per-substep object alloc).
	#wallContact = false;
	// Scratch for the inflated AABB used by #tryBoatHullContact.
	readonly #tmpHullProbe: Vec3 = vec3(0, 0, 0);

	// ── Parameters ────────────────────────────────────────────────────────────
	private readonly deceleration = 0.85;
	private readonly inAirSpeed = 4.0;
	private readonly onGroundSpeed = 4.0;
	private readonly jumpHeight = 0.35;
	private readonly jumpStaminaCost = 10;
	private readonly accelRateGround = 36;
	private readonly sprintMultiplier = 1.75;
	private readonly sneakMultiplier = 0.5;
	private readonly colliderHalfWidth = 0.3;
	private readonly standingHalfHeight = 0.875;
	private readonly crouchHalfHeight = 0.725;
	private colliderHalfHeight = this.standingHalfHeight;
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

	// ── Wall jump / climbing ─────────────────────────────────────────────────
	// Formalised replacement for the old "jump up a wall" exploit. Touching a
	// wall is not sticky: tapping jump while airborne and in contact launches a
	// parkour wall-jump (up impulse + small push off the wall). Gravity arcs
	// between hops; at zero stamina you can't hop and instead slide down slowly.
	private readonly noStaminaSlideSpeed = 0.15; // slow slide while climbing
	// Controlled descent speed while climbing + sneaking (faster than the
	// out-of-stamina slow slide). Tunable.
	private readonly climbDownSneakSpeed = 5.0;
	// Max distance of solid ground below the feet that still suppresses climbing
	// (so you don't stick to / slow-slide a 1-tall step or the base of a wall).
	private readonly climbGroundMaxDist = 1.0;
	// Footprint used to detect *floor* (narrow so walls beside the player are
	// not mistaken for ground). This is the actual bug fix.
	private readonly footProbeHalfWidth: number; // colliderHalfWidth * 0.7
	private readonly footProbeHalfHeight = 0.04;
	// Half-height of the side slab used to detect wall contact.
	private readonly wallProbeHalfHeight: number; // colliderHalfHeight * 0.6

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
		this.scene = options.scene;
		this.#engine = options.engine;
		this.#camera = options.camera;
		this.#controls = options.controls;
		this.#playerStats = options.playerStats;

		// PERF: Pre-compute all derived constants once at construction time.
		this.colliderHalfWidthProbe = this.colliderHalfWidth * 0.75;
		this.colliderHalfWidthWater = this.colliderHalfWidth * 0.9;
		this.stepUpCooldownMs = this.stepUpCooldown * 1000;
		this.jumpImpulse = this.#characterGravityLen * this.jumpHeight;
		this.footProbeHalfWidth = this.colliderHalfWidth * 0.7;
		this.wallProbeHalfHeight = this.colliderHalfHeight * 0.6;

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
			{
				x: this.colliderHalfWidth,
				y: this.colliderHalfHeight,
				z: this.colliderHalfWidth,
			},
			createVoxelColliderBlockSampler(
				(x, y, z) => {
					if (!isChunkLoadedAtWorldCoords(x, y, z)) {
						// Chunk under this probe is not loaded: treat it as solid
						// terrain so the player collides with / rests on it instead
						// of falling through into the void while chunks stream in.
						return _unloadedSolid;
					}
					const r = getBlockAndStateByWorldCoords(x, y, z);
					if (!isCollidableBlock(r.blockId)) return null;
					return r;
				},
				{
					getFenceDynamicShape,
					getShapeForBlockId,
					isFenceBlockId,
					computeFenceNeighborMask,
				},
			),
			this.collisionEpsilon,
			{
				scene: this.scene,
				name: "playerAABB",
				position: this.voxelPosition,
				renderOrder: 1,
			},
		);

		this.boatVoxelCollider = new VoxelAabbCollider(
			{
				x: this.colliderHalfWidth,
				y: this.colliderHalfHeight,
				z: this.colliderHalfWidth,
			},
			createVoxelColliderBlockSampler(
				(x, y, z) => {
					const chunk = this.#collisionBoat?.boatChunk;
					if (!chunk) return null;
					const packed = chunk.getBlockLocal(x, y, z);
					const blockId = packed & 0x3ff;
					if (!isCollidableBlock(blockId)) return null;
					const blockState = (packed >>> 10) & 0x3f;
					return { blockId, blockState };
				},
				{
					getFenceDynamicShape,
					getShapeForBlockId,
					isFenceBlockId,
					computeFenceNeighborMask,
				},
			),
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
	public getSceneContext(): SceneContext {
		return this.scene;
	}
	public get camera(): PlayerCamera {
		return this.#camera;
	}
	public get position(): Vec3 {
		return this.voxelPosition;
	}
	public get isMovementLocked(): boolean {
		return this.#movementLocked;
	}
	public get climbing(): boolean {
		return this.#isClimbing;
	}
	public get isClimbing(): boolean {
		return this.#isClimbing;
	}

	public get inputDirection(): Vec3 {
		return this.#controls.inputDirection;
	}
	public get wantJump(): number {
		return this.#controls.wantJump;
	}
	public set wantJump(v: number) {
		this.#controls.wantJump = v;
	}
	public get isSprinting(): boolean {
		return this.#controls.isSprinting;
	}
	public set isSprinting(v: boolean) {
		this.#controls.isSprinting = v;
	}
	public get isFlying(): boolean {
		return this.#controls.isFlying;
	}
	public set isFlying(v: boolean) {
		this.#controls.isFlying = v;
	}
	public get isJumpHeld(): boolean {
		return this.#controls.isJumpHeld;
	}
	public set isJumpHeld(v: boolean) {
		this.#controls.isJumpHeld = v;
	}
	public get isSneaking(): boolean {
		return this.#controls.isSneaking;
	}
	public set isSneaking(v: boolean) {
		this.#controls.isSneaking = v;
	}

	public toggleFlying(): void {
		this.#controls.isFlying = !this.#controls.isFlying;
	}

	public clearControlState(): void {
		this.#controls.reset();
	}

	public respawn(): void {
		// Until the world spawn is prepared the player has not been teleported
		// to it yet; snapping to the default (0,0,0) would park the player
		// inside terrain at the origin and trigger a pre-teleport chunk load.
		if (!isSpawnPrepared()) return;
		const spawn = getSpawnPosition();
		this.voxelPosition.x = spawn.x;
		this.voxelPosition.y = spawn.y;
		this.voxelPosition.z = spawn.z;
		setVec3(this.voxelVelocity, 0, 0, 0);
		this.#characterController.setPosition(this.voxelPosition);
		this.#camera.snapToPlayer(this.voxelPosition);
		this.#displayCapsule?.position.copyFrom(this.voxelPosition);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
	}

	public teleportTo(x: number, y: number, z: number): void {
		this.voxelPosition.x = x;
		this.voxelPosition.y = y;
		this.voxelPosition.z = z;
		setVec3(this.voxelVelocity, 0, 0, 0);
		this.#characterController.setPosition(this.voxelPosition);
		this.#camera.snapToPlayer(this.voxelPosition);
		this.#displayCapsule?.position.copyFrom(this.voxelPosition);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
	}

	// ── Boat mode helpers ─────────────────────────────────────────────────────

	private isOnBoat(): boolean {
		return !!this.#collisionBoat?.boatChunk;
	}

	/** Rotate world XZ vector into boat-local XZ. Y unchanged. */
	#toBoatLocal(world: Vec3, _yaw: number, out: Vec3): void {
		const boat = this.#collisionBoat;

		if (!boat) {
			copyVec3(out, world);
			return;
		}

		// Do not assign scratch references to voxelPosition.
		const start = this.voxelPosition;

		setVec3(
			this.#tmp6,
			start.x + world.x,
			start.y + world.y,
			start.z + world.z,
		);

		const localStart = boat.worldToBoatChunkLocalPoint(start, this.#tmp7);
		const localEnd = boat.worldToBoatChunkLocalPoint(this.#tmp6, this.#tmp8);

		if (!localStart || !localEnd) {
			copyVec3(out, world);
			return;
		}

		out.x = localEnd.x - localStart.x;
		out.y = world.y;
		out.z = localEnd.z - localStart.z;
	}

	/** Rotate boat-local XZ vector into world XZ. Y unchanged. */
	#toWorld(local: Vec3, _yaw: number, out: Vec3): void {
		const boat = this.#collisionBoat;

		if (!boat) {
			copyVec3(out, local);
			return;
		}

		// Do not assign scratch references to #boatLocalPos.
		const start = this.#boatLocalPos;

		setVec3(
			this.#tmp6,
			start.x + local.x,
			start.y + local.y,
			start.z + local.z,
		);

		const worldStart = boat.boatChunkLocalPointToWorld(start, this.#tmp7);
		const worldEnd = boat.boatChunkLocalPointToWorld(this.#tmp6, this.#tmp8);

		if (!worldStart || !worldEnd) {
			copyVec3(out, local);
			return;
		}

		out.x = worldEnd.x - worldStart.x;
		out.y = local.y;
		out.z = worldEnd.z - worldStart.z;
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
		const boat = this.#collisionBoat;
		if (!boat) return;

		const world = boat.boatChunkLocalPointToWorld(
			this.#boatLocalPos,
			this.#tmp0,
		);

		if (!world) {
			this.#collisionBoat = null;
			return;
		}

		// Important: copy into the stable position object.
		// Do not replace voxelPosition with #tmp0, because #tmp0 is reused elsewhere.
		copyVec3(this.voxelPosition, world);
	}

	/**
	 * Check if placing a block at the given world coordinates would overlap with the player.
	 * Uses the voxel collider's collision logic for accurate detection.
	 */
	public wouldBlockOverlapPlayer(
		blockX: number,
		blockY: number,
		blockZ: number,
		blockShape: {
			boxes: Array<{
				min: [number, number, number];
				max: [number, number, number];
			}>;
			rotateY: boolean;
			usesSliceState: boolean;
		},
		rotation: number,
		slice: number,
		flipY: boolean,
	): boolean {
		// Use the character controller's current position (most up-to-date)
		const pos = this.#characterController.getPosition();
		return this.voxelCollider.wouldOverlapBlock(
			pos,
			blockX,
			blockY,
			blockZ,
			blockShape,
			rotation,
			slice,
			flipY,
		);
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

		// PERF: write into the #tmp1 scratch instead of replacing the object
		// reference with a fresh `{ x, y, z }` literal every frame.
		setVec3(
			this.#tmp1,
			this.voxelPosition.x + dx,
			this.voxelPosition.y + dy,
			this.voxelPosition.z + dz,
		);
		if (!this.voxelCollider.overlaps(this.#tmp1)) {
			copyVec3(this.voxelPosition, this.#tmp1);
		}
	}

	#tryBoatSupport(boat: CustomBoat, chunk: BoatChunk, footY: number): boolean {
		for (const [sx, sz] of this._groundProbeOffsets) {
			setVec3(
				this.#tmp2,
				this.voxelPosition.x + sx,
				footY,
				this.voxelPosition.z + sz,
			);

			const local = boat.worldToBoatChunkLocalPoint(this.#tmp2, this.#tmp3);
			if (!local) continue;

			const bx = Math.floor(local.x);
			const by = Math.floor(local.y);
			const bz = Math.floor(local.z);

			// chunk.getBlockLocal() appears to return a packed block value.
			// Match the boat collider sampler and mask the block id before testing.
			const blockHereId = chunk.getBlockLocal(bx, by, bz) & 0x3ff;
			const blockBelowId = chunk.getBlockLocal(bx, by - 1, bz) & 0x3ff;

			if (isCollidableBlock(blockHereId) || isCollidableBlock(blockBelowId)) {
				this.#supportBoat = boat;

				const supportLocal = boat.worldToBoatChunkLocalPoint(
					this.voxelPosition,
					this.#boatSupportLocal,
				);

				return !!supportLocal;
			}
		}

		return false;
	}

	#tryBoatHullContact(boat: CustomBoat): boolean {
		const local = boat.worldToBoatChunkLocalPoint(
			this.voxelPosition,
			this.#tmp6,
		);
		if (!local) return false;
		// Temporarily point the boat collider at this boat so overlapsBox() tests
		// its blocks, then restore the previous collision boat.
		const prev = this.#collisionBoat;
		this.#collisionBoat = boat;
		setVec3(
			this.#tmpHullProbe,
			this.colliderHalfWidth + 0.15,
			this.colliderHalfHeight + 0.15,
			this.colliderHalfWidth + 0.15,
		);
		const touches = this.boatVoxelCollider.overlapsBox(
			local,
			this.#tmpHullProbe,
		);
		this.#collisionBoat = prev;
		if (touches) {
			this.#supportBoat = boat;
			return true;
		}
		return false;
	}

	#updateSupportBoat(): void {
		this.#supportBoat = null;

		const footY = this.voxelPosition.y - this.colliderHalfHeight - 0.1;

		const boats = CustomBoat.getActiveBoats();
		const collisionBoat = this.#collisionBoat;

		// Side-hull contact: while airborne and not in water, grab onto a boat we
		// are touching so movement and the grounded/wall checks run in boat space.
		// Without this the player clips through tilted hulls (the world collider
		// has no boat geometry) and the ground check evaluates in world space.
		if (!this.voxelIsGrounded && !this.frameIsInWater) {
			for (const boat of boats) {
				if (this.#tryBoatHullContact(boat)) return;
			}
		}

		// Check collision boat first (avoids allocation of reordered array).
		if (collisionBoat) {
			const chunk = collisionBoat.boatChunk;
			if (chunk && this.#tryBoatSupport(collisionBoat, chunk, footY)) return;
		}
		for (const boat of boats) {
			if (boat === collisionBoat) continue;
			const chunk = boat.boatChunk;
			if (!chunk) continue;
			if (this.#tryBoatSupport(boat, chunk, footY)) return;
		}

		// OBB check: collision boat first, then others.
		if (collisionBoat) {
			if (this.#isInsideBoatObb(collisionBoat)) {
				this.#supportBoat = collisionBoat;
				collisionBoat.worldToBoatChunkLocalPoint(
					this.voxelPosition,
					this.#boatSupportLocal,
				);
				return;
			}
		}
		for (const boat of boats) {
			if (boat === collisionBoat) continue;
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
			this.#lastBoatSupportMs = this.now;

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
			this.now - this.#lastBoatSupportMs <= this.boatSupportGraceMs
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
	#getDesiredVelocity(speed: number, boatYaw: number | null, out: Vec3): void {
		scaleVec3ToRef(this.inputDirection, speed, out);
		// PERF: Inline quaternion rotation avoids Vector3 alloc from applyRotationQuaternion.
		const q = this.#characterOrientation;
		_rotateVec3ByQuat(out.x, out.y, out.z, q.x, q.y, q.z, q.w, out);

		if (boatYaw !== null) {
			// Rotate world direction into boat-local space in-place via scratch.
			this.#toBoatLocal(out, boatYaw, _scratchA);
			copyVec3(out, _scratchA);
		}
	}

	// ── Sweep ─────────────────────────────────────────────────────────────────

	#sweepAxis(
		pos: Vec3,
		vel: Vec3,
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

			// PERF: #tmp4 is already a scratch — just write into it directly.
			copyVec3(this.#tmp4, pos);
			if (axis === Axis.X) this.#tmp4.x += step;
			else if (axis === Axis.Y) this.#tmp4.y += step;
			else this.#tmp4.z += step;

			if (collider.overlaps(this.#tmp4)) {
				if (axis === Axis.X) vel.x = 0;
				else if (axis === Axis.Y) vel.y = 0;
				else vel.z = 0;
				return;
			}
			copyVec3(pos, this.#tmp4);
			remaining -= step;
		}
	}

	#attemptStepUp(
		pos: Vec3,
		vel: Vec3,
		collider: VoxelAabbCollider,
		axis: Axis.X | Axis.Z,
		delta: number,
	): boolean {
		return voxelStepUp(collider, pos, axis, delta, this.stepUpHeight, () => {
			vel.y = 0;
			this.lastStepUpTime = this.now;
		});
	}

	#moveAxis(
		pos: Vec3,
		vel: Vec3,
		collider: VoxelAabbCollider,
		input: Vec3,
		axis: Axis,
		delta: number,
	): void {
		if (
			axis !== Axis.Y &&
			this.voxelIsGrounded &&
			Math.abs(delta) > 1e-6 &&
			(input.x !== 0 || input.z !== 0) &&
			this.now - this.lastStepUpTime > this.stepUpCooldownMs
		) {
			const savedX = pos.x,
				savedY = pos.y,
				savedZ = pos.z;
			if (
				this.#attemptStepUp(pos, vel, collider, axis as Axis.X | Axis.Z, delta)
			)
				return;
			setVec3(pos, savedX, savedY, savedZ);
		}
		this.#sweepAxis(pos, vel, collider, axis, delta);
	}

	#checkGrounded(pos: Vec3, collider: VoxelAabbCollider): boolean {
		// Probe a thin slab *just below the feet* using the interior footprint
		// (narrower than the body). This detects a real floor without mistaking a
		// wall the player is pressed against for ground — which previously let the
		// player re-jump off a wall every frame.
		const footY = pos.y - this.colliderHalfHeight;
		const p = this.#tmpProbe;
		setVec3(p, pos.x, footY - this.footProbeHalfHeight, pos.z);
		const extents = setVec3(
			this.#tmpV,
			this.footProbeHalfWidth,
			this.footProbeHalfHeight,
			this.footProbeHalfWidth,
		);
		return collider.overlapsBox(p, extents);
	}

	/**
	 * Detect a solid wall in contact with the player's body on either the X or Z
	 * sides, writing the result into `#wallContact` (no per-call object
	 * allocation). Only the body-height side slabs are probed, so floors/ceilings
	 * are ignored. The caller is responsible for resetting `#wallContact` to
	 * false before calling when a fresh result is needed.
	 */
	#checkWallContactInto(pos: Vec3, collider: VoxelAabbCollider): void {
		this.#wallContact = false;
		const cy = pos.y;
		const hx = this.colliderHalfWidth + 0.06;
		const hz = this.colliderHalfWidth + 0.06;
		const hy = this.wallProbeHalfHeight;
		const p = this.#tmpProbe;
		const extents = setVec3(this.#tmpV, hx, hy, hz);

		// +X / -X
		setVec3(p, pos.x + this.colliderHalfWidth + 0.04, cy, pos.z);
		const v1 = collider.firstSolidVoxel(p, extents);
		if (v1 && this.#isClimbableWall(v1)) {
			this.#wallContact = true;
			return;
		}
		setVec3(p, pos.x - this.colliderHalfWidth - 0.04, cy, pos.z);
		const v2 = collider.firstSolidVoxel(p, extents);
		if (v2 && this.#isClimbableWall(v2)) {
			this.#wallContact = true;
			return;
		}
		// +Z / -Z
		setVec3(p, pos.x, cy, pos.z + this.colliderHalfWidth + 0.04);
		const v3 = collider.firstSolidVoxel(p, extents);
		if (v3 && this.#isClimbableWall(v3)) {
			this.#wallContact = true;
			return;
		}
		setVec3(p, pos.x, cy, pos.z - this.colliderHalfWidth - 0.04);
		const v4 = collider.firstSolidVoxel(p, extents);
		if (v4 && this.#isClimbableWall(v4)) {
			this.#wallContact = true;
		}
	}

	/**
	 * Decide whether the block at the exact contacted voxel `v` is a climbable
	 * wall. A lone 1-tall block resting on a surface (air above, solid below) is
	 * just a step — not climbable. A wall with a block above it, or a
	 * free-floating block with no solid block directly beneath it, is climbable.
	 */
	#isClimbableWall(v: { x: number; y: number; z: number }): boolean {
		let aboveCollidable: boolean;
		let belowCollidable: boolean;
		if (this.isOnBoat()) {
			// `v` came from the boat collider, so it is in boat-LOCAL space — query
			// the boat chunk's local blocks, not world coordinates.
			const chunk = this.#collisionBoat!.boatChunk!;
			const above = chunk.getBlockLocal(v.x, v.y + 1, v.z) & 0x3ff;
			const below = chunk.getBlockLocal(v.x, v.y - 1, v.z) & 0x3ff;
			aboveCollidable = isCollidableBlock(above);
			belowCollidable = isCollidableBlock(below);
		} else {
			const above = getBlockAndStateByWorldCoords(v.x, v.y + 1, v.z);
			const below = getBlockAndStateByWorldCoords(v.x, v.y - 1, v.z);
			aboveCollidable = isCollidableBlock(above.blockId);
			belowCollidable = isCollidableBlock(below.blockId);
		}
		return aboveCollidable || !belowCollidable;
	}

	/**
	 * True if there is a solid block within `dist` blocks directly below the
	 * player's feet. Used to suppress climbing entirely when the player is
	 * effectively next to a step / the base of a wall (ground within 1 block
	 * under the feet) — so you drop the last stretch freely instead of sticking.
	 */
	#hasGroundBelowFeet(
		pos: Vec3,
		collider: VoxelAabbCollider,
		dist: number,
	): boolean {
		const feetY = pos.y - this.colliderHalfHeight;
		setVec3(this.#tmpProbe, pos.x, feetY - dist * 0.5, pos.z);
		const h = setVec3(
			this.#tmpV,
			this.colliderHalfWidth,
			dist * 0.5,
			this.colliderHalfWidth,
		);
		return collider.overlapsBox(this.#tmpProbe, h);
	}

	#isInsideBoatObb(boat: CustomBoat): boolean {
		// Lite port: the classic code read `boat.boatMesh.getBoundingInfo()
		// .boundingBox` + `getWorldMatrix()` (unavailable in Lite). The boat
		// already exposes `worldToBoatChunkLocalPoint` which transforms a world
		// point into boat-local space (yaw + position) — the same space its
		// `collisionHalfExtents` describe. So we test the player against the
		// boat's AABB directly without any mesh world-matrix lookup.
		const local = boat.worldToBoatChunkLocalPoint(
			this.voxelPosition,
			_scratchC,
		);
		if (!local) return false;
		const he = boat.collisionHalfExtents;
		if (!he) return false;

		const xzMargin = 0.2;
		const yBelowMargin = 0.9;
		const yAboveMargin = 0.35;

		return (
			Math.abs(local.x) <= he.x + xzMargin &&
			Math.abs(local.z) <= he.z + xzMargin &&
			local.y >= -he.y - yBelowMargin &&
			local.y <= he.y + yAboveMargin
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

		const isInWater = this.frameIsInWater;

		// Wall contact is only meaningful for climbing, which can't start while
		// grounded (and is already tracked once climbing). Skip the 4 side probes
		// on normal ground movement.
		this.#wallContact = false;
		if (!isInWater && (!this.voxelIsGrounded || this.isClimbing)) {
			this.#checkWallContactInto(activePos, activeCol);
		}

		// Suppress climbing entirely when solid ground is within 1 block under the
		// feet (a step / the base of a wall) — both ascent and descent. Driven by
		// the player's own support, not the wall block, so descent releases and
		// you drop the last stretch freely.
		const nearGroundBelow =
			!isInWater &&
			!this.voxelIsGrounded &&
			(this.isClimbing || this.#wallContact) &&
			this.#hasGroundBelowFeet(activePos, activeCol, this.climbGroundMaxDist);

		// Climbing state: entered while airborne and in wall contact, exited when
		// the player leaves the wall, lands, or is within 1 block of the ground.
		// Drives the slow-slide grip and wall-jumps; horizontal movement stays
		// fully free.
		if (this.isClimbing) {
			if (!this.#wallContact || this.voxelIsGrounded || nearGroundBelow)
				this.#isClimbing = false;
		} else if (this.#wallContact && !this.voxelIsGrounded && !nearGroundBelow) {
			this.#isClimbing = true;
		}

		const speed = isInWater
			? this.swimSpeed
			: this.voxelIsGrounded
				? this.onGroundSpeed
				: this.inAirSpeed;

		// PERF: cache the controls getter once per physics substep
		const input = this.inputDirection;

		// PERF: #getDesiredVelocity now writes into a pre-allocated scratch.
		const desired = this.#tmpDesiredH;
		this.#getDesiredVelocity(speed, activeBoatYaw, desired);

		if (
			this.isSprinting &&
			!isInWater &&
			this.voxelIsGrounded &&
			(input.x !== 0 || input.z !== 0)
		) {
			scaleVec3InPlace(desired, this.sprintMultiplier);
		}

		if (this.#controls.isSneaking && this.voxelIsGrounded) {
			scaleVec3InPlace(desired, this.sneakMultiplier);
		}

		// PERF: Use pre-allocated scratch vectors; avoid `{ x: 0, y: 0, z: 0 }` here.
		const curH = this.#tmpCurH;
		setVec3(curH, activeVel.x, 0, activeVel.z);
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

		if (!isInWater && this.voxelIsGrounded && input.x === 0 && input.z === 0) {
			activeVel.x *= this.deceleration;
			activeVel.z *= this.deceleration;
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
			// Wall-jump: a fresh jump press while airborne and touching a wall
			// launches straight up (like a normal jump). Costs stamina in every
			// gamemode. Gated on the press edge so holding Space doesn't spam hops.
			const jumpPressed = this.isJumpHeld && !this.prevJumpHeld;
			this.prevJumpHeld = this.isJumpHeld;

			if (this.wantJump > 0 && this.voxelIsGrounded) {
				this.wantJump--;
				const canJump = this.#playerStats.consumeStamina(this.jumpStaminaCost);
				//Jump with 0 stamina in Creative
				if (this.#playerStats.gamemode === Gamemodes.Creative || canJump) {
					// PERF: Use cached jumpImpulse — avoids gravity.length() sqrt.
					activeVel.y = Math.max(this.jumpImpulse, activeVel.y);
					this.voxelIsGrounded = false;
				}
			} else if (jumpPressed && this.isClimbing) {
				const canJump = this.#playerStats.consumeStamina(this.jumpStaminaCost);
				if (canJump || this.#playerStats.gamemode === Gamemodes.Creative) {
					activeVel.y = Math.max(this.jumpImpulse, activeVel.y);
				}
			}
			activeVel.y += this.#characterGravity.y * deltaTime;

			// Grip: while climbing and descending, slide slowly instead of
			// free-falling (so you don't plummet when out of stamina). Sneaking
			// uses a faster, still-controlled descent cap.
			if (this.isClimbing) {
				const downCap = this.#controls.isSneaking
					? this.climbDownSneakSpeed
					: this.noStaminaSlideSpeed;
				if (activeVel.y < -downCap) activeVel.y = -downCap;
				if (input.x === 0) activeVel.x *= 0.98;
				if (input.z === 0) activeVel.z *= 0.98;
			}
		}

		this.#moveAxis(
			activePos,
			activeVel,
			activeCol,
			input,
			Axis.X,
			activeVel.x * deltaTime,
		);
		this.#moveAxis(
			activePos,
			activeVel,
			activeCol,
			input,
			Axis.Y,
			activeVel.y * deltaTime,
		);
		this.#moveAxis(
			activePos,
			activeVel,
			activeCol,
			input,
			Axis.Z,
			activeVel.z * deltaTime,
		);

		this.voxelIsGrounded = this.#checkGrounded(activePos, activeCol);

		if (this.isOnBoat()) {
			this.#flushToWorld();
			this.#collisionBoat?.worldToBoatChunkLocalPoint(
				this.voxelPosition,
				this.#boatSupportLocal,
			);
		}

		this.#characterController.setPosition(this.voxelPosition);
		this.#characterController.setVelocity(this.#zeroVelocity);
	}

	// ── Public update ─────────────────────────────────────────────────────────

	public updateCameraAndVisuals(deltaMs?: number): void {
		Quaternion.FromEulerAnglesToRef(
			0,
			this.#camera.cameraYaw,
			0,
			this.#characterOrientation,
		);
		this.#camera.moveWithPlayer(
			this.getPositionInternal(),
			deltaMs !== undefined ? deltaMs / 1000 : undefined,
		);
		this.#displayCapsule.position.copyFrom(this.getPositionInternal());
		const rq = this.#displayCapsule.rotationQuaternion;
		rq.set(
			this.#characterOrientation.x,
			this.#characterOrientation.y,
			this.#characterOrientation.z,
			this.#characterOrientation.w,
		);
	}

	public update(deltaTimeMs: number): void {
		// PlayerLoopController passes the frame delta in MILLISECONDS; the motor
		// integrates physics in SECONDS, so convert once at the boundary.
		const deltaTime = deltaTimeMs / 1000;
		if (this.isJumpHeld) this.wantJump = Math.max(this.wantJump, 1);

		if (this.#movementLocked) {
			if (this.#lockedPosition) {
				copyVec3(this.voxelPosition, this.#lockedPosition);
				this.#characterController.setPosition(this.#lockedPosition);
			}
			setVec3(this.voxelVelocity, 0, 0, 0);
			this.#characterController.setVelocity(this.#zeroVelocity);
			this.voxelCollider.syncDebugMesh(this.voxelPosition);
			return;
		}

		const isSneaking = this.#controls.isSneaking;
		if (isSneaking !== this.#previousSneaking) {
			this.#previousSneaking = isSneaking;
			const newHalfHeight = isSneaking
				? this.crouchHalfHeight
				: this.standingHalfHeight;
			const deltaY = newHalfHeight - this.colliderHalfHeight;
			let canChange = true;

			// When uncrouching, check for headroom before expanding
			if (!isSneaking && deltaY > 0) {
				setVec3(
					this.#tmpProbe,
					this.voxelPosition.x,
					this.voxelPosition.y + this.colliderHalfHeight + deltaY,
					this.voxelPosition.z,
				);
				setVec3(
					this.#tmpV,
					this.colliderHalfWidth,
					deltaY,
					this.colliderHalfWidth,
				);
				if (this.voxelCollider.overlapsBox(this.#tmpProbe, this.#tmpV)) {
					this.#previousSneaking = true;
					canChange = false;
				}
			}

			if (canChange) {
				this.colliderHalfHeight = newHalfHeight;
				setVec3(
					this.#tmpHalfExtents,
					this.colliderHalfWidth,
					newHalfHeight,
					this.colliderHalfWidth,
				);
				this.voxelCollider.HalfExtents = this.#tmpHalfExtents;
				this.boatVoxelCollider.HalfExtents = this.#tmpHalfExtents;
				this.#displayCapsule.scaling.y =
					newHalfHeight / this.standingHalfHeight;
				this.voxelPosition.y += deltaY;
				this.#characterController.setPosition(this.voxelPosition);
			}
		}

		const mount = this.mount;
		if (mount) {
			mount.update();
			copyVec3(this.voxelPosition, this.#characterController.getPosition());
			setVec3(this.voxelVelocity, 0, 0, 0);
		} else {
			if (this.isFlying) {
				const dv = this.calculateFlyingVelocity(deltaTime);
				this.setVelocityInternal(dv);
				// PERF: scaleVec3ToRef avoids allocating the intermediate sum.
				scaleVec3ToRef(dv, deltaTime, _scratchB);
				addVec3InPlace(this.voxelPosition, _scratchB);
				this.#characterController.setPosition(this.voxelPosition);
				this.#characterController.setVelocity(this.#zeroVelocity);
				this.voxelCollider.syncDebugMesh(this.voxelPosition);
				return;
			}
			this.integrateMovement(deltaTime);
		}

		this.voxelCollider.syncDebugMesh(this.voxelPosition);
	}

	public lockMovementAtCurrentPosition(): void {
		const cur = this.getPositionInternal();
		this.#lockedPosition = vec3(cur.x, cur.y, cur.z);
		this.#movementLocked = true;
		copyVec3(this.voxelPosition, this.#lockedPosition);
		this.#characterController.setPosition(this.#lockedPosition);
		this.#characterController.setVelocity(this.#zeroVelocity);
		this.#camera.snapToPlayer(this.#lockedPosition);
		this.#displayCapsule.position.copyFrom(this.#lockedPosition);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
	}

	public unlockMovement(): void {
		this.#movementLocked = false;
		this.#lockedPosition = null;
		setVec3(this.voxelVelocity, 0, 0, 0);
		this.#characterController.setVelocity(this.#zeroVelocity);
	}

	public getSavedPosition(): Vec3 {
		const p = this.getPositionInternal();
		return vec3(p.x, p.y, p.z);
	}

	public restoreSavedPosition(position: unknown): boolean {
		if (!this.isValidSavedPosition(position)) return false;
		const p = vec3(
			position.x,
			position.y < -1000 ? 32 : position.y,
			position.z,
		);
		copyVec3(this.voxelPosition, p);
		setVec3(this.voxelVelocity, 0, 0, 0);
		this.#characterController.setPosition(p);
		if (this.#movementLocked) this.#lockedPosition = vec3(p.x, p.y, p.z);
		this.#camera.snapToPlayer(p);
		this.#displayCapsule.position.copyFrom(p);
		this.voxelCollider.syncDebugMesh(this.voxelPosition);
		const view = position as { yaw?: unknown; pitch?: unknown };
		if (
			typeof view.yaw === "number" &&
			Number.isFinite(view.yaw) &&
			typeof view.pitch === "number" &&
			Number.isFinite(view.pitch)
		) {
			// View angles use the network convention (degrees, negative pitch =
			// looking down); the camera stores radians with the opposite sign.
			this.#camera.cameraYaw = (view.yaw * Math.PI) / 180;
			this.#camera.cameraPitch = (-view.pitch * Math.PI) / 180;
		}
		this.#savedPositionRestored = true;
		return true;
	}

	/** True once a previously saved position has been restored this session. */
	public hasRestoredSavedPosition(): boolean {
		return this.#savedPositionRestored;
	}

	/**
	 * Current position plus the camera view angles (degrees, network
	 * convention: negative pitch means looking down).
	 */
	public getSavedViewState(): {
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	} {
		const p = this.getPositionInternal();
		return {
			x: p.x,
			y: p.y,
			z: p.z,
			yaw: (this.#camera.cameraYaw * 180) / Math.PI,
			pitch: (-this.#camera.cameraPitch * 180) / Math.PI,
		};
	}

	// ── Integration ───────────────────────────────────────────────────────────

	private initializeCharacter(): void {
		this.#displayCapsule = this.createCharacterMesh();
		const start = vec3(0, 165, 0);
		this.#characterController = new SimpleCharacterController(start);
		this.configureCharacterController();
		copyVec3(this.voxelPosition, start);
		setVec3(this.voxelVelocity, 0, 0, 0);
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

	private createCharacterMesh(): Mesh {
		ensureWorldRigLights(this.scene);
		const body = createPlayerRigMesh(
			this.#engine,
			"playerDisplayRig",
			"center",
		);
		const mat = createStandardMaterial();
		mat.specularColor = [0, 0, 0];
		mat.backFaceCulling = false;
		body.material = mat;
		body.pickable = false;
		body.visible = false;
		addToScene(this.scene, body);
		applyPlayerSkin(this.#engine, this.scene, mat);
		return body;
	}

	private integrateMovement(deltaTime: number): void {
		this.integrateVoxelMovement(deltaTime);
	}

	private integrateVoxelMovement(deltaTime: number): void {
		this.now = performance.now();
		// Cache environment queries once per frame; substeps reuse them.
		this.frameIsInWater = this.isInWater();
		if (deltaTime <= 1 / 60) {
			this.integrateVoxelMovementStep(deltaTime);
			return;
		}
		const sub = Math.min(8, Math.ceil(deltaTime / (1 / 120)));
		const dt = deltaTime / sub;
		for (let i = 0; i < sub; i++) this.integrateVoxelMovementStep(dt);
	}

	// ── Physics helpers ───────────────────────────────────────────────────────

	private calculateFlyingVelocity(deltaTime: number): Vec3 {
		// PERF: Use #tmpDv scratch instead of allocating a new dv vector.
		const dv = this.#tmpDv;
		scaleVec3ToRef(this.inputDirection, this.onGroundSpeed * 112.5, dv);
		const q = this.#characterOrientation;
		_rotateVec3ByQuat(dv.x, dv.y, dv.z, q.x, q.y, q.z, q.w, dv);

		if (this.wantJump > 0) {
			// up = -gravity normalised; multiply inline to avoid getUpVector alloc.
			const spd = this.onGroundSpeed * 112.5;
			dv.x += this.#upX * spd;
			dv.y += this.#upY * spd;
			dv.z += this.#upZ * spd;
		}
		if (this.#controls.isSneaking) {
			const spd = this.onGroundSpeed * 112.5;
			dv.x -= this.#upX * spd;
			dv.y -= this.#upY * spd;
			dv.z -= this.#upZ * spd;
			scaleVec3InPlace(dv, this.sneakMultiplier);
		}

		const cur = this.velocity;
		if (lengthSqVec3(dv) < 0.01) {
			// PERF: scaleVec3ToRef into existing scratch avoids clone + scaleInPlace.
			return scaleVec3ToRef(cur, this.deceleration, this.#tmpV);
		}
		return this.accelerateInto(
			cur,
			dv,
			this.accelRateGround,
			deltaTime,
			this.#tmpV,
		);
	}

	private accelerateInto(
		cur: Vec3,
		tgt: Vec3,
		maxA: number,
		dt: number,
		out: Vec3,
	): Vec3 {
		// PERF: Inline subtract + length check; no allocation.
		const dx = tgt.x - cur.x;
		const dy = tgt.y - cur.y;
		const dz = tgt.z - cur.z;
		const lenSq = dx * dx + dy * dy + dz * dz;
		if (lenSq < 0.01) {
			copyVec3(out, cur);
			return out;
		}
		const len = Math.sqrt(lenSq);
		const scale = Math.min(len, maxA * dt) / len;
		return setVec3(
			out,
			cur.x + dx * scale,
			cur.y + dy * scale,
			cur.z + dz * scale,
		);
	}

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

	private isValidSavedPosition(p: unknown): p is Vec3 {
		if (!p || typeof p !== "object") return false;
		const c = p as Partial<Vec3>;
		return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z);
	}

	private getPositionInternal(): Vec3 {
		return this.voxelPosition;
	}

	private setVelocityInternal(v: Vec3): void {
		copyVec3(this.voxelVelocity, v);
	}

	/** Current world-space velocity of the player body (m/s). */
	public get velocity(): Vec3 {
		return this.voxelVelocity;
	}
}
