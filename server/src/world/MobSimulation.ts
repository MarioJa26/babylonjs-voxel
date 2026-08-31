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
import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
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
const MAX_SPAWN_SCAN_Y = 1024;

/**
 * Block sampler for one simulation tick. Caches the decompressed chunk
 * arrays it touches so a mob scanning a column doesn't re-fetch the same
 * chunk for every voxel, and so the storage decompress pool isn't thrashed.
 */
class TickBlockSampler {
	private readonly chunkCache = new Map<
		number,
		Uint8Array | Uint16Array | null
	>();
	private readonly pendingBlocks = new Map<string, number>();

	constructor(private readonly storage: ServerWorldStorage) {}

	begin(): void {
		this.chunkCache.clear();
	}

	setPendingBlock(x: number, y: number, z: number, blockId: number): void {
		this.pendingBlocks.set(`${x},${y},${z}`, blockId);
	}

	clearPending(): void {
		this.pendingBlocks.clear();
	}

	sample(worldX: number, worldY: number, worldZ: number): number | null {
		// Mob positions are sub-block floats; voxel lookups must use the
		// containing integer coordinate or every array index becomes invalid.
		const x = Math.floor(worldX);
		const y = Math.floor(worldY);
		const z = Math.floor(worldZ);
		const pending = this.pendingBlocks.get(`${x},${y},${z}`);
		if (pending !== undefined) return pending;
		const cx = Math.floor(x / CHUNK_SIZE);
		const cy = Math.floor(y / CHUNK_SIZE);
		const cz = Math.floor(z / CHUNK_SIZE);
		const key = packChunkKeyFast(cx, cy, cz);

		let blocks = this.chunkCache.get(key);
		if (blocks === undefined) {
			blocks = this.storage.getCachedChunkBlocks(cx, cy, cz);
			this.chunkCache.set(key, blocks);
		}
		if (!blocks) return null;

		const localX = x - cx * CHUNK_SIZE;
		const localY = y - cy * CHUNK_SIZE;
		const localZ = z - cz * CHUNK_SIZE;
		// Block layout matches generation: index = x + (y << 5) + (z << 10).
		// Entries are packed id|state values — return the raw block id so
		// every BlockType/isCollidableBlock comparison keeps working.
		return unpackBlockId(blocks[localX + (localY << 5) + (localZ << 10)]);
	}
}

/**
 * Result of scanning one world column from the sky down.
 * - ground: found a solid voxel (non-air, non-water) at `y`
 * - water:  hit water before any solid voxel (mob must turn around)
 * - unknown: a chunk wasn't cached — caller keeps the current height
 * - air:    nothing solid found within the scan limit
 */
