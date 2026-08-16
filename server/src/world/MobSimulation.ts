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
 */

import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import { MobTypeId } from "@/code/Network/protocol/messages.ts";
import { packChunkKeyFast } from "@/code/World/Storage/ChunkKey.ts";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import type { ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface ServerMob {
	readonly id: number;
	readonly typeId: number;
	/** Mob center position (same convention as the client's mesh position). */
	x: number;
	y: number;
	z: number;
	/** 0-255 byte mapping the full 360° circle (player yaw convention). */
	yaw: number;
	/** ms until the next random wander heading. */
	headingTimer: number;
	/** ms without forward progress — forces a new heading. */
	stuckTimer: number;
	/** Whether the mob was already fleeing on the previous tick. */
	fleeing: boolean;
	path: ServerWaypoint[];
	pathIndex: number;
	pathTimer: number;
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
}

const MOB_TYPE_CONFIGS: Record<number, MobTypeConfig> = {
	[MobTypeId.Chicken]: {
		maxCount: 30,
		speed: 1.8,
		halfHeight: 0.25,
	},
	[MobTypeId.Sheep]: {
		maxCount: 20,
		speed: 1.5,
		halfHeight: 0.35,
	},
};

/**
 * Block ids a mob may spawn on top of (the surface voxel directly below the
 * mob's feet). Add or remove entries freely to control where mobs appear.
 */
export const SPAWNABLE_BLOCK_IDS: readonly number[] = [
	BlockType.RockyTerrain02, // 14
	BlockType.Grass001, // 15
	BlockType.ConcreteMoss, // 51
];

const SPAWN_INTERVAL_MS = 1000;
const SPAWN_RING_MIN = 32;
const SPAWN_RING_MAX = 128;
const SPAWN_ATTEMPTS = 6;
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
	private readonly chunkCache = new Map<number, Uint8Array | null>();

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
		return blocks[localX + (localY << 5) + (localZ << 10)];
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
	// TEMP DIAG: tick counter for periodic logging.
	private diagTickCount = 0;
	private readonly sampler: TickBlockSampler;
	// Reused across ticks — the room broadcasts from it synchronously.
	private readonly eventScratch: ServerMobEvent[] = [];

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

	clear(): void {
		this.mobs.clear();
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
		this.sampler.begin();

		for (const mob of this.mobs.values()) {
			this.updateMob(mob, deltaMs, players);
		}

		if (players.length > 0) {
			this.spawnAccum += deltaMs;
			if (this.spawnAccum >= SPAWN_INTERVAL_MS) {
				this.spawnAccum = 0;
				this.trySpawn(players, events);
			}
		}

		// TEMP DIAG: periodic heartbeat (~every 5s at 20Hz tick).
		this.diagTickCount++;
		if (this.diagTickCount % 100 === 0) {
			console.log(
				`[MobDiag] tick players=${players.length} mobs=${this.mobs.size} cachedChunks=${this.storage.cachedChunkCount}`,
			);
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
		const open: Node[] = [
			{
				x: startX,
				z: startZ,
				groundY: startY,
				g: 0,
				f: Math.abs(startX - targetX) + Math.abs(startZ - targetZ),
				parent: null,
			},
		];
		const best = new Map<string, number>([[key(startX, startZ, startY), 0]]);
		const dirs = [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		];

		for (let expanded = 0; open.length > 0 && expanded < 300; expanded++) {
			open.sort((a, b) => a.f - b.f);
			const current = open.shift()!;
			if (
				current.x === targetX &&
				current.z === targetZ &&
				current.groundY === targetY
			) {
				const result: ServerWaypoint[] = [];
				let node: Node | null = current;
				while (node?.parent) {
					result.push({ x: node.x, z: node.z, groundY: node.groundY });
					node = node.parent;
				}
				result.reverse();
				return result;
			}

			for (const [dx, dz] of dirs) {
				const x = current.x + dx;
				const z = current.z + dz;
				const surface = this.findLandSurface(x, z, current.groundY, halfHeight);
				if (!surface || Math.abs(surface.groundY - current.groundY) > 1)
					continue;
				const g =
					current.g + 1 + Math.abs(surface.groundY - current.groundY) * 4;
				const nodeKey = key(x, z, surface.groundY);
				if ((best.get(nodeKey) ?? Infinity) <= g) continue;
				best.set(nodeKey, g);
				open.push({
					x,
					z,
					groundY: surface.groundY,
					g,
					f: g + Math.abs(x - targetX) + Math.abs(z - targetZ),
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
		const totalCap = this.totalCap();
		if (this.mobs.size >= totalCap) return;

		const player = players[Math.floor(Math.random() * players.length)];
		if (!player) return;

		// TEMP DIAG
		console.log(
			`[MobDiag] trySpawn players=${players.length} mobs=${this.mobs.size} cap=${totalCap} typeIdLimit=${Object.keys(MOB_TYPE_CONFIGS).length}`,
		);

		for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
			if (this.mobs.size >= totalCap) return;

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
				headingTimer:
					WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS),
				stuckTimer: 0,
				fleeing: false,
				path: [],
				pathIndex: 0,
				pathTimer: 0,
			};
			this.mobs.set(mob.id, mob);
			events.push({ kind: "spawn", mob });
		}
	}

	/** Random species whose cap isn't reached yet (equal weights, like the client). */
	private pickSpawnType(): number | null {
		const available: number[] = [];
		for (const typeId of Object.keys(MOB_TYPE_CONFIGS).map(Number)) {
			const config = MOB_TYPE_CONFIGS[typeId];
			if (this.countByType(typeId) < config.maxCount) {
				available.push(typeId);
			}
		}
		if (available.length === 0) return null;
		return available[Math.floor(Math.random() * available.length)];
	}

	private countByType(typeId: number): number {
		let count = 0;
		for (const mob of this.mobs.values()) {
			if (mob.typeId === typeId) count++;
		}
		return count;
	}

	private totalCap(): number {
		let cap = 0;
		for (const typeId of Object.keys(MOB_TYPE_CONFIGS).map(Number)) {
			cap += MOB_TYPE_CONFIGS[typeId].maxCount;
		}
		return cap;
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

		// TEMP DIAG: classify why a column fails to spawn.
		let diagCachedVoxels = 0;
		let diagTopSolidId = -1;
		let diagSawSpawnable = false;
		let diagAirBlocked = 0;

		// Scan the column top-down for a spawnable block with air above it.
		for (let wy = MAX_SPAWN_SCAN_Y; wy >= 0; wy--) {
			const sampleId = this.sampler.sample(wx, wy, wz);
			if (sampleId !== null) {
				diagCachedVoxels++;
				if (sampleId !== 0 && diagTopSolidId === -1) {
					diagTopSolidId = sampleId;
				}
			}

			if (
				SPAWNABLE_BLOCK_IDS.includes(sampleId ?? -1) &&
				this.sampler.sample(wx, wy + 1, wz) === 0
			) {
				diagSawSpawnable = true;
				if (this.isSpawnTooClose(wx, wz)) continue;

				const spawnY = wy + 1.02 + config.halfHeight;
				return {
					x: wx + 0.5,
					// The visual mesh is centered on y. Keep its feet exactly on
					// the top face of the spawn block.
					y: spawnY,
					z: wz + 0.5,
				};
			} else if (
				sampleId !== null &&
				SPAWNABLE_BLOCK_IDS.includes(sampleId ?? -1)
			) {
				diagAirBlocked++;
			}
		}

		if (diagCachedVoxels === 0) {
			console.log(
				`[MobDiag] spawn FAILED column=${wx},${wz} reason=noCachedChunks`,
			);
		} else {
			console.log(
				`[MobDiag] spawn FAILED column=${wx},${wz} reason=${
					diagSawSpawnable ? "airBlocked" : "wrongBlock"
				} cachedVoxels=${diagCachedVoxels} topSolidId=${diagTopSolidId} airBlocked=${diagAirBlocked}`,
			);
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
