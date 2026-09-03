/**
 * MobSimulation — server-authoritative lightweight animal simulation.
 *
 * Deliberately Babylon-free: runs on the fixed-rate room tick using only
 * synchronous block lookups (ServerWorldStorage.getCachedChunkBlocks), so
 * the server never blocks on LevelDB. Clients render these mobs as remote
 * interpolated meshes driven by MobSpawn / MobUpdateBatch / MobDespawn.
 *
 * Spawn rules mirror the client's singleplayer SpawnCoordinator/MobSetup:
 * grass below, air above, ring 24–96 blocks around a player, per-type caps.
 * Sky-light is not checked server-side (the air-above test approximates it).
 *
 * Mobs are chunk-column scoped: a column within MOB_ACTIVE_RADIUS_CHUNKS of a
 * player is "loaded". When a column leaves that radius its mobs are persisted
 * to LevelDB and removed from the active set (freeing their cap slot); when a
 * column re-enters it, the mobs are loaded back. Only loaded (active) mobs
 * count toward the per-type caps, so a world full of persisted mobs never
 * blocks new spawns near players.
 */

import {
	FALL_DAMAGE_PER_BLOCK,
	FALL_DAMAGE_THRESHOLD,
	MOB_SPAWN_CONFIGS,
	MOB_STATS,
} from "@/code/Entities/MobConfig";
import { CHUNK_SHIFT, CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import { unpackBlockId } from "@/code/World/Chunk/DataStructures/BlockEncoding";
import {
	packChunkKeyFast,
	unpackChunkKeyFast,
} from "@/code/World/Storage/ChunkKey.ts";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import { MinHeap } from "./MinHeap.ts";
import type { PersistedMob, ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface ServerMob {
	readonly id: number;
	readonly typeId: number;
	/** Mob center position (same convention as the client's mesh position). */
	x: number;
	y: number;
	z: number;
	/** 0-255 byte mapping the full 360° circle (player yaw convention). */
	yaw: number;
	/** Current hit points; the mob dies (and despawns) at 0. */
	hp: number;
	/** Y position where the current fall started; NaN when not falling. */
	fallStartY: number;
	/** ms until the next random wander heading. */
	headingTimer: number;
	/** ms without forward progress — forces a new heading. */
	stuckTimer: number;
	/** Whether the mob was already fleeing on the previous tick. */
	fleeing: boolean;
	/** ms remaining in a damage-triggered panic; 0 = not panicking. */
	fleeTimer: number;
	path: ServerWaypoint[];
	pathIndex: number;
	pathTimer: number;
	/**
	 * Spawn-egg mobs are cap-exempt: they never occupy a cap slot, so the
	 * mob cap (which limits natural spawning only) can never block them.
	 */
	egg: boolean;
}
type PlayerPosition = Readonly<{
	x: number;
	y: number;
	z: number;
}>;

type PlayerColumnPosition = Readonly<{
	x: number;
	z: number;
}>;

interface ServerWaypoint {
	x: number;
	z: number;
	groundY: number;
}

export interface ServerMobEvent {
	kind: "spawn" | "despawn" | "impact";
	mob: ServerMob;
	/** Fall distance used to scale the landing particle burst. */
	fallDistance?: number;
	/** Fall damage accepted by the server, used for the remote blood effect. */
	damage?: number;
}

/** A mob death recorded for food-drop spawning (drained by the room). */
export interface ServerMobDeath {
	typeId: number;
	x: number;
	y: number;
	z: number;
}

const FLEE_SPEED = 5;
const FLEE_DURATION_MS = 3000; // How long a mob flees after being damaged

const MOB_TYPE_IDS = Object.keys(MOB_STATS).map(Number);
const TOTAL_MOB_CAP = MOB_TYPE_IDS.reduce(
	(sum, typeId) => sum + MOB_SPAWN_CONFIGS[typeId].maxCount,
	0,
);

/**
 * Spawn cap enforced per player's spawn region (not globally). A single shared
 * cap is saturated by the combined active mobs of every player, which halted
 * all spawning once a second player joined — mobs spawned fine with one player
 * but never with two. Each player's region may hold up to this many mobs.
 */
const PER_PLAYER_MOB_CAP = TOTAL_MOB_CAP;
/** Global safety ceiling (players × per-player cap) to bound total mob count. */
const HARD_MOB_CAP = TOTAL_MOB_CAP * 4;

/**
 * Block ids a mob may spawn on top of (the surface voxel directly below the
 * mob's feet). Add or remove entries freely to control where mobs appear.
 */
export const SPAWNABLE_BLOCK_IDS: readonly number[] = [
	BlockType.RockyTerrain02, // 14
	BlockType.Grass001, // 15
	BlockType.ConcreteMoss, // 51
];
const SPAWNABLE_BLOCK_ID_SET = new Set<number>(SPAWNABLE_BLOCK_IDS);
const SPAWN_INTERVAL_MS = 1000;
const SPAWN_RING_MIN = 32;
const SPAWN_RING_MAX = 128;
const SPAWN_ATTEMPTS = 6;
// Chunk columns within this many chunks of a player are "loaded". Mobs in
// unloaded columns are persisted and removed from the active set (freeing
// their cap slot); they are loaded back when the column is loaded again.
const MOB_ACTIVE_RADIUS_CHUNKS = 8;
const WANDER_MIN_MS = 1000;
const WANDER_MAX_MS = 4000;
const STUCK_MS = 1500;
const FALL_LIMIT = 24; // Blocks of free-fall before the mob is removed
/**
 * Deepest voluntary step-down (blocks), mirroring the client's NeutralMob
 * cliff guard. Drops deeper than this would deal fall damage (see
 * FALL_DAMAGE_THRESHOLD), so canMoveTo refuses them — for wandering and
 * fleeing alike.
 */
const MAX_SAFE_LEDGE_DROP = 3;
const MAX_SPAWN_SCAN_Y = 1024;

const COLUMN_SCAN_WATER = Number.POSITIVE_INFINITY;
const COLUMN_SCAN_UNKNOWN = Number.NEGATIVE_INFINITY;
const COLUMN_SCAN_AIR = Number.MAX_VALUE;

const FULL_YAW = 256;
const HALF_YAW = 128;
const QUARTER_YAW = 64;
const YAW_MASK = 255;
const TWO_PI = Math.PI * 2;
const MS_TO_SECONDS = 0.001;

const PATH_DX = new Int8Array([1, -1, 0, 0]);
const PATH_DZ = new Int8Array([0, 0, 1, -1]);

/**
 * Block sampler for one simulation tick. Caches the decompressed chunk
 * arrays it touches so a mob scanning a column doesn't re-fetch the same
 * chunk for every voxel, and so the storage decompress pool isn't thrashed.
 */
const INV_CHUNK_SIZE = 1 / CHUNK_SIZE;

class TickBlockSampler {
	private readonly chunkCache = new Map<
		number,
		Uint8Array | Uint16Array | null
	>();

	/*
	 * Chunk key -> local voxel index -> raw block ID.
	 *
	 * Local indices occupy 15 bits:
	 *   bits 0..4   = X
	 *   bits 5..9   = Y
	 *   bits 10..14 = Z
	 */
	private readonly pendingBlocksByChunk = new Map<
		number,
		Map<number, number>
	>();

	private pendingBlockCount = 0;

	/*
	 * Sampling is commonly spatially coherent. These fields avoid a Map
	 * lookup when consecutive samples access the same chunk.
	 */
	private lastChunkKey: number | undefined;
	private lastChunkBlocks: Uint8Array | Uint16Array | null = null;
	private lastPendingEdits: Map<number, number> | undefined;

	constructor(private readonly storage: ServerWorldStorage) {}

	begin(): void {
		this.chunkCache.clear();

		this.lastChunkKey = undefined;
		this.lastChunkBlocks = null;
		this.lastPendingEdits = undefined;
	}

	setPendingBlock(
		worldX: number,
		worldY: number,
		worldZ: number,
		blockId: number,
	): void {
		const x = Math.floor(worldX);
		const y = Math.floor(worldY);
		const z = Math.floor(worldZ);

		const chunkX = Math.floor(x * INV_CHUNK_SIZE);
		const chunkY = Math.floor(y * INV_CHUNK_SIZE);
		const chunkZ = Math.floor(z * INV_CHUNK_SIZE);

		const chunkKey = packChunkKeyFast(chunkX, chunkY, chunkZ);

		let edits = this.pendingBlocksByChunk.get(chunkKey);

		if (edits === undefined) {
			edits = new Map<number, number>();
			this.pendingBlocksByChunk.set(chunkKey, edits);
		}

		const localX = x - chunkX * CHUNK_SIZE;
		const localY = y - chunkY * CHUNK_SIZE;
		const localZ = z - chunkZ * CHUNK_SIZE;

		const localIndex =
			localX | (localY << CHUNK_SHIFT) | (localZ << (CHUNK_SHIFT * 2));

		/*
		 * Block IDs are numbers, so undefined unambiguously means that the
		 * local index has not been edited yet. This avoids has() followed by
		 * set(), which would perform two Map searches.
		 */
		if (edits.get(localIndex) === undefined) {
			this.pendingBlockCount++;
		}

		edits.set(localIndex, blockId);

		/*
		 * Keep the one-entry pending-edit cache coherent if this is currently
		 * the hot chunk.
		 */
		if (this.lastChunkKey === chunkKey) {
			this.lastPendingEdits = edits;
		}
	}

	clearPending(): void {
		this.pendingBlocksByChunk.clear();
		this.pendingBlockCount = 0;
		this.lastPendingEdits = undefined;
	}

	sample(worldX: number, worldY: number, worldZ: number): number | null {
		const x = Math.floor(worldX);
		const y = Math.floor(worldY);
		const z = Math.floor(worldZ);

		const chunkX = Math.floor(x * INV_CHUNK_SIZE);
		const chunkY = Math.floor(y * INV_CHUNK_SIZE);
		const chunkZ = Math.floor(z * INV_CHUNK_SIZE);

		const localX = x - chunkX * CHUNK_SIZE;
		const localY = y - chunkY * CHUNK_SIZE;
		const localZ = z - chunkZ * CHUNK_SIZE;

		const localIndex =
			localX | (localY << CHUNK_SHIFT) | (localZ << (CHUNK_SHIFT * 2));

		const chunkKey = packChunkKeyFast(chunkX, chunkY, chunkZ);

		let blocks: Uint8Array | Uint16Array | null;
		let edits: Map<number, number> | undefined;

		if (chunkKey === this.lastChunkKey) {
			blocks = this.lastChunkBlocks;
			edits = this.lastPendingEdits;
		} else {
			edits =
				this.pendingBlockCount === 0
					? undefined
					: this.pendingBlocksByChunk.get(chunkKey);

			const cached = this.chunkCache.get(chunkKey);

			if (cached !== undefined) {
				blocks = cached;
			} else {
				blocks = this.storage.getCachedChunkBlocks(chunkX, chunkY, chunkZ);

				this.chunkCache.set(chunkKey, blocks);
			}

			this.lastChunkKey = chunkKey;
			this.lastChunkBlocks = blocks;
			this.lastPendingEdits = edits;
		}

		if (edits !== undefined) {
			const pendingBlockId = edits.get(localIndex);

			if (pendingBlockId !== undefined) {
				return pendingBlockId;
			}
		}

		if (blocks === null) {
			return null;
		}

		return unpackBlockId(blocks[localIndex]);
	}
}

export class ServerMobSimulation {
	private readonly mobs = new Map<number, ServerMob>();
	private nextId = 1;
	private spawnAccum = 0;
	private readonly sampler: TickBlockSampler;
	// Reused across ticks — the room broadcasts from it synchronously.
	private readonly eventScratch: ServerMobEvent[] = [];
	// Spawn events completed by async chunk-mob loads since the last tick.
	private readonly asyncEvents: ServerMobEvent[] = [];
	// Chunk columns (cx,cz) considered loaded on the last lifecycle pass.
	// Double-buffered so updateChunkMobLifecycle does not allocate a new Set every tick.
	private loadedColumnsA = new Set<number>();
	private loadedColumnsB = new Set<number>();
	private lastLoadedColumns = this.loadedColumnsA;

	// Columns whose persisted mobs are currently being read back.
	private readonly pendingColumnLoads = new Set<number>();

	private readonly typeCounts = new Map<number, number>();
	// Cap accounting tracks only naturally spawned mobs; spawn-egg mobs
	// (egg === true) never occupy cap slots.
	private readonly naturalTypeCounts = new Map<number, number>();
	private naturalTotal = 0;
	// Per-mob depth targets for aquatic mobs (mobId -> target depth in blocks)
	// Deprecated: replaced by random water-block wander targets (5×3×4 box).
	private readonly depthTargets = new Map<number, number>();
	// Random water-block wander targets for aquatic mobs (straight-path swimming)
	private readonly aquaticTargets = new Map<
		number,
		{ x: number; y: number; z: number }
	>();
	private readonly aquaticIdleTime = new Map<number, number>();

	// Crash resilience: a single bad mob must not abort the whole tick (which
	// would silently stop ALL mob spawning in multiplayer — the only place this
	// server sim runs). Errors are surfaced once per 5s for diagnosis.
	private lastTickErrorLog = 0;
	private lastSpawnCount = 0;

	/**
	 * Deaths since the last drain (every damageMob kill: player damage and
	 * server-side fall damage alike). The room drains these each tick to
	 * spawn food drops. Chunk-lifecycle evictions bypass damageMob, so
	 * persisted-away mobs correctly drop nothing.
	 */
	private readonly recentDeaths: ServerMobDeath[] = [];

	constructor(private readonly storage: ServerWorldStorage) {
		this.sampler = new TickBlockSampler(storage);
		// Populate on the first tick that has players instead of waiting out
		// a full spawn interval.
		this.spawnAccum = SPAWN_INTERVAL_MS;
	}

	/** Called by VoxelRoom when a player edits a block so the next tick sees it instantly. */
	notifyBlockEdit(x: number, y: number, z: number, blockId: number): void {
		this.sampler.setPendingBlock(x, y, z, blockId);
	}

	/** Clear the pending edit overlay after the edits have been flushed to storage. */
	clearPendingEdits(): void {
		this.sampler.clearPending();
	}

	get size(): number {
		return this.mobs.size;
	}

	/** Fill a reusable array with the current mobs (join snapshot). */
	snapshotInto(target: ServerMob[]): ServerMob[] {
		target.length = 0;
		for (const mob of this.mobs.values()) target.push(mob);
		return target;
	}

	/** Look up an active mob by id (hit validation for MobDamage). */
	findMob(mobId: number): ServerMob | undefined {
		return this.mobs.get(mobId);
	}

	clear(): void {
		this.mobs.clear();
		this.typeCounts.clear();
		this.naturalTypeCounts.clear();
		this.naturalTotal = 0;
		this.recentDeaths.length = 0;
	}
	private addActiveMob(mob: ServerMob): void {
		this.mobs.set(mob.id, mob);
		this.typeCounts.set(mob.typeId, (this.typeCounts.get(mob.typeId) ?? 0) + 1);

		if (!mob.egg) {
			this.naturalTotal++;
			this.naturalTypeCounts.set(
				mob.typeId,
				(this.naturalTypeCounts.get(mob.typeId) ?? 0) + 1,
			);
		}
	}
	private removeActiveMob(mob: ServerMob): boolean {
		this.aquaticTargets.delete(mob.id);
		this.aquaticIdleTime.delete(mob.id);
		this.depthTargets.delete(mob.id);
		if (!this.mobs.delete(mob.id)) return false;

		const next = (this.typeCounts.get(mob.typeId) ?? 1) - 1;
		if (next > 0) {
			this.typeCounts.set(mob.typeId, next);
		} else {
			this.typeCounts.delete(mob.typeId);
		}

		if (!mob.egg) {
			this.naturalTotal = Math.max(0, this.naturalTotal - 1);

			const naturalNext = (this.naturalTypeCounts.get(mob.typeId) ?? 1) - 1;
			if (naturalNext > 0) {
				this.naturalTypeCounts.set(mob.typeId, naturalNext);
			} else {
				this.naturalTypeCounts.delete(mob.typeId);
			}
		}

		return true;
	}
	/**
	 * Advance the simulation by deltaMs and return the spawn/despawn events
	 * that must be broadcast (positions are broadcast separately via
	 * snapshotInto at the room's update cadence).
	 */
	tick(
		deltaMs: number,
		players: ReadonlyArray<{ x: number; y: number; z: number }>,
	): ServerMobEvent[] {
		const events = this.eventScratch;
		events.length = 0;

		// Drain events completed by async chunk-mob loads since the last tick.
		// A load can only resolve between ticks (JS is single-threaded), so
		// the room always broadcasts them on the following tick.
		if (this.asyncEvents.length > 0) {
			for (const event of this.asyncEvents) events.push(event);
			this.asyncEvents.length = 0;
		}

		this.sampler.begin();

		for (const mob of this.mobs.values()) {
			try {
				const died = this.updateMob(mob, deltaMs, players, events);
				if (died) {
					events.push({ kind: "despawn", mob });
				}
			} catch (err) {
				this.logTickError("updateMob", mob, err);
			}
		}

		if (players.length > 0) {
			// Persist mobs whose column left the loaded radius and load back
			// the mobs of columns that entered it, so far mobs free their cap
			// slots but are never lost.
			try {
				this.updateChunkMobLifecycle(players, events);
			} catch (err) {
				this.logTickError("updateChunkMobLifecycle", null, err);
			}

			this.spawnAccum += deltaMs;
			if (this.spawnAccum >= SPAWN_INTERVAL_MS) {
				this.spawnAccum = 0;
				const before = events.length;
				try {
					this.trySpawn(players, events);
				} catch (err) {
					this.logTickError("trySpawn", null, err);
				}
				this.lastSpawnCount = events.length - before;
			}
		}

		return events;
	}

	/** Diagnostics: counts of live mobs per type plus the last tick's spawn count. */
	getDebugStats(): {
		total: number;
		byType: Record<number, number>;
		lastSpawnCount: number;
	} {
		const byType: Record<number, number> = Object.create(null) as Record<
			number,
			number
		>;

		for (const [typeId, count] of this.typeCounts) {
			byType[typeId] = count;
		}

		return {
			total: this.mobs.size,
			byType,
			lastSpawnCount: this.lastSpawnCount,
		};
	}

	/**
	 * Snapshot of every active server mob. Used to bring a newly-joined client
	 * up to date — mob spawn/despawn events are only broadcast for changes that
	 * happen after a client connects, so without this a late joiner sees none
	 * of the mobs that already exist in the world.
	 */
	getActiveMobs(): ReadonlyArray<ServerMob> {
		return Array.from(this.mobs.values());
	}

	private logTickError(
		phase: string,
		mob: ServerMob | null,
		err: unknown,
	): void {
		const now = Date.now();
		if (now - this.lastTickErrorLog < 5000) return;
		this.lastTickErrorLog = now;
		const tag = mob ? ` (id=${mob.id}, type=${mob.typeId})` : "";
		console.error(`[MobSim] ${phase} failed${tag}:`, err);
	}

	private updateMob(
		mob: ServerMob,
		deltaMs: number,
		players: ReadonlyArray<{ x: number; y: number; z: number }>,
		events: ServerMobEvent[],
	): boolean {
		const stats = MOB_STATS[mob.typeId];

		// Aquatic mobs use water swimming AI instead of land pathfinding.
		if (stats.aquatic) {
			return this.updateAquaticMob(mob, deltaMs, players, events);
		}

		// Damage-triggered panic: flee from the nearest player for fleeTimer ms,
		// regardless of distance. This lets sheep (which have fleeRadiusSq = 0)
		// still run away when hit.
		if (mob.fleeTimer > 0) {
			mob.fleeTimer = Math.max(0, mob.fleeTimer - deltaMs);
		}

		const threat = this.findNearestThreat(mob, players);
		// Also flee if damage-panicking — target the nearest player even if
		// they're outside the normal proximity radius.
		const damageFleeing = mob.fleeTimer > 0 && players.length > 0;
		const fleeing = threat !== null || damageFleeing;
		if (fleeing) {
			mob.path.length = 0;
			mob.pathIndex = 0;
		}

		mob.headingTimer -= deltaMs;
		if (fleeing) {
			// Refresh the escape vector periodically. When blocked, the heading
			// is kept long enough to route around the obstacle.
			if (!mob.fleeing || mob.headingTimer <= 0) {
				const target = threat ?? this.findNearestPlayer(mob, players);
				if (target) {
					const awayX = mob.x - target.x;
					const awayZ = mob.z - target.z;
					if (awayX * awayX + awayZ * awayZ > 0.0001) {
						mob.yaw = this.vectorToYaw(awayX, awayZ);
					} else {
						mob.yaw = (mob.yaw + 64) & 255;
					}
				}
				mob.headingTimer = 250;
			}
			mob.fleeing = true;
		} else if (mob.headingTimer <= 0) {
			mob.fleeing = false;
			mob.headingTimer =
				WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS);
			mob.yaw = Math.floor(Math.random() * 256);
			mob.stuckTimer = 0;
		}
		if (!fleeing) {
			this.followWanderPath(mob, stats.feetHeight, deltaMs);
		}

		const step = (fleeing ? FLEE_SPEED : stats.speed) * (deltaMs / 1000);
		if (step > 0) {
			const radians = (mob.yaw / 255) * Math.PI * 2;
			const nx = mob.x + Math.sin(radians) * step;
			const nz = mob.z + Math.cos(radians) * step;

			if (!this.canMoveTo(mob, nx, nz, stats.halfHeight, stats.feetHeight)) {
				// Turn around, or sidestep while fleeing so a wall does not
				// pin the mob while the player remains on the other side.
				// Horizontal refusal never skips the vertical settle below:
				// an airborne mob must keep falling even when its drift is
				// blocked, otherwise it would freeze in mid-air.
				mob.yaw = (mob.yaw + (fleeing ? 64 : 128)) & 255;
				mob.headingTimer = fleeing ? 800 : Math.min(mob.headingTimer, 800);
				mob.stuckTimer += deltaMs;
				if (mob.stuckTimer > STUCK_MS) {
					mob.stuckTimer = 0;
					mob.headingTimer = 0;
				}
			} else {
				mob.x = nx;
				mob.z = nz;
				mob.stuckTimer = 0;

				// Mobs don't swim — turn back before wading in.
				if (
					this.sampler.sample(nx, Math.floor(mob.y - stats.feetHeight), nz) ===
					BlockType.Water
				) {
					mob.yaw = (mob.yaw + 128) & 255;
					mob.headingTimer = Math.min(mob.headingTimer, 800);
				}
			}
		}

		return this.settleHeight(mob, stats.feetHeight, deltaMs, events);
	}

	/**
	 * Aquatic mob AI — swims in water with buoyancy and damping, wanders
	 * randomly, and avoids beaching on land.
	 */
	private updateAquaticMob(
		mob: ServerMob,
		deltaMs: number,
		players: ReadonlyArray<{ x: number; y: number; z: number }>,
		events: ServerMobEvent[],
	): boolean {
		const stats = MOB_STATS[mob.typeId];
		const dt = deltaMs / 1000;

		// Check if currently in water
		const feetY = Math.floor(mob.y - stats.halfHeight);
		const centerY = Math.floor(mob.y);
		const headY = Math.floor(mob.y + stats.halfHeight - 0.01);
		const feetBlock = this.sampler.sample(mob.x, feetY, mob.z);
		const centerBlock = this.sampler.sample(mob.x, centerY, mob.z);
		const headBlock = this.sampler.sample(mob.x, headY, mob.z);
		// If any water-check chunk is not yet cached (null), the column is
		// still streaming in — hold position. Land mobs do this via
		// scanDown→unknown→hold height; aquatics must do the same or a
		// false `inWater=false` drops them with `mob.y -= 2*dt` into terrain.
		// This mirrors the client AquaticMob freeze for chunk-loading.
		if (feetBlock === null || centerBlock === null || headBlock === null) {
			return false;
		}
		const inWater =
			feetBlock === BlockType.Water ||
			centerBlock === BlockType.Water ||
			headBlock === BlockType.Water;

		// Find water surface Y and floor Y (bottom of water column)
		let waterSurfaceY = centerY;
		let waterFloorY = centerY;
		if (inWater) {
			// Scan up to find water surface — unknown chunks (null) are
			// treated as water so a partially-streamed column doesn't
			// prematurely cap the surface at the chunk boundary.
			let surfaceFound = false;
			for (let y = centerY; y < centerY + 16; y++) {
				const b = this.sampler.sample(mob.x, y, mob.z);
				if (b === null) continue;
				if (b !== BlockType.Water) {
					waterSurfaceY = y;
					surfaceFound = true;
					break;
				}
			}
			if (!surfaceFound && waterSurfaceY === centerY) {
				// Column top not yet cached — hold vertical drift this tick
				// instead of clamping to a truncated column.
				return false;
			}
			// Scan down to find water floor — null is skipped (unknown).
			let floorFound = false;
			for (let y = centerY; y > centerY - 32; y--) {
				const block = this.sampler.sample(mob.x, y, mob.z);
				if (block === null) continue;
				if (block !== BlockType.Water) {
					waterFloorY = y + 1; // First water block above floor
					floorFound = true;
					break;
				}
			}
			if (!floorFound) {
				// Floor column not cached yet — hold.
				return false;
			}
		}

		// Damage-triggered panic
		if (mob.fleeTimer > 0) {
			mob.fleeTimer = Math.max(0, mob.fleeTimer - deltaMs);
		}

		// Evaluate threat BEFORE idling so a nearby player always triggers a
		// flee, even while the mob is in its idle hover window (previously the
		// idle early-return meant aquatics ignored players ~20-30% of the time
		// and appeared "stuck / not fleeing").
		const threat = this.findNearestThreat(mob, players);
		const damageFleeing = mob.fleeTimer > 0 && players.length > 0;
		const fleeing = threat !== null || damageFleeing;

		// Idle hover: aquatics don't wander constantly — can just drift
		const idleRemain = this.aquaticIdleTime.get(mob.id) ?? 0;
		if (idleRemain > 0) {
			this.aquaticIdleTime.set(mob.id, Math.max(0, idleRemain - dt));
			if ((this.aquaticIdleTime.get(mob.id) ?? 0) <= 0) {
				mob.headingTimer = 0;
			}
			if (!fleeing) return false;
		}

		mob.headingTimer -= deltaMs;
		// If we have a wander target and we're close, force a new pick
		const existingTarget = this.aquaticTargets.get(mob.id);
		if (
			existingTarget &&
			(existingTarget.x - mob.x) * (existingTarget.x - mob.x) +
				(existingTarget.z - mob.z) * (existingTarget.z - mob.z) <
				0.25 &&
			Math.abs(existingTarget.y - mob.y) < 0.5
		) {
			mob.headingTimer = 0;
		}
		if (fleeing) {
			if (!mob.fleeing || mob.headingTimer <= 0) {
				const target = threat ?? this.findNearestPlayer(mob, players);
				if (target) {
					const awayX = mob.x - target.x;
					const awayZ = mob.z - target.z;
					if (awayX * awayX + awayZ * awayZ > 0.0001) {
						mob.yaw = this.vectorToYaw(awayX, awayZ);
					} else {
						mob.yaw = (mob.yaw + 64) & 255;
					}
				}
				mob.headingTimer = 250;
			}
			mob.fleeing = true;
		} else if (mob.headingTimer <= 0) {
			mob.fleeing = false;
			// Chance to just idle/drift in place instead of wandering
			if (Math.random() < this.getAquaticIdleChance(mob.typeId)) {
				const dur = 1.2 + Math.random() * 1.8;
				this.aquaticIdleTime.set(mob.id, dur);
				this.aquaticTargets.delete(mob.id);
				mob.headingTimer = dur * 1000 + Math.random() * 500;
				return false;
			}
			mob.headingTimer =
				WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS);
			// Random water-block wander: 5 wide, 3 up, 4 down, biased down per type
			const waterTarget = this.findRandomAquaticTarget(mob);
			if (waterTarget) {
				this.aquaticTargets.set(mob.id, waterTarget);
				const dx = waterTarget.x - mob.x;
				const dz = waterTarget.z - mob.z;
				if (dx * dx + dz * dz > 0.0001) {
					mob.yaw = this.vectorToYaw(dx, dz);
				}
			} else {
				// Fallback: small random turn if no water found
				mob.yaw = (mob.yaw + Math.floor((Math.random() - 0.5) * 128)) & 255;
				this.aquaticTargets.delete(mob.id);
			}
		}

		// Calculate movement
		const speed = fleeing ? FLEE_SPEED : stats.speed;
		const step = speed * dt;

		if (step > 0) {
			const radians = (mob.yaw / 255) * Math.PI * 2;
			const nx = mob.x + Math.sin(radians) * step;
			const nz = mob.z + Math.cos(radians) * step;

			// Check if next position has water — unknown (null) holds.
			const nextCenterBlock = this.sampler.sample(nx, centerY, nz);
			const nextFeetBlock = this.sampler.sample(nx, feetY, nz);
			if (nextCenterBlock === null || nextFeetBlock === null) {
				// Column not cached — hold position this tick.
			} else if (
				nextCenterBlock === BlockType.Water ||
				nextFeetBlock === BlockType.Water
			) {
				// Can move into water
				mob.x = nx;
				mob.z = nz;
			} else {
				// Blocked by land — turn around
				mob.yaw = (mob.yaw + 128) & 255;
				mob.headingTimer = Math.min(mob.headingTimer, 800);
			}
		}

		// Vertical movement: follow the selected water target.
		if (inWater) {
			const wanderTarget = this.aquaticTargets.get(mob.id);
			let targetY: number;

			if (wanderTarget) {
				targetY = wanderTarget.y;
			} else {
				/*
				 * Do not use `?? { min: 1, max: 4 }` here because that allocates a new
				 * fallback object every time an aquatic mob lacks depthRange.
				 */
				const depthRange = stats.depthRange;
				const minimumDepth = depthRange?.min ?? 1;
				const maximumDepth = depthRange?.max ?? 4;

				const maxAvailableDepth = waterSurfaceY - waterFloorY;

				const depthLimit = Math.max(0, maxAvailableDepth - 1);

				const clampedMin = Math.min(minimumDepth, depthLimit);

				const clampedMax = Math.min(maximumDepth, depthLimit);

				let targetDepth = this.depthTargets.get(mob.id);

				if (targetDepth === undefined || mob.headingTimer <= 0) {
					targetDepth =
						clampedMin + Math.random() * Math.max(0, clampedMax - clampedMin);

					this.depthTargets.set(mob.id, targetDepth);
				}

				targetY = waterSurfaceY - targetDepth - stats.halfHeight;
			}

			const depthError = targetY - mob.y;
			const depthSpeed = fleeing ? 0.075 : 0.0375;

			mob.y += depthError * Math.min(1, dt * depthSpeed);

			const minY = waterFloorY + stats.halfHeight;

			const maxY = waterSurfaceY - stats.halfHeight - 0.1;

			if (waterFloorY !== centerY || waterSurfaceY !== centerY) {
				mob.y = Math.max(minY, Math.min(maxY, mob.y));
			}
		} else {
			// Beached: descend slowly and track the fall.
			if (Number.isNaN(mob.fallStartY)) {
				mob.fallStartY = mob.y;
			}

			mob.y = Math.max(mob.y - 2 * dt, 0);

			if (this.settleBeachedAquatic(mob, stats.feetHeight, events)) {
				return true;
			}

			this.aquaticTargets.delete(mob.id);
		}

		return false;
	}
	private settleBeachedAquatic(
		mob: ServerMob,
		feetHeight: number,
		events: ServerMobEvent[],
	): boolean {
		const groundY = this.scanDown(mob.x, mob.z, Math.floor(mob.y - feetHeight));

		if (
			groundY === COLUMN_SCAN_UNKNOWN ||
			groundY === COLUMN_SCAN_WATER ||
			groundY === COLUMN_SCAN_AIR
		) {
			return false;
		}

		const fallDistance = mob.fallStartY - mob.y;

		const damage =
			fallDistance > FALL_DAMAGE_THRESHOLD
				? (fallDistance - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_PER_BLOCK
				: 0;

		if (fallDistance > 0.5) {
			events.push({
				kind: "impact",
				mob,
				fallDistance,
				damage,
			});
		}

		mob.fallStartY = Number.NaN;

		return damage > 0 && this.damageMob(mob.id, damage);
	}
	/** Follow a short land route using the same surface/headroom rules as NeutralMob. */
	private followWanderPath(
		mob: ServerMob,
		feetHeight: number,
		deltaMs: number,
	): void {
		mob.pathTimer -= deltaMs / 1000;
		if (mob.pathIndex >= mob.path.length) {
			mob.path.length = 0;
			mob.pathIndex = 0;
		}

		if (mob.path.length === 0 && mob.pathTimer <= 0) {
			this.buildWanderPath(mob, feetHeight);
		}

		const waypoint = mob.path[mob.pathIndex];
		if (!waypoint) return;

		const dx = waypoint.x + 0.5 - mob.x;
		const dz = waypoint.z + 0.5 - mob.z;
		if (dx * dx + dz * dz < 0.16) {
			mob.pathIndex++;
			return;
		}

		mob.yaw = this.vectorToYaw(dx, dz);
		mob.headingTimer = Math.max(mob.headingTimer, 250);
	}

	private buildWanderPath(mob: ServerMob, feetHeight: number): void {
		mob.path.length = 0;
		mob.pathIndex = 0;
		mob.pathTimer = 1.0;

		const halfHeight = MOB_STATS[mob.typeId].halfHeight;
		const sx = Math.floor(mob.x);
		const sz = Math.floor(mob.z);
		const startGround = Math.floor(mob.y - feetHeight - 0.01);
		const start = this.findLandSurface(sx, sz, startGround, halfHeight);
		if (!start) return;

		for (let attempt = 0; attempt < 3; attempt++) {
			const angle = Math.random() * Math.PI * 2;
			const distance = 6 + Math.random() * 14;
			const tx = Math.floor(mob.x + Math.sin(angle) * distance);
			const tz = Math.floor(mob.z + Math.cos(angle) * distance);
			const target = this.findLandSurface(tx, tz, start.groundY, halfHeight);
			if (!target) continue;

			const path = this.findLandPath(
				sx,
				sz,
				start.groundY,
				tx,
				tz,
				target.groundY,
				halfHeight,
			);
			if (path.length > 0) {
				mob.path = path;
				mob.pathTimer = path.length * 0.7 + 1;
				return;
			}
		}
	}

	private findLandSurface(
		x: number,
		z: number,
		startY: number,
		halfHeight: number,
	): { groundY: number } | null {
		const headroom = Math.max(1, Math.ceil(halfHeight * 2));
		for (let dy = 1; dy >= -2; dy--) {
			const groundY = startY + dy;
			if (!this.isSolid(x, groundY, z)) continue;
			let clear = true;
			for (let y = 1; y <= headroom; y++) {
				if (this.isSolid(x, groundY + y, z)) {
					clear = false;
					break;
				}
			}
			if (clear) return { groundY };
		}
		return null;
	}

	private findLandPath(
		startX: number,
		startZ: number,
		startY: number,
		targetX: number,
		targetZ: number,
		targetY: number,
		halfHeight: number,
	): ServerWaypoint[] {
		interface PathNode {
			x: number;
			z: number;
			groundY: number;
			g: number;
			f: number;
			parent: PathNode | null;
		}

		/*
		 * The search is capped at 300 expansions and wander destinations are near
		 * the mob. Nested numeric maps avoid collision-prone coordinate packing.
		 */
		const bestByX = new Map<number, Map<number, Map<number, number>>>();

		const getBest = (x: number, z: number, y: number): number | undefined => {
			return bestByX.get(x)?.get(z)?.get(y);
		};

		const setBest = (x: number, z: number, y: number, cost: number): void => {
			let byZ = bestByX.get(x);

			if (byZ === undefined) {
				byZ = new Map<number, Map<number, number>>();
				bestByX.set(x, byZ);
			}

			let byY = byZ.get(z);

			if (byY === undefined) {
				byY = new Map<number, number>();
				byZ.set(z, byY);
			}

			byY.set(y, cost);
		};

		const open = new MinHeap<PathNode>((left, right) => left.f < right.f);

		const startHeuristic =
			Math.abs(startX - targetX) + Math.abs(startZ - targetZ);

		open.push({
			x: startX,
			z: startZ,
			groundY: startY,
			g: 0,
			f: startHeuristic,
			parent: null,
		});

		setBest(startX, startZ, startY, 0);

		for (let expanded = 0; open.length > 0 && expanded < 300; expanded++) {
			const current = open.pop()!;

			const recordedCost = getBest(current.x, current.z, current.groundY);

			if (recordedCost !== undefined && recordedCost < current.g) {
				continue;
			}

			if (
				current.x === targetX &&
				current.z === targetZ &&
				current.groundY === targetY
			) {
				let routeLength = 0;
				let cursor: PathNode | null = current;

				while (cursor !== null && cursor.parent !== null) {
					routeLength++;
					cursor = cursor.parent;
				}

				/*
				 * Allocate the result at its exact final size and fill it backwards.
				 * This avoids repeated growth plus result.reverse().
				 */
				const result = new Array<ServerWaypoint>(routeLength);

				cursor = current;

				for (let index = routeLength - 1; index >= 0; index--) {
					result[index] = {
						x: cursor!.x,
						z: cursor!.z,
						groundY: cursor!.groundY,
					};

					cursor = cursor!.parent;
				}

				return result;
			}

			for (let direction = 0; direction < 4; direction++) {
				const x = current.x + PATH_DX[direction];
				const z = current.z + PATH_DZ[direction];

				const surfaceY = this.findLandSurfaceY(
					x,
					z,
					current.groundY,
					halfHeight,
				);

				if (surfaceY === null || Math.abs(surfaceY - current.groundY) > 1) {
					continue;
				}

				const heightDifference = Math.abs(surfaceY - current.groundY);

				const cost = current.g + 1 + heightDifference * 4;

				const previousBest = getBest(x, z, surfaceY);

				if (previousBest !== undefined && previousBest <= cost) {
					continue;
				}

				setBest(x, z, surfaceY, cost);

				open.push({
					x,
					z,
					groundY: surfaceY,
					g: cost,
					f: cost + Math.abs(x - targetX) + Math.abs(z - targetZ),
					parent: current,
				});
			}
		}

		return [];
	}
	private findLandSurfaceY(
		x: number,
		z: number,
		startY: number,
		halfHeight: number,
	): number | null {
		const headroom = Math.max(1, Math.ceil(halfHeight * 2));

		for (let offset = 1; offset >= -2; offset--) {
			const groundY = startY + offset;

			if (!this.isSolid(x, groundY, z)) {
				continue;
			}

			let clear = true;

			for (let height = 1; height <= headroom; height++) {
				if (this.isSolid(x, groundY + height, z)) {
					clear = false;
					break;
				}
			}

			if (clear) {
				return groundY;
			}
		}

		return null;
	}
	private findNearestThreat(
		mob: ServerMob,
		players: ReadonlyArray<PlayerPosition>,
	): PlayerPosition | null {
		const fleeRadiusSq = MOB_STATS[mob.typeId].fleeRadiusSq;

		if (fleeRadiusSq <= 0) {
			return null;
		}

		let nearest: PlayerPosition | null = null;
		let nearestDistanceSq = fleeRadiusSq;

		const mobX = mob.x;
		const mobY = mob.y;
		const mobZ = mob.z;

		for (let index = 0; index < players.length; index++) {
			const player = players[index];

			const dx = mobX - player.x;
			const dy = mobY - player.y;
			const dz = mobZ - player.z;

			const distanceSq = dx * dx + dy * dy + dz * dz;

			if (distanceSq < nearestDistanceSq) {
				nearestDistanceSq = distanceSq;
				nearest = player;
			}
		}

		return nearest;
	}

	/** Find the nearest player regardless of distance (for damage-triggered panic). */
	private findNearestPlayer(
		mob: ServerMob,
		players: ReadonlyArray<PlayerPosition>,
	): PlayerPosition | null {
		let nearest: PlayerPosition | null = null;
		let nearestDistanceSq = Number.POSITIVE_INFINITY;

		const mobX = mob.x;
		const mobY = mob.y;
		const mobZ = mob.z;

		for (let index = 0; index < players.length; index++) {
			const player = players[index];

			const dx = mobX - player.x;
			const dy = mobY - player.y;
			const dz = mobZ - player.z;

			const distanceSq = dx * dx + dy * dy + dz * dz;

			if (distanceSq < nearestDistanceSq) {
				nearestDistanceSq = distanceSq;
				nearest = player;
			}
		}

		return nearest;
	}
	private vectorToYaw(x: number, z: number): number {
		/*
		 * Bit masking is equivalent for the rounded integer here and avoids two
		 * modulo operations.
		 */
		return Math.round((Math.atan2(x, z) / TWO_PI) * YAW_MASK) & YAW_MASK;
	}

	private getAquaticBias(typeId: number): number {
		switch (typeId) {
			case 4: // Squid
				return 0.7;
			case 6: // Kraken
				return 0.8;
			case 5: // Fish
				return 0.3;
			default:
				return 0.5;
		}
	}

	private getAquaticIdleChance(typeId: number): number {
		switch (typeId) {
			case 5: // Fish — more active
				return 0.2;
			case 4: // Squid
				return 0.3;
			case 6: // Kraken — boss, drifts more
				return 0.25;
			default:
				return 0.3;
		}
	}

	private findRandomAquaticTarget(
		mob: ServerMob,
	): { x: number; y: number; z: number } | null {
		const bias = this.getAquaticBias(mob.typeId);
		const baseX = Math.floor(mob.x);
		const baseY = Math.floor(mob.y);
		const baseZ = Math.floor(mob.z);
		for (let i = 0; i < 8; i++) {
			const dx = (Math.random() * 5) | 0;
			const dz = (Math.random() * 5) | 0;
			const rx = baseX + dx - 2;
			const rz = baseZ + dz - 2;
			let dy: number;
			if (Math.random() < bias) {
				dy = -((Math.random() * 4) | 0) - 1; // -1 .. -4 biased down
			} else {
				dy = ((Math.random() * 8) | 0) - 4; // -4 .. 3
			}
			const ry = baseY + dy;
			const b = this.sampler.sample(rx, ry, rz);
			if (b === null) continue; // uncached
			if (b !== BlockType.Water) continue;
			// headroom: allow water or air above
			const above = this.sampler.sample(rx, ry + 1, rz);
			if (
				above !== null &&
				above !== BlockType.Water &&
				above !== BlockType.Air
			) {
				if (isCollidableBlock(above)) continue;
			}
			return { x: rx + 0.5, y: ry + 0.5, z: rz + 0.5 };
		}
		return null;
	}

	/**
	 * True when the mob's center voxel and head voxel are free at (nx, nz),
	 * allowing a one-block step-up onto low terrain.
	 */
	private canMoveTo(
		mob: ServerMob,
		nextX: number,
		nextZ: number,
		halfHeight: number,
		feetHeight: number,
	): boolean {
		const groundY = this.scanDown(nextX, nextZ, Math.floor(mob.y + 1));

		/*
		 * All sentinels are non-finite or extremely large. A normal ground result
		 * is always a finite practical world coordinate.
		 */
		if (
			groundY === COLUMN_SCAN_UNKNOWN ||
			groundY === COLUMN_SCAN_WATER ||
			groundY === COLUMN_SCAN_AIR
		) {
			return false;
		}

		const targetY = groundY + 1 + feetHeight;

		if (targetY > mob.y + 1.01) {
			return false;
		}

		// Cliff guard: refuse voluntary steps into drops deeper than
		// MAX_SAFE_LEDGE_DROP. Skipped while already airborne — a falling
		// mob keeps its drift so settleHeight can bring it down — and over
		// water, where any landing is a safe splash-down. The caller turns
		// the mob on false, so blocked mobs steer away instead of walking
		// off.
		const feetNow = Math.floor(mob.y - feetHeight);
		const supportNow = this.scanDown(mob.x, mob.z, feetNow);
		const airborne =
			supportNow === COLUMN_SCAN_AIR ||
			supportNow === COLUMN_SCAN_WATER ||
			(supportNow !== COLUMN_SCAN_UNKNOWN && feetNow - supportNow > 1);
		if (!airborne && groundY < feetNow - MAX_SAFE_LEDGE_DROP) {
			return false;
		}

		const feetY = Math.floor(mob.y - feetHeight);
		const bodyY = Math.floor(mob.y);
		const headY = Math.floor(mob.y + halfHeight - 0.01);

		const bodyBlock = this.sampler.sample(nextX, bodyY, nextZ);

		const headBlock =
			headY === bodyY ? bodyBlock : this.sampler.sample(nextX, headY, nextZ);

		if (this.isSolidId(bodyBlock) || this.isSolidId(headBlock)) {
			const feetBlock = this.sampler.sample(nextX, feetY, nextZ);

			const aboveFeet = this.sampler.sample(nextX, feetY + 1, nextZ);

			const twoAbove = this.sampler.sample(nextX, feetY + 2, nextZ);

			if (
				this.isSolidId(feetBlock) &&
				!this.isSolidId(aboveFeet) &&
				!this.isSolidId(twoAbove)
			) {
				mob.y = targetY;
				return true;
			}

			return false;
		}

		return true;
	}

	private settleHeight(
		mob: ServerMob,
		feetHeight: number,
		deltaMs: number,
		events: ServerMobEvent[],
	): boolean {
		const groundY = this.scanDown(mob.x, mob.z, Math.floor(mob.y - feetHeight));

		if (groundY === COLUMN_SCAN_UNKNOWN) {
			/*
			 * The chunk is not cached. Hold the current height rather than falling
			 * through terrain that may exist in storage.
			 */
			return false;
		}

		if (groundY === COLUMN_SCAN_WATER) {
			mob.yaw = (mob.yaw + HALF_YAW) & YAW_MASK;
			mob.headingTimer = Math.min(mob.headingTimer, 800);
			mob.fallStartY = Number.NaN;
			return false;
		}

		if (groundY === COLUMN_SCAN_AIR) {
			if (Number.isNaN(mob.fallStartY)) {
				mob.fallStartY = mob.y;
			}

			mob.y = Math.max(mob.y - 16 * deltaMs * MS_TO_SECONDS, 0);

			return false;
		}

		const targetY = groundY + 1 + feetHeight;

		if (targetY < mob.y - 1) {
			if (Number.isNaN(mob.fallStartY)) {
				mob.fallStartY = mob.y;
			}

			mob.y = Math.max(mob.y - 16 * deltaMs * MS_TO_SECONDS, 0);

			return false;
		}

		mob.y = targetY;

		if (Number.isNaN(mob.fallStartY)) {
			return false;
		}

		const fallDistance = mob.fallStartY - mob.y;

		const damage =
			fallDistance > FALL_DAMAGE_THRESHOLD
				? (fallDistance - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_PER_BLOCK
				: 0;

		if (fallDistance > 0.5) {
			events.push({
				kind: "impact",
				mob,
				fallDistance,
				damage,
			});
		}

		mob.fallStartY = Number.NaN;

		return damage > 0 && this.damageMob(mob.id, damage);
	}

	/**
	 * Scan a world column from `startY` downward to `startY - FALL_LIMIT`.
	 * Water short-circuits to "water"; an uncached chunk short-circuits to
	 * "unknown"; anything else falls through.
	 */
	private scanDown(worldX: number, worldZ: number, startY: number): number {
		const endY = startY - FALL_LIMIT;

		for (let y = startY; y > endY; y--) {
			const blockId = this.sampler.sample(worldX, y, worldZ);

			if (blockId === null) {
				return COLUMN_SCAN_UNKNOWN;
			}

			if (blockId === BlockType.Water) {
				return COLUMN_SCAN_WATER;
			}

			if (isCollidableBlock(blockId)) {
				return y;
			}
		}

		return COLUMN_SCAN_AIR;
	}
	private isSolid(worldX: number, worldY: number, worldZ: number): boolean {
		return this.isSolidId(this.sampler.sample(worldX, worldY, worldZ));
	}

	private isSolidId(id: number | null): boolean {
		return id !== null && isCollidableBlock(id);
	}

	private trySpawn(
		players: ReadonlyArray<{ x: number; y: number; z: number }>,
		events: ServerMobEvent[],
	): void {
		const player = players[Math.floor(Math.random() * players.length)];
		if (!player) return;

		// Cap is per player's spawn region, not global. A shared cap is
		// saturated by the combined active mobs of all players, which halted
		// all spawning once a second player joined.
		if (this.countMobsNear(player, SPAWN_RING_MAX) >= PER_PLAYER_MOB_CAP) {
			return;
		}

		for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
			if (this.naturalTotal >= HARD_MOB_CAP) return;

			const typeId = this.pickSpawnType();
			if (typeId === null) return;

			const stats = MOB_STATS[typeId];
			const pos = this.findSpawnPosition(player, typeId);
			if (!pos) continue;

			const mob: ServerMob = {
				id: this.nextId++,
				typeId,
				x: pos.x,
				y: pos.y,
				z: pos.z,
				yaw: Math.floor(Math.random() * 256),
				hp: stats.hp,
				fallStartY: Number.NaN,
				headingTimer:
					WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS),
				stuckTimer: 0,
				fleeing: false,
				fleeTimer: 0,
				path: [],
				pathIndex: 0,
				pathTimer: 0,
				egg: false,
			};

			this.addActiveMob(mob);
			events.push({ kind: "spawn", mob });
		}
	}

	/**
	 * Spawn a cap-exempt mob at an explicit position (spawn egg use). The
	 * position must be inside a loaded chunk with a free body + head cell;
	 * the simulation settles the mob onto the ground on subsequent ticks.
	 * Returns the spawned mob, or null when the request is invalid.
	 */
	spawnEggMob(
		typeId: number,
		x: number,
		y: number,
		z: number,
	): ServerMob | null {
		const stats = MOB_STATS[typeId];
		if (!stats) return null;
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
			return null;
		}

		// Unknown chunk (not cached) — reject.
		if (this.sampler.sample(x, y, z) === null) return null;

		if (stats.aquatic) {
			// Aquatic mobs spawn in water — require water at body and head.
			const bodyBlock = this.sampler.sample(x, y, z);
			const headBlock = this.sampler.sample(x, y + 1, z);
			if (bodyBlock !== BlockType.Water) return null;
			// Head can be water or air (surface)
			if (headBlock !== BlockType.Water && headBlock !== BlockType.Air)
				return null;
		} else {
			// Land mobs — reject solid body/head cell so the mob never spawns
			// stuck inside terrain.
			if (this.isSolid(x, y, z) || this.isSolid(x, y + 1, z)) return null;
		}

		const mob: ServerMob = {
			id: this.nextId++,
			typeId,
			x,
			y,
			z,
			yaw: Math.floor(Math.random() * 256),
			hp: stats.hp,
			fallStartY: Number.NaN,
			headingTimer:
				WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS),
			stuckTimer: 0,
			fleeing: false,
			fleeTimer: 0,
			path: [],
			pathIndex: 0,
			pathTimer: 0,
			egg: true,
		};

		this.addActiveMob(mob);
		return mob;
	}

	/**
	 * Apply damage to a mob (player projectile hit). Returns true when the
	 * hit killed the mob — the caller must broadcast the despawn; the mob is
	 * already removed from the active set (dead mobs are never persisted).
	 * Kills are recorded for drainDeaths() so the room can spawn food drops.
	 */
	damageMob(mobId: number, amount: number): boolean {
		const mob = this.mobs.get(mobId);
		if (!mob) return false;

		mob.hp -= amount;
		if (mob.hp > 0) {
			// Survived — trigger a panic response (e.g. sheep flee for a few seconds).
			mob.fleeTimer = Math.max(mob.fleeTimer, FLEE_DURATION_MS);
			return false;
		}

		this.removeActiveMob(mob);
		this.recentDeaths.push({
			typeId: mob.typeId,
			x: mob.x,
			y: mob.y,
			z: mob.z,
		});
		return true;
	}

	/**
	 * Drain deaths recorded since the last call (reused scratch — consume
	 * synchronously before the next tick, like tick()'s event array).
	 */
	drainDeaths(target: ServerMobDeath[]): ServerMobDeath[] {
		target.length = 0;
		for (const death of this.recentDeaths) target.push(death);
		this.recentDeaths.length = 0;
		return target;
	}

	/** Random species whose natural cap isn't reached yet (equal weights, like the client). */
	private pickSpawnType(): number | null {
		let selectedType: number | null = null;
		let availableCount = 0;

		for (let index = 0; index < MOB_TYPE_IDS.length; index++) {
			const typeId = MOB_TYPE_IDS[index];
			const spawnConfig = MOB_SPAWN_CONFIGS[typeId];

			if ((this.naturalTypeCounts.get(typeId) ?? 0) >= spawnConfig.maxCount) {
				continue;
			}

			availableCount++;

			if (Math.random() * availableCount < 1) {
				selectedType = typeId;
			}
		}

		return selectedType;
	}

	/**
	 * Chunk-column mob lifecycle. A column within MOB_ACTIVE_RADIUS_CHUNKS of
	 * any player is "loaded":
	 * - mobs in columns that left the loaded radius are persisted to storage
	 * and removed from the active set, broadcast as despawn, freeing their
	 * cap slots,
	 * - columns that entered the loaded radius read their persisted mobs back
	 * and are broadcast as spawn on the following tick.
	 */
	private updateChunkMobLifecycle(
		players: ReadonlyArray<{ x: number; z: number }>,
		events: ServerMobEvent[],
	): void {
		const radius = MOB_ACTIVE_RADIUS_CHUNKS;

		// Reuse the inactive buffer instead of allocating a new Set every tick.
		const loaded =
			this.lastLoadedColumns === this.loadedColumnsA
				? this.loadedColumnsB
				: this.loadedColumnsA;

		loaded.clear();

		for (let i = 0; i < players.length; i++) {
			const p = players[i];
			const pcx = Math.floor(p.x / CHUNK_SIZE);
			const pcz = Math.floor(p.z / CHUNK_SIZE);

			for (let dx = -radius; dx <= radius; dx++) {
				const cx = pcx + dx;

				for (let dz = -radius; dz <= radius; dz++) {
					loaded.add(packChunkKeyFast(cx, 0, pcz + dz));
				}
			}
		}

		// Persist and evict active mobs in columns that are no longer loaded.
		// Deleting the current item during Map iteration is safe in JS, and avoids
		// building a temporary toUnload array.
		if (this.mobs.size > 0) {
			const byColumn = new Map<number, PersistedMob[]>();

			for (const mob of this.mobs.values()) {
				const cx = Math.floor(mob.x / CHUNK_SIZE);
				const cz = Math.floor(mob.z / CHUNK_SIZE);
				const col = packChunkKeyFast(cx, 0, cz);

				if (loaded.has(col)) continue;

				this.removeActiveMob(mob);
				events.push({ kind: "despawn", mob });

				let list = byColumn.get(col);
				if (list === undefined) {
					list = [];
					byColumn.set(col, list);
				}

				list.push(this.persistMob(mob));
			}

			for (const [col, list] of byColumn) {
				const coords = unpackChunkKeyFast(col);
				void this.storage.saveChunkMobs(coords[0], coords[2], list);
			}
		}

		// Read back the persisted mobs of columns that just entered the loaded set.
		for (const col of loaded) {
			if (this.lastLoadedColumns.has(col)) continue;
			if (this.pendingColumnLoads.has(col)) continue;

			this.pendingColumnLoads.add(col);

			const coords = unpackChunkKeyFast(col);
			void this.loadColumnMobs(coords[0], coords[2], col);
		}

		this.lastLoadedColumns = loaded;
	}

	private async loadColumnMobs(
		cx: number,
		cz: number,
		col: number,
	): Promise<void> {
		try {
			const persisted = await this.storage.loadChunkMobs(cx, cz);
			if (persisted.length === 0) return;

			// The column may have left the loaded radius while the read was in
			// flight — leave its mobs persisted in that case.
			if (!this.lastLoadedColumns.has(col)) return;

			const kept: PersistedMob[] = [];
			for (const pm of persisted) {
				const stats = MOB_STATS[pm.typeId];
				if (!stats) continue; // Unknown type — drop.

				// Already active (id collision) — keep it persisted.
				if (this.mobs.has(pm.id)) {
					kept.push(pm);
					continue;
				}

				// Natural mobs count toward the per-type cap; if it's full,
				// leave this one persisted until a slot frees up. Spawn-egg
				// mobs are cap-exempt and always load back.
				const spawnConfig = MOB_SPAWN_CONFIGS[pm.typeId];
				const naturalCount = this.naturalTypeCounts.get(pm.typeId) ?? 0;
				if (!pm.egg && naturalCount >= spawnConfig.maxCount) {
					kept.push(pm);
					continue;
				}

				const mob = this.restoreMob(pm);
				this.addActiveMob(mob);
				this.asyncEvents.push({ kind: "spawn", mob });
			}

			if (kept.length !== persisted.length) {
				void this.storage.saveChunkMobs(cx, cz, kept);
			}
		} finally {
			this.pendingColumnLoads.delete(col);
		}
	}

	/** Snapshot a mob into its durable, column-scoped representation. */
	private persistMob(mob: ServerMob): PersistedMob {
		return {
			id: mob.id,
			typeId: mob.typeId,
			x: mob.x,
			y: mob.y,
			z: mob.z,
			yaw: mob.yaw,
			hp: mob.hp,
			headingTimer: mob.headingTimer,
			stuckTimer: mob.stuckTimer,
			fleeing: mob.fleeing,
			fleeTimer: mob.fleeTimer,
			path: mob.path.map((w) => ({ x: w.x, z: w.z, groundY: w.groundY })),
			pathIndex: mob.pathIndex,
			pathTimer: mob.pathTimer,
			egg: mob.egg,
		};
	}

	/** Reconstruct a live mob from its persisted snapshot. */
	private restoreMob(pm: PersistedMob): ServerMob {
		// Keep id allocation above every restored id so a fresh spawn can
		// never collide with a mob loaded back from storage.
		if (pm.id >= this.nextId) this.nextId = pm.id + 1;

		return {
			id: pm.id,
			typeId: pm.typeId,
			x: pm.x,
			y: pm.y,
			z: pm.z,
			yaw: pm.yaw,
			hp: pm.hp ?? MOB_STATS[pm.typeId].hp,
			fallStartY: Number.NaN,
			headingTimer: pm.headingTimer,
			stuckTimer: pm.stuckTimer,
			fleeing: pm.fleeing,
			fleeTimer: pm.fleeTimer ?? 0,
			path: pm.path.map((w) => ({ x: w.x, z: w.z, groundY: w.groundY })),
			pathIndex: pm.pathIndex,
			pathTimer: pm.pathTimer,
			egg: pm.egg ?? false,
		};
	}

	/** Persist every active mob to its column (room shutdown). */
	async persistAll(): Promise<void> {
		const byColumn = new Map<number, PersistedMob[]>();

		for (const mob of this.mobs.values()) {
			const cx = Math.floor(mob.x / CHUNK_SIZE);
			const cz = Math.floor(mob.z / CHUNK_SIZE);
			const col = packChunkKeyFast(cx, 0, cz);

			let list = byColumn.get(col);
			if (!list) {
				list = [];
				byColumn.set(col, list);
			}

			list.push(this.persistMob(mob));
		}

		const writes: Promise<void>[] = [];

		for (const [col, list] of byColumn) {
			const coords = unpackChunkKeyFast(col);
			writes.push(this.storage.saveChunkMobs(coords[0], coords[2], list));
		}

		await Promise.allSettled(writes);
	}

	private findSpawnPosition(
		player: { x: number; y: number; z: number },
		typeId: number,
	): { x: number; y: number; z: number } | null {
		const stats = MOB_STATS[typeId];
		const isAquatic = stats.aquatic;
		const angle = Math.random() * Math.PI * 2;
		const dist =
			SPAWN_RING_MIN + Math.random() * (SPAWN_RING_MAX - SPAWN_RING_MIN);

		const wx = Math.floor(player.x + Math.cos(angle) * dist);
		const wz = Math.floor(player.z + Math.sin(angle) * dist);

		const cx = Math.floor(wx / CHUNK_SIZE);
		const cz = Math.floor(wz / CHUNK_SIZE);
		const localX = wx - cx * CHUNK_SIZE;
		const localZ = wz - cz * CHUNK_SIZE;

		const maxCy = Math.floor(MAX_SPAWN_SCAN_Y / CHUNK_SIZE);
		const minCy = -4; // down to y=-128, covers deep trenches below y27 and y<0
		const aquaticCandidates: { x: number; y: number; z: number }[] = [];

		// Scan top-down, but fetch each cached chunk section only once instead of
		// routing every Y coordinate through TickBlockSampler.sample().
		for (let cy = maxCy; cy >= minCy; cy--) {
			const blocks = this.storage.getCachedChunkBlocks(cx, cy, cz);
			if (!blocks) continue;

			const chunkBaseY = cy * CHUNK_SIZE;
			const startLocalY =
				cy === maxCy
					? Math.min(CHUNK_SIZE - 1, MAX_SPAWN_SCAN_Y - chunkBaseY)
					: CHUNK_SIZE - 1;
			const endLocalY = cy === minCy ? 0 : 0;

			const columnBase = localX + (localZ << 10);

			for (let localY = startLocalY; localY >= endLocalY; localY--) {
				// Entries are packed values — match the set on the raw block id.
				const blockId = unpackBlockId(blocks[columnBase + (localY << 5)]);

				if (isAquatic) {
					// Aquatic mobs spawn in water — look for water blocks with
					// water or air above (so they're not buried). Use real water,
					// not SEA_LEVEL constant, and collect candidates for
					// random-depth pick (5×3×4 wander will then keep them deep).
					if (blockId !== BlockType.Water) continue;

					const wy = chunkBaseY + localY;
					const above = this.sampler.sample(wx, wy + 1, wz);
					// Headroom can be water or air
					if (above !== BlockType.Water && above !== BlockType.Air) continue;

					if (this.isSpawnTooClose(wx, wz)) continue;

					aquaticCandidates.push({
						x: wx + 0.5,
						y: wy + 0.5,
						z: wz + 0.5,
					});
				} else {
					// Land mobs — look for spawnable ground blocks.
					if (!SPAWNABLE_BLOCK_ID_SET.has(blockId)) continue;

					const wy = chunkBaseY + localY;

					// Preserve the original air-above rule. This intentionally uses
					// the sampler because wy + 1 may cross into the next chunk section.
					// Air is always packed 0, so the raw comparison stays valid.
					if (this.sampler.sample(wx, wy + 1, wz) !== 0) continue;

					if (this.isSpawnTooClose(wx, wz)) continue;

					return {
						x: wx + 0.5,
						y: wy + 1.02 + stats.feetHeight,
						z: wz + 0.5,
					};
				}
			}
		}

		if (isAquatic && aquaticCandidates.length > 0) {
			// Random water block, biased deeper for squid/kraken (real water, not SEA_LEVEL)
			const bias = typeId === 4 ? 0.7 : typeId === 6 ? 0.8 : 0.3;
			// Candidates collected top-down → shallow first, deep last.
			// Sort by y ascending to make deep bias deterministic
			aquaticCandidates.sort((a, b) => a.y - b.y);
			let idx: number;
			if (Math.random() < bias) {
				// Pick from deeper half
				const half = Math.floor(aquaticCandidates.length / 2);
				idx = half + ((Math.random() * (aquaticCandidates.length - half)) | 0);
			} else {
				idx = (Math.random() * aquaticCandidates.length) | 0;
			}
			return aquaticCandidates[idx]!;
		}

		return null;
	}
	private isSpawnTooClose(wx: number, wz: number): boolean {
		for (const mob of this.mobs.values()) {
			const dx = mob.x - wx;
			const dz = mob.z - wz;
			if (dx * dx + dz * dz < 4) return true;
		}
		return false;
	}

	/**
	 * Counts active mobs within `radius` of a player's x/z. Used to enforce the
	 * per-player spawn cap instead of a single shared global cap.
	 */
	private countMobsNear(player: PlayerColumnPosition, radius: number): number {
		const radiusSq = radius * radius;
		const playerX = player.x;
		const playerZ = player.z;

		let count = 0;

		for (const mob of this.mobs.values()) {
			const dx = mob.x - playerX;
			const dz = mob.z - playerZ;

			if (dx * dx + dz * dz <= radiusSq) {
				count++;
			}
		}

		return count;
	}
}
