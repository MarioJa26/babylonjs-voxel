/**
 * ItemSimulation — server-authoritative dropped-item physics.
 *
 * Deliberately Babylon-free: runs on the fixed-rate room tick using only
 * synchronous block lookups (ServerWorldStorage.getCachedChunkBlocks), so the
 * server never blocks on LevelDB. Clients render these items as remote
 * interpolated meshes driven by ItemSpawn / ItemUpdateBatch / ItemDespawn.
 *
 * Items fall with gravity, rest on top of solid blocks, and despawn after a
 * lifetime or when they leave the world bounds. The server owns all item
 * positions and lifetimes; clients only render + interpolate.
 */

import { CHUNK_SIZE } from "@/code/Lib/VoxelMath";
import { packChunkKeyFast } from "@/code/World/Storage/ChunkKey.ts";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import type { ServerWorldStorage } from "./ServerWorldStorage.ts";

export interface ServerItem {
	readonly id: number;
	itemId: number;
	stackSize: number;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	/** ms the item has been alive (drives the despawn lifetime). */
	age: number;
}

export interface ServerItemEvent {
	kind: "despawn";
	item: ServerItem;
}

const GRAVITY = -18; // matches the client's DroppedItem.GRAVITY
const HALF_SIZE = 0.15; // small AABB half-extent for ground resting
const AIR_DAMPING_PER_SEC = 1.8;
const GROUND_DAMPING_PER_SEC = 8.0;
const MIN_SPEED = 0.03;
const ITEM_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes
const DESPAWN_Y = -64; // fell out of the world
const WORLD_BOUNDARY = 1_000_000;
const STEP_SIZE = 0.2; // max movement per sub-step (matches client)

/**
 * Block sampler for one simulation tick. Caches the decompressed chunk arrays
 * it touches so an item scanning a column doesn't re-fetch the same chunk for
 * every voxel, and so the storage decompress pool isn't thrashed.
 */
class ItemBlockSampler {
	private readonly chunkCache = new Map<number, Uint8Array | null>();

	constructor(private readonly storage: ServerWorldStorage) {}

	begin(): void {
		this.chunkCache.clear();
	}

