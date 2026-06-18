import { type Mesh, type Observer, type Scene, Vector3 } from "@babylonjs/core";
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
	_blockShapeInfoScratch,
	Axis,
	type BlockShapeInfo,
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
const PANIC_SPEED = 5.0;
const PANIC_RADIUS = 5;
const PANIC_RADIUS_SQ = PANIC_RADIUS * PANIC_RADIUS;

const BREATH_MAX = 5.0;
const DROWN_INTERVAL = 2.0;
const DROWN_DAMAGE = 1;
const SWIM_BUOYANCY = 6.0;
const SWIM_SPEED_FACTOR = 0.6;

type NeutralMobState = "wander" | "idle";

export abstract class NeutralMob {
	abstract readonly mobType: string;
	abstract readonly CHUNK_ENTITY_TYPE: string;

	#hp: number;
	#maxHp: number;
	#bodyMesh!: Mesh;
	#velocity = new Vector3();
	#collider: VoxelAabbCollider;
	#state: NeutralMobState = "idle";
	#stateTimer = 0;
	#facingAngle = 0;
	#scene: Scene;
	#playerPosition: Vector3 | null = null;
	#isDisposed = false;
	#chunkBindingHandle?: symbol;
	#fleeTimer = 0;
	#breathTimer = BREATH_MAX;
	#wanderSpeed: number;
	#halfHeight: number;
	#tmpUp = new Vector3();
	#tmpFwd = new Vector3();
	#tmpGround = new Vector3();
	#tmpAway = new Vector3();
	#tmpProbe = new Vector3();

	// --- Abstract hooks for subclasses ---

	abstract configureChunkLoader(scene: Scene): void;
	abstract getWanderSpeed(): number;
	abstract onDeath(): void;

	// --- Static shared observer ---

	static #observer: Observer<Scene> | null = null;
	static readonly #allMobs = new Set<NeutralMob>();

	static #ensureObserver(): void {
		if (NeutralMob.#observer) return;
		NeutralMob.#observer = Map1.mainScene.onBeforeRenderObservable.add(() => {
			const dt = Map1.mainScene.getEngine().getDeltaTime() / 1000;
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
		if (NeutralMob.#observer) {
			Map1.mainScene.onBeforeRenderObservable.remove(NeutralMob.#observer);
			NeutralMob.#observer = null;
		}
	}

	// --- Constructor ---

	protected constructor(hp: number, scene: Scene, halfSize: Vector3) {
		this.#hp = hp;
		this.#maxHp = hp;
		this.#scene = scene;
		this.#wanderSpeed = this.getWanderSpeed();
		this.#halfHeight = halfSize.y;

		this.#collider = new VoxelAabbCollider(
			halfSize,
			(wx, wy, wz): BlockShapeInfo | null => {
				const blockId = getBlockByWorldCoords(wx, wy, wz);
				if (!isCollidableBlock(blockId)) return null;
				if (isFenceBlockId(blockId)) {
					const mask = computeFenceNeighborMask(wx, wy, wz, (fx, fy, fz) =>
						getBlockByWorldCoords(fx, fy, fz),
					);
					_blockShapeInfoScratch.shape = getFenceDynamicShape(mask);
					_blockShapeInfoScratch.rotation = 0;
					_blockShapeInfoScratch.slice = 0;
					_blockShapeInfoScratch.flipY = false;
					return _blockShapeInfoScratch;
				}
				const state = getBlockStateByWorldCoords(wx, wy, wz);
				const shape = getShapeForBlockId(blockId);
				_blockShapeInfoScratch.shape = shape;
				_blockShapeInfoScratch.rotation = shape.rotateY ? state & 3 : 0;
				_blockShapeInfoScratch.slice = 0;
				_blockShapeInfoScratch.flipY = shape.allowFlipY && (state & 4) !== 0;
				return _blockShapeInfoScratch;
			},
			EPSILON,
		);

		// Subclass calls setBodyMesh() after super() to complete setup
	}

	// --- Protected accessors for subclass use ---

