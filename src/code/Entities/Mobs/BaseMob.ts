import { onBeforeRender, type SceneContext, type Vec3 } from "@babylonjs/lite";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import { playMobDamage } from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import type { Player } from "@/code/Player/Player";
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
	voxelStepUp,
} from "@/code/World/Collision/VoxelAabbCollider";
import { getShapeForBlockId } from "@/code/World/Shape/BlockShapes";
import {
	computeFenceNeighborMask,
	getFenceDynamicShape,
	isFenceBlockId,
} from "@/code/World/Shape/FenceConnect";
import { isCollidableBlock } from "@/code/World/Texture/BlockType";
import type { SavedChunkEntityData } from "@/code/World/WorldStorage";
import type { Mob } from "./Mob";

const STEP_SIZE = 0.2;
const EPSILON = 0.001;

/**
 * Per-family staged tick membership plus its scene-tracked frame observer.
 *
 * Mobs staged mid-frame begin simulation on the next frame: deleting the
 * current entry during Set iteration is safe, but entries added
 * mid-iteration could otherwise tick immediately. Each family keeps its own
 * set because tick loops, chunk gates, and path budgets differ; only the
 * staging/drain/dispose/observer machinery is shared.
 */
export class MobTickSet<
	T extends { readonly isDisposed: boolean; dispose(): void },
> {
	#live = new Set<T>();
	#pending: T[] = [];
	#observedScene: SceneContext | null = null;

	constructor(private readonly tickAll: (deltaMs: number) => void) {}

	/** Stage a mob for next-frame simulation (idempotent observer setup). */
	stage(mob: T): void {
		this.#pending.push(mob);
		this.ensureObserver();
	}

	remove(mob: T): void {
		this.#live.delete(mob);
	}

	/** Move staged mobs into the tick set, skipping those already disposed. */
	drain(): void {
		const pending = this.#pending;

		if (pending.length === 0) {
			return;
		}

		for (const mob of pending) {
			// A mob disposed between registration and this frame (e.g.
			// chunk unload) never enters the tick set; dispose() already
			// released its slot, lighting, and chunk binding.
			if (!mob.isDisposed) {
				this.#live.add(mob);
			}
		}

		pending.length = 0;
	}

	disposeAll(): void {
		for (const mob of this.#pending) {
			mob.dispose();
		}

		this.#pending.length = 0;

		// Deleting the current Set entry during iteration is valid.
		for (const mob of this.#live) {
			mob.dispose();
		}
	}

	ensureObserver(): void {
		// Scene-tracked, not a boolean flag: Map1.mainScene is reassigned
		// on every world load, and a stuck flag would leave the new scene
		// with no tick observer (frozen mobs).
		if (this.#observedScene === Map1.mainScene) {
			return;
		}

		this.#observedScene = Map1.mainScene;

		const tickAll = this.tickAll;

		onBeforeRender(Map1.mainScene, (deltaMs: number) => {
			tickAll(deltaMs);
		});
	}

	[Symbol.iterator](): IterableIterator<T> {
		return this.#live.values();
	}
}

/**
 * Shared lifecycle, physics state, and movement helpers for the four mob
 * families (neutral, hostile, aquatic, flying).
 *
 * Owns everything the families previously copy-pasted: hit points, body
 * state, collider construction, chunk binding, registry membership,
 * damage/death flow, chunk serialization, and the axis/step-up/grounded
 * movement primitives. Tick bodies, AI state machines, chunk gates, and
 * family-specific movement stay in the subclasses untouched.
 */
export abstract class BaseMob implements Mob {
	abstract readonly mobType: string;
	/** Chunk persistence key; empty when the family never persists. */
	readonly CHUNK_ENTITY_TYPE: string = "";

	/** Spawn eggs set this to false before registry insertion (cap-exempt). */
	countsTowardMobCap = true;

	#hp: number;
	#maxHp: number;
	#scene: SceneContext;
	#isDisposed = false;
	#chunkBindingHandle?: symbol;

