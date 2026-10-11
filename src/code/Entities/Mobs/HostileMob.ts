import type { SceneContext, Vec3 } from "@babylonjs/lite";
import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { isUiOpen } from "@/code/Lib/GameRuntimeState";
import {
	playLandingDust,
	playMobDamageDirected,
	playMobDeath,
} from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import { Gamemodes } from "@/code/Player/PlayerStats";
import { Chunk, getChunk } from "@/code/World/Chunk/Chunk";
import {
	getBlockByWorldCoords,
	getLightByWorldCoords,
	resolveBlockAtWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { Axis } from "@/code/World/Collision/VoxelAabbCollider";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import {
	findPathInto,
	type PathWaypoint,
} from "@/code/World/Pathfinding/Pathfinding";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import { FALL_DAMAGE_PER_BLOCK, FALL_DAMAGE_THRESHOLD } from "../MobConfig";
import { getMeleeDamage, getMeleeRange } from "../WeaponStats";
import { BaseMob, MobTickSet } from "./BaseMob";

const GRAVITY = -18;

/** Radians of walk-swing phase accumulated per meter of travel. */
const WALK_STRIDE_FACTOR = 2.0;
/** Phase decay rate (per second) when idle. */
const WALK_PHASE_DECAY = 6.0;

/** Blocks: chase starts inside this radius of the player. */
const DEFAULT_AGGRO_RADIUS = 16;
/** Blocks: chase breaks beyond this radius (hysteresis vs aggro). */
const DEFAULT_DEAGGRO_RADIUS = 32;
/** Seconds between melee swings. */
const DEFAULT_ATTACK_INTERVAL = 1.0;
/** Sun-up threshold: daylight burn runs while the sun is above this. */
const DAYLIGHT_SUN_UP = -0.12;
/** Baked skylight at the head cell that counts as "open sky" for burning. */
const DAYLIGHT_OPEN_SKY = 12;
/** Daylight burn damage per second (silent death — no drops). */
const DAYLIGHT_BURN_DPS = 2;

const MAX_SAFE_LEDGE_DROP = 3;
const LEDGE_SCAN_SLACK = 2;
const LEDGE_WATER_SCAN_DEPTH = 12;
const WATER_GRAVITY = -3.0;
const WATER_FLOAT_ACCEL = 18.0;
const WATER_SURFACE_OFFSET = 0.1;
const WATER_MAX_UP_SPEED = 1.25;
const WATER_MAX_DOWN_SPEED = -0.35;
const WATER_HORIZONTAL_DAMPING = 2.0;
const WATER_VERTICAL_DAMPING = 3.3;
const SWIM_BUOYANCY = 6.0;

const enum HostileMobState {
	Idle,
	Wander,
	Chase,
}

/**
 * Hostile mob base — the player-hunting counterpart to NeutralMob.
 *
 * Singleplayer simulation: wanders at night, chases the player inside its
 * aggro radius, and melees with its WEAPON's reach/damage (see WeaponStats —
 * never hardcoded per mob). Burns silently in daylight under open sky.
 * Undead don't breathe, so there is no drowning; water only slows them.
 *
 * Multiplayer rendering/positioning is server-authoritative (RemoteMobManager
 * + MobSimulation); this class is the singleplayer body plus the shared
 * movement tuning the server mirrors.
 */
export abstract class HostileMob extends BaseMob {
	abstract readonly mobType: string;
	abstract readonly CHUNK_ENTITY_TYPE: string;

	#state: HostileMobState = HostileMobState.Idle;
	#stateTimer = 0;
	#attackCooldown = 0;
	#chasePathTimer = 0;
	// True while pursuing a target (arms-up attack pose). Drives the pose
	// through onAttackPoseChanged; transitions only.
	#attackHolding = false;

	// PERF: cliff-guard result cache (see #hasLethalDropAhead). A moving mob
	// re-probes the same column for ~30 frames while a full scan costs up to
	// 13 mutation-layer resolves per call.
	#ledgePx = 0x7fffffff;
	#ledgeFeetY = 0x7fffffff;
	#ledgePz = 0x7fffffff;
	#ledgeResult = false;
	#ledgeRevA = -1;
	#ledgeRevB = -1;

	#path: PathWaypoint[] = [];
	#pathIndex = 0;
	#inWaterCached = false;
	#waterSurfaceY = 0;
	readonly #requiredHeadroom: number;

	abstract configureChunkLoader(scene: SceneContext): void;
	abstract getWanderSpeed(): number;
	abstract onDeath(): void;
	/** Push the mob's current transform into its instance pool slots. */
	protected abstract syncToInstances(): void;

	/** Equipped weapon item id (virtual ids allowed) — drives reach+damage. */
	protected getWeaponId(): number | undefined {
		return undefined;
	}
	protected getAggroRadiusSq(): number {
		return DEFAULT_AGGRO_RADIUS * DEFAULT_AGGRO_RADIUS;
	}
	protected getDeaggroRadiusSq(): number {
		return DEFAULT_DEAGGRO_RADIUS * DEFAULT_DEAGGRO_RADIUS;
	}
	protected getAttackIntervalSec(): number {
		return DEFAULT_ATTACK_INTERVAL;
	}
	/** False opts out of daylight burning (for future nether-style mobs). */
	protected getBurnsInDaylight(): boolean {
		return true;
	}

	/**
	 * Fires when the mob starts/stops pursuing a target. Subclasses override
	 * to swap visuals (e.g. raised-arm attack pose). Only fires on
	 * transitions, never every tick.
	 */
	protected onAttackPoseChanged(_attacking: boolean): void {}

	#setAttackHolding(holding: boolean): void {
		if (holding === this.#attackHolding) return;
		this.#attackHolding = holding;
		this.onAttackPoseChanged(holding);
	}

	static readonly ticks = new MobTickSet<HostileMob>(HostileMob.tickAll);
	static #pathSlotsRemaining = 0;
	private static readonly PATH_SLOTS_PER_TICK = 2;

	private static tryClaimPathSlot(): boolean {
		if (HostileMob.#pathSlotsRemaining <= 0) return false;
		HostileMob.#pathSlotsRemaining--;
		return true;
	}

	private static tickAll(deltaMs: number): void {
		const dt = deltaMs * 0.001;
		if (dt <= 0 || isUiOpen()) return;

		HostileMob.#pathSlotsRemaining = HostileMob.PATH_SLOTS_PER_TICK;

		HostileMob.ticks.drain();

		frameProfiler.begin("hostileMobs");
		for (const mob of HostileMob.ticks) {
			const pos = mob.bodyPosition;
			const chunk = getChunk(
				Math.floor(pos.x / Chunk.SIZE),
				Math.floor(pos.y / Chunk.SIZE),
				Math.floor(pos.z / Chunk.SIZE),
			);
			if (
				!chunk ||
				!chunk.isLoaded ||
				!chunk.hasVoxelData ||
				chunk.lodLevel > 1
			) {
				continue;
			}
			mob.tick(dt);
		}
		frameProfiler.end("hostileMobs");
	}

	static disposeAll(): void {
		HostileMob.ticks.disposeAll();
	}

	protected constructor(
		hp: number,
		scene: SceneContext,
		halfSize: Vec3,
		feetHeight?: number,
	) {
		super(hp, scene, halfSize, feetHeight);
		this.#requiredHeadroom = Math.max(1, Math.ceil(halfSize.y * 2));
	}

	protected override stageForTick(): void {
		HostileMob.ticks.stage(this);
	}

	protected override unstageFromTick(): void {
		HostileMob.ticks.remove(this);
	}

	#updateWaterState(pos: Vec3): boolean {
		const x = Math.floor(pos.x);
		const z = Math.floor(pos.z);
		const feetY = Math.floor(pos.y - this.halfHeight + 0.05);
		const centerY = Math.floor(pos.y);

		const feetInWater = getBlockByWorldCoords(x, feetY, z) === BlockType.Water;
		const centerInWater =
			getBlockByWorldCoords(x, centerY, z) === BlockType.Water;
		const inWater = feetInWater || centerInWater;

		this.#inWaterCached = inWater;
		this.#waterSurfaceY = feetInWater
			? feetY + 1
			: centerInWater
				? centerY + 1
				: 0;
		return inWater;
	}

	protected isInWater(): boolean {
		return this.#inWaterCached;
	}

	/**
	 * Daylight burn check: sun above the horizon and open sky over the
	 * mob's head. Uses the same sun vector the sky renderer writes, so
	 * burning always agrees with the visible sky.
	 */
	#isExposedToDaylight(pos: Vec3): boolean {
		if (GLOBAL_VALUES.skyLightDirection.y > DAYLIGHT_SUN_UP) return false;
		const light = getLightByWorldCoords(
			Math.floor(pos.x),
			Math.floor(pos.y + this.halfHeight),
			Math.floor(pos.z),
		);
		return ((light >> 4) & 0xf) >= DAYLIGHT_OPEN_SKY;
	}

	/** Valid combat target: a set, non-creative player position. */
	#acquireTarget(): Vec3 | null {
		const playerPosition = this.playerPosition;
		if (playerPosition === null) return null;
		const player = Map1.mainPlayer;
		if (!player || player.stats.gamemode === Gamemodes.Creative) return null;
		return playerPosition;
	}

	tick(dt: number): void {
		if (this.isDisposed) {
			HostileMob.ticks.remove(this);
			return;
		}

		const pos = this.bodyPosition;
		const velocity = this.bodyVelocity;

		// Daylight burn ticks before anything else: dawn clears the night's
		// leftovers even mid-chase. Burn deaths are silent (no drops).
		if (this.getBurnsInDaylight() && this.#isExposedToDaylight(pos)) {
			if (this.applySilentDamage(DAYLIGHT_BURN_DPS * dt)) {
				playMobDeath(pos.x, pos.y, pos.z);
				return;
			}
		}

		this.#attackCooldown = Math.max(0, this.#attackCooldown - dt);

		const target = this.#acquireTarget();
		const inWater = this.#updateWaterState(pos);
		let chasing = false;

		if (target !== null) {
			const dx = target.x - pos.x;
			const dy = target.y - pos.y;
			const dz = target.z - pos.z;
			const distSq = dx * dx + dy * dy + dz * dz;

			const aggroSq = this.getAggroRadiusSq();
			const deaggroSq = this.getDeaggroRadiusSq();
			const wasChasing = this.#state === HostileMobState.Chase;
			chasing = wasChasing ? distSq < deaggroSq : distSq < aggroSq;

			if (chasing) {
				this.#state = HostileMobState.Chase;
				this.facingAngle = Math.atan2(dx, dz);
				// Arms up for the whole pursuit, not just the final swing.
				this.#setAttackHolding(true);

				const weaponId = this.getWeaponId();
				const range = getMeleeRange(weaponId);
				const horizontalSq = dx * dx + dz * dz;

				if (horizontalSq <= range * range && Math.abs(dy) <= 2.5) {
					// In reach: hold and swing on cooldown.
					velocity.x = 0;
					velocity.z = 0;
					if (this.#path.length !== 0) {
						this.#path.length = 0;
						this.#pathIndex = 0;
					}
					if (this.#attackCooldown <= 0) {
						this.#attackCooldown = this.getAttackIntervalSec();
						this.#strikePlayer(weaponId);
					}
				} else {
					this.#chaseMove(dt, pos, target, inWater, distSq);
				}
			} else if (wasChasing) {
				this.#state = HostileMobState.Idle;
				this.#stateTimer = 1 + Math.random() * 2;
				this.#path.length = 0;
				this.#pathIndex = 0;
			}
		} else if (this.#state === HostileMobState.Chase) {
			this.#state = HostileMobState.Idle;
			this.#stateTimer = 1 + Math.random() * 2;
			this.#path.length = 0;
			this.#pathIndex = 0;
		}

		// Losing the target for any reason (deaggro, lost position,
		// creative toggle) drops the attack pose.
		if (!chasing) this.#setAttackHolding(false);

		if (!chasing && !inWater) {
			this.#stateTimer -= dt;
			if (this.#stateTimer <= 0) {
				if (this.#state === HostileMobState.Wander) {
					this.#state = HostileMobState.Idle;
					this.#stateTimer = 2 + Math.random() * 3;
					velocity.x = 0;
					velocity.z = 0;
					if (this.#path.length !== 0) {
						this.#path.length = 0;
						this.#pathIndex = 0;
					}
				} else if (HostileMob.tryClaimPathSlot()) {
					this.#state = HostileMobState.Wander;
					this.#stateTimer = 1 + Math.random() * 4;
					this.#pickWanderTarget(pos);
				}
			}
		}

		if (!chasing && this.#state === HostileMobState.Wander) {
			const hasActivePath =
				this.#path.length !== 0 && this.#pathIndex < this.#path.length;
			if (hasActivePath) {
				this.#advanceOnPath(this.wanderSpeed, pos);
			} else if (!inWater) {
				velocity.x = Math.sin(this.facingAngle) * this.wanderSpeed;
				velocity.z = Math.cos(this.facingAngle) * this.wanderSpeed;
			}
		}

		// Vertical: undead wade — float toward the surface, never drown.
		if (inWater) {
			velocity.y += WATER_GRAVITY * dt;
			const targetCenterY =
				this.#waterSurfaceY - this.halfHeight + WATER_SURFACE_OFFSET;
			const surfaceError = targetCenterY - pos.y;
			if (surfaceError > 0) {
				velocity.y +=
					Math.min(surfaceError * WATER_FLOAT_ACCEL, SWIM_BUOYANCY) * dt;
			}
			velocity.y *= Math.max(0, 1 - WATER_VERTICAL_DAMPING * dt);
			if (velocity.y > WATER_MAX_UP_SPEED) velocity.y = WATER_MAX_UP_SPEED;
			else if (velocity.y < WATER_MAX_DOWN_SPEED)
				velocity.y = WATER_MAX_DOWN_SPEED;

			const swimCap = this.wanderSpeed * 0.75;
			const hSq = velocity.x * velocity.x + velocity.z * velocity.z;
			if (hSq > swimCap * swimCap && hSq > 0) {
				const scale = swimCap / Math.sqrt(hSq);
				velocity.x *= scale;
				velocity.z *= scale;
			}
		} else {
			velocity.y += GRAVITY * dt;
		}

		const startY = pos.y;
		const wasGrounded = this.isGrounded(pos);
		const canStepUp = wasGrounded || inWater;

		let moveX = velocity.x * dt;
		const moveY = velocity.y * dt;
		let moveZ = velocity.z * dt;

		// Cliff guard: never walk into drops deeper than MAX_SAFE_LEDGE_DROP,
		// chasing or wandering alike — the mob stops and turns instead.
		if (
			!inWater &&
			wasGrounded &&
			(moveX !== 0 || moveZ !== 0) &&
			this.#hasLethalDropAhead(pos, moveX, moveZ)
		) {
			velocity.x = 0;
			velocity.z = 0;
			moveX = 0;
			moveZ = 0;
			this.facingAngle += Math.PI * (0.5 + Math.random() * 0.5);
			if (this.#path.length !== 0) {
				this.#path.length = 0;
				this.#pathIndex = 0;
			}
			if (!chasing) {
				this.#state = HostileMobState.Idle;
				this.#stateTimer = 1 + Math.random() * 2;
			}
		}

		if (moveX !== 0) this.moveAxis(pos, Axis.X, moveX, canStepUp);
		if (moveY !== 0) this.moveAxis(pos, Axis.Y, moveY, canStepUp);
		if (moveZ !== 0) this.moveAxis(pos, Axis.Z, moveZ, canStepUp);

		let grounded = this.isGrounded(pos);
		const hasCentralSupport = inWater || this.hasCentralSupport(pos);
		if (!hasCentralSupport) {
			grounded = false;
			if (Math.abs(velocity.y) < 0.01) velocity.y = -0.5;
		}
		if (grounded && velocity.y < 0) velocity.y = 0;

		if (inWater) {
			this.fallStartY = Number.NaN;
		} else if (grounded) {
			if (!Number.isNaN(this.fallStartY)) {
				const fallDistance = this.fallStartY - pos.y;
				if (fallDistance > 0.5) {
					playLandingDust(pos.x, pos.y - this.halfHeight, pos.z, fallDistance);
				}
				if (fallDistance > FALL_DAMAGE_THRESHOLD) {
					this.takeDamage(
						(fallDistance - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_PER_BLOCK,
					);
					if (this.isDisposed) return;
				}
				this.fallStartY = Number.NaN;
			}
		} else if (Number.isNaN(this.fallStartY)) {
			this.fallStartY = startY;
		}

		const damping = inWater ? WATER_HORIZONTAL_DAMPING : grounded ? 8 : 1.8;
		const keep = Math.max(0, 1 - damping * dt);
		velocity.x *= keep;
		velocity.z *= keep;
		if (Math.abs(velocity.x) < 0.03) velocity.x = 0;
		if (Math.abs(velocity.z) < 0.03) velocity.z = 0;

		if (Number.isNaN(this.prevX)) {
			this.prevX = pos.x;
			this.prevZ = pos.z;
		} else {
			const traveledX = pos.x - this.prevX;
			const traveledZ = pos.z - this.prevZ;
			const traveledSq = traveledX * traveledX + traveledZ * traveledZ;
			if (traveledSq > 0.0001) {
				this.walkPhase += Math.sqrt(traveledSq) * WALK_STRIDE_FACTOR;
			} else if (this.walkPhase !== 0) {
				this.walkPhase *= Math.max(0, 1 - WALK_PHASE_DECAY * dt);
				if (this.walkPhase < 0.01) this.walkPhase = 0;
			}
			this.prevX = pos.x;
			this.prevZ = pos.z;
		}

		if (!inWater && !hasCentralSupport) {
			if (velocity.y > -2) velocity.y -= 2 * dt;
			if (Math.abs(velocity.y) < 0.1) {
				const nudge = this.tmpFallNudge;
				nudge.x = pos.x;
				nudge.y = pos.y - 0.03;
				nudge.z = pos.z;
				if (!this.bodyCollider.overlaps(nudge)) pos.y -= 0.03;
			}
		}

		this.commitTick();
	}

	/** One melee swing against the tracked player. */
	#strikePlayer(weaponId: number | undefined): void {
		const player = Map1.mainPlayer;
		if (!player || player.stats.gamemode === Gamemodes.Creative) return;
		const pp = player.position;
		const dx = pp.x - this.bodyPosition.x;
		const dz = pp.z - this.bodyPosition.z;
		// Re-verify against the live player body (the tracked position may
		// lag by a tick) with a small tolerance over the weapon's reach.
		const range = getMeleeRange(weaponId) + 0.3;
		if (dx * dx + dz * dz > range * range) return;
		if (Math.abs(pp.y - this.bodyPosition.y) > 3) return;
		const damage = getMeleeDamage(weaponId);
		// Blood blows back toward the mob (opposite the hit facing) so the
		// spray stays in front of the camera instead of past it.
		playMobDamageDirected(pp.x, pp.y, pp.z, damage, -dx, -dz);
		player.stats.takeDamage(damage);
	}

	/**
	 * Chase steering: direct pursuit nearby, short rebuilt paths at range
	 * so walls don't pin the mob. Falls back to direct steering when no
	 * path slot is free.
	 */
	#chaseMove(
		dt: number,
		pos: Vec3,
		target: Vec3,
		inWater: boolean,
		distSq: number,
	): void {
		const speed = this.wanderSpeed * 1.15;
		const dx = target.x - pos.x;
		const dz = target.z - pos.z;

		if (distSq > 64 && !inWater) {
			this.#chasePathTimer -= dt;
			const hasActivePath =
				this.#path.length !== 0 && this.#pathIndex < this.#path.length;
			if (!hasActivePath && this.#chasePathTimer <= 0) {
				this.#chasePathTimer = 1.0;
				if (HostileMob.tryClaimPathSlot()) {
					this.#pickChaseTarget(pos, target);
				} else {
					this.#chasePathTimer = 0.25;
				}
			}
			if (this.#path.length !== 0 && this.#pathIndex < this.#path.length) {
				this.#advanceOnPath(speed, pos);
				return;
			}
		} else if (this.#path.length !== 0) {
			this.#path.length = 0;
			this.#pathIndex = 0;
		}

		const invDist = 1 / Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
		this.bodyVelocity.x = dx * invDist * speed;
		this.bodyVelocity.z = dz * invDist * speed;
	}

	/**
	 * Cliff guard: true when the ground at the mob's next horizontal step
	 * falls away more than MAX_SAFE_LEDGE_DROP below its feet.
	 *
	 * PERF: result cache keyed by probe column + the blockRevisions of the
	 * chunks covering the scan column (feetY down to feetY -
	 * LEDGE_WATER_SCAN_DEPTH spans at most two 32-tall chunks). Any terrain
	 * edit bumps blockRevision, and unload/load transitions flip
	 * isLoaded/hasVoxelData (reads degrade to revision -1), so cache hits
	 * reproduce the uncached scan exactly. The only uncovered input is
	 * boat-deck motion, which can only yield water columns (scanned safe)
	 * and self-corrects on the next column change.
	 */
	#hasLethalDropAhead(pos: Vec3, moveX: number, moveZ: number): boolean {
		const stepLenSq = moveX * moveX + moveZ * moveZ;
		if (stepLenSq <= 0) return false;
		const stepLen = Math.sqrt(stepLenSq);
		const lookAhead = stepLen + 0.5;
		const px = Math.floor(pos.x + (moveX / stepLen) * lookAhead);
		const pz = Math.floor(pos.z + (moveZ / stepLen) * lookAhead);
		const feetY = Math.floor(pos.y - this.feetHeight);

		const cx = Math.floor(px / Chunk.SIZE);
		const cz = Math.floor(pz / Chunk.SIZE);
		const cyA = Math.floor(feetY / Chunk.SIZE);
		const cyB = Math.floor((feetY - LEDGE_WATER_SCAN_DEPTH) / Chunk.SIZE);
		const chA = getChunk(cx, cyA, cz);
		const revA = chA?.isLoaded && chA.hasVoxelData ? chA.blockRevision : -1;
		let revB = revA;
		if (cyB !== cyA) {
			const chB = getChunk(cx, cyB, cz);
			revB = chB?.isLoaded && chB.hasVoxelData ? chB.blockRevision : -1;
		}

		if (
			px === this.#ledgePx &&
			feetY === this.#ledgeFeetY &&
			pz === this.#ledgePz &&
			revA === this.#ledgeRevA &&
			revB === this.#ledgeRevB
		) {
			return this.#ledgeResult;
		}

		const result = this.#scanLedgeDropAhead(px, feetY, pz);

		this.#ledgePx = px;
		this.#ledgeFeetY = feetY;
		this.#ledgePz = pz;
		this.#ledgeResult = result;
		this.#ledgeRevA = revA;
		this.#ledgeRevB = revB;

		return result;
	}

	/** Uncached cliff-guard column scan; see #hasLethalDropAhead. */
	#scanLedgeDropAhead(px: number, feetY: number, pz: number): boolean {
		const solidScanDepth = MAX_SAFE_LEDGE_DROP + LEDGE_SCAN_SLACK;
		for (let dy = 0; dy <= solidScanDepth; dy++) {
			const r = resolveBlockAtWorldCoords(px, feetY - dy, pz);
			if (r.unloaded) return false;
			if (r.blockId === BlockType.Water) return false;
			if (isCollidableBlock(r.blockId)) return dy > MAX_SAFE_LEDGE_DROP;
		}
		for (let dy = solidScanDepth + 1; dy <= LEDGE_WATER_SCAN_DEPTH; dy++) {
			const r = resolveBlockAtWorldCoords(px, feetY - dy, pz);
			if (r.unloaded) return false;
			if (r.blockId === BlockType.Water) return false;
			if (isCollidableBlock(r.blockId)) return true;
		}
		return true;
	}

	#pickWanderTarget(pos: Vec3): void {
		const sx = Math.round(pos.x);
		const sz = Math.round(pos.z);
		const startGroundY = Math.floor(pos.y - 0.5);

		for (let attempt = 0; attempt < 2; attempt++) {
			const angle = Math.random() * Math.PI * 2;
			const dist = 5 + Math.random() * 15;
			const tx = Math.round(pos.x + Math.sin(angle) * dist);
			const tz = Math.round(pos.z + Math.cos(angle) * dist);

			if (
				findPathInto(
					this.#path,
					sx,
					sz,
					startGroundY,
					tx,
					tz,
					this.#requiredHeadroom,
					250,
				)
			) {
				this.#pathIndex = 0;
				const first = this.#path[0];
				this.facingAngle = Math.atan2(
					first.x + 0.5 - pos.x,
					first.z + 0.5 - pos.z,
				);
				return;
			}
		}

		this.#state = HostileMobState.Idle;
		this.#stateTimer = 1 + Math.random() * 2;
		this.bodyVelocity.x = 0;
		this.bodyVelocity.z = 0;
		this.#path.length = 0;
		this.#pathIndex = 0;
	}

	#pickChaseTarget(pos: Vec3, target: Vec3): void {
		const sx = Math.round(pos.x);
		const sz = Math.round(pos.z);
		const startGroundY = Math.floor(pos.y - 0.5);
		const tx = Math.round(target.x);
		const tz = Math.round(target.z);

		this.#path.length = 0;
		this.#pathIndex = 0;
		if (
			findPathInto(
				this.#path,
				sx,
				sz,
				startGroundY,
				tx,
				tz,
				this.#requiredHeadroom,
				300,
			)
		) {
			this.#pathIndex = 0;
		}
	}

	#advanceOnPath(speed: number, pos: Vec3): void {
		while (this.#pathIndex < this.#path.length) {
			const wp = this.#path[this.#pathIndex];
			const dx = wp.x + 0.5 - pos.x;
			const dz = wp.z + 0.5 - pos.z;
			if (dx * dx + dz * dz >= 0.04) break;
			this.#pathIndex++;
		}

		if (this.#pathIndex >= this.#path.length) {
			this.#path.length = 0;
			this.#pathIndex = 0;
			this.bodyVelocity.x = 0;
			this.bodyVelocity.z = 0;
			if (this.#state !== HostileMobState.Chase) {
				this.#state = HostileMobState.Idle;
				this.#stateTimer = 2 + Math.random() * 3;
			}
			return;
		}

		const wp = this.#path[this.#pathIndex];
		const dx = wp.x + 0.5 - pos.x;
		const dz = wp.z + 0.5 - pos.z;
		const distSq = dx * dx + dz * dz;
		if (distSq < 0.0001) {
			this.bodyVelocity.x = 0;
			this.bodyVelocity.z = 0;
			return;
		}
		const invDist = 1 / Math.sqrt(distSq);
		this.bodyVelocity.x = dx * invDist * speed;
		this.bodyVelocity.z = dz * invDist * speed;
		this.facingAngle = Math.atan2(dx, dz);
	}
}
