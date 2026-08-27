import { onBeforeRender, type SceneContext, type Vec3 } from "@babylonjs/lite";
import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { isUiOpen } from "@/code/Lib/GameRuntimeState";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import type { Player } from "@/code/Player/Player";
import { Chunk, getChunk } from "@/code/World/Chunk/Chunk";
import {
	getBlockAndStateByWorldCoords,
	getBlockByWorldCoords,
	registerChunkBoundEntity,
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
 * Aquatic mob base — water-native counterpart to NeutralMob.
 * Stays *in* water, swims with buoyancy/damping, does NOT seek shore.
 * Beaches itself to despawn quickly if stranded on land.
 */
const GRAVITY = -18;
const STEP_SIZE = 0.2;
const EPSILON = 0.001;

const WALK_STRIDE_FACTOR = 2.0;
const WALK_PHASE_DECAY = 6.0;

// Water physics (tuned for floating aquatic mobs)
const WATER_GRAVITY = -2.0;
const WATER_BUOYANCY = 4.0;
const WATER_FLOAT_ACCEL = 12.0;
const WATER_SURFACE_OFFSET = 0.2;
const WATER_VERTICAL_DAMPING = 2.5;
const WATER_HORIZONTAL_DAMPING = 1.2;
const WATER_MAX_UP = 1.0;
const WATER_MAX_DOWN = -0.6;
const SWIM_SPEED_FACTOR = 1.0;

export abstract class AquaticMob {
	abstract readonly mobType: string;
	abstract readonly CHUNK_ENTITY_TYPE: string;

	countsTowardMobCap = true;

	#hp: number;
	#maxHp: number;
	#position = vec3Zero();
	#hitHalfExtents: Vec3;
	#velocity = vec3Zero();
	#collider: VoxelAabbCollider;
	#facingAngle = 0;
	#scene: SceneContext;
	#playerPosition: Vec3 | null = null;
	#isDisposed = false;
	#chunkBindingHandle?: symbol;
	#wanderSpeed: number;
	#halfHeight: number;

	// Water state
	#inWaterCached = false;
	#headSubmergedCached = false;
	#waterSurfaceY = 0;
	#targetDepth: number | null = null;

	// Wander
	#swimTimer = 0;
	#strandedTimer = 0;

	// Walk/swim phase for tentacle/fin animation via instance color alpha
	#walkPhase = 0;
	#prevX = Number.NaN;
	#prevZ = Number.NaN;

	abstract configureChunkLoader(scene: SceneContext): void;
	abstract getWanderSpeed(): number;
	abstract onDeath(): void;
	protected abstract syncToInstances(): void;

	/**
	 * Preferred depth range below water surface (blocks). Override to control
	 * how deep this mob swims. Default is shallow (1-3 blocks).
	 */
	protected getDepthRange(): { min: number; max: number } {
		return { min: 1, max: 3 };
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
			const dt = deltaMs * 0.001;
			if (dt <= 0 || isUiOpen()) return;
			frameProfiler.begin("aquaticMobs");
			for (const mob of AquaticMob.#allMobs) {
				const pos = mob.#position;
				const chunk = getChunk(
					Math.floor(pos.x / Chunk.SIZE),
					Math.floor(pos.y / Chunk.SIZE),
					Math.floor(pos.z / Chunk.SIZE),
				);
				if (!chunk || chunk.lodLevel > 1) continue;
				mob.tick(dt);
			}
			frameProfiler.end("aquaticMobs");
		});
	}

	static disposeAll(): void {
		for (const mob of AquaticMob.#allMobs) mob.dispose();
	}

	protected constructor(hp: number, scene: SceneContext, halfSize: Vec3) {
		this.#hp = hp;
		this.#maxHp = hp;
		this.#scene = scene;
		this.#hitHalfExtents = { x: halfSize.x, y: halfSize.y, z: halfSize.z };
		this.#wanderSpeed = this.getWanderSpeed();
		this.#halfHeight = halfSize.y;
		this.#collider = new VoxelAabbCollider(
			halfSize,
			createVoxelColliderBlockSampler(
				(wx, wy, wz) => {
					const r = getBlockAndStateByWorldCoords(wx, wy, wz);
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
	set hp(v: number) {
		this.#hp = Math.max(0, Math.min(v, this.#maxHp));
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
			this.onDeath();
			this.dispose();
		} else {
			this.onDamaged();
		}
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

	#updateWaterState(pos: Vec3): boolean {
		const x = Math.floor(pos.x);
		const z = Math.floor(pos.z);
		const feetY = Math.floor(pos.y - this.#halfHeight + 0.05);
		const centerY = Math.floor(pos.y);
		const headY = Math.floor(pos.y + this.#halfHeight - 0.05);
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
		if (headInWater) this.#waterSurfaceY = headY + 1;
		else if (centerInWater) this.#waterSurfaceY = centerY + 1;
		else if (feetInWater) this.#waterSurfaceY = feetY + 1;
		else this.#waterSurfaceY = 0;
		return inWater;
	}

	protected isInWater(): boolean {
		return this.#inWaterCached;
	}

	/** Override to make a mob never drown / not despawn on land (e.g. kraken). */
	protected shouldStrandedDespawn(): boolean {
		return true;
	}

	tick(dt: number): void {
		if (this.#isDisposed) {
			AquaticMob.#allMobs.delete(this);
			return;
		}
		const pos = this.#position;
		const velocity = this.#velocity;
		const inWater = this.#updateWaterState(pos);

		// Stranded on land: gravity + slow despawn
		if (!inWater) {
			this.#strandedTimer += dt;
			if (this.shouldStrandedDespawn() && this.#strandedTimer > 8) {
				this.dispose();
				return;
			}
			velocity.y += GRAVITY * dt;
			// Flop slowly toward nearest water (random jitter)
			this.#swimTimer -= dt;
			if (this.#swimTimer <= 0) {
				this.#swimTimer = 0.5 + Math.random() * 0.8;
				this.#facingAngle += -1.0 + Math.random() * 2.0;
			}
			const flopSpeed = this.#wanderSpeed * 0.3;
			velocity.x = Math.sin(this.#facingAngle) * flopSpeed;
			velocity.z = Math.cos(this.#facingAngle) * flopSpeed;
		} else {
			this.#strandedTimer = 0;
			// Water wander — pick new heading periodically
			this.#swimTimer -= dt;
			const hSpeedSq = velocity.x * velocity.x + velocity.z * velocity.z;
			if (this.#swimTimer <= 0 || hSpeedSq < 0.05) {
				this.#swimTimer = 1.0 + Math.random() * 2.0;
				this.#facingAngle += -1.2 + Math.random() * 2.4;
			}
			const swimSpeed = this.#wanderSpeed * SWIM_SPEED_FACTOR;
			velocity.x = Math.sin(this.#facingAngle) * swimSpeed;
			velocity.z = Math.cos(this.#facingAngle) * swimSpeed;

			// Depth control — drift within depth range with slow natural movement
			const depthRange = this.getDepthRange();
			const waterFloorY = this.#waterSurfaceY - 24; // Approximate floor
			const maxDepth = Math.max(1, this.#waterSurfaceY - waterFloorY - 2);
			const clampedMin = Math.min(depthRange.min, maxDepth);
			const clampedMax = Math.min(depthRange.max, maxDepth);

			// Pick a random target depth within range (changes slowly)
			if (this.#swimTimer <= 0) {
				this.#targetDepth =
					clampedMin + Math.random() * (clampedMax - clampedMin);
			}
			const targetY =
				this.#waterSurfaceY -
				(this.#targetDepth ?? clampedMin) -
				this.#halfHeight;

			const depthError = targetY - pos.y;
			velocity.y += depthError * 0.1 * dt;

			// Vertical damping and limits
			velocity.y *= Math.max(0, 1 - WATER_VERTICAL_DAMPING * dt);
			if (velocity.y > WATER_MAX_UP) velocity.y = WATER_MAX_UP;
			else if (velocity.y < WATER_MAX_DOWN) velocity.y = WATER_MAX_DOWN;

			// Gentle horizontal damping in water
			velocity.x *= Math.max(0, 1 - WATER_HORIZONTAL_DAMPING * dt);
			velocity.z *= Math.max(0, 1 - WATER_HORIZONTAL_DAMPING * dt);
		}

		// If not in water, apply ground damping
		if (!inWater) {
			velocity.y += GRAVITY * dt * 0; // already applied
		}

		// Collision move
		this.#collider.moveAxis(pos, velocity, Axis.X, velocity.x * dt, STEP_SIZE);
		this.#collider.moveAxis(pos, velocity, Axis.Y, velocity.y * dt, STEP_SIZE);
		this.#collider.moveAxis(pos, velocity, Axis.Z, velocity.z * dt, STEP_SIZE);

		// Damp remaining
		if (!inWater) {
			const grounded = velocity.y <= 0.01 && this.#isGrounded(pos);
			if (grounded && velocity.y < 0) velocity.y = 0;
			const damp = grounded ? 6.0 : 1.8;
			const keep = Math.max(0, 1 - damp * dt);
			velocity.x *= keep;
			velocity.z *= keep;
			if (Math.abs(velocity.x) < 0.03) velocity.x = 0;
			if (Math.abs(velocity.z) < 0.03) velocity.z = 0;
		}

		// Walk/swim phase for animation
		if (Number.isNaN(this.#prevX)) {
			this.#prevX = pos.x;
			this.#prevZ = pos.z;
		}
		const dx = pos.x - this.#prevX;
		const dz = pos.z - this.#prevZ;
		const dist = Math.sqrt(dx * dx + dz * dz);
		if (dist > 0.001) this.#walkPhase += dist * WALK_STRIDE_FACTOR + dt * 2.0;
		else {
			this.#walkPhase += dt * 1.0; // gentle idle undulation for tentacles
		}
		this.#prevX = pos.x;
		this.#prevZ = pos.z;

		this.syncToInstances();
	}

	#isGrounded(pos: Vec3): boolean {
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
				position: { x: pos.x, y: pos.y, z: pos.z },
				hp: this.#hp,
				...extra,
			},
		};
	}
	protected getExtraPayload(): Record<string, unknown> {
		return {};
	}
}
