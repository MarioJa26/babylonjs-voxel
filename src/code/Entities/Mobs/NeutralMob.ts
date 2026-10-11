import type { SceneContext, Vec3 } from "@babylonjs/lite";
import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { isUiOpen } from "@/code/Lib/GameRuntimeState";
import { playLandingDust } from "@/code/Maps/BlockBreakParticles";
import { Chunk, getChunk } from "@/code/World/Chunk/Chunk";
import {
	getBlockByWorldCoords,
	resolveBlockAtWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { Axis } from "@/code/World/Collision/VoxelAabbCollider";
import {
	findLandSurface,
	findPathInto,
	PathNodeKind,
	type PathWaypoint,
} from "@/code/World/Pathfinding/Pathfinding";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import { FALL_DAMAGE_PER_BLOCK, FALL_DAMAGE_THRESHOLD } from "../MobConfig";
import { BaseMob, MobTickSet } from "./BaseMob";

const GRAVITY = -18;
const PANIC_SPEED = 5.0;
const PANIC_RADIUS = 5;
const PANIC_RADIUS_SQ = PANIC_RADIUS * PANIC_RADIUS;

/** Radians of walk-swing phase accumulated per meter of horizontal travel. */
const WALK_STRIDE_FACTOR = 2.0;
/** Phase decay rate (per second) when idle — legs ease back to rest. */
const WALK_PHASE_DECAY = 6.0;

const BREATH_MAX = 5.0;
const DROWN_INTERVAL = 2.0;
const DROWN_DAMAGE = 1;
/**
 * Deepest voluntary step-down (blocks). Drops deeper than this would deal
 * fall damage (see FALL_DAMAGE_THRESHOLD in MobConfig), so grounded mobs
 * refuse to walk into them — the cliff guard stops and turns them instead.
 * Applies to wander drift and fleeing alike.
 */
const MAX_SAFE_LEDGE_DROP = 3;
/** Extra scan depth past MAX_SAFE_LEDGE_DROP before giving up on support. */
const LEDGE_SCAN_SLACK = 2;
/** Deepest water landing the guard still treats as a safe splash-down. */
const LEDGE_WATER_SCAN_DEPTH = 12;
const SWIM_BUOYANCY = 6.0;
const SWIM_SPEED_FACTOR = 0.75;
const WATER_ESCAPE_BUOYANCY = 3.5;
const WATER_ESCAPE_MAX_UP_SPEED = 1.6;
const WATER_GRAVITY = -3.0;
const WATER_FLOAT_ACCEL = 18.0;
const WATER_SURFACE_OFFSET = 0.1;
const WATER_MAX_UP_SPEED = 1.25;
const WATER_MAX_DOWN_SPEED = -0.35;
const WATER_HORIZONTAL_DAMPING = 2.0;
const WATER_VERTICAL_DAMPING = 3.3;

const enum NeutralMobState {
	Idle,
	Wander,
}

export abstract class NeutralMob extends BaseMob {
	abstract readonly mobType: string;
	abstract readonly CHUNK_ENTITY_TYPE: string;

	#state: NeutralMobState = NeutralMobState.Idle;
	#stateTimer = 0;
	#fleeTimer = 0;
	#breathTimer = BREATH_MAX;

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
	#shoreSearchTimer = 0;
	#waterWanderTimer = 0;
	readonly #requiredHeadroom: number;
	#inWaterCached = false;
	#headSubmergedCached = false;
	#waterSurfaceY = 0;

	abstract configureChunkLoader(scene: SceneContext): void;
	abstract getWanderSpeed(): number;
	abstract onDeath(): void;
	/** Push the mob's current transform into its instance pool slots. */
	protected abstract syncToInstances(): void;

	/**
	 * Squared radius (meters) within which a nearby player triggers panic.
	 * Return 0 to disable proximity panic (e.g. sheep only panic on damage).
	 */
	protected getPanicRadiusSq(): number {
		return PANIC_RADIUS_SQ;
	}

	/**
	 * Called when the mob takes damage. Override to trigger a panic response
	 * (e.g. sheep flee for a few seconds when hit).
	 */
	/**
	 * Trigger a panic response: flee from the player for `duration` seconds.
	 * Safe to call from onDamaged() or any other context.
	 */
	protected triggerPanic(duration: number): void {
		this.#fleeTimer = Math.max(this.#fleeTimer, duration);
	}

	static readonly ticks = new MobTickSet<NeutralMob>(NeutralMob.tickAll);

	// PERF: Pathfinding searches are budgeted globally (1500 expansions per
	// 40ms in Pathfinding.ts). When several mobs search on the same frame they
	// exhaust the window together, fail together, and retry together 0.5s
	// later — a synchronized spike. Cap the number of searches that may START
	// per tick; denied mobs simply re-attempt next frame as slots free up.
	static #pathSlotsRemaining = 0;
	private static readonly PATH_SLOTS_PER_TICK = 2;

	private static tryClaimPathSlot(): boolean {
		if (NeutralMob.#pathSlotsRemaining <= 0) return false;
		NeutralMob.#pathSlotsRemaining--;
		return true;
	}

	private static tickAll(deltaMs: number): void {
		const dt = deltaMs * 0.001;
		if (dt <= 0 || isUiOpen()) return;

		NeutralMob.#pathSlotsRemaining = NeutralMob.PATH_SLOTS_PER_TICK;

		NeutralMob.ticks.drain();

		frameProfiler.begin("mobs");
		for (const mob of NeutralMob.ticks) {
			const pos = mob.bodyPosition;
			const chunk = getChunk(
				Math.floor(pos.x / Chunk.SIZE),
				Math.floor(pos.y / Chunk.SIZE),
				Math.floor(pos.z / Chunk.SIZE),
			);

			// Match AquaticMob: skip when the chunk isn't loaded yet or
			// has no voxel data, not just when it's missing or far-LOD.
			// The collision sampler returns null for unloaded cells, so
			// ticking on missing data would make the mob accumulate
			// downward velocity forever (apparent freeze on the streaming
			// seam). Far mobs are also stopped by the lodLevel > 1 gate.
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
		frameProfiler.end("mobs");
	}

	static disposeAll(): void {
		NeutralMob.ticks.disposeAll();
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
		NeutralMob.ticks.stage(this);
	}

	protected override unstageFromTick(): void {
		NeutralMob.ticks.remove(this);
	}

	#updateWaterState(pos: Vec3): boolean {
		const x = Math.floor(pos.x);
		const z = Math.floor(pos.z);
		const feetY = Math.floor(pos.y - this.halfHeight + 0.05);
		const centerY = Math.floor(pos.y);
		const headY = Math.floor(pos.y + this.halfHeight - 0.05);

		const chunkCX = x >> 5;
		const chunkCY = feetY >> 5;
		const chunkCZ = z >> 5;

		let feetInWater = false;
		let centerInWater = false;
		let headInWater = false;

		if (centerY >> 5 === chunkCY && headY >> 5 === chunkCY) {
			const chunk = getChunk(chunkCX, chunkCY, chunkCZ);

			if (chunk?.isLoaded) {
				const lx = x & 31;
				const lz = z & 31;

				feetInWater = chunk.getBlock(lx, feetY & 31, lz) === BlockType.Water;
				centerInWater =
					chunk.getBlock(lx, centerY & 31, lz) === BlockType.Water;
				headInWater = chunk.getBlock(lx, headY & 31, lz) === BlockType.Water;
			}
		} else {
			feetInWater = getBlockByWorldCoords(x, feetY, z) === BlockType.Water;
			centerInWater = getBlockByWorldCoords(x, centerY, z) === BlockType.Water;
			headInWater = getBlockByWorldCoords(x, headY, z) === BlockType.Water;
		}

		const inWater = feetInWater || centerInWater || headInWater;

		this.#inWaterCached = inWater;
		this.#headSubmergedCached = headInWater;

		if (headInWater) {
			this.#waterSurfaceY = headY + 1;
		} else if (centerInWater) {
			this.#waterSurfaceY = centerY + 1;
		} else if (feetInWater) {
			this.#waterSurfaceY = feetY + 1;
		} else {
			this.#waterSurfaceY = 0;
		}

		return inWater;
	}

	protected isInWater(): boolean {
		return this.#inWaterCached;
	}

	protected isHeadSubmerged(): boolean {
		return this.#headSubmergedCached;
	}

	/**
	 * Executes one simulation step.
	 *
	 * This version avoids hot-path vector allocations, performs the central
	 * support lookup once after movement, skips unnecessary trigonometry, and
	 * consolidates several repeated path-state checks.
	 */
	tick(dt: number): void {
		if (this.isDisposed) {
			NeutralMob.ticks.remove(this);
			return;
		}

		const pos = this.bodyPosition;
		const velocity = this.bodyVelocity;
		const startY = pos.y;

		let currentSpeed = this.wanderSpeed;
		let fleeing = false;

		const playerPosition = this.playerPosition;

		if (playerPosition !== null) {
			const dx = pos.x - playerPosition.x;
			const dy = pos.y - playerPosition.y;
			const dz = pos.z - playerPosition.z;
			const panicRadiusSq = this.getPanicRadiusSq();

			if (panicRadiusSq > 0 && dx * dx + dy * dy + dz * dz < panicRadiusSq) {
				this.#fleeTimer = 2.5;
			}

			if (this.#fleeTimer > 0) {
				fleeing = true;
				currentSpeed = PANIC_SPEED;
				this.#state = NeutralMobState.Wander;

				if (this.#path.length !== 0) {
					this.#path.length = 0;
					this.#pathIndex = 0;
				}

				this.#fleeTimer = Math.max(0, this.#fleeTimer - dt);

				const horizontalDistSq = dx * dx + dz * dz;

				if (horizontalDistSq > 0.01) {
					this.facingAngle = Math.atan2(dx, dz);
				}
			}
		}

		const inWater = this.#updateWaterState(pos);

		if (!fleeing && !inWater) {
			this.#stateTimer -= dt;

			if (this.#stateTimer <= 0) {
				if (this.#state === NeutralMobState.Wander) {
					this.#state = NeutralMobState.Idle;
					this.#stateTimer = 2 + Math.random() * 3;

					velocity.x = 0;
					velocity.z = 0;

					if (this.#path.length !== 0) {
						this.#path.length = 0;
						this.#pathIndex = 0;
					}
				} else if (NeutralMob.tryClaimPathSlot()) {
					this.#state = NeutralMobState.Wander;
					this.#stateTimer = 1 + Math.random() * 4;
					this.#pickWanderTarget(pos);
				}

				/*
				 * If no path slot was available, stateTimer intentionally remains
				 * non-positive so the mob retries on the next simulation tick.
				 */
			}
		}

		let waterWandered = false;
		let hasActivePath =
			this.#path.length !== 0 && this.#pathIndex < this.#path.length;

		if (inWater && !fleeing) {
			this.#state = NeutralMobState.Wander;
			this.#stateTimer = 1;

			if (!hasActivePath) {
				if (this.#path.length !== 0 || this.#pathIndex !== 0) {
					this.#path.length = 0;
					this.#pathIndex = 0;
				}

				this.#shoreSearchTimer -= dt;

				if (this.#shoreSearchTimer <= 0 && NeutralMob.tryClaimPathSlot()) {
					this.#findNearestShore(pos);

					hasActivePath =
						this.#path.length !== 0 && this.#pathIndex < this.#path.length;

					if (!hasActivePath) {
						/*
						 * Randomization prevents multiple swimming mobs from
						 * synchronizing their pathfinding retries.
						 */
						this.#shoreSearchTimer = 0.4 + Math.random() * 0.4;
					}
				}

				if (!hasActivePath) {
					this.#waterWander(dt);
					waterWandered = true;
				}
			}
		}

		if (this.#state === NeutralMobState.Wander) {
			hasActivePath =
				this.#path.length !== 0 && this.#pathIndex < this.#path.length;

			if (hasActivePath) {
				this.#advanceOnPath(currentSpeed, dt, pos, inWater);
			} else if (inWater && !fleeing) {
				if (!waterWandered) {
					this.#waterWander(dt);
				}
			} else {
				/*
				 * Trigonometry is now evaluated only for direction-based movement.
				 * The old temporary sinFacing and cosFacing variables were set on
				 * every tick even though most branches never used them.
				 */
				velocity.x = Math.sin(this.facingAngle) * currentSpeed;
				velocity.z = Math.cos(this.facingAngle) * currentSpeed;
			}
		}

		hasActivePath =
			this.#path.length !== 0 && this.#pathIndex < this.#path.length;

		if (inWater) {
			const escapingWater = hasActivePath && !fleeing;
			const headSubmerged = this.#headSubmergedCached;

			velocity.y += WATER_GRAVITY * dt;

			const targetCenterY =
				this.#waterSurfaceY - this.halfHeight + WATER_SURFACE_OFFSET;
			const surfaceError = targetCenterY - pos.y;

			if (headSubmerged) {
				velocity.y += SWIM_BUOYANCY * dt;
			} else if (surfaceError > 0) {
				velocity.y +=
					Math.min(surfaceError * WATER_FLOAT_ACCEL, SWIM_BUOYANCY) * dt;
			} else {
				velocity.y += Math.max(surfaceError * 2, -1) * dt;
			}

			if (escapingWater) {
				velocity.y += WATER_ESCAPE_BUOYANCY * dt;
			}

			velocity.y *= Math.max(0, 1 - WATER_VERTICAL_DAMPING * dt);

			const maxUpSpeed = escapingWater
				? WATER_ESCAPE_MAX_UP_SPEED
				: WATER_MAX_UP_SPEED;

			if (velocity.y > maxUpSpeed) {
				velocity.y = maxUpSpeed;
			} else if (velocity.y < WATER_MAX_DOWN_SPEED) {
				velocity.y = WATER_MAX_DOWN_SPEED;
			}

			const swimSpeedCap = hasActivePath
				? this.wanderSpeed * 0.9
				: this.wanderSpeed * SWIM_SPEED_FACTOR;
			const horizontalSpeedSq =
				velocity.x * velocity.x + velocity.z * velocity.z;
			const swimSpeedCapSq = swimSpeedCap * swimSpeedCap;

			if (horizontalSpeedSq > swimSpeedCapSq && horizontalSpeedSq > 0) {
				const scale = swimSpeedCap / Math.sqrt(horizontalSpeedSq);

				velocity.x *= scale;
				velocity.z *= scale;
			}
		} else {
			velocity.y += GRAVITY * dt;
		}

		if (inWater && this.#headSubmergedCached) {
			this.#breathTimer -= dt;

			if (this.#breathTimer <= 0) {
				this.takeDamage(DROWN_DAMAGE);

				if (this.isDisposed) {
					return;
				}

				this.#breathTimer = DROWN_INTERVAL;
			}
		} else {
			this.#breathTimer = BREATH_MAX;
		}

		/*
		 * The pre-movement grounded result is needed only to determine whether a
		 * step-up may be attempted. Water pathing also permits stepping onto shore.
		 */
		const wasGrounded = this.isGrounded(pos);
		const canStepUp = wasGrounded || (inWater && hasActivePath);

		let moveX = velocity.x * dt;
		const moveY = velocity.y * dt;
		let moveZ = velocity.z * dt;

		/*
		 * Cliff guard: a grounded mob on dry land never walks into a drop
		 * deeper than MAX_SAFE_LEDGE_DROP — whether wandering, drifting, or
		 * fleeing. Blocked mobs stop and turn so wander repicks instead of
		 * pushing at the edge; the flee timer keeps running so a panicked
		 * mob paces the edge rather than leaping off it.
		 */
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
			if (!fleeing) {
				this.#state = NeutralMobState.Idle;
				this.#stateTimer = 1 + Math.random() * 2;
			}
		}

		if (moveX !== 0) {
			this.moveAxis(pos, Axis.X, moveX, canStepUp);
		}

		if (moveY !== 0) {
			this.moveAxis(pos, Axis.Y, moveY, canStepUp);
		}

		if (moveZ !== 0) {
			this.moveAxis(pos, Axis.Z, moveZ, canStepUp);
		}

		let grounded = this.isGrounded(pos);

		/*
		 * Perform the post-movement central-support lookup once and reuse it for
		 * both grounded correction and the final fall failsafe.
		 */
		const hasCentralSupport = inWater || this.hasCentralSupport(pos);

		if (!hasCentralSupport) {
			grounded = false;

			if (Math.abs(velocity.y) < 0.01) {
				velocity.y = -0.5;
			}
		}

		if (grounded && velocity.y < 0) {
			velocity.y = 0;
		}

		if (inWater) {
			/*
			 * Entering water breaks the fall and prevents delayed landing damage
			 * after the mob exits.
			 */
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

					if (this.isDisposed) {
						return;
					}
				}

				this.fallStartY = Number.NaN;
			}
		} else if (Number.isNaN(this.fallStartY)) {
			this.fallStartY = startY;
		}

		const damping = inWater ? WATER_HORIZONTAL_DAMPING : grounded ? 8 : 1.8;
		const horizontalKeep = Math.max(0, 1 - damping * dt);

		velocity.x *= horizontalKeep;
		velocity.z *= horizontalKeep;

		if (Math.abs(velocity.x) < 0.03) {
			velocity.x = 0;
		}

		if (Math.abs(velocity.z) < 0.03) {
			velocity.z = 0;
		}

		/*
		 * Advance animation from actual horizontal displacement. The first tick
		 * initializes the previous coordinates without treating spawn placement
		 * as movement.
		 */
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

				if (this.walkPhase < 0.01) {
					this.walkPhase = 0;
				}
			}

			this.prevX = pos.x;
			this.prevZ = pos.z;
		}

		/*
		 * Absolute unsupported-center failsafe.
		 *
		 * This now reuses a per-mob scratch vector instead of allocating a new
		 * vec3Zero object every unsupported simulation tick.
		 */
		if (!inWater && !hasCentralSupport) {
			if (velocity.y > -2) {
				velocity.y -= 2 * dt;
			}

			if (Math.abs(velocity.y) < 0.1) {
				const nudge = this.tmpFallNudge;

				nudge.x = pos.x;
				nudge.y = pos.y - 0.03;
				nudge.z = pos.z;

				if (!this.bodyCollider.overlaps(nudge)) {
					pos.y -= 0.03;
				}
			}
		}

		this.commitTick();
	}

	/**
	 * Cliff guard: true when the ground at the mob's next horizontal step
	 * falls away more than MAX_SAFE_LEDGE_DROP below its feet. Water counts
	 * as a safe landing at any scanned depth (splash-downs never deal fall
	 * damage), and unloaded columns count as safe so mobs never freeze at
	 * chunk borders on missing data.
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
		// Probe one full step ahead plus half a body width so wide mobs
		// (sheep/cow) don't nose over the edge before the guard trips.
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

		// No support in range — still safe if it's a splash-down into water.
		for (let dy = solidScanDepth + 1; dy <= LEDGE_WATER_SCAN_DEPTH; dy++) {
			const r = resolveBlockAtWorldCoords(px, feetY - dy, pz);
			if (r.unloaded) return false;
			if (r.blockId === BlockType.Water) return false;
			if (isCollidableBlock(r.blockId)) return true;
		}

		return true;
	}

	#findNearestShore(pos: Vec3): void {
		const sx = Math.round(pos.x);
		const sz = Math.round(pos.z);
		const sy =
			this.#inWaterCached && this.#waterSurfaceY > 0
				? Math.floor(this.#waterSurfaceY - 1)
				: Math.floor(pos.y - 0.5);

		let attempts = 0;

		for (let r = 1; r <= 20 && attempts < 6; r++) {
			for (let dx = -r; dx <= r && attempts < 6; dx++) {
				for (let dz = -r; dz <= r && attempts < 6; dz++) {
					if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;

					const tx = sx + dx;
					const tz = sz + dz;
					const land = findLandSurface(tx, tz, sy, this.#requiredHeadroom);

					if (!land) continue;

					attempts++;

					if (
						findPathInto(
							this.#path,
							sx,
							sz,
							sy,
							tx,
							tz,
							this.#requiredHeadroom,
							700,
							land.groundY,
						)
					) {
						this.#pathIndex = 0;
						this.#state = NeutralMobState.Wander;
						this.#stateTimer = this.#path.length * 0.5 + 1;

						const first = this.#path[0];
						this.facingAngle = Math.atan2(
							first.x + 0.5 - pos.x,
							first.z + 0.5 - pos.z,
						);

						return;
					}
				}
			}
		}

		this.#path.length = 0;
		this.#pathIndex = 0;
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

		this.#state = NeutralMobState.Idle;
		this.#stateTimer = 1 + Math.random() * 2;
		this.bodyVelocity.x = 0;
		this.bodyVelocity.z = 0;
		this.#path.length = 0;
		this.#pathIndex = 0;
	}

	#waterWander(dt: number): void {
		this.#waterWanderTimer -= dt;

		const hSpeedSq =
			this.bodyVelocity.x * this.bodyVelocity.x +
			this.bodyVelocity.z * this.bodyVelocity.z;

		if (this.#waterWanderTimer <= 0 || hSpeedSq < 0.0025) {
			this.#waterWanderTimer = 0.75 + Math.random() * 1.25;
			this.facingAngle += -1.5 + Math.random() * 3.0;
		}

		const swimSpeed = this.wanderSpeed * SWIM_SPEED_FACTOR;

		this.bodyVelocity.x = Math.sin(this.facingAngle) * swimSpeed;
		this.bodyVelocity.z = Math.cos(this.facingAngle) * swimSpeed;
	}

	#advanceOnPath(speed: number, dt: number, pos: Vec3, inWater: boolean): void {
		while (this.#pathIndex < this.#path.length) {
			const wp = this.#path[this.#pathIndex];
			const dx = wp.x + 0.5 - pos.x;
			const dz = wp.z + 0.5 - pos.z;

			if (
				inWater &&
				this.#pathIndex === this.#path.length - 1 &&
				wp.kind === PathNodeKind.Land
			) {
				break;
			}

			if (dx * dx + dz * dz >= (inWater ? 0.25 : 0.04)) break;

			this.#pathIndex++;
		}

		if (this.#pathIndex >= this.#path.length) {
			this.#path.length = 0;
			this.#pathIndex = 0;
			this.bodyVelocity.x = 0;
			this.bodyVelocity.z = 0;

			if (this.#inWaterCached || !this.isGrounded(pos)) {
				this.#state = NeutralMobState.Wander;
				this.#shoreSearchTimer = 0;
			} else {
				this.#state = NeutralMobState.Idle;
				this.#stateTimer = 2 + Math.random() * 3;
			}

			return;
		}

		const wp = this.#path[this.#pathIndex];

		if (wp.kind === PathNodeKind.Water) {
			const targetY = wp.groundY + 0.45;
			const dy = targetY - pos.y;
			this.bodyVelocity.y += Math.max(-1, Math.min(1, dy)) * 4.0 * dt;
		}

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
