import {
	onBeforeRender,
	type SceneContext,
	type Vec3,
	vec3,
} from "@babylonjs/lite";
import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { isUiOpen } from "@/code/Lib/GameRuntimeState";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
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
	VoxelAabbCollider,
} from "@/code/World/Collision/VoxelAabbCollider";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import type { SavedChunkEntityData } from "@/code/World/WorldStorage";

/**
 * Aquatic mob base, the water-native counterpart to NeutralMob.
 * Remains in water, swims using depth control and damping, and does not seek
 * shore. If stranded on land, it despawns after a short delay.
 */

const GRAVITY = -18;
const STEP_SIZE = 0.2;
const EPSILON = 0.001;

const WALK_STRIDE_FACTOR = 2.0;

const WATER_VERTICAL_DAMPING = 2.5;
const WATER_HORIZONTAL_DAMPING = 1.2;
const WATER_MAX_UP = 1.0;
const WATER_MAX_DOWN = -0.6;
const SWIM_SPEED_FACTOR = 1.0;

const STRANDED_DESPAWN_SECONDS = 8;
const MIN_MOVEMENT_DISTANCE_SQ = 0.000001;
const MIN_HORIZONTAL_SPEED_SQ = 0.05;

const CHUNK_SHIFT = 5;
const CHUNK_MASK = Chunk.SIZE - 1;

export abstract class AquaticMob {
	abstract readonly mobType: string;
	abstract readonly CHUNK_ENTITY_TYPE: string;

	countsTowardMobCap = true;

	#hp: number;
	#maxHp: number;

	#position = vec3Zero();
	#velocity = vec3Zero();
	#hitHalfExtents: Vec3;

	#collider: VoxelAabbCollider;
	#scene: SceneContext;

	#facingAngle = 0;
	#isDisposed = false;
	#chunkBindingHandle?: symbol;

	#wanderSpeed: number;
	#halfHeight: number;

	// Retained because subclasses or future behavior may use the player's
	// position even though the base wander behavior currently does not.
	#playerPosition: Vec3 | null = null;

	// Water state
	#inWaterCached = false;
	#headSubmergedCached = false;
	#waterSurfaceY = 0;
	#targetDepth: number | null = null;

	// Random water-block wander target (replaces depthRange preference)
	#wanderTarget: Vec3 | null = null;
	#wanderTargetScratch = vec3Zero();

	// Wander state
	#swimTimer = 0;
	#strandedTimer = 0;
	#idleTime = 0;

	// Swim phase used for fin/tentacle animation
	#walkPhase = 0;
	#prevX = Number.NaN;
	#prevZ = Number.NaN;

	abstract configureChunkLoader(scene: SceneContext): void;
	abstract getWanderSpeed(): number;
	abstract onDeath(): void;
	protected abstract syncToInstances(): void;

	/**
	 * Preferred depth below the detected water surface, in blocks.
	 * Deprecated: replaced by random water-block search (5×3×4 box).
	 * Kept for fallback when no water target is found.
	 */
	protected getDepthRange(): { min: number; max: number } {
		return { min: 1, max: 3 };
	}

	/**
	 * Bias toward deeper water when picking a random wander target.
	 * 0 = uniform (-4..+3), 1 = always down. Squid/kraken override higher.
	 */
	protected getWaterSearchBias(): number {
		return 0.5;
	}

	/**
	 * Chance that a wander cycle becomes idle (no thrust) instead of
	 * picking a water-block target. 0 = always wander. Override per type.
	 */
	protected getIdleChance(): number {
		return 0.3;
	}

	protected getIdleDuration(): { min: number; max: number } {
		return { min: 1.2, max: 3.0 };
	}

	protected getPanicRadiusSq(): number {
		return 25;
	}

	protected onDamaged(): void {}

	protected triggerPanic(_duration: number): void {}

	static #observerRegistered = false;
	static readonly #allMobs = new Set<AquaticMob>();