type ColumnScan =
	| { kind: "ground"; y: number }
	| { kind: "water" }
	| { kind: "unknown" }
	| { kind: "air" };

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
		const byType: Record<number, number> = {};
		for (const m of this.mobs.values()) {
			byType[m.typeId] = (byType[m.typeId] ?? 0) + 1;
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
				mob.yaw = (mob.yaw + (fleeing ? 64 : 128)) & 255;
				mob.headingTimer = fleeing ? 800 : Math.min(mob.headingTimer, 800);
				mob.stuckTimer += deltaMs;
				if (mob.stuckTimer > STUCK_MS) {
					mob.stuckTimer = 0;
					mob.headingTimer = 0;
				}
				return false;
			}

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

		// Vertical movement — straight path to random water block (5×3×4 box)
		if (inWater) {
			const wanderTarget = this.aquaticTargets.get(mob.id);
			let targetY: number;
			if (wanderTarget) {
				targetY = wanderTarget.y;
			} else {
				// Fallback: legacy depth range if no water target yet
				const depthRange = stats.depthRange ?? { min: 1, max: 4 };
				const maxDepth = waterSurfaceY - waterFloorY;
				const clampedMin = Math.min(depthRange.min, Math.max(0, maxDepth - 1));
				const clampedMax = Math.min(depthRange.max, Math.max(0, maxDepth - 1));
				if (!this.depthTargets.has(mob.id) || mob.headingTimer <= 0) {
					const targetDepth =
						clampedMin + Math.random() * Math.max(0, clampedMax - clampedMin);
					this.depthTargets.set(mob.id, targetDepth);
				}
				const targetDepth = this.depthTargets.get(mob.id) ?? clampedMin;
				targetY = waterSurfaceY - targetDepth - stats.halfHeight;
			}

			// Very slow depth drift (real water, not sea level)
			const depthError = targetY - mob.y;
			const depthSpeed = fleeing ? 0.075 : 0.0375;
			mob.y += depthError * Math.min(1, dt * depthSpeed);

			// Keep mob within water bounds (when known)
			const minY = waterFloorY + stats.halfHeight;
			const maxY = waterSurfaceY - stats.halfHeight - 0.1;
			if (waterFloorY !== centerY || waterSurfaceY !== centerY) {
				mob.y = Math.max(minY, Math.min(maxY, mob.y));
			}
		} else {
			// Beached — gently sink (will despawn via lifecycle).
			// Track falls so beached aquatics take damage from long drops.
			if (Number.isNaN(mob.fallStartY)) {
				mob.fallStartY = mob.y;
			}
			mob.y = Math.max(mob.y - 2 * dt, 0);
			// Check for ground — if landed, apply fall damage.
			const ground = this.scanDown(
				mob.x,
				mob.z,
				Math.floor(mob.y - stats.feetHeight),
			);
			if (ground.kind === "ground") {
				const fallDistance = mob.fallStartY - mob.y;
				const damage =
					fallDistance > FALL_DAMAGE_THRESHOLD
						? (fallDistance - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_PER_BLOCK
						: 0;
				if (fallDistance > 0.5) {
					events.push({ kind: "impact", mob, fallDistance, damage });
				}
				if (damage > 0) {
					const killed = this.damageMob(mob.id, damage);
					if (killed) return true;
				}
				mob.fallStartY = Number.NaN;
			}
			this.aquaticTargets.delete(mob.id);
		}
		return false;
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
		interface Node {
			x: number;
			z: number;
			groundY: number;
			g: number;
			f: number;
			parent: Node | null;
		}

		const key = (x: number, z: number, y: number): string => `${x},${z},${y}`;
		const heuristic = (x: number, z: number): number =>
			Math.abs(x - targetX) + Math.abs(z - targetZ);

		const open = new MinHeap<Node>((a, b) => a.f < b.f);
		open.push({
			x: startX,
			z: startZ,
			groundY: startY,
			g: 0,
			f: heuristic(startX, startZ),
			parent: null,
		});

		const best = new Map<string, number>();
		best.set(key(startX, startZ, startY), 0);

		const dirs = [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		] as const;

		for (let expanded = 0; open.length > 0 && expanded < 300; expanded++) {
			const current = open.pop()!;
			const currentKey = key(current.x, current.z, current.groundY);

			// Skip stale heap entries that were superseded by a cheaper path.
			if ((best.get(currentKey) ?? Infinity) < current.g) continue;

			if (
				current.x === targetX &&
				current.z === targetZ &&
				current.groundY === targetY
			) {
				const result: ServerWaypoint[] = [];
				let node: Node | null = current;

				while (node?.parent) {
					result.push({
						x: node.x,
						z: node.z,
						groundY: node.groundY,
					});
					node = node.parent;
				}

				result.reverse();
				return result;
			}

			for (const [dx, dz] of dirs) {
				const x = current.x + dx;
				const z = current.z + dz;
				const surface = this.findLandSurface(x, z, current.groundY, halfHeight);

				if (!surface || Math.abs(surface.groundY - current.groundY) > 1) {
					continue;
				}

				const stepCost = 1 + Math.abs(surface.groundY - current.groundY) * 4;
				const g = current.g + stepCost;
				const nodeKey = key(x, z, surface.groundY);

				if ((best.get(nodeKey) ?? Infinity) <= g) continue;

				best.set(nodeKey, g);
				open.push({
					x,
					z,
					groundY: surface.groundY,
					g,
					f: g + heuristic(x, z),
					parent: current,
				});
			}
		}

		return [];
	}

	private findNearestThreat(
		mob: ServerMob,
		players: ReadonlyArray<{ x: number; y: number; z: number }>,
	): { x: number; y: number; z: number } | null {
		const fleeRadiusSq = MOB_STATS[mob.typeId].fleeRadiusSq;
		if (fleeRadiusSq <= 0) return null;

		let nearest: { x: number; y: number; z: number } | null = null;
		let nearestDistSq = fleeRadiusSq;

		for (const player of players) {
			const dx = mob.x - player.x;
			const dy = mob.y - player.y;
			const dz = mob.z - player.z;
			const distSq = dx * dx + dy * dy + dz * dz;
			if (distSq < nearestDistSq) {
				nearestDistSq = distSq;
				nearest = player;
			}
		}

		return nearest;
	}

	/** Find the nearest player regardless of distance (for damage-triggered panic). */
	private findNearestPlayer(
		mob: ServerMob,
		players: ReadonlyArray<{ x: number; y: number; z: number }>,
	): { x: number; y: number; z: number } | null {
		let nearest: { x: number; y: number; z: number } | null = null;
		let nearestDistSq = Infinity;

		for (const player of players) {
			const dx = mob.x - player.x;
			const dy = mob.y - player.y;
			const dz = mob.z - player.z;
			const distSq = dx * dx + dy * dy + dz * dz;
			if (distSq < nearestDistSq) {
				nearestDistSq = distSq;
				nearest = player;
			}
		}

		return nearest;
	}

	private vectorToYaw(x: number, z: number): number {
		const radians = Math.atan2(x, z);
		return ((Math.round((radians / (Math.PI * 2)) * 255) % 256) + 256) % 256;
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
		nx: number,
		nz: number,
		halfHeight: number,
		feetHeight: number,
	): boolean {
		// Never advance into a column with no nearby support. The old check
		// only tested the body/head voxels, so a mob could walk over a drop or
		// chunk edge while its vertical fall caught up several frames later.
		const support = this.scanDown(nx, nz, Math.floor(mob.y + 1));
		if (support.kind !== "ground") return false;

		const targetY = support.y + 1 + feetHeight;
		if (targetY > mob.y + 1.01) return false;

		const feetY = Math.floor(mob.y - feetHeight);
		const bodyY = Math.floor(mob.y);
		const headY = Math.floor(mob.y + halfHeight - 0.01);

		if (this.isSolid(nx, bodyY, nz) || this.isSolid(nx, headY, nz)) {
			// Step up one block if the target feet voxel is solid but the
			// two voxels above it are free.
			const aboveFeet = this.sampler.sample(nx, feetY + 1, nz);
			const twoAbove = this.sampler.sample(nx, feetY + 2, nz);
			if (
				this.isSolid(nx, feetY, nz) &&
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
		const scan = this.scanDown(mob.x, mob.z, Math.floor(mob.y - feetHeight));

		switch (scan.kind) {
			case "ground": {
				// Feet sit on top of the ground voxel. A small step-down
				// (≤ 1 block) or upward step snaps to the surface. A larger
				// drop free-falls smoothly (Minecraft-style) until the mob
				// is within 1 block of the ground, then snaps and lands.
				const targetY = scan.y + 1 + feetHeight;
				if (targetY >= mob.y - 1) {
					mob.y = targetY;
					// Landed — apply fall damage if the fall was long enough.
					if (!Number.isNaN(mob.fallStartY)) {
						const fallDistance = mob.fallStartY - mob.y;
						const damage =
							fallDistance > FALL_DAMAGE_THRESHOLD
								? (fallDistance - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_PER_BLOCK
								: 0;
						if (fallDistance > 0.5) {
							events.push({ kind: "impact", mob, fallDistance, damage });
						}
						if (damage > 0) {
							const killed = this.damageMob(mob.id, damage);
							if (killed) return true;
						}
						mob.fallStartY = Number.NaN;
					}
				} else {
					// Ground is more than 1 block below: free-fall.
					if (Number.isNaN(mob.fallStartY)) {
						mob.fallStartY = mob.y;
					}
					mob.y = Math.max(mob.y - 16 * (deltaMs / 1000), 0);
				}
				return false;
			}
			case "water":
				// Standing at the shore: turn away from the water.
				mob.yaw = (mob.yaw + 128) & 255;
				mob.headingTimer = Math.min(mob.headingTimer, 800);
				// Water breaks the fall — reset tracking.
				mob.fallStartY = Number.NaN;
				return false;
			case "air": {
				// Free fall (16 blocks/sec, matching gravity feel) until
				// ground is found again or the fall limit removes the mob.
				// Record the Y where the fall started.
				if (Number.isNaN(mob.fallStartY)) {
					mob.fallStartY = mob.y;
				}
				mob.y = Math.max(mob.y - 16 * (deltaMs / 1000), 0);
				return false;
			}
			case "unknown":
				// Chunk not cached — hold height rather than fall through
				// terrain that exists but isn't in memory.
				return false;
		}
	}

	/**
	 * Scan a world column from `startY` downward to `startY - FALL_LIMIT`.
	 * Water short-circuits to "water"; an uncached chunk short-circuits to
	 * "unknown"; anything else falls through.
	 */
	private scanDown(worldX: number, worldZ: number, startY: number): ColumnScan {
		for (let y = startY; y > startY - FALL_LIMIT; y--) {
			const id = this.sampler.sample(worldX, y, worldZ);
			if (id === null) return { kind: "unknown" };
			if (id === BlockType.Water) return { kind: "water" };
			if (isCollidableBlock(id)) return { kind: "ground", y };
		}
		return { kind: "air" };
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
		return true;
	}

	/** Random species whose natural cap isn't reached yet (equal weights, like the client). */
	private pickSpawnType(): number | null {
		const available: number[] = [];

		for (const typeId of MOB_TYPE_IDS) {
			const spawnConfig = MOB_SPAWN_CONFIGS[typeId];
			if ((this.naturalTypeCounts.get(typeId) ?? 0) < spawnConfig.maxCount) {
				available.push(typeId);
			}
		}

		if (available.length === 0) return null;
		return available[Math.floor(Math.random() * available.length)];
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
	private countMobsNear(
		player: { x: number; z: number },
		radius: number,
	): number {
		const r2 = radius * radius;
		let count = 0;
		for (const mob of this.mobs.values()) {
			const dx = mob.x - player.x;
			const dz = mob.z - player.z;
			if (dx * dx + dz * dz <= r2) count++;
		}
		return count;
	}
}
