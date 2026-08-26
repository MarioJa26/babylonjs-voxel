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
	voxelStepUp,
} from "@/code/World/Collision/VoxelAabbCollider";
import {
	findLandSurface,
	findPathInto,
	PathNodeKind,
	type PathWaypoint,
} from "@/code/World/Pathfinding/Pathfinding";
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
const PANIC_SPEED = 5.0;
const PANIC_RADIUS = 5;
const PANIC_RADIUS_SQ = PANIC_RADIUS * PANIC_RADIUS;

const BREATH_MAX = 5.0;
const DROWN_INTERVAL = 2.0;
const DROWN_DAMAGE = 1;
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

export abstract class NeutralMob {
	abstract readonly mobType: string;
	abstract readonly CHUNK_ENTITY_TYPE: string;

	/** Spawn eggs set this to false before registry insertion (cap-exempt). */
	countsTowardMobCap = true;

	#hp: number;
	#maxHp: number;
	#position = vec3Zero();
	#velocity = vec3Zero();
	#collider: VoxelAabbCollider;
	#state: NeutralMobState = NeutralMobState.Idle;
	#stateTimer = 0;
	#facingAngle = 0;
	#scene: SceneContext;
	#playerPosition: Vec3 | null = null;
	#isDisposed = false;
	#chunkBindingHandle?: symbol;
	#fleeTimer = 0;
	#breathTimer = BREATH_MAX;
	#wanderSpeed: number;
	#halfHeight: number;

	#tmpProbe = vec3Zero();

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

	static #observerRegistered = false;
	static readonly #allMobs = new Set<NeutralMob>();

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

