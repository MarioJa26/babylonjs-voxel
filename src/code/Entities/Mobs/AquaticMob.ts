import { onBeforeRender, type SceneContext, type Vec3 } from "@babylonjs/lite";
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
const TARGET_HORIZONTAL_DISTANCE_SQ = 0.25;
const TARGET_VERTICAL_DISTANCE = 0.5;

const CHUNK_SHIFT = 5;
const CHUNK_MASK = Chunk.SIZE - 1;

/**
 * Result of sampling the mob's water occupancy.
 *
 * NotReady means at least one required chunk is unavailable or has an
 * unsuitable LOD, so movement must be frozen for the current frame.
 */
const enum WaterSampleResult {
	NotReady = -1,
	Dry = 0,
	InWater = 1,
}

/**
 * Aquatic mob base, the water-native counterpart to NeutralMob.
 * Remains in water, swims using depth control and damping, and does not seek
 * shore. If stranded on land, it despawns after a short delay.
 */
export abstract class AquaticMob {
	abstract readonly mobType: string;
	abstract readonly CHUNK_ENTITY_TYPE: string;

	countsTowardMobCap = true;

	#hp: number;
	#maxHp: number;

	#position = vec3Zero();
	#velocity = vec3Zero();
	#hitHalfExtents: Vec3;

	/*
	 * Reused hot-path vectors. These replace per-call allocations in
	 * #isGrounded() and #findRandomWaterTarget().
	 */
	#groundProbe = vec3Zero();
	#wanderTargetScratch = vec3Zero();

	#collider: VoxelAabbCollider;
	#scene: SceneContext;

	#facingAngle = 0;
	#isDisposed = false;
	#chunkBindingHandle?: symbol;

	#wanderSpeed: number;
	#halfHeight: number;

	/*
	 * Retained for subclasses or future behavior even though the base wander
	 * logic currently does not read it.
	 */
	#playerPosition: Vec3 | null = null;

	#inWaterCached = false;
	#headSubmergedCached = false;
	#waterSurfaceY = 0;
	#targetDepth: number | null = null;

	#wanderTarget: Vec3 | null = null;

	#swimTimer = 0;
	#strandedTimer = 0;
	#idleTime = 0;

	#walkPhase = 0;
	#prevX = Number.NaN;
	#prevZ = Number.NaN;

	abstract configureChunkLoader(scene: SceneContext): void;
	abstract getWanderSpeed(): number;
	abstract onDeath(): void;
	protected abstract syncToInstances(): void;

	/**
	 * Preferred depth below the detected water surface, in blocks.
	 * Kept as a fallback when no suitable water target is found.
	 */
	protected getDepthRange(): { min: number; max: number } {
		return { min: 1, max: 3 };
	}

	/**
	 * Bias toward deeper water when picking a random wander target.
	 * 0 means uniform depth selection and 1 means always choose downward.
	 */
	protected getWaterSearchBias(): number {
		return 0.5;
	}

	/**
	 * Chance that a wander cycle becomes idle instead of selecting a target.
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
		if (AquaticMob.#observerRegistered) {
			return;
		}

		AquaticMob.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			if (deltaMs <= 0 || isUiOpen()) {
				return;
			}

			const dt = deltaMs * 0.001;

			frameProfiler.begin("aquaticMobs");

			try {
				for (const mob of AquaticMob.#allMobs) {
					if (mob.#isDisposed) {
						continue;
					}

					const pos = mob.#position;

					/*
					 * Chunk.SIZE is 32, so arithmetic shifts produce the same
					 * chunk coordinate as floor division, including for
					 * negative coordinates.
					 */
					const chunk = getChunk(
						Math.floor(pos.x) >> CHUNK_SHIFT,
						Math.floor(pos.y) >> CHUNK_SHIFT,
						Math.floor(pos.z) >> CHUNK_SHIFT,
					);

					if (!chunk || !chunk.isLoaded || chunk.lodLevel > 1) {
						continue;
					}