	protected bodyPosition = vec3Zero();
	protected bodyVelocity = vec3Zero();
	protected bodyCollider: VoxelAabbCollider;
	protected hitExtents: Vec3;
	protected facingAngle = 0;
	/** Walk/flap phase (radians); written to the instance color alpha. */
	protected walkPhase = 0;
	protected prevX = Number.NaN;
	protected prevZ = Number.NaN;
	/** Y position where the current fall started; NaN when grounded/in water. */
	protected fallStartY = Number.NaN;
	protected halfHeight: number;
	protected feetHeight: number;
	protected wanderSpeed: number;
	protected playerPosition: Vec3 | null = null;

	protected tmpProbe = vec3Zero();
	protected tmpGroundExtents = vec3Zero();
	protected tmpFallNudge = vec3Zero();

	abstract getWanderSpeed(): number;
	abstract onDeath(): void;
	/** Push the mob's current transform into its instance pool slots. */
	protected abstract syncToInstances(): void;
	abstract configureChunkLoader(scene: SceneContext): void;
	/** Family tick set for staging/removal (loops stay per-family). */
	protected abstract stageForTick(): void;
	protected abstract unstageFromTick(): void;

	protected constructor(
		hp: number,
		scene: SceneContext,
		halfSize: Vec3,
		feetHeight?: number,
	) {
		this.#hp = hp;
		this.#maxHp = hp;
		this.#scene = scene;
		this.hitExtents = { x: halfSize.x, y: halfSize.y, z: halfSize.z };
		this.halfHeight = halfSize.y;
		this.feetHeight = feetHeight ?? halfSize.y;
		this.wanderSpeed = this.getWanderSpeed();

		this.bodyCollider = new VoxelAabbCollider(
			halfSize,
			createVoxelColliderBlockSampler(
				(wx, wy, wz) => {
					// Streaming-unloaded cells now rest on a cobble
					// sentinel so mobs don't fall through seams the way
					// they did when ticks ran on not-yet-loaded chunks,
					// leaving the mob accumulating fall velocity forever.
					// Once the chunk streams in the collider snaps down to
					// the real surface.
					const r = resolveBlockAtWorldCoords(wx, wy, wz);
					if (r.unloaded) return UNLOADED_SOLID_RESOLVE;
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
		setVec3(this.bodyPosition, x, y, z);
	}

	get facingYaw(): number {
		return this.facingAngle;
	}

	get hitHalfExtents(): Vec3 {
		return this.hitExtents;
	}

	/** Register chunk binding + tick loop after instance slots are claimed. */
	protected finalizeRegistration(): void {
		this.configureChunkLoader(this.#scene);

		this.#chunkBindingHandle = registerChunkBoundEntity({
			getWorldPosition: () => this.bodyPosition,
			unload: () => this.dispose(),
			isAlive: () => !this.#isDisposed,
			serializeForChunkReload: () => this.serializeForChunkReload(),
		});

		this.stageForTick();
	}

	get position(): Vec3 {
		return this.bodyPosition;
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
		this.playerPosition = pos;
	}

	takeDamage(amount: number, impactPosition?: Vec3): void {
		this.#hp -= amount;

		// Blood particles at the hit point when available, otherwise at the
		// mob's body center for fall/environmental damage.
		const bloodPosition = impactPosition ?? this.bodyPosition;
		playMobDamage(bloodPosition.x, bloodPosition.y, bloodPosition.z, amount);

		if (this.#hp <= 0) {
			this.#hp = 0;
			this.onDeath();
			this.dispose();
			return;
		}

		this.onDamaged();
	}

	/** Called when the mob takes damage but survives. */
	protected onDamaged(): void {}

	/**
	 * Flee response hook. Neutral and flying families override this with a
	 * real implementation; aquatic mobs ignore panic.
	 */
	protected triggerPanic(_duration: number): void {}

	/**
	 * Damage without blood, drops, or the onDamaged hook (e.g. daylight
	 * burn). Returns true when lethal — the mob is already disposed, so the
	 * caller must stop ticking immediately.
	 */
	protected applySilentDamage(amount: number): boolean {
		this.#hp -= amount;

		if (this.#hp <= 0) {
			this.#hp = 0;
			this.dispose();
			return true;
		}

		return false;
	}

	serializeForChunkReload(): SavedChunkEntityData | null {
		if (this.#isDisposed || !this.persistsToChunk()) {
			return null;
		}

		const pos = this.bodyPosition;
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

	/** False for families that never persist (flyers). */
	protected persistsToChunk(): boolean {
		return true;
	}

	protected getExtraPayload(): Record<string, unknown> {
		return {};
	}

	use(_player: Player): void {
		// Placeholder
	}

	dispose(): void {
		if (this.#isDisposed) return;

		this.#isDisposed = true;

		unregisterChunkBoundEntity(this.#chunkBindingHandle);
		this.#chunkBindingHandle = undefined;

		this.unstageFromTick();
		Map1.mobRegistry?.removeMob(this);

		this.bodyCollider.dispose();
		this.playerPosition = null;
	}

	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	/**
	 * End-of-tick bookkeeping shared by walkers and flyers: refresh the
	 * registry spatial cell, then push the transform to the instance pool.
	 * Swimmers call the same two steps around their animation update.
	 */
	protected commitTick(): void {
		Map1.mobRegistry?.updateMobPosition(this);
		this.syncToInstances();
	}

	protected moveAxis(
		pos: Vec3,
		axis: Axis,
		delta: number,
		canStepUp: boolean,
	): void {
		if (
			axis !== Axis.Y &&
			canStepUp &&
			(this.bodyVelocity.x !== 0 || this.bodyVelocity.z !== 0)
		) {
			const savedX = pos.x;
			const savedY = pos.y;
			const savedZ = pos.z;

			if (this.attemptStepUp(pos, axis, delta)) return;

			setVec3(pos, savedX, savedY, savedZ);
		}

		this.bodyCollider.moveAxis(pos, this.bodyVelocity, axis, delta, STEP_SIZE);
	}

	// PERF: bound once per mob. voxelStepUp's onStep used to allocate a fresh
	// closure per axis attempt — up to 2 per physics substep while walking.
	protected readonly onStepUp = (): void => {
		this.bodyVelocity.y = 0;
	};

	protected attemptStepUp(
		pos: Vec3,
		axis: Axis.X | Axis.Z,
		delta: number,
	): boolean {
		return voxelStepUp(this.bodyCollider, pos, axis, delta, 1.0, this.onStepUp);
	}

	protected isGrounded(pos: Vec3): boolean {
		// Central support check: mining the block directly under the mob must
		// make it fall, even if neighboring blocks would still support the
		// wide collider. This matches the server's single-column scanDown.
		const cx = Math.floor(pos.x);
		const cy = Math.floor(pos.y - this.feetHeight - 0.02);
		const cz = Math.floor(pos.z);
		if (!isCollidableBlock(getBlockByWorldCoords(cx, cy, cz))) return false;
		// Narrow foot probe so a single missing block under the center makes the
		// mob fall, matching the server's single-column scanDown and the player's
		// 0.7× footProbe. The old full-AABB overlap let wide mobs (Sheep z=0.52)
		// stay grounded on neighboring blocks after the center was mined.
		// Use feetHeight (visual bottom) — for Sheep feet is 0.23 below the
		// collider, so probing at halfHeight misses the ground and makes the
		// mob hover one block above it.
		const probe = this.tmpProbe;
		const footY = pos.y - this.feetHeight;
		probe.x = pos.x;
		probe.y = footY - 0.04;
		probe.z = pos.z;
		const ext = this.tmpGroundExtents;
		setVec3(ext, this.hitExtents.x * 0.7, 0.04, this.hitExtents.z * 0.7);
		return this.bodyCollider.overlapsBox(probe, ext);
	}

	/**
	 * Returns whether the block directly beneath the visual center of the mob is
	 * collidable.
	 *
	 * Keeping this lookup in one helper prevents the grounded check, post-movement
	 * failsafe, and absolute fall failsafe from independently rebuilding the same
	 * coordinates.
	 */
	protected hasCentralSupport(pos: Vec3, yOffset = 0.05): boolean {
		return isCollidableBlock(
			getBlockByWorldCoords(
				Math.floor(pos.x),
				Math.floor(pos.y - this.feetHeight - yOffset),
				Math.floor(pos.z),
			),
		);
	}
}