	static #ensureObserver(): void {
		if (NeutralMob.#observerRegistered) return;

		NeutralMob.#observerRegistered = true;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs * 0.001;
			if (dt <= 0 || isUiOpen()) return;

			NeutralMob.#pathSlotsRemaining = NeutralMob.PATH_SLOTS_PER_TICK;

			frameProfiler.begin("mobs");
			for (const mob of NeutralMob.#allMobs) {
				const pos = mob.#position;
				const chunk = getChunk(
					Math.floor(pos.x / Chunk.SIZE),
					Math.floor(pos.y / Chunk.SIZE),
					Math.floor(pos.z / Chunk.SIZE),
				);

				if (!chunk || chunk.lodLevel > 1) continue;

				mob.tick(dt);
			}
			frameProfiler.end("mobs");
		});
	}

	static disposeAll(): void {
		for (const mob of NeutralMob.#allMobs) {
			mob.dispose();
		}
	}

	protected constructor(hp: number, scene: SceneContext, halfSize: Vec3) {
		this.#hp = hp;
		this.#maxHp = hp;
		this.#scene = scene;
		this.#wanderSpeed = this.getWanderSpeed();
		this.#halfHeight = halfSize.y;
		this.#requiredHeadroom = Math.max(1, Math.ceil(halfSize.y * 2));

		this.#collider = new VoxelAabbCollider(
			halfSize,
			createVoxelColliderBlockSampler(
				(wx, wy, wz) => {
					// PERF: single chunk resolution (was two: block id + state),
					// halving the BigInt packCoords getChunk calls per voxel.
					const r = getBlockAndStateByWorldCoords(wx, wy, wz);
					if (!isCollidableBlock(r.blockId)) return null;

					// Shared scratch — consumed immediately by the sampler.
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

	protected get facingYaw(): number {
		return this.#facingAngle;
	}

	/** Register chunk binding + tick loop after instance slots are claimed. */
	protected finalizeRegistration(): void {
		this.configureChunkLoader(this.#scene);

		this.#chunkBindingHandle = registerChunkBoundEntity({
			getWorldPosition: () => this.#position,
			unload: () => this.dispose(),
			isAlive: () => !this.#isDisposed,
			serializeForChunkReload: () => this.#serializeForChunkReload(),
		});

		NeutralMob.#allMobs.add(this);
		NeutralMob.#ensureObserver();
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
			this.onDeath();
			this.dispose();
		}
	}

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

		NeutralMob.#allMobs.delete(this);
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

	tick(dt: number): void {
		if (this.#isDisposed) {
			NeutralMob.#allMobs.delete(this);
			return;
		}

		const pos = this.#position;
		const velocity = this.#velocity;

		let currentSpeed = this.#wanderSpeed;
		let fleeing = false;

		const playerPosition = this.#playerPosition;
		if (playerPosition) {
			const dx = pos.x - playerPosition.x;
			const dy = pos.y - playerPosition.y;
			const dz = pos.z - playerPosition.z;
			const distSq = dx * dx + dy * dy + dz * dz;

			if (distSq < PANIC_RADIUS_SQ) {
				this.#fleeTimer = 2.5;
			}

			if (this.#fleeTimer > 0) {
				fleeing = true;
				currentSpeed = PANIC_SPEED;
				this.#state = NeutralMobState.Wander;
				this.#path.length = 0;
				this.#pathIndex = 0;
				this.#fleeTimer -= dt;

				const awayX = pos.x - playerPosition.x;
				const awayZ = pos.z - playerPosition.z;
				if (awayX * awayX + awayZ * awayZ > 0.01) {
					this.#facingAngle = Math.atan2(awayX, awayZ);
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
					this.#path.length = 0;
					this.#pathIndex = 0;
				} else if (NeutralMob.tryClaimPathSlot()) {
					this.#state = NeutralMobState.Wander;
					this.#stateTimer = 1 + Math.random() * 4;
					this.#pickWanderTarget(pos);
				}
				// Slot denied: timer stays <= 0, retry next frame.
			}
		}

		let waterWandered = false;

		if (inWater && !fleeing) {
			this.#state = NeutralMobState.Wander;
			this.#stateTimer = 1.0;

			if (this.#path.length === 0 || this.#pathIndex >= this.#path.length) {
				this.#path.length = 0;
				this.#pathIndex = 0;
				this.#shoreSearchTimer -= dt;

				if (this.#shoreSearchTimer <= 0 && NeutralMob.tryClaimPathSlot()) {
					this.#findNearestShore(pos);

					if (this.#path.length === 0) {
						// Jittered retry: a fixed 0.5s cadence re-synchronizes
						// beached mobs into a herd that hammers the shared
						// pathfinding budget every half second.
						this.#shoreSearchTimer = 0.4 + Math.random() * 0.4;
					}
				}

				if (this.#path.length === 0) {
					this.#waterWander(dt);
					waterWandered = true;
				}
			}
		}

		let sinFacing = 0;
		let cosFacing = 0;

		if (this.#state === NeutralMobState.Wander) {
			if (this.#path.length > 0 && this.#pathIndex < this.#path.length) {
				this.#advanceOnPath(currentSpeed, dt, pos, inWater);
			} else if (inWater && !fleeing) {
				if (!waterWandered) {
					this.#waterWander(dt);
				}
			} else {
				sinFacing = Math.sin(this.#facingAngle);
				cosFacing = Math.cos(this.#facingAngle);
				velocity.x = sinFacing * currentSpeed;
				velocity.z = cosFacing * currentSpeed;
			}
		}

		if (inWater) {
			const escapingWater = this.#path.length > 0 && !fleeing;
			const headSubmerged = this.#headSubmergedCached;

			velocity.y += WATER_GRAVITY * dt;

			const targetCenterY =
				this.#waterSurfaceY - this.#halfHeight + WATER_SURFACE_OFFSET;
			const surfaceError = targetCenterY - pos.y;

			if (headSubmerged) {
				velocity.y += SWIM_BUOYANCY * dt;
			} else if (surfaceError > 0) {
				velocity.y +=
					Math.min(surfaceError * WATER_FLOAT_ACCEL, SWIM_BUOYANCY) * dt;
			} else {
				velocity.y += Math.max(surfaceError * 2.0, -1.0) * dt;
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

			const swimPathCap =
				this.#path.length > 0
					? this.#wanderSpeed * 0.9
					: this.#wanderSpeed * SWIM_SPEED_FACTOR;
			const hLenSq = velocity.x * velocity.x + velocity.z * velocity.z;
			const swimPathCapSq = swimPathCap * swimPathCap;

			if (hLenSq > swimPathCapSq) {
				const scale = swimPathCap / Math.sqrt(hLenSq);
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
				if (this.#isDisposed) return;

				this.#breathTimer = DROWN_INTERVAL;
			}
		} else {
			this.#breathTimer = BREATH_MAX;
		}

		if (
			this.#state === NeutralMobState.Wander &&
			!inWater &&
			this.#path.length === 0
		) {
			const aheadX = Math.floor(pos.x + sinFacing * 1.5);
			const aheadZ = Math.floor(pos.z + cosFacing * 1.5);
			const groundY = Math.floor(pos.y - 0.5);
			const groundBlock = getBlockByWorldCoords(aheadX, groundY, aheadZ);

			if (!isCollidableBlock(groundBlock)) {
				this.#facingAngle += Math.PI;
				this.#stateTimer = Math.min(this.#stateTimer, 0.5);
			}
		}

		const wasGrounded = this.#isGrounded(pos);
		const canStepUp = wasGrounded || (inWater && this.#path.length > 0);

		this.#moveAxis(pos, Axis.X, velocity.x * dt, canStepUp);
		this.#moveAxis(pos, Axis.Y, velocity.y * dt, canStepUp);
		this.#moveAxis(pos, Axis.Z, velocity.z * dt, canStepUp);

		const grounded = this.#isGrounded(pos);
		if (grounded && velocity.y < 0) {
			velocity.y = 0;
		}

		const damping = inWater ? WATER_HORIZONTAL_DAMPING : grounded ? 8.0 : 1.8;
		const keep = Math.max(0, 1 - damping * dt);

		velocity.x *= keep;
		velocity.z *= keep;

		if (Math.abs(velocity.x) < 0.03) velocity.x = 0;
		if (Math.abs(velocity.z) < 0.03) velocity.z = 0;

		// Publish the (possibly moved) transform to this mob's instance slots.
		this.syncToInstances();
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

	#moveAxis(pos: Vec3, axis: Axis, delta: number, canStepUp: boolean): void {
		if (
			axis !== Axis.Y &&
			canStepUp &&
			(this.#velocity.x !== 0 || this.#velocity.z !== 0)
		) {
			const savedX = pos.x;
			const savedY = pos.y;
			const savedZ = pos.z;

			if (this.#attemptStepUp(pos, axis, delta)) return;

			setVec3(pos, savedX, savedY, savedZ);
		}

		this.#collider.moveAxis(pos, this.#velocity, axis, delta, STEP_SIZE);
	}

	// PERF: bound once per mob. voxelStepUp's onStep used to allocate a fresh
	// closure per axis attempt — up to 2 per physics substep while walking.
	readonly #onStepUp = (): void => {
		this.#velocity.y = 0;
	};

	#attemptStepUp(pos: Vec3, axis: Axis.X | Axis.Z, delta: number): boolean {
		return voxelStepUp(this.#collider, pos, axis, delta, 1.0, this.#onStepUp);
	}

	#isGrounded(pos: Vec3): boolean {
		const probe = this.#tmpProbe;

		probe.x = pos.x;
		probe.y = pos.y - 0.01;
		probe.z = pos.z;

		return this.#collider.overlaps(probe);
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
						this.#facingAngle = Math.atan2(
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
				this.#facingAngle = Math.atan2(
					first.x + 0.5 - pos.x,
					first.z + 0.5 - pos.z,
				);

				return;
			}
		}

		this.#state = NeutralMobState.Idle;
		this.#stateTimer = 1 + Math.random() * 2;
		this.#velocity.x = 0;
		this.#velocity.z = 0;
		this.#path.length = 0;
		this.#pathIndex = 0;
	}

	#waterWander(dt: number): void {
		this.#waterWanderTimer -= dt;

		const hSpeedSq =
			this.#velocity.x * this.#velocity.x + this.#velocity.z * this.#velocity.z;

		if (this.#waterWanderTimer <= 0 || hSpeedSq < 0.0025) {
			this.#waterWanderTimer = 0.75 + Math.random() * 1.25;
			this.#facingAngle += -1.5 + Math.random() * 3.0;
		}

		const swimSpeed = this.#wanderSpeed * SWIM_SPEED_FACTOR;

		this.#velocity.x = Math.sin(this.#facingAngle) * swimSpeed;
		this.#velocity.z = Math.cos(this.#facingAngle) * swimSpeed;
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
			this.#velocity.x = 0;
			this.#velocity.z = 0;

			if (this.#inWaterCached || !this.#isGrounded(pos)) {
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
			this.#velocity.y += Math.max(-1, Math.min(1, dy)) * 4.0 * dt;
		}

		const dx = wp.x + 0.5 - pos.x;
		const dz = wp.z + 0.5 - pos.z;
		const distSq = dx * dx + dz * dz;

		if (distSq < 0.0001) {
			this.#velocity.x = 0;
			this.#velocity.z = 0;
			return;
		}

		const invDist = 1 / Math.sqrt(distSq);

		this.#velocity.x = dx * invDist * speed;
		this.#velocity.z = dz * invDist * speed;
		this.#facingAngle = Math.atan2(dx, dz);
	}
}