	sample(worldX: number, worldY: number, worldZ: number): number | null {
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

export class ServerItemSimulation {
	private readonly items = new Map<number, ServerItem>();
	private nextId = 1;
	private readonly sampler: ItemBlockSampler;
	// Reused across ticks — the room broadcasts from it synchronously.
	private readonly eventScratch: ServerItemEvent[] = [];
	// Scratch velocity object decoupled from the item (position). moveAxis
	// zeroes velocity components on collision, so it must never alias pos.
	private readonly velocityScratch = { x: 0, y: 0, z: 0 };

	constructor(private readonly storage: ServerWorldStorage) {
		this.sampler = new ItemBlockSampler(storage);
	}

	/**
	 * Check whether an AABB centered at (x, y, z) with the given half-extents
	 * overlaps any collidable block. Scans every block cell the AABB touches.
	 * Uses a tiny skin width to avoid false positives at exact block boundaries
	 * caused by floating-point imprecision.
	 */
	private overlapsAABB(
		x: number,
		y: number,
		z: number,
		hx: number,
		hy: number,
		hz: number,
	): boolean {
		// Skin width: items resting exactly on a block surface (bottom at
		// integer Y) should NOT be considered overlapping that block. A
		// tiny inward push avoids float rounding creating a false overlap.
		const SKIN = 0.001;
		const x0 = Math.floor(x - hx + SKIN);
		const x1 = Math.floor(x + hx - SKIN);
		const y0 = Math.floor(y - hy + SKIN);
		const y1 = Math.floor(y + hy - SKIN);
		const z0 = Math.floor(z - hz + SKIN);
		const z1 = Math.floor(z + hz - SKIN);

		for (let bx = x0; bx <= x1; bx++) {
			for (let by = y0; by <= y1; by++) {
				for (let bz = z0; bz <= z1; bz++) {
					const id = this.sampler.sample(bx, by, bz);
					if (
						id !== null &&
						id !== BlockType.Water &&
						isCollidableBlock(id)
					) {
						return true;
					}
				}
			}
		}
		return false;
	}

	/**
	 * Step-move a single axis with collision. When falling (axis Y, negative
	 * delta) and hitting a block, the item is snapped to the block surface.
	 * Zeroes the velocity component on the collision axis.
	 */
	private moveAxis(
		pos: { x: number; y: number; z: number },
		vel: { x: number; y: number; z: number },
		axis: "x" | "y" | "z",
		delta: number,
	): void {
		if (delta === 0) return;

		const dir = delta > 0 ? 1 : -1;
		let remaining = Math.abs(delta);
		const hx = HALF_SIZE;
		const hy = HALF_SIZE;
		const hz = HALF_SIZE;

		while (remaining > 1e-8) {
			const step = remaining > STEP_SIZE ? STEP_SIZE : remaining;
			const move = step * dir;

			const nx = axis === "x" ? pos.x + move : pos.x;
			const ny = axis === "y" ? pos.y + move : pos.y;
			const nz = axis === "z" ? pos.z + move : pos.z;

			if (this.overlapsAABB(nx, ny, nz, hx, hy, hz)) {
				// For downward Y movement, snap to the top of the block
				// the item's bottom was entering.
				if (axis === "y" && dir < 0) {
					// The block the bottom entered is at floor(ny - hy).
					// Its top surface is at floor(ny - hy) + 1.
					// Place the item so its bottom sits exactly on that surface.
					const blockTop = Math.floor(ny - hy) + 1;
					const snapY = blockTop + hy;
					if (
						!this.overlapsAABB(pos.x, snapY, pos.z, hx, hy, hz)
					) {
						pos.y = snapY;
					}
				}
				vel[axis] = 0;
				break;
			}

			pos.x = nx;
			pos.y = ny;
			pos.z = nz;
			remaining -= step;
		}
	}

	get size(): number {
		return this.items.size;
	}

	/** Fill a reusable array with the current items (join snapshot). */
	snapshotInto(target: ServerItem[]): ServerItem[] {
		target.length = 0;
		for (const item of this.items.values()) target.push(item);
		return target;
	}

	/** Create a new dropped item and assign it a server instance id. */
	add(
		itemId: number,
		stackSize: number,
		x: number,
		y: number,
		z: number,
		vx: number,
		vy: number,
		vz: number,
	): ServerItem {
		const item: ServerItem = {
			id: this.nextId++,
			itemId,
			stackSize,
			x,
			y,
			z,
			vx,
			vy,
			vz,
			age: 0,
		};
		this.items.set(item.id, item);
		return item;
	}

	/** Remove an item by instance id (e.g. on pickup). Returns true if found. */
	remove(id: number): boolean {
		return this.items.delete(id);
	}

	/** Look up an item by instance id (used for pickup reach validation). */
	get(id: number): ServerItem | undefined {
		return this.items.get(id);
	}

	/**
	 * Advance the simulation by deltaMs and return the despawn events that must
	 * be broadcast (positions are broadcast separately via snapshotInto at the
	 * room's update cadence).
	 */
	tick(deltaMs: number): ServerItemEvent[] {
		const events = this.eventScratch;
		events.length = 0;
		const dt = deltaMs / 1000;
		this.sampler.begin();

		for (const item of this.items.values()) {
			item.age += deltaMs;

			// Despawn conditions: lifetime exceeded or out of bounds.
			if (
				item.age >= ITEM_LIFETIME_MS ||
				item.y < DESPAWN_Y ||
				Math.abs(item.x) > WORLD_BOUNDARY ||
				Math.abs(item.y) > WORLD_BOUNDARY ||
				Math.abs(item.z) > WORLD_BOUNDARY
			) {
				this.items.delete(item.id);
				events.push({ kind: "despawn", item });
				continue;
			}

			// Gravity.
			item.vy += GRAVITY * dt;

			// Step-based collision on all three axes (matches client approach).
			// The velocity lives in a scratch object separate from the item
			// (which doubles as the position): moveAxis zeroes the velocity
			// component on collision, so aliasing it to the item would write
			// the position instead (e.g. item.y = 0 on landing).
			const velocity = this.velocityScratch;
			velocity.x = item.vx;
			velocity.y = item.vy;
			velocity.z = item.vz;

			const preVy = velocity.y;
			this.moveAxis(item, velocity, "y", velocity.y * dt);

			// Detect grounded: if vertical velocity was killed while falling,
			// the item landed on something.
			const grounded = velocity.y === 0 && preVy < 0;

			this.moveAxis(item, velocity, "x", velocity.x * dt);
			this.moveAxis(item, velocity, "z", velocity.z * dt);

			item.vx = velocity.x;
			item.vy = velocity.y;
			item.vz = velocity.z;

			// Velocity damping so settled items stop jittering.
			const damping = grounded
				? GROUND_DAMPING_PER_SEC
				: AIR_DAMPING_PER_SEC;
			const keep = Math.exp(-damping * dt);
			item.vx *= keep;
			item.vy *= keep;
			item.vz *= keep;

			if (item.vx > -MIN_SPEED && item.vx < MIN_SPEED) item.vx = 0;
			if (item.vy > -MIN_SPEED && item.vy < MIN_SPEED) item.vy = 0;
			if (item.vz > -MIN_SPEED && item.vz < MIN_SPEED) item.vz = 0;
		}

		return events;
	}
}