					mob.tick(dt);
				}
			} finally {
				frameProfiler.end("aquaticMobs");
			}
		});
	}

	static disposeAll(): void {
		/*
		 * Deleting the current Set entry during iteration is valid. No array
		 * snapshot is required.
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
					const result = resolveBlockAtWorldCoords(wx, wy, wz);

					if (result.unloaded) {
						/*
						 * Treat unloaded space as solid terrain so entities do
						 * not fall through the world during chunk streaming.
						 */
						_voxelResolveScratch.blockId = BlockType.Cobble;
						_voxelResolveScratch.blockState = 0;
						return _voxelResolveScratch;
					}

					if (!isCollidableBlock(result.blockId)) {
						return null;
					}

					_voxelResolveScratch.blockId = result.blockId;
					_voxelResolveScratch.blockState = result.blockState;

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
		if (this.#isDisposed) {
			return;
		}

		this.#isDisposed = true;

		unregisterChunkBoundEntity(this.#chunkBindingHandle);
		this.#chunkBindingHandle = undefined;

		AquaticMob.#allMobs.delete(this);
		Map1.mobRegistry?.removeMob(this);

		this.#collider.dispose();

		/*
		 * Drop retained references that are no longer needed after disposal.
		 */
		this.#playerPosition = null;
		this.#wanderTarget = null;
	}

	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	/**
	 * Samples feet, center, and head occupancy and verifies all required
	 * chunks in the same pass.
	 *
	 * This replaces the previous #isWaterStateReady() followed by
	 * #updateWaterState() sequence, which looked up the same chunks twice
	 * during every active mob tick.
	 */
	#sampleWaterState(pos: Vec3): WaterSampleResult {
		const worldX = Math.floor(pos.x);
		const worldZ = Math.floor(pos.z);

		const centerY = Math.floor(pos.y);
		const feetY = Math.floor(pos.y - this.#halfHeight + 0.05);
		const headY = Math.floor(pos.y + this.#halfHeight - 0.05);

		const chunkX = worldX >> CHUNK_SHIFT;
		const chunkZ = worldZ >> CHUNK_SHIFT;

		const feetChunkY = feetY >> CHUNK_SHIFT;
		const centerChunkY = centerY >> CHUNK_SHIFT;
		const headChunkY = headY >> CHUNK_SHIFT;

		let feetInWater: boolean;
		let centerInWater: boolean;
		let headInWater: boolean;

		if (centerChunkY === feetChunkY && headChunkY === feetChunkY) {
			/*
			 * The common case requires one chunk lookup and three direct
			 * local-coordinate reads.
			 */
			const chunk = getChunk(chunkX, feetChunkY, chunkZ);

			if (!chunk?.isLoaded || chunk.lodLevel > 1) {
				return WaterSampleResult.NotReady;
			}

			const localX = worldX & CHUNK_MASK;
			const localZ = worldZ & CHUNK_MASK;

			feetInWater =
				chunk.getBlock(localX, feetY & CHUNK_MASK, localZ) === BlockType.Water;

			centerInWater =
				chunk.getBlock(localX, centerY & CHUNK_MASK, localZ) ===
				BlockType.Water;

			headInWater =
				chunk.getBlock(localX, headY & CHUNK_MASK, localZ) === BlockType.Water;
		} else {
			/*
			 * The vertical body span crosses chunk boundaries. Cache each
			 * required chunk reference so duplicate Y chunks are not fetched
			 * repeatedly.
			 */
			const feetChunk = getChunk(chunkX, feetChunkY, chunkZ);

			if (!feetChunk?.isLoaded || feetChunk.lodLevel > 1) {
				return WaterSampleResult.NotReady;
			}

			const centerChunk =
				centerChunkY === feetChunkY
					? feetChunk
					: getChunk(chunkX, centerChunkY, chunkZ);

			if (!centerChunk || !centerChunk.isLoaded || centerChunk.lodLevel > 1) {
				return WaterSampleResult.NotReady;
			}

			let headChunk: Chunk | undefined;

			if (headChunkY === centerChunkY) {
				headChunk = centerChunk;
			} else if (headChunkY === feetChunkY) {
				headChunk = feetChunk;
			} else {
				headChunk = getChunk(chunkX, headChunkY, chunkZ);
			}

			if (!headChunk || !headChunk.isLoaded || headChunk.lodLevel > 1) {
				return WaterSampleResult.NotReady;
			}

			/*
			 * Preserve the existing world-coordinate access path for
			 * cross-chunk samples.
			 */
			feetInWater =
				getBlockByWorldCoords(worldX, feetY, worldZ) === BlockType.Water;

			centerInWater =
				getBlockByWorldCoords(worldX, centerY, worldZ) === BlockType.Water;

			headInWater =
				getBlockByWorldCoords(worldX, headY, worldZ) === BlockType.Water;
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

		return inWater ? WaterSampleResult.InWater : WaterSampleResult.Dry;
	}

	protected isInWater(): boolean {
		return this.#inWaterCached;
	}

	protected isHeadSubmerged(): boolean {
		return this.#headSubmergedCached;
	}

	protected shouldStrandedDespawn(): boolean {
		return true;
	}

	tick(dt: number): void {
		if (this.#isDisposed) {
			return;
		}

		const pos = this.#position;
		const waterState = this.#sampleWaterState(pos);

		/*
		 * Freeze physics while any relevant chunk is unavailable. Keep the
		 * visual phase and instance state synchronized.
		 */
		if (waterState === WaterSampleResult.NotReady) {
			this.#updateAnimationPhase(dt, pos);
			this.syncToInstances();
			return;
		}

		const velocity = this.#velocity;
		const inWater = waterState === WaterSampleResult.InWater;

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

	/**
	 * Finds a valid random water target.
	 *
	 * The returned vector is owned by this mob and reused between searches.
	 * Callers must not retain it outside the mob.
	 */
	#findRandomWaterTarget(pos: Vec3): Vec3 | null {
		const attempts = 4;
		const bias = this.getWaterSearchBias();

		const baseX = Math.floor(pos.x);
		const baseY = Math.floor(pos.y);
		const baseZ = Math.floor(pos.z);

		for (let i = 0; i < attempts; i++) {
			const targetX = baseX + ((Math.random() * 5) | 0) - 2;

			const targetZ = baseZ + ((Math.random() * 5) | 0) - 2;

			let targetOffsetY: number;

			if (Math.random() < bias) {
				targetOffsetY = -((Math.random() * 4) | 0) - 1;
			} else {
				targetOffsetY = ((Math.random() * 8) | 0) - 4;
			}

			const targetY = baseY + targetOffsetY;

			const chunk = getChunk(
				targetX >> CHUNK_SHIFT,
				targetY >> CHUNK_SHIFT,
				targetZ >> CHUNK_SHIFT,
			);

			if (!chunk || !chunk.isLoaded || chunk.lodLevel > 1) {
				continue;
			}

			const targetBlock = resolveBlockAtWorldCoords(targetX, targetY, targetZ);

			if (targetBlock.unloaded || targetBlock.blockId !== BlockType.Water) {
				continue;
			}

			const headBlock = resolveBlockAtWorldCoords(
				targetX,
				targetY + 1,
				targetZ,
			);

			if (
				!headBlock.unloaded &&
				headBlock.blockId !== BlockType.Water &&
				headBlock.blockId !== BlockType.Air &&
				isCollidableBlock(headBlock.blockId)
			) {
				continue;
			}

			/*
			 * Write only after the complete candidate is accepted. Failed
			 * searches therefore cannot alter the existing wander target.
			 */
			setVec3(
				this.#wanderTargetScratch,
				targetX + 0.5,
				targetY + 0.5,
				targetZ + 0.5,
			);

			return this.#wanderTargetScratch;
		}

		return null;
	}

	#tickSwimming(dt: number, pos: Vec3, velocity: Vec3): void {
		this.#strandedTimer = 0;

		if (this.#idleTime > 0) {
			this.#idleTime -= dt;

			const idleHorizontalKeep = Math.max(
				0,
				1 - WATER_HORIZONTAL_DAMPING * 0.6 * dt,
			);

			const idleVerticalKeep = Math.max(
				0,
				1 - WATER_VERTICAL_DAMPING * 0.8 * dt,
			);

			velocity.x *= idleHorizontalKeep;
			velocity.z *= idleHorizontalKeep;
			velocity.y *= idleVerticalKeep;

			if (Math.abs(velocity.x) < 0.02) {
				velocity.x = 0;
			}

			if (Math.abs(velocity.z) < 0.02) {
				velocity.z = 0;
			}

			if (Math.abs(velocity.y) < 0.02) {
				velocity.y = 0;
			}

			if (this.#idleTime <= 0) {
				this.#swimTimer = 0;
			}

			return;
		}

		this.#swimTimer -= dt;

		const horizontalSpeedSq = velocity.x * velocity.x + velocity.z * velocity.z;

		const wanderTarget = this.#wanderTarget;
		let nearTarget = false;

		if (wanderTarget !== null) {
			const targetDx = wanderTarget.x - pos.x;
			const targetDz = wanderTarget.z - pos.z;

			nearTarget =
				targetDx * targetDx + targetDz * targetDz <
					TARGET_HORIZONTAL_DISTANCE_SQ &&
				Math.abs(wanderTarget.y - pos.y) < TARGET_VERTICAL_DISTANCE;
		}

		const chooseNewDirection =
			this.#swimTimer <= 0 ||
			horizontalSpeedSq < MIN_HORIZONTAL_SPEED_SQ ||
			nearTarget ||
			wanderTarget === null;

		if (chooseNewDirection) {
			if (Math.random() < this.getIdleChance()) {
				const duration = this.getIdleDuration();

				this.#idleTime =
					duration.min + Math.random() * (duration.max - duration.min);

				this.#swimTimer = this.#idleTime + Math.random() * 0.5;

				this.#wanderTarget = null;

				velocity.x *= 0.5;
				velocity.z *= 0.5;
				return;
			}

			this.#swimTimer = 1.0 + Math.random() * 2.0;

			const target = this.#findRandomWaterTarget(pos);

			if (target !== null) {
				this.#wanderTarget = target;

				const dx = target.x - pos.x;
				const dz = target.z - pos.z;

				if (dx * dx + dz * dz > 0.0001) {
					this.#facingAngle = Math.atan2(dx, dz);
				}
			} else {
				this.#facingAngle += Math.random() * 2.4 - 1.2;

				if (nearTarget) {
					this.#wanderTarget = null;
				}
			}

			if (this.#wanderTarget === null) {
				this.#chooseTargetDepth();
			}
		} else if (this.#targetDepth === null && this.#wanderTarget === null) {
			this.#chooseTargetDepth();
		}

		const swimSpeed = this.#wanderSpeed * SWIM_SPEED_FACTOR;

		const horizontalKeep = Math.max(0, 1 - WATER_HORIZONTAL_DAMPING * dt);

		velocity.x = Math.sin(this.#facingAngle) * swimSpeed * horizontalKeep;

		velocity.z = Math.cos(this.#facingAngle) * swimSpeed * horizontalKeep;

		const currentTarget = this.#wanderTarget;

		const targetY =
			currentTarget !== null
				? currentTarget.y
				: this.#waterSurfaceY - (this.#targetDepth ?? 1) - this.#halfHeight;

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
		const maxDepth = 22;

		let minDepth = Math.min(range.min, maxDepth);
		let maxRangeDepth = Math.min(range.max, maxDepth);

		if (!Number.isFinite(minDepth)) {
			minDepth = 1;
		}

		if (!Number.isFinite(maxRangeDepth)) {
			maxRangeDepth = minDepth;
		}

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

		if (Math.abs(velocity.x) < 0.03) {
			velocity.x = 0;
		}

		if (Math.abs(velocity.z) < 0.03) {
			velocity.z = 0;
		}
	}

	#updateAnimationPhase(dt: number, pos: Vec3): void {
		const currentX = pos.x;
		const currentZ = pos.z;
		const previousX = this.#prevX;

		if (Number.isNaN(previousX)) {
			this.#prevX = currentX;
			this.#prevZ = currentZ;
			this.#walkPhase += dt;
			return;
		}

		const dx = currentX - previousX;
		const dz = currentZ - this.#prevZ;
		const distanceSq = dx * dx + dz * dz;

		if (distanceSq > MIN_MOVEMENT_DISTANCE_SQ) {
			this.#walkPhase += Math.sqrt(distanceSq) * WALK_STRIDE_FACTOR + dt * 2.0;
		} else {
			this.#walkPhase += dt;
		}

		this.#prevX = currentX;
		this.#prevZ = currentZ;
	}

	#isGrounded(pos: Vec3): boolean {
		const probe = this.#groundProbe;

		probe.x = pos.x;
		probe.y = pos.y - 0.01;
		probe.z = pos.z;

		return this.#collider.overlaps(probe);
	}

	#serializeForChunkReload(): SavedChunkEntityData | null {
		if (this.#isDisposed) {
			return null;
		}

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