	static #ensureObserver(): void {
		if (AquaticMob.#observerRegistered) return;

		AquaticMob.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			if (deltaMs <= 0 || isUiOpen()) return;

			const dt = deltaMs * 0.001;
			const chunkSize = Chunk.SIZE;

			frameProfiler.begin("aquaticMobs");

			try {
				for (const mob of AquaticMob.#allMobs) {
					if (mob.#isDisposed) continue;

					const pos = mob.#position;
					const chunk = getChunk(
						Math.floor(pos.x / chunkSize),
						Math.floor(pos.y / chunkSize),
						Math.floor(pos.z / chunkSize),
					);

					if (!chunk || chunk.lodLevel > 1) continue;

					mob.tick(dt);
				}
			} finally {
				frameProfiler.end("aquaticMobs");
			}
		});
	}

	static disposeAll(): void {
		/*
		 * Set iteration remains valid when dispose() removes the current item.
		 * No temporary array copy is required.
		 */
		for (const mob of AquaticMob.#allMobs) {
			mob.dispose();
		}
	}

	protected constructor(hp: number, scene: SceneContext, halfSize: Vec3) {
		this.#hp = hp;
		this.#maxHp = hp;
		this.#scene = scene;

		this.#hitHalfExtents = {
			x: halfSize.x,
			y: halfSize.y,
			z: halfSize.z,
		};

		this.#wanderSpeed = this.getWanderSpeed();
		this.#halfHeight = halfSize.y;

		this.#collider = new VoxelAabbCollider(
			halfSize,
			createVoxelColliderBlockSampler(
				(wx, wy, wz) => {
					// PERF: single chunk resolution per voxel (was two: a loaded
					// check via getChunk + a block/state read). resolveBlockAtWorldCoords
					// resolves once and reports unloaded so we can treat it as solid.
					const r = resolveBlockAtWorldCoords(wx, wy, wz);
					if (r.unloaded) {
						// Chunk under this probe is not loaded: treat it as solid
						// terrain so the mob collides with / rests on it instead
						// of falling through into the void while chunks stream in.
						_voxelResolveScratch.blockId = BlockType.Cobble;
						_voxelResolveScratch.blockState = 0;
						return _voxelResolveScratch;
					}

					if (!isCollidableBlock(r.blockId)) {
						return null;
					}

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

	protected setPosition(x: number, y: number, z: number): void {
		setVec3(this.#position, x, y, z);
	}

	get facingYaw(): number {
		return this.#facingAngle;
	}

	protected get walkPhase(): number {
		return this.#walkPhase;
	}

	get hitHalfExtents(): Vec3 {
		return this.#hitHalfExtents;
	}

	protected finalizeRegistration(): void {
		this.configureChunkLoader(this.#scene);

		this.#chunkBindingHandle = registerChunkBoundEntity({
			getWorldPosition: () => this.#position,
			unload: () => this.dispose(),
			isAlive: () => !this.#isDisposed,
			serializeForChunkReload: () => this.#serializeForChunkReload(),
		});

		AquaticMob.#allMobs.add(this);
		AquaticMob.#ensureObserver();
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

	takeDamage(amount: number): void {
		this.#hp -= amount;

		if (this.#hp <= 0) {
			this.#hp = 0;
			this.onDeath();
			this.dispose();
			return;
		}

		this.onDamaged();
	}

	serializeForChunkReload(): SavedChunkEntityData | null {
		return this.#serializeForChunkReload();
	}

	use(_player: Player): void {}

	dispose(): void {
		if (this.#isDisposed) return;

		this.#isDisposed = true;

		unregisterChunkBoundEntity(this.#chunkBindingHandle);
		this.#chunkBindingHandle = undefined;

		AquaticMob.#allMobs.delete(this);
		Map1.mobRegistry?.removeMob(this);

		this.#collider.dispose();
	}

	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	#isWaterStateReady(pos: Vec3): boolean {
		const x = Math.floor(pos.x);
		const z = Math.floor(pos.z);
		const feetY = Math.floor(pos.y - this.#halfHeight + 0.05);
		const centerY = Math.floor(pos.y);
		const headY = Math.floor(pos.y + this.#halfHeight - 0.05);
		const chunkX = x >> CHUNK_SHIFT;
		const chunkZ = z >> CHUNK_SHIFT;
		const feetChunkY = feetY >> CHUNK_SHIFT;
		const centerChunkY = centerY >> CHUNK_SHIFT;
		const headChunkY = headY >> CHUNK_SHIFT;
		const lodOk = (c: ReturnType<typeof getChunk>) =>
			c !== undefined && c.isLoaded && c.lodLevel <= 1;
		if (centerChunkY === feetChunkY && headChunkY === feetChunkY) {
			return lodOk(getChunk(chunkX, feetChunkY, chunkZ));
		}
		return (
			lodOk(getChunk(chunkX, feetChunkY, chunkZ)) &&
			lodOk(getChunk(chunkX, centerChunkY, chunkZ)) &&
			lodOk(getChunk(chunkX, headChunkY, chunkZ))
		);
	}

	/**
	 * Samples feet, center, and head water occupancy.
	 *
	 * When all samples are in the same loaded chunk, direct chunk access avoids
	 * three separate world-coordinate lookups.
	 */
	#updateWaterState(pos: Vec3): boolean {
		const x = Math.floor(pos.x);
		const z = Math.floor(pos.z);

		const feetY = Math.floor(pos.y - this.#halfHeight + 0.05);
		const centerY = Math.floor(pos.y);
		const headY = Math.floor(pos.y + this.#halfHeight - 0.05);

		const chunkX = x >> CHUNK_SHIFT;
		const chunkZ = z >> CHUNK_SHIFT;

		const feetChunkY = feetY >> CHUNK_SHIFT;
		const centerChunkY = centerY >> CHUNK_SHIFT;
		const headChunkY = headY >> CHUNK_SHIFT;

		let feetInWater: boolean;
		let centerInWater: boolean;
		let headInWater: boolean;

		if (centerChunkY === feetChunkY && headChunkY === feetChunkY) {
			const chunk = getChunk(chunkX, feetChunkY, chunkZ);

			if (chunk?.isLoaded && chunk.lodLevel <= 1) {
				const localX = x & CHUNK_MASK;
				const localZ = z & CHUNK_MASK;

				feetInWater =
					chunk.getBlock(localX, feetY & CHUNK_MASK, localZ) ===
					BlockType.Water;

				centerInWater =
					chunk.getBlock(localX, centerY & CHUNK_MASK, localZ) ===
					BlockType.Water;

				headInWater =
					chunk.getBlock(localX, headY & CHUNK_MASK, localZ) ===
					BlockType.Water;
			} else {
				// Chunk not ready — keep previous water state to avoid
				// false stranded transition that sinks the mob into terrain
				// while the chunk streams in (land mobs avoid this via the
				// collider's fake-Cobble; aquatics must freeze instead).
				return this.#inWaterCached;
			}
		} else {
			// Cross-chunk sample — any unloaded piece means water state is
			// unreliable; freeze as water if we were water before, otherwise
			// treat as not ready.
			if (!this.#isWaterStateReady(pos)) {
				return this.#inWaterCached;
			}
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

	/**
	 * Available for subclasses that need to distinguish full submersion from
	 * partial water contact.
	 */
	protected isHeadSubmerged(): boolean {
		return this.#headSubmergedCached;
	}

	/**
	 * Override for creatures that must not despawn when outside water.
	 */
	protected shouldStrandedDespawn(): boolean {
		return true;
	}

	tick(dt: number): void {
		if (this.#isDisposed) return;

		const pos = this.#position;
		// While any water-check chunk is not lod0-ready, freeze in place.
		// This mirrors NeutralMob's lod>1 skip but covers the vertical span
		// of an aquatic's body; without it a chunk-reloaded squid/fish
		// samples false for water (0) and enters stranded GRAVITY, sinking
		// through the water column into the ground before the column loads.
		// Land sheeps don't hit this because their collider's fake-Cobble
		// holds them up and they are rarely cross-chunk.
		if (!this.#isWaterStateReady(pos)) {
			// Preserve targetDepth/velocity but don't integrate; keep visual
			// pose alive so light + walk phase stay coherent.
			this.#updateAnimationPhase(dt, pos);
			this.syncToInstances();
			return;
		}
		const velocity = this.#velocity;
		const inWater = this.#updateWaterState(pos);

		if (inWater) {
			this.#tickSwimming(dt, pos, velocity);
		} else if (!this.#tickStranded(dt, velocity)) {
			return;
		}

		this.#collider.moveAxis(pos, velocity, Axis.X, velocity.x * dt, STEP_SIZE);

		this.#collider.moveAxis(pos, velocity, Axis.Y, velocity.y * dt, STEP_SIZE);

		this.#collider.moveAxis(pos, velocity, Axis.Z, velocity.z * dt, STEP_SIZE);

		if (!inWater) {
			this.#applyLandDamping(dt, pos, velocity);
		}

		this.#updateAnimationPhase(dt, pos);
		this.syncToInstances();
	}

	/**
	 * Returns false when the mob was disposed and tick processing must stop.
	 */
	#tickStranded(dt: number, velocity: Vec3): boolean {
		this.#strandedTimer += dt;

		if (
			this.shouldStrandedDespawn() &&
			this.#strandedTimer > STRANDED_DESPAWN_SECONDS
		) {
			this.dispose();
			return false;
		}

		velocity.y += GRAVITY * dt;

		this.#swimTimer -= dt;

		if (this.#swimTimer <= 0) {
			this.#swimTimer = 0.5 + Math.random() * 0.8;
			this.#facingAngle += Math.random() * 2.0 - 1.0;
		}

		const flopSpeed = this.#wanderSpeed * 0.3;

		velocity.x = Math.sin(this.#facingAngle) * flopSpeed;
		velocity.z = Math.cos(this.#facingAngle) * flopSpeed;

		return true;
	}

	#findRandomWaterTarget(pos: Vec3): Vec3 | null {
		const attempts = 4;
		const bias = this.getWaterSearchBias();
		const baseX = Math.floor(pos.x);
		const baseY = Math.floor(pos.y);
		const baseZ = Math.floor(pos.z);
		for (let i = 0; i < attempts; i++) {
			const dx = (Math.random() * 5) | 0;
			const dz = (Math.random() * 5) | 0;
			const rx = baseX + dx - 2;
			const rz = baseZ + dz - 2;
			let dy: number;
			// Biased down for squid/kraken (e.g. 0.7 → 70% picks -4..-1)
			if (Math.random() < bias) {
				dy = -((Math.random() * 4) | 0) - 1; // -1 .. -4
			} else {
				dy = ((Math.random() * 8) | 0) - 4; // -4 .. 3
			}
			const ry = baseY + dy;

			// Skip unloaded / lod>1 targets — use real water, not SEA_LEVEL
			const cx = rx >> CHUNK_SHIFT;
			const cy = ry >> CHUNK_SHIFT;
			const cz = rz >> CHUNK_SHIFT;
			const chunk = getChunk(cx, cy, cz);
			if (!chunk || !chunk.isLoaded || chunk.lodLevel > 1) continue;

			const r = resolveBlockAtWorldCoords(rx, ry, rz);
			if (r.unloaded) continue;
			if (r.blockId !== BlockType.Water) continue;

			// Headroom: ensure the mob fits at target (center + head)
			const headY = ry + 1;
			const rh = resolveBlockAtWorldCoords(rx, headY, rz);
			if (
				!rh.unloaded &&
				rh.blockId !== BlockType.Water &&
				rh.blockId !== BlockType.Air
			) {
				// Allow air at surface, but not solid
				if (isCollidableBlock(rh.blockId)) continue;
			}

			return vec3(rx + 0.5, ry + 0.5, rz + 0.5);
		}
		return null;
	}

	#tickSwimming(dt: number, pos: Vec3, velocity: Vec3): void {
		this.#strandedTimer = 0;
		// Idle hover — not always wandering, can just drift in place
		if (this.#idleTime > 0) {
			this.#idleTime -= dt;
			const idleKeepH = Math.max(0, 1 - WATER_HORIZONTAL_DAMPING * 0.6 * dt);
			const idleKeepV = Math.max(0, 1 - WATER_VERTICAL_DAMPING * 0.8 * dt);
			velocity.x *= idleKeepH;
			velocity.z *= idleKeepH;
			velocity.y *= idleKeepV;
			if (Math.abs(velocity.x) < 0.02) velocity.x = 0;
			if (Math.abs(velocity.z) < 0.02) velocity.z = 0;
			if (Math.abs(velocity.y) < 0.02) velocity.y = 0;
			if (this.#idleTime <= 0) this.#swimTimer = 0;
			return;
		}
		this.#swimTimer -= dt;

		const horizontalSpeedSq = velocity.x * velocity.x + velocity.z * velocity.z;
		const nearTarget =
			this.#wanderTarget !== null &&
			(this.#wanderTarget.x - pos.x) * (this.#wanderTarget.x - pos.x) +
				(this.#wanderTarget.z - pos.z) * (this.#wanderTarget.z - pos.z) <
				0.25 &&
			Math.abs(this.#wanderTarget.y - pos.y) < 0.5;

		const chooseNewDirection =
			this.#swimTimer <= 0 ||
			horizontalSpeedSq < MIN_HORIZONTAL_SPEED_SQ ||
			nearTarget ||
			this.#wanderTarget === null;

		if (chooseNewDirection) {
			// Chance to just idle instead of wandering
			if (Math.random() < this.getIdleChance()) {
				const dur = this.getIdleDuration();
				this.#idleTime = dur.min + Math.random() * (dur.max - dur.min);
				this.#swimTimer = this.#idleTime + Math.random() * 0.5;
				this.#wanderTarget = null;
				velocity.x *= 0.5;
				velocity.z *= 0.5;
				return;
			}
			this.#swimTimer = 1.0 + Math.random() * 2.0;
			const target = this.#findRandomWaterTarget(pos);
			if (target) {
				this.#wanderTarget = target;
				const dx = target.x - pos.x;
				const dz = target.z - pos.z;
				if (dx * dx + dz * dz > 0.0001) {
					this.#facingAngle = Math.atan2(dx, dz);
				}
			} else {
				// Fallback: small random turn if no water found
				this.#facingAngle += Math.random() * 2.4 - 1.2;
				// Keep existing target or clear
				if (nearTarget) this.#wanderTarget = null;
			}
			// Also refresh fallback depth for vertical if no target
			if (!this.#wanderTarget) this.#chooseTargetDepth();
		} else if (this.#targetDepth === null && this.#wanderTarget === null) {
			/*
			 * Ensures newly spawned mobs have a valid depth target even when
			 * their initial horizontal velocity is already nonzero.
			 */
			this.#chooseTargetDepth();
		}

		const swimSpeed = this.#wanderSpeed * SWIM_SPEED_FACTOR;
		const horizontalKeep = Math.max(0, 1 - WATER_HORIZONTAL_DAMPING * dt);

		/*
		 * Preserve the original behavior where desired velocity is assigned
		 * first and then damped during the same tick.
		 */
		velocity.x = Math.sin(this.#facingAngle) * swimSpeed * horizontalKeep;

		velocity.z = Math.cos(this.#facingAngle) * swimSpeed * horizontalKeep;

		// Prefer straight-path water block target; fallback to depth range.
		let targetY: number;
		if (this.#wanderTarget) {
			targetY = this.#wanderTarget.y;
		} else {
			targetY =
				this.#waterSurfaceY - (this.#targetDepth ?? 1) - this.#halfHeight;
		}

		const depthError = targetY - pos.y;

		velocity.y += depthError * 0.1 * dt;
		velocity.y *= Math.max(0, 1 - WATER_VERTICAL_DAMPING * dt);

		if (velocity.y > WATER_MAX_UP) {
			velocity.y = WATER_MAX_UP;
		} else if (velocity.y < WATER_MAX_DOWN) {
			velocity.y = WATER_MAX_DOWN;
		}
	}

	#chooseTargetDepth(): void {
		const range = this.getDepthRange();

		/*
		 * This preserves the original effective maximum depth of 22 blocks.
		 * The previous waterFloorY calculation always produced this same value:
		 *
		 * waterFloorY = surfaceY - 24
		 * maxDepth = surfaceY - waterFloorY - 2
		 * maxDepth = 22
		 */
		const maxDepth = 22;

		let minDepth = Math.min(range.min, maxDepth);
		let maxRangeDepth = Math.min(range.max, maxDepth);

		/*
		 * Normalize invalid subclass ranges without allocating another object.
		 */
		if (!Number.isFinite(minDepth)) minDepth = 1;
		if (!Number.isFinite(maxRangeDepth)) maxRangeDepth = minDepth;

		if (minDepth > maxRangeDepth) {
			const temporary = minDepth;
			minDepth = maxRangeDepth;
			maxRangeDepth = temporary;
		}

		this.#targetDepth = minDepth + Math.random() * (maxRangeDepth - minDepth);
	}

	#applyLandDamping(dt: number, pos: Vec3, velocity: Vec3): void {
		const grounded = velocity.y <= 0.01 && this.#isGrounded(pos);

		if (grounded && velocity.y < 0) {
			velocity.y = 0;
		}

		const damping = grounded ? 6.0 : 1.8;
		const keep = Math.max(0, 1 - damping * dt);

		velocity.x *= keep;
		velocity.z *= keep;

		if (Math.abs(velocity.x) < 0.03) velocity.x = 0;
		if (Math.abs(velocity.z) < 0.03) velocity.z = 0;
	}

	#updateAnimationPhase(dt: number, pos: Vec3): void {
		const previousX = this.#prevX;
		const previousZ = this.#prevZ;

		if (Number.isNaN(previousX)) {
			this.#prevX = pos.x;
			this.#prevZ = pos.z;
			this.#walkPhase += dt;
			return;
		}

		const dx = pos.x - previousX;
		const dz = pos.z - previousZ;
		const distanceSq = dx * dx + dz * dz;

		if (distanceSq > MIN_MOVEMENT_DISTANCE_SQ) {
			this.#walkPhase += Math.sqrt(distanceSq) * WALK_STRIDE_FACTOR + dt * 2.0;
		} else {
			this.#walkPhase += dt;
		}

		this.#prevX = pos.x;
		this.#prevZ = pos.z;
	}

	#isGrounded(pos: Vec3): boolean {
		/*
		 * This still allocates through vec3Zero() because it is unknown whether
		 * the returned vector can safely be retained across collider calls.
		 */
		const probe = vec3Zero();

		probe.x = pos.x;
		probe.y = pos.y - 0.01;
		probe.z = pos.z;

		return this.#collider.overlaps(probe);
	}

	#serializeForChunkReload(): SavedChunkEntityData | null {
		if (this.#isDisposed) return null;

		const pos = this.#position;
		const extra = this.getExtraPayload();

		return {
			type: this.CHUNK_ENTITY_TYPE,
			payload: {
				position: {
					x: pos.x,
					y: pos.y,
					z: pos.z,
				},
				hp: this.#hp,
				...extra,
			},
		};
	}

	protected getExtraPayload(): Record<string, unknown> {
		return {};
	}
}
