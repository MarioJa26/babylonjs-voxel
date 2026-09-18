import { onBeforeRender, type SceneContext, type Vec3 } from "@babylonjs/lite";
import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { isUiOpen } from "@/code/Lib/GameRuntimeState";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import { playMobDamage } from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import type { Player } from "@/code/Player/Player";
import { Chunk, getChunk } from "@/code/World/Chunk/Chunk";
import {
	getBlockByWorldCoords,
	registerChunkBoundEntity,
	resolveBlockAtWorldCoords,
	unregisterChunkBoundEntity,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	_voxelResolveScratch,
	Axis,
	createVoxelColliderBlockSampler,
	UNLOADED_SOLID_RESOLVE,
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import type { SavedChunkEntityData } from "@/code/World/WorldStorage";
import { DEFAULT_FLEE_RADIUS_SQ, isNightTimeFraction } from "../MobConfig";

const STEP_SIZE = 0.2;
const EPSILON = 0.001;

/** Steering responsiveness: higher snaps harder onto the waypoint line. */
const STEER_DAMPING = 2.5;
/** Panic burst speed multiplier over wander speed. */
const PANIC_SPEED_MULT = 1.8;
/** Seconds a damaged bird flees before resuming its route. */
const PANIC_DURATION = 2.5;
/** 3D distance that counts as "reached" for a waypoint. */
const WAYPOINT_REACH = 0.9;
/** Upward escape speed when blocked or dunked. */
const CLIMB_SPEED = 2.5;
/** Consecutive blocked ticks before abandoning the current waypoint. */
const BLOCKED_REPICK_TICKS = 3;
/** Fraction of intended per-axis travel that counts as "moved". */
const BLOCKED_MOVE_FRACTION = 0.3;

/** Radians of flap phase accumulated per meter flown (shader ×3). */
const FLAP_STRIDE_FACTOR = 2.0;
/** Phase decay rate (per second) when still — wings ease back to rest. */
const FLAP_PHASE_DECAY = 6.0;

/** True when the world clock is in its night phase (mirrors SpawnCoordinator). */
function isNightNow(): boolean {
	const env = Map1.environment;
	if (!env) return false;
	return isNightTimeFraction(
		env.getTimeOfDayMs() / SETTING_PARAMS.DAY_DURATION_MS,
	);
}

/**
 * Flying mob base, the airborne counterpart to NeutralMob/AquaticMob.
 *
 * Gravity-free 3D waypoint steering with voxel-collider sliding: blocked
 * axes climb or repick instead of tunneling. Wing flap phase advances with
 * distance flown and decays when still, so perched birds fold their wings.
 * Panics (fast burst away) on player proximity or damage.
 *
 * Birds are never persistent: serializeForChunkReload always returns null,
 * so unloaded chunks simply dispose them instead of reloading them later.
 */
export abstract class FlyingMob {
	abstract readonly mobType: string;

	/** Spawn eggs set this to false before registry insertion (cap-exempt). */
	countsTowardMobCap = true;

	#hp: number;
	#maxHp: number;
	#position = vec3Zero();
	#hitHalfExtents: Vec3;
	#velocity = vec3Zero();
	#collider: VoxelAabbCollider;
	#scene: SceneContext;
	#facingAngle = 0;
	#playerPosition: Vec3 | null = null;
	#isDisposed = false;
	#chunkBindingHandle?: symbol;
	#fleeTimer = 0;
	#wanderSpeed: number;

	#waypoint = vec3Zero();
	#hasWaypoint = false;
	#idleTimer = 0;
	#blockedTicks = 0;
	// Perch hold (songbirds): while positive the bird sits still instead
	// of routing. Cleared by panic so damage always flushes a perched bird.
	#holdTimer = 0;

	// Flap phase (radians) advanced by distance flown and decayed when
	// still. Written to the instance color alpha channel by
	// syncToInstances(); the wing shader triple-times it.
	#flapPhase = 0;
	#prevX = Number.NaN;
	#prevY = Number.NaN;
	#prevZ = Number.NaN;

	abstract getWanderSpeed(): number;
	abstract onDeath(): void;
	/** Push the mob's current transform into its instance pool slots. */
	protected abstract syncToInstances(): void;
	/**
	 * Pick the next flight target (world coords) or null to drift idly.
	 * Called on spawn, on arrival, and when the current route is blocked.
	 */
	protected abstract pickWaypoint(pos: Vec3): Vec3 | null;
	/** Called when a waypoint is reached (e.g. songbirds start perching). */
	protected onWaypointReached(): void {}

	/**
	 * Squared radius (meters) within which a nearby player triggers panic.
	 * Return 0 to disable proximity panic (damage still panics).
	 */
	protected getPanicRadiusSq(): number {
		return DEFAULT_FLEE_RADIUS_SQ;
	}

	/** Called when the mob takes damage but survives. */
	protected onDamaged(): void {
		this.triggerPanic(PANIC_DURATION);
	}

	/**
	 * Flee directly away from the player for `duration` seconds, ignoring
	 * waypoints until it expires.
	 */
	protected triggerPanic(duration: number): void {
		this.#fleeTimer = Math.max(this.#fleeTimer, duration);
	}

	/**
	 * Sit still for `seconds` (perching): velocity damps to zero and no new
	 * waypoints are picked until it expires. Panic clears it.
	 */
	protected holdStill(seconds: number): void {
		this.#holdTimer = Math.max(this.#holdTimer, seconds);
	}

	/** True while perched (holding still by choice, not panic). */
	protected get isHolding(): boolean {
		return this.#holdTimer > 0;
	}

	static #observerRegistered = false;
	static readonly #allMobs = new Set<FlyingMob>();

	static #ensureObserver(): void {
		if (FlyingMob.#observerRegistered) return;

		FlyingMob.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001;
			if (dt <= 0 || isUiOpen()) return;

			// PERF: night flag hoisted out of the per-bird tick — was
			// Map1.environment + division per bird per frame.
			const night = isNightNow();

			frameProfiler.begin("birds");
			for (const mob of FlyingMob.#allMobs) {
				const pos = mob.#position;
				const chunk = getChunk(
					Math.floor(pos.x / Chunk.SIZE),
					Math.floor(pos.y / Chunk.SIZE),
					Math.floor(pos.z / Chunk.SIZE),
				);

				// Same streaming gate as walkers/swimmers: never tick on
				// missing voxel data or far LOD.
				if (
					!chunk?.isLoaded ||
					!chunk?.hasVoxelData ||
					(chunk?.lodLevel ?? 2) > 1
				) {
					continue;
				}

				mob.tick(dt, night);
			}
			frameProfiler.end("birds");
		});
	}

	static disposeAll(): void {
		for (const mob of FlyingMob.#allMobs) {
			mob.dispose();
		}
	}

	protected constructor(
		hp: number,
		scene: SceneContext,
		halfSize: Vec3,
		// Reserved for API symmetry with NeutralMob; flyers perch and
		// steer in full 3D, so they never need a feet offset.
		_feetHeight?: number,
	) {
		this.#hp = hp;
		this.#maxHp = hp;
		this.#scene = scene;
		this.#hitHalfExtents = { x: halfSize.x, y: halfSize.y, z: halfSize.z };
		this.#wanderSpeed = this.getWanderSpeed();

		this.#collider = new VoxelAabbCollider(
			halfSize,
			createVoxelColliderBlockSampler(
				(wx, wy, wz) => {
					const r = resolveBlockAtWorldCoords(wx, wy, wz);
					if (r.unloaded) return UNLOADED_SOLID_RESOLVE;
					if (!isCollidableBlock(r.blockId)) return null;

					_voxelResolveScratch.blockId = r.blockId;
					_voxelResolveScratch.blockState = r.blockState;
					return _voxelResolveScratch;
				},
				{
					getFenceDynamicShape,
					getShapeForBlockId,
					isFenceBlockId,
					computeFenceNeighborMask,
				},
			),
			EPSILON,
		);
	}

	/** Spawn position for subclasses that own their instance slots. */
	protected setPosition(x: number, y: number, z: number): void {
		setVec3(this.#position, x, y, z);
	}

	get facingYaw(): number {
		return this.#facingAngle;
	}

	/** Current flap phase (radians) for wing animation. */
	protected get walkPhase(): number {
		return this.#flapPhase;
	}

	get hitHalfExtents(): Vec3 {
		return this.#hitHalfExtents;
	}

	/** Register chunk binding + tick loop after instance slots are claimed. */
	protected finalizeRegistration(): void {
		this.#chunkBindingHandle = registerChunkBoundEntity({
			getWorldPosition: () => this.#position,
			unload: () => this.dispose(),
			isAlive: () => !this.#isDisposed,
			serializeForChunkReload: () => this.#serializeForChunkReload(),
		});

		FlyingMob.#allMobs.add(this);
		FlyingMob.#ensureObserver();
	}

	protected get scene(): SceneContext {
		return this.#scene;
	}

	get position(): Vec3 {
		return this.#position;
	}

	get hp(): number {
		return this.#hp;
	}

	set hp(value: number) {
		this.#hp = Math.max(0, Math.min(value, this.#maxHp));
	}

	get maxHp(): number {
		return this.#maxHp;
	}

	setPlayerPosition(pos: Vec3): void {
		this.#playerPosition = pos;
	}

	takeDamage(amount: number, impactPosition?: Vec3): void {
		this.#hp -= amount;

		const bloodPosition = impactPosition ?? this.#position;
		playMobDamage(bloodPosition.x, bloodPosition.y, bloodPosition.z, amount);

		if (this.#hp <= 0) {
			this.onDeath();
			this.dispose();
		} else {
			this.onDamaged();
		}
	}

	/**
	 * Birds never persist: chunk unload disposes them via the binding above
	 * and reload finds nothing, so fly-overs that leave reach are gone for
	 * good instead of popping back in.
	 */
	serializeForChunkReload(): SavedChunkEntityData | null {
		return this.#serializeForChunkReload();
	}

	use(_player: Player): void {
		// Placeholder
	}

	dispose(): void {
		if (this.#isDisposed) return;

		this.#isDisposed = true;

		unregisterChunkBoundEntity(this.#chunkBindingHandle);
		this.#chunkBindingHandle = undefined;

		FlyingMob.#allMobs.delete(this);
		Map1.mobRegistry?.removeMob(this);

		this.#collider.dispose();
	}

	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	#serializeForChunkReload(): SavedChunkEntityData | null {
		return null;
	}

	tick(dt: number, night: boolean): void {
		if (this.#isDisposed) {
			FlyingMob.#allMobs.delete(this);
			return;
		}

		// Day-only ambient: nightfall clears the sky quietly (no drops).
		// `night` is computed once per frame by the family loop.
		if (night) {
			this.dispose();
			return;
		}

		const pos = this.#position;
		const velocity = this.#velocity;
		let speed = this.#wanderSpeed;

		// Panic: fast burst directly away from the player, ignoring routes.
		let panicking = false;
		if (this.#fleeTimer > 0) {
			this.#fleeTimer = Math.max(0, this.#fleeTimer - dt);
			panicking = this.#fleeTimer > 0;
		} else {
			const playerPosition = this.#playerPosition;
			const panicRadiusSq = this.getPanicRadiusSq();
			if (playerPosition !== null && panicRadiusSq > 0) {
				const dx = pos.x - playerPosition.x;
				const dy = pos.y - playerPosition.y;
				const dz = pos.z - playerPosition.z;
				if (dx * dx + dy * dy + dz * dz < panicRadiusSq) {
					this.#fleeTimer = PANIC_DURATION;
					panicking = true;
				}
			}
		}

		if (panicking && this.#playerPosition !== null) {
			this.#holdTimer = 0;
			const away = this.#playerPosition;
			const dx = pos.x - away.x;
			const dy = pos.y - away.y + 1.5;
			const dz = pos.z - away.z;
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
			const panicSpeed = this.#wanderSpeed * PANIC_SPEED_MULT;
			velocity.x = (dx / dist) * panicSpeed;
			velocity.y = (dy / dist) * panicSpeed;
			velocity.z = (dz / dist) * panicSpeed;
			this.#hasWaypoint = false;
			speed = panicSpeed;
		} else if (this.#holdTimer > 0) {
			// Perched: sit still, wings folding via phase decay below.
			this.#holdTimer = Math.max(0, this.#holdTimer - dt);
			const perchDamp = Math.max(0, 1 - STEER_DAMPING * 2 * dt);
			velocity.x *= perchDamp;
			velocity.y *= perchDamp;
			velocity.z *= perchDamp;
		} else {
			// Route following: arrive → notify → idle → repick.
			if (this.#hasWaypoint) {
				const dx = this.#waypoint.x - pos.x;
				const dy = this.#waypoint.y - pos.y;
				const dz = this.#waypoint.z - pos.z;
				if (dx * dx + dy * dy + dz * dz < WAYPOINT_REACH * WAYPOINT_REACH) {
					this.#hasWaypoint = false;
					this.onWaypointReached();
				}
			}

			if (!this.#hasWaypoint) {
				if (this.#idleTimer > 0) {
					this.#idleTimer = Math.max(0, this.#idleTimer - dt);
					velocity.x *= Math.max(0, 1 - STEER_DAMPING * dt);
					velocity.y *= Math.max(0, 1 - STEER_DAMPING * dt);
					velocity.z *= Math.max(0, 1 - STEER_DAMPING * dt);
				} else {
					const next = this.pickWaypoint(pos);
					if (next) {
						setVec3(this.#waypoint, next.x, next.y, next.z);
						this.#hasWaypoint = true;
					} else {
						this.#idleTimer = 0.5 + Math.random();
					}
				}
			}

			if (this.#hasWaypoint) {
				const dx = this.#waypoint.x - pos.x;
				const dy = this.#waypoint.y - pos.y;
				const dz = this.#waypoint.z - pos.z;
				const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
				const steer = Math.min(1, STEER_DAMPING * dt);
				velocity.x += ((dx / dist) * speed - velocity.x) * steer;
				velocity.y += ((dy / dist) * speed - velocity.y) * steer;
				velocity.z += ((dz / dist) * speed - velocity.z) * steer;
			}
		}

		// Dunked (rain? splashdown): climb out and reroute.
		if (
			getBlockByWorldCoords(
				Math.floor(pos.x),
				Math.floor(pos.y),
				Math.floor(pos.z),
			) === BlockType.Water
		) {
			velocity.y = Math.max(velocity.y, CLIMB_SPEED);
			this.#hasWaypoint = false;
		}

		// Void safety net: never sink below the world.
		if (pos.y < 1) {
			velocity.y = Math.max(velocity.y, CLIMB_SPEED);
		}

		// Face travel direction (banking is yaw-only, like walkers).
		const hSpeedSq = velocity.x * velocity.x + velocity.z * velocity.z;
		if (hSpeedSq > 0.09) {
			this.#facingAngle = Math.atan2(velocity.x, velocity.z);
		}

		// Move per axis through the voxel collider so terrain slides
		// instead of tunneling. Track blocked horizontal axes to climb or
		// abandon the route.
		// PERF: unrolled axes — the old `for (const axis of [X,Y,Z])`
		// allocated a 3-element array per bird per tick.
		let blockedAxes = 0;
		{
			const deltaX = velocity.x * dt;
			if (deltaX !== 0) {
				const before = pos.x;
				this.#collider.moveAxis(pos, velocity, Axis.X, deltaX, STEP_SIZE);
				if (
					Math.abs(deltaX) > 0.001 &&
					Math.abs(pos.x - before) < Math.abs(deltaX) * BLOCKED_MOVE_FRACTION
				) {
					blockedAxes++;
				}
			}
		}
		{
			const deltaY = velocity.y * dt;
			if (deltaY !== 0) {
				this.#collider.moveAxis(pos, velocity, Axis.Y, deltaY, STEP_SIZE);
			}
		}
		{
			const deltaZ = velocity.z * dt;
			if (deltaZ !== 0) {
				const before = pos.z;
				this.#collider.moveAxis(pos, velocity, Axis.Z, deltaZ, STEP_SIZE);
				if (
					Math.abs(deltaZ) > 0.001 &&
					Math.abs(pos.z - before) < Math.abs(deltaZ) * BLOCKED_MOVE_FRACTION
				) {
					blockedAxes++;
				}
			}
		}

		if (!panicking && blockedAxes > 0) {
			this.#blockedTicks++;
			if (this.#blockedTicks >= BLOCKED_REPICK_TICKS) {
				this.#blockedTicks = 0;
				this.#hasWaypoint = false;
				velocity.y = Math.max(velocity.y, CLIMB_SPEED);
			} else {
				velocity.y += CLIMB_SPEED * dt;
			}
		} else {
			this.#blockedTicks = 0;
		}

		// Flap phase advances with 3D distance flown, decays when still.
		if (Number.isNaN(this.#prevX)) {
			this.#prevX = pos.x;
			this.#prevY = pos.y;
			this.#prevZ = pos.z;
		} else {
			const traveledX = pos.x - this.#prevX;
			const traveledY = pos.y - this.#prevY;
			const traveledZ = pos.z - this.#prevZ;
			const traveledSq =
				traveledX * traveledX + traveledY * traveledY + traveledZ * traveledZ;

			if (traveledSq > 0.0001) {
				this.#flapPhase += Math.sqrt(traveledSq) * FLAP_STRIDE_FACTOR;
			} else if (this.#flapPhase !== 0) {
				this.#flapPhase *= Math.max(0, 1 - FLAP_PHASE_DECAY * dt);

				if (this.#flapPhase < 0.01) {
					this.#flapPhase = 0;
				}
			}

			this.#prevX = pos.x;
			this.#prevY = pos.y;
			this.#prevZ = pos.z;
		}

		this.syncToInstances();
	}
}
