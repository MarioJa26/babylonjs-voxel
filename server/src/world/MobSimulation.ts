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

import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import { MobTypeId } from "@/code/Network/protocol/messages.ts";
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
	/** ms until the next random wander heading. */
	headingTimer: number;
	/** ms without forward progress — forces a new heading. */
	stuckTimer: number;
	/** Whether the mob was already fleeing on the previous tick. */
	fleeing: boolean;
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
	kind: "spawn" | "despawn";
	mob: ServerMob;
}

interface MobTypeConfig {
	maxCount: number;
	speed: number;
	/** Half the mob's body height, used for voxel collision. */
	halfHeight: number;
	/** Hit points a freshly spawned mob of this type gets. */
	hp: number;
}

const MOB_TYPE_CONFIGS: Record<number, MobTypeConfig> = {
	[MobTypeId.Chicken]: {
		maxCount: 30,
		speed: 1.8,
		// Half heights match the client's multi-part models (CHICKEN_HIT_HALF /
		// SHEEP_HIT_HALF) so settleHeight anchors the body exactly where the
		// client renders it — otherwise hit boxes and visuals diverge.
		halfHeight: 0.45,
		hp: 4,
	},
	[MobTypeId.Sheep]: {
		maxCount: 20,
		speed: 1.5,
		halfHeight: 0.55,
		hp: 8,
	},
};
const MOB_TYPE_IDS = Object.keys(MOB_TYPE_CONFIGS).map(Number);
const TOTAL_MOB_CAP = MOB_TYPE_IDS.reduce(
	(sum, typeId) => sum + MOB_TYPE_CONFIGS[typeId].maxCount,
	0,
);

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
const FLEE_RADIUS = 8;
const FLEE_RADIUS_SQ = FLEE_RADIUS * FLEE_RADIUS;
const FLEE_SPEED = 5;

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

	constructor(private readonly storage: ServerWorldStorage) {}

	begin(): void {
		this.chunkCache.clear();
	}

	sample(worldX: number, worldY: number, worldZ: number): number | null {
		// Mob positions are sub-block floats; voxel lookups must use the
		// containing integer coordinate or every array index becomes invalid.
		const x = Math.floor(worldX);
		const y = Math.floor(worldY);
		const z = Math.floor(worldZ);
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

	constructor(private readonly storage: ServerWorldStorage) {
		this.sampler = new TickBlockSampler(storage);
		// Populate on the first tick that has players instead of waiting out
		// a full spawn interval.
		this.spawnAccum = SPAWN_INTERVAL_MS;
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
			this.updateMob(mob, deltaMs, players);
		}

		if (players.length > 0) {
			// Persist mobs whose column left the loaded radius and load back
			// the mobs of columns that entered it, so far mobs free their cap
			// slots but are never lost.
			this.updateChunkMobLifecycle(players, events);

			this.spawnAccum += deltaMs;
			if (this.spawnAccum >= SPAWN_INTERVAL_MS) {
				this.spawnAccum = 0;
				this.trySpawn(players, events);
			}
		}

		return events;
	}

	private updateMob(
		mob: ServerMob,
		deltaMs: number,
		players: ReadonlyArray<{ x: number; y: number; z: number }>,
	): void {
		const config = MOB_TYPE_CONFIGS[mob.typeId];
		const threat = this.findNearestThreat(mob, players);
		const fleeing = threat !== null;
		if (fleeing) {
			mob.path.length = 0;
			mob.pathIndex = 0;
		}

		mob.headingTimer -= deltaMs;
		if (fleeing) {
			// Refresh the escape vector periodically. When blocked, the heading
			// is kept long enough to route around the obstacle.
			if (!mob.fleeing || mob.headingTimer <= 0) {
				const awayX = mob.x - threat.x;
				const awayZ = mob.z - threat.z;
				if (awayX * awayX + awayZ * awayZ > 0.0001) {
					mob.yaw = this.vectorToYaw(awayX, awayZ);
				} else {
					mob.yaw = (mob.yaw + 64) & 255;
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
			this.followWanderPath(mob, config.halfHeight, deltaMs);
		}

		const step = (fleeing ? FLEE_SPEED : config.speed) * (deltaMs / 1000);
		if (step > 0) {
			const radians = (mob.yaw / 255) * Math.PI * 2;
			const nx = mob.x + Math.sin(radians) * step;
			const nz = mob.z + Math.cos(radians) * step;

			if (!this.canMoveTo(mob, nx, nz, config.halfHeight)) {
				// Turn around, or sidestep while fleeing so a wall does not
				// pin the mob while the player remains on the other side.
				mob.yaw = (mob.yaw + (fleeing ? 64 : 128)) & 255;
				mob.headingTimer = fleeing ? 800 : Math.min(mob.headingTimer, 800);
				mob.stuckTimer += deltaMs;
				if (mob.stuckTimer > STUCK_MS) {
					mob.stuckTimer = 0;
					mob.headingTimer = 0;
				}
				return;
			}

			mob.x = nx;
			mob.z = nz;
			mob.stuckTimer = 0;

			// Mobs don't swim — turn back before wading in.
			if (
				this.sampler.sample(nx, Math.floor(mob.y - config.halfHeight), nz) ===
				BlockType.Water
			) {
				mob.yaw = (mob.yaw + 128) & 255;
				mob.headingTimer = Math.min(mob.headingTimer, 800);
			}
		}

		this.settleHeight(mob, config.halfHeight, deltaMs);
	}

	/** Follow a short land route using the same surface/headroom rules as NeutralMob. */
	private followWanderPath(
		mob: ServerMob,
		halfHeight: number,
		deltaMs: number,
	): void {
		mob.pathTimer -= deltaMs / 1000;
		if (mob.pathIndex >= mob.path.length) {
			mob.path.length = 0;
			mob.pathIndex = 0;
		}

		if (mob.path.length === 0 && mob.pathTimer <= 0) {
			this.buildWanderPath(mob, halfHeight);
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

	private buildWanderPath(mob: ServerMob, halfHeight: number): void {
		mob.path.length = 0;
		mob.pathIndex = 0;
		mob.pathTimer = 1.0;

		const sx = Math.floor(mob.x);
		const sz = Math.floor(mob.z);
		const startGround = Math.floor(mob.y - halfHeight - 0.01);
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
		let nearest: { x: number; y: number; z: number } | null = null;
		let nearestDistSq = FLEE_RADIUS_SQ;

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

	/**
	 * True when the mob's center voxel and head voxel are free at (nx, nz),
	 * allowing a one-block step-up onto low terrain.
	 */
	private canMoveTo(
		mob: ServerMob,
		nx: number,
		nz: number,
		halfHeight: number,
	): boolean {
		// Never advance into a column with no nearby support. The old check
		// only tested the body/head voxels, so a mob could walk over a drop or
		// chunk edge while its vertical fall caught up several frames later.
		const support = this.scanDown(nx, nz, Math.floor(mob.y + 1));
		if (support.kind !== "ground") return false;

		const targetY = support.y + 1 + halfHeight;
		if (targetY > mob.y + 1.01 || targetY < mob.y - 1.01) return false;

		const feetY = Math.floor(mob.y - halfHeight);
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
		halfHeight: number,
		deltaMs: number,
	): void {
		const scan = this.scanDown(mob.x, mob.z, Math.floor(mob.y - halfHeight));

		switch (scan.kind) {
			case "ground": {
				// Feet sit on top of the ground voxel; snap downward, and
				// allow a small upward step (the climb path already moved y).
				const targetY = scan.y + 1 + halfHeight;
				if (targetY < mob.y || targetY - mob.y <= 1) {
					mob.y = targetY;
				}
				break;
			}
			case "water":
				// Standing at the shore: turn away from the water.
				mob.yaw = (mob.yaw + 128) & 255;
				mob.headingTimer = Math.min(mob.headingTimer, 800);
				break;
			case "air":
				// Free fall (16 blocks/sec, matching gravity feel) until
				// ground is found again or the fall limit removes the mob.
				mob.y = Math.max(mob.y - 16 * (deltaMs / 1000), 0);
				break;
			case "unknown":
				// Chunk not cached — hold height rather than fall through
				// terrain that exists but isn't in memory.
				break;
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
		// Only naturally spawned mobs occupy cap slots; spawn-egg mobs never
		// block natural spawning.
		if (this.naturalTotal >= TOTAL_MOB_CAP) return;

		const player = players[Math.floor(Math.random() * players.length)];
		if (!player) return;

		for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
			if (this.naturalTotal >= TOTAL_MOB_CAP) return;

			const typeId = this.pickSpawnType();
			if (typeId === null) return;

			const config = MOB_TYPE_CONFIGS[typeId];
			const pos = this.findSpawnPosition(player, config);
			if (!pos) continue;

			const mob: ServerMob = {
				id: this.nextId++,
				typeId,
				x: pos.x,
				y: pos.y,
				z: pos.z,
				yaw: Math.floor(Math.random() * 256),
				hp: config.hp,
				headingTimer:
					WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS),
				stuckTimer: 0,
				fleeing: false,
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
		const config = MOB_TYPE_CONFIGS[typeId];
		if (!config) return null;
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
			return null;
		}

		// Unknown chunk (not cached) or solid body/head cell — reject so the
		// mob never spawns stuck inside terrain.
		if (this.sampler.sample(x, y, z) === null) return null;
		if (this.isSolid(x, y, z) || this.isSolid(x, y + 1, z)) return null;

		const mob: ServerMob = {
			id: this.nextId++,
			typeId,
			x,
			y,
			z,
			yaw: Math.floor(Math.random() * 256),
			hp: config.hp,
			headingTimer:
				WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS),
			stuckTimer: 0,
			fleeing: false,
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
		if (mob.hp > 0) return false;

		this.removeActiveMob(mob);
		return true;
	}

	/** Random species whose natural cap isn't reached yet (equal weights, like the client). */
	private pickSpawnType(): number | null {
		const available: number[] = [];

		for (const typeId of MOB_TYPE_IDS) {
			const config = MOB_TYPE_CONFIGS[typeId];
			if ((this.naturalTypeCounts.get(typeId) ?? 0) < config.maxCount) {
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
				const config = MOB_TYPE_CONFIGS[pm.typeId];
				if (!config) continue; // Unknown type — drop.

				// Already active (id collision) — keep it persisted.
				if (this.mobs.has(pm.id)) {
					kept.push(pm);
					continue;
				}

				// Natural mobs count toward the per-type cap; if it's full,
				// leave this one persisted until a slot frees up. Spawn-egg
				// mobs are cap-exempt and always load back.
				const naturalCount = this.naturalTypeCounts.get(pm.typeId) ?? 0;
				if (!pm.egg && naturalCount >= config.maxCount) {
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
			hp: pm.hp ?? MOB_TYPE_CONFIGS[pm.typeId].hp,
			headingTimer: pm.headingTimer,
			stuckTimer: pm.stuckTimer,
			fleeing: pm.fleeing,
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
		config: MobTypeConfig,
	): { x: number; y: number; z: number } | null {
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

		// Scan top-down, but fetch each cached chunk section only once instead of
		// routing every Y coordinate through TickBlockSampler.sample().
		for (let cy = maxCy; cy >= 0; cy--) {
			const blocks = this.storage.getCachedChunkBlocks(cx, cy, cz);
			if (!blocks) continue;

			const chunkBaseY = cy * CHUNK_SIZE;
			const startLocalY =
				cy === maxCy
					? Math.min(CHUNK_SIZE - 1, MAX_SPAWN_SCAN_Y - chunkBaseY)
					: CHUNK_SIZE - 1;

			const columnBase = localX + (localZ << 10);

			for (let localY = startLocalY; localY >= 0; localY--) {
				// Entries are packed values — match the set on the raw block id.
				const blockId = unpackBlockId(blocks[columnBase + (localY << 5)]);
				if (!SPAWNABLE_BLOCK_ID_SET.has(blockId)) continue;

				const wy = chunkBaseY + localY;

				// Preserve the original air-above rule. This intentionally uses
				// the sampler because wy + 1 may cross into the next chunk section.
				// Air is always packed 0, so the raw comparison stays valid.
				if (this.sampler.sample(wx, wy + 1, wz) !== 0) continue;

				if (this.isSpawnTooClose(wx, wz)) continue;

				return {
					x: wx + 0.5,
					y: wy + 1.02 + config.halfHeight,
					z: wz + 0.5,
				};
			}
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
}