	protected setBodyMesh(mesh: Mesh): void {
		this.#bodyMesh = mesh;
		mesh.metadata?.set("mob", this);

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

	protected get scene(): Scene {
		return this.#scene;
	}

	// --- Public interface ---

	get position(): Vector3 {
		return this.#bodyMesh.position;
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

	setPlayerPosition(pos: Vector3): void {
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

	// --- Water detection ---

	protected isInWater(): boolean {
		const pos = this.#bodyMesh.position;
		return (
			getBlockByWorldCoords(
				Math.floor(pos.x),
				Math.floor(pos.y),
				Math.floor(pos.z),
			) === BlockType.Water
		);
	}

	protected isHeadSubmerged(): boolean {
		const pos = this.#bodyMesh.position;
		return (
			getBlockByWorldCoords(
				Math.floor(pos.x),
				Math.floor(pos.y + this.#halfHeight),
				Math.floor(pos.z),
			) === BlockType.Water
		);
	}

	// --- Core tick ---

	tick(dt: number): void {
		if (this.#bodyMesh.isDisposed()) {
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
				this.#state = "wander";
				this.#fleeTimer -= dt;
				const away = this.#tmpAway;
				away.copyFrom(this.#bodyMesh.position);
				away.x -= this.#playerPosition.x;
				away.y -= this.#playerPosition.y;
				away.z -= this.#playerPosition.z;
				away.y = 0;
				if (away.lengthSquared() > 0.01) {
					this.#facingAngle = Math.atan2(away.x, away.z);
				}
			}
		}

		// State machine — only when not fleeing
		if (!fleeing) {
			this.#stateTimer -= dt;
			if (this.#stateTimer <= 0) {
				if (this.#state === "wander") {
					this.#state = "idle";
					this.#stateTimer = 2 + Math.random() * 3;
					this.#velocity.x = 0;
					this.#velocity.z = 0;
				} else {
					this.#state = "wander";
					this.#stateTimer = 1 + Math.random() * 4;
					this.#facingAngle += (Math.random() - 0.5) * Math.PI;
				}
			}
		}

		// Apply movement
		if (this.#state === "wander") {
			this.#velocity.x = Math.sin(this.#facingAngle) * currentSpeed;
			this.#velocity.z = Math.cos(this.#facingAngle) * currentSpeed;
		}

		// Gravity / Water physics
		const inWater = this.isInWater();
		if (inWater) {
			this.#velocity.y += SWIM_BUOYANCY * dt;
			if (this.#velocity.y > 2.0) this.#velocity.y = 2.0;
			const maxH = this.#wanderSpeed * SWIM_SPEED_FACTOR;
			const hLen = Math.sqrt(
				this.#velocity.x * this.#velocity.x +
					this.#velocity.z * this.#velocity.z,
			);
			if (hLen > maxH) {
				const scale = maxH / hLen;
				this.#velocity.x *= scale;
				this.#velocity.z *= scale;
			}
			this.#breathTimer = BREATH_MAX;
		} else {
			this.#velocity.y += GRAVITY * dt;
			this.#breathTimer = BREATH_MAX;
		}

		// Drowning
		if (inWater && this.isHeadSubmerged()) {
			this.#breathTimer -= dt;
			if (this.#breathTimer <= 0) {
				this.takeDamage(DROWN_DAMAGE);
				this.#breathTimer = DROWN_INTERVAL;
			}
		}

		// Edge detection — skip while swimming
		if (this.#state === "wander" && !inWater) {
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
		this.#moveAxis(Axis.X, this.#velocity.x * dt);
		this.#moveAxis(Axis.Y, this.#velocity.y * dt);
		this.#moveAxis(Axis.Z, this.#velocity.z * dt);

		// Ground check
		const grounded = this.#isGrounded();
		if (grounded && this.#velocity.y < 0) {
			this.#velocity.y = 0;
		}

		// Damping
		const damping = grounded ? 8.0 : 1.8;
		const keep = Math.max(0, 1 - damping * dt);
		this.#velocity.x *= keep;
		this.#velocity.z *= keep;

		// Snap to zero when slow
		if (Math.abs(this.#velocity.x) < 0.03) this.#velocity.x = 0;
		if (Math.abs(this.#velocity.z) < 0.03) this.#velocity.z = 0;

		// Rotate body to face movement direction
		if (this.#state === "wander") {
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

	#moveAxis(axis: Axis, delta: number): void {
		if (
			axis !== Axis.Y &&
			this.#isGrounded() &&
			(this.#velocity.x !== 0 || this.#velocity.z !== 0)
		) {
			const pos = this.#bodyMesh.position;
			const savedX = pos.x;
			const savedY = pos.y;
			const savedZ = pos.z;
			if (this.#attemptStepUp(pos, axis, delta)) return;
			pos.set(savedX, savedY, savedZ);
		}
		this.#collider.moveAxis(
			this.#bodyMesh.position,
			this.#velocity,
			axis,
			delta,
			STEP_SIZE,
		);
	}

	#attemptStepUp(pos: Vector3, axis: Axis.X | Axis.Z, delta: number): boolean {
		const up = this.#tmpUp;
		const fwd = this.#tmpFwd;
		const ground = this.#tmpGround;

		for (let rise = 0.25; rise <= 1.0; rise += 0.25) {
			up.copyFrom(pos);
			up.y += rise;
			if (this.#collider.overlaps(up)) continue;

			fwd.copyFrom(up);
			if (axis === Axis.X) fwd.x += delta;
			else fwd.z += delta;
			if (this.#collider.overlaps(fwd)) continue;

			ground.copyFrom(fwd);
			ground.y -= 0.08;
			if (!this.#collider.overlaps(ground)) continue;

			pos.copyFrom(fwd);
			this.#velocity.y = 0;
			return true;
		}
		return false;
	}

	#isGrounded(): boolean {
		const probe = this.#tmpProbe;
		probe.copyFrom(this.#bodyMesh.position);
		probe.y -= 0.01;
		return this.#collider.overlaps(probe);
	}
}
