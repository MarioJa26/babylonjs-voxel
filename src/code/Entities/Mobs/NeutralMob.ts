import {
	type LiteMetadata,
	type Mesh,
	onBeforeRender,
	type SceneContext,
	type Vec3,
} from "@babylonjs/lite";
import { MetadataContainer } from "@/code/Entities/MetadataContainer";
import { copyVec3, lengthSqVec3, setVec3, vec3Zero } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import type { Player } from "@/code/Player/Player";
import { Chunk, getChunk } from "@/code/World/Chunk/Chunk";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
	registerChunkBoundEntity,
	unregisterChunkBoundEntity,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
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

	#hp: number;
	#maxHp: number;
	#bodyMesh!: Mesh;
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

	#tmpAway = vec3Zero();
	#tmpProbe = vec3Zero();

	#path: PathWaypoint[] = [];
	#pathIndex = 0;
	#shoreSearchTimer = 0;
	#waterWanderTimer = 0;
	readonly #requiredHeadroom: number;
	#inWaterCached = false;
	#headSubmergedCached = false;
	#waterSurfaceY = 0;

	// --- Abstract hooks for subclasses ---

	abstract configureChunkLoader(scene: SceneContext): void;
	abstract getWanderSpeed(): number;
	abstract onDeath(): void;

	// --- Static shared observer ---

	static #observerRegistered = false;
	static readonly #allMobs = new Set<NeutralMob>();

	static #ensureObserver(): void {
		if (NeutralMob.#observerRegistered) return;
		NeutralMob.#observerRegistered = true;
		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			const dt = deltaMs / 1000;
			if (dt <= 0) return;
			for (const mob of NeutralMob.#allMobs) {
				if (!mob.#bodyMesh) continue;
				const pos = mob.#bodyMesh.position;
				const cx = Math.floor(pos.x / Chunk.SIZE);
				const cy = Math.floor(pos.y / Chunk.SIZE);
				const cz = Math.floor(pos.z / Chunk.SIZE);
				const chunk = getChunk(cx, cy, cz);
				if (!chunk || chunk.lodLevel > 1) continue;
				mob.tick(dt);
			}
		});
	}

	static disposeAll(): void {
		for (const mob of [...NeutralMob.#allMobs]) {
			mob.dispose();
		}
	}

	// --- Constructor ---

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
					const blockId = getBlockByWorldCoords(wx, wy, wz);
					if (!isCollidableBlock(blockId)) return null;
					return {
						blockId,
						blockState: getBlockStateByWorldCoords(wx, wy, wz),
					};
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

		// Subclass calls setBodyMesh() after super() to complete setup
	}

	// --- Protected accessors for subclass use ---

	protected setBodyMesh(mesh: Mesh): void {
		this.#bodyMesh = mesh;
		let meta = mesh.metadata as MetadataContainer | undefined;
		if (!meta) {
			meta = new MetadataContainer();
			mesh.metadata = meta as unknown as LiteMetadata;
		}
		meta.set("mob", this);

		this.configureChunkLoader(this.#scene);

		this.#chunkBindingHandle = registerChunkBoundEntity({
			getWorldPosition: () => this.#bodyMesh.position,
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

	// --- Public interface ---

	get position(): Vec3 {
		return this.#bodyMesh.position as unknown as Vec3;
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
		(this.#bodyMesh.metadata as MetadataContainer | undefined)?.delete("mob");
		unregisterChunkBoundEntity(this.#chunkBindingHandle);
		this.#chunkBindingHandle = undefined;
		NeutralMob.#allMobs.delete(this);
		Map1.mobRegistry?.removeMob(this);
		this.#collider.dispose();
	}

	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	// --- Water detection ---

	#updateWaterState(): boolean {
		const pos = this.#bodyMesh.position;
		const x = Math.floor(pos.x);
		const z = Math.floor(pos.z);
		const feetY = Math.floor(pos.y - this.#halfHeight + 0.05);
		const centerY = Math.floor(pos.y);
		const headY = Math.floor(pos.y + this.#halfHeight - 0.05);

		// Batch lookups: resolve chunk once and read all 3 Y values locally.
		const chunkCX = x >> 5;
		const chunkCY = feetY >> 5;
		const chunkCZ = z >> 5;
		const sameChunk = centerY >> 5 === chunkCY && headY >> 5 === chunkCY;
		let feetInWater = false;
		let centerInWater = false;
		let headInWater = false;
		if (sameChunk) {
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

		this.#inWaterCached = feetInWater || centerInWater || headInWater;
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

		return this.#inWaterCached;
	}

	protected isInWater(): boolean {
		return this.#inWaterCached;
	}

	protected isHeadSubmerged(): boolean {
		return this.#headSubmergedCached;
	}

	// --- Core tick ---

	tick(dt: number): void {
		if (this.#isDisposed) {
			NeutralMob.#allMobs.delete(this);
			return;
		}

		// Panic check — run from player
		let currentSpeed = this.#wanderSpeed;
		let fleeing = false;
		if (this.#playerPosition) {
			const pos = this.#bodyMesh.position;
			const dx = pos.x - this.#playerPosition.x;
			const dy = pos.y - this.#playerPosition.y;
			const dz = pos.z - this.#playerPosition.z;
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
				const away = this.#tmpAway;
				copyVec3(away, this.#bodyMesh.position as unknown as Vec3);
				away.x -= this.#playerPosition.x;
				away.y -= this.#playerPosition.y;
				away.z -= this.#playerPosition.z;
				away.y = 0;
				if (lengthSqVec3(away) > 0.01) {
					this.#facingAngle = Math.atan2(away.x, away.z);
				}
			}
		}

		// Water detection (used early for water escape)
		const inWater = this.#updateWaterState();

		// State machine — only when not fleeing and not in water
		if (!fleeing && !inWater) {
			this.#stateTimer -= dt;
			if (this.#stateTimer <= 0) {
				if (this.#state === NeutralMobState.Wander) {
					this.#state = NeutralMobState.Idle;
					this.#stateTimer = 2 + Math.random() * 3;
					this.#velocity.x = 0;
					this.#velocity.z = 0;
					this.#path.length = 0;
					this.#pathIndex = 0;
				} else {
					this.#state = NeutralMobState.Wander;
					this.#stateTimer = 1 + Math.random() * 4;
					this.#pickWanderTarget();
				}
			}
		}

		// Water behavior — always wander/swim while in water.
		if (inWater && !fleeing) {
			this.#state = NeutralMobState.Wander;
			this.#stateTimer = 1.0;
			if (this.#path.length === 0 || this.#pathIndex >= this.#path.length) {
				this.#path.length = 0;
				this.#pathIndex = 0;
				this.#shoreSearchTimer -= dt;
				if (this.#shoreSearchTimer <= 0) {
					this.#findNearestShore();
					if (this.#path.length === 0) {
						this.#shoreSearchTimer = 0.5;
					}
				}
				if (this.#path.length === 0) {
					this.#waterWander(dt);
				}
			}
		}

		// Apply movement — pathfinding or free wander
		if (this.#state === NeutralMobState.Wander) {
			if (this.#path.length > 0 && this.#pathIndex < this.#path.length) {
				this.#advanceOnPath(currentSpeed, dt);
			} else if (inWater && !fleeing) {
				this.#waterWander(dt);
			} else {
				this.#velocity.x = Math.sin(this.#facingAngle) * currentSpeed;
				this.#velocity.z = Math.cos(this.#facingAngle) * currentSpeed;
			}
		}

		// Gravity / Water physics
		if (inWater) {
			const escapingWater = this.#path.length > 0 && !fleeing;
			const headSubmerged = this.#headSubmergedCached;

			this.#velocity.y += WATER_GRAVITY * dt;

			const targetCenterY =
				this.#waterSurfaceY - this.#halfHeight + WATER_SURFACE_OFFSET;
			const surfaceError = targetCenterY - this.#bodyMesh.position.y;

			if (headSubmerged) {
				this.#velocity.y += SWIM_BUOYANCY * dt;
			} else if (surfaceError > 0) {
				const floatAccel = Math.min(
					surfaceError * WATER_FLOAT_ACCEL,
					SWIM_BUOYANCY,
				);
				this.#velocity.y += floatAccel * dt;
			} else {
				this.#velocity.y += Math.max(surfaceError * 2.0, -1.0) * dt;
			}

			if (escapingWater) {
				this.#velocity.y += WATER_ESCAPE_BUOYANCY * dt;
			}

			const verticalKeep = Math.max(0, 1 - WATER_VERTICAL_DAMPING * dt);
			this.#velocity.y *= verticalKeep;

			const maxUpSpeed = escapingWater
				? WATER_ESCAPE_MAX_UP_SPEED
				: WATER_MAX_UP_SPEED;
			if (this.#velocity.y > maxUpSpeed) {
				this.#velocity.y = maxUpSpeed;
			} else if (this.#velocity.y < WATER_MAX_DOWN_SPEED) {
				this.#velocity.y = WATER_MAX_DOWN_SPEED;
			}

			const swimPathCap =
				this.#path.length > 0
					? this.#wanderSpeed * 0.9
					: this.#wanderSpeed * SWIM_SPEED_FACTOR;
			const hLenSq =
				this.#velocity.x * this.#velocity.x +
				this.#velocity.z * this.#velocity.z;
			if (hLenSq > swimPathCap * swimPathCap) {
				const scale = swimPathCap / Math.sqrt(hLenSq);
				this.#velocity.x *= scale;
				this.#velocity.z *= scale;
			}
		} else {
			this.#velocity.y += GRAVITY * dt;
		}

		// Drowning
		if (inWater && this.#headSubmergedCached) {
			this.#breathTimer -= dt;
			if (this.#breathTimer <= 0) {
				this.takeDamage(DROWN_DAMAGE);
				this.#breathTimer = DROWN_INTERVAL;
			}
		} else {
			this.#breathTimer = BREATH_MAX;
		}

		// Edge detection — skip while swimming or pathfinding
		if (
			this.#state === NeutralMobState.Wander &&
			!inWater &&
			this.#path.length === 0
		) {
			const aheadX = Math.floor(
				this.#bodyMesh.position.x + Math.sin(this.#facingAngle) * 1.5,
			);
			const aheadZ = Math.floor(
				this.#bodyMesh.position.z + Math.cos(this.#facingAngle) * 1.5,
			);
			const groundY = Math.floor(this.#bodyMesh.position.y - 0.5);
			const groundBlock = getBlockByWorldCoords(aheadX, groundY, aheadZ);
			if (!isCollidableBlock(groundBlock)) {
				this.#facingAngle += Math.PI;
				this.#stateTimer = Math.min(this.#stateTimer, 0.5);
			}
		}

		// Move with collision
		const wasGrounded = this.#isGrounded();
		const canStepUp = wasGrounded || (inWater && this.#path.length > 0);
		this.#moveAxis(Axis.X, this.#velocity.x * dt, canStepUp);
		this.#moveAxis(Axis.Y, this.#velocity.y * dt, canStepUp);
		this.#moveAxis(Axis.Z, this.#velocity.z * dt, canStepUp);

		// Ground check
		const grounded = this.#isGrounded();
		if (grounded && this.#velocity.y < 0) {
			this.#velocity.y = 0;
		}

		// Damping
		const damping = inWater ? WATER_HORIZONTAL_DAMPING : grounded ? 8.0 : 1.8;
		const keep = Math.max(0, 1 - damping * dt);
		this.#velocity.x *= keep;
		this.#velocity.z *= keep;

		// Snap to zero when slow
		if (Math.abs(this.#velocity.x) < 0.03) this.#velocity.x = 0;
		if (Math.abs(this.#velocity.z) < 0.03) this.#velocity.z = 0;

		// Rotate body to face movement direction
		if (this.#state === NeutralMobState.Wander) {
			this.#bodyMesh.rotation.y = this.#facingAngle;
		}
	}

	#serializeForChunkReload(): SavedChunkEntityData | null {
		if (this.#isDisposed) return null;
		const pos = this.#bodyMesh.position;
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

	#moveAxis(axis: Axis, delta: number, canStepUp: boolean): void {
		if (
			axis !== Axis.Y &&
			canStepUp &&
			(this.#velocity.x !== 0 || this.#velocity.z !== 0)
		) {
			const pos = this.#bodyMesh.position as unknown as Vec3;
			const savedX = pos.x;
			const savedY = pos.y;
			const savedZ = pos.z;
			if (this.#attemptStepUp(pos, axis, delta)) return;
			setVec3(pos, savedX, savedY, savedZ);
		}
		this.#collider.moveAxis(
			this.#bodyMesh.position as unknown as Vec3,
			this.#velocity,
			axis,
			delta,
			STEP_SIZE,
		);
	}

	#attemptStepUp(pos: Vec3, axis: Axis.X | Axis.Z, delta: number): boolean {
		return voxelStepUp(this.#collider, pos, axis, delta, 1.0, () => {
			this.#velocity.y = 0;
		});
	}

	#isGrounded(): boolean {
		const probe = this.#tmpProbe;
		copyVec3(probe, this.#bodyMesh.position as unknown as Vec3);
		probe.y -= 0.01;
		return this.#collider.overlaps(probe);
	}

	#findNearestShore(): void {
		const pos = this.#bodyMesh.position;
		const sx = Math.round(pos.x);
		const sz = Math.round(pos.z);
		const sy =
			this.isInWater() && this.#waterSurfaceY > 0
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

	#pickWanderTarget(): void {
		const pos = this.#bodyMesh.position;
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

		// No reachable target — go idle early
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

	#advanceOnPath(speed: number, dt: number): void {
		const pos = this.#bodyMesh.position;

		const inWater = this.isInWater();
		while (this.#pathIndex < this.#path.length) {
			const wp = this.#path[this.#pathIndex];
			const dx = wp.x + 0.5 - pos.x;
			const dz = wp.z + 0.5 - pos.z;
			if (
				inWater &&
				this.#pathIndex === this.#path.length - 1 &&
				this.#path[this.#pathIndex].kind === PathNodeKind.Land
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
			if (this.isInWater() || !this.#isGrounded()) {
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
			const clampedDy = Math.max(-1, Math.min(1, dy));
			this.#velocity.y += clampedDy * 4.0 * dt;
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
