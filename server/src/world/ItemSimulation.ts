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
import { unpackBlockId } from "@/code/World/Chunk/DataStructures/BlockEncoding";
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

const GRAVITY = -18;
const HALF_SIZE = 0.15;
const AIR_DAMPING_PER_SEC = 1.8;
const GROUND_DAMPING_PER_SEC = 8.0;
const MIN_SPEED = 0.03;
const ITEM_LIFETIME_MS = 5 * 60 * 1000;
const DESPAWN_Y = -64;
const WORLD_BOUNDARY = 1_000_000;
const STEP_SIZE = 0.2;
const COLLISION_EPSILON = 1e-8;
const AABB_SKIN = 0.001;

/**
 * Block sampler for one simulation tick.
 *
 * The cache Map and decompressed chunk arrays are reused for the entire tick.
 * Integer-coordinate sampling avoids repeating Math.floor calls when collision
 * code is already iterating over block coordinates.
 */
class ItemBlockSampler {
	private readonly chunkCache = new Map<
		number,
		Uint8Array | Uint16Array | null
	>();

	constructor(private readonly storage: ServerWorldStorage) {}

	begin(): void {
		// clear() retains the Map's internal capacity in typical engines,
		// avoiding construction of a new Map every tick.
		this.chunkCache.clear();
	}

	sampleBlock(x: number, y: number, z: number): number | null {
		const cx = Math.floor(x / CHUNK_SIZE);
		const cy = Math.floor(y / CHUNK_SIZE);
		const cz = Math.floor(z / CHUNK_SIZE);
		const key = packChunkKeyFast(cx, cy, cz);

		let blocks = this.chunkCache.get(key);

		if (blocks === undefined) {
			blocks = this.storage.getCachedChunkBlocks(cx, cy, cz);
			this.chunkCache.set(key, blocks);
		}

		if (blocks === null) {
			return null;
		}

		const localX = x - cx * CHUNK_SIZE;
		const localY = y - cy * CHUNK_SIZE;
		const localZ = z - cz * CHUNK_SIZE;

		return unpackBlockId(blocks[localX + (localY << 5) + (localZ << 10)]);
	}

	sample(worldX: number, worldY: number, worldZ: number): number | null {
		return this.sampleBlock(
			Math.floor(worldX),
			Math.floor(worldY),
			Math.floor(worldZ),
		);
	}
}

export class ServerItemSimulation {
	private readonly items = new Map<number, ServerItem>();
	private nextId = 1;
	private readonly sampler: ItemBlockSampler;

	/**
	 * Reused across ticks. Consumers must finish reading the returned array
	 * synchronously before the next tick, matching the original contract.
	 */
	private readonly eventScratch: ServerItemEvent[] = [];

	constructor(private readonly storage: ServerWorldStorage) {
		this.sampler = new ItemBlockSampler(storage);
	}

	/**
	 * Check whether an AABB overlaps a collidable block.
	 *
	 * All loop coordinates are already integers, so sampleBlock avoids three
	 * redundant Math.floor operations for every visited voxel.
	 */
	private overlapsAABB(
		x: number,
		y: number,
		z: number,
		hx: number,
		hy: number,
		hz: number,
	): boolean {
		const x0 = Math.floor(x - hx + AABB_SKIN);
		const x1 = Math.floor(x + hx - AABB_SKIN);
		const y0 = Math.floor(y - hy + AABB_SKIN);
		const y1 = Math.floor(y + hy - AABB_SKIN);
		const z0 = Math.floor(z - hz + AABB_SKIN);
		const z1 = Math.floor(z + hz - AABB_SKIN);

		for (let bx = x0; bx <= x1; bx++) {
			for (let by = y0; by <= y1; by++) {
				for (let bz = z0; bz <= z1; bz++) {
					const id = this.sampler.sampleBlock(bx, by, bz);

					if (id !== null && id !== BlockType.Water && isCollidableBlock(id)) {
						return true;
					}
				}
			}
		}

		return false;
	}

	/**
	 * Move on the Y axis and return the resulting Y velocity.
	 *
	 * Returning the velocity removes the need for a temporary mutable velocity
	 * object while preserving collision behavior.
	 */
	private moveY(item: ServerItem, velocity: number, delta: number): number {
		if (delta === 0) {
			return velocity;
		}

		const dir = delta > 0 ? 1 : -1;
		let remaining = Math.abs(delta);

		while (remaining > COLLISION_EPSILON) {
			const step = remaining > STEP_SIZE ? STEP_SIZE : remaining;
			const nextY = item.y + step * dir;

			if (
				this.overlapsAABB(
					item.x,
					nextY,
					item.z,
					HALF_SIZE,
					HALF_SIZE,
					HALF_SIZE,
				)
			) {
				if (dir < 0) {
					const blockTop = Math.floor(nextY - HALF_SIZE) + 1;
					const snapY = blockTop + HALF_SIZE;

					if (
						!this.overlapsAABB(
							item.x,
							snapY,
							item.z,
							HALF_SIZE,
							HALF_SIZE,
							HALF_SIZE,
						)
					) {
						item.y = snapY;
					}
				}

				return 0;
			}

			item.y = nextY;
			remaining -= step;
		}

		return velocity;
	}

	/**
	 * Move on the X axis and return the resulting X velocity.
	 */
	private moveX(item: ServerItem, velocity: number, delta: number): number {
		if (delta === 0) {
			return velocity;
		}

		const dir = delta > 0 ? 1 : -1;
		let remaining = Math.abs(delta);

		while (remaining > COLLISION_EPSILON) {
			const step = remaining > STEP_SIZE ? STEP_SIZE : remaining;
			const nextX = item.x + step * dir;

			if (
				this.overlapsAABB(
					nextX,
					item.y,
					item.z,
					HALF_SIZE,
					HALF_SIZE,
					HALF_SIZE,
				)
			) {
				return 0;
			}

			item.x = nextX;
			remaining -= step;
		}

		return velocity;
	}

	/**
	 * Move on the Z axis and return the resulting Z velocity.
	 */
	private moveZ(item: ServerItem, velocity: number, delta: number): number {
		if (delta === 0) {
			return velocity;
		}

		const dir = delta > 0 ? 1 : -1;
		let remaining = Math.abs(delta);

		while (remaining > COLLISION_EPSILON) {
			const step = remaining > STEP_SIZE ? STEP_SIZE : remaining;
			const nextZ = item.z + step * dir;

			if (
				this.overlapsAABB(
					item.x,
					item.y,
					nextZ,
					HALF_SIZE,
					HALF_SIZE,
					HALF_SIZE,
				)
			) {
				return 0;
			}

			item.z = nextZ;
			remaining -= step;
		}

		return velocity;
	}

	get size(): number {
		return this.items.size;
	}

	/** Fill a reusable array with the current items for a join snapshot. */
	snapshotInto(target: ServerItem[]): ServerItem[] {
		target.length = 0;

		for (const item of this.items.values()) {
			target.push(item);
		}

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

	/** Remove an item by instance id. Returns true if it existed. */
	remove(id: number): boolean {
		return this.items.delete(id);
	}

	/** Look up an item by instance id. */
	get(id: number): ServerItem | undefined {
		return this.items.get(id);
	}

	/**
	 * Advance the simulation and return despawn events for this tick.
	 *
	 * The returned array is reused by the next tick, matching the original
	 * synchronous-consumption contract.
	 */
	tick(deltaMs: number): ServerItemEvent[] {
		const events = this.eventScratch;
		events.length = 0;

		const dt = deltaMs * 0.001;
		this.sampler.begin();

		for (const item of this.items.values()) {
			item.age += deltaMs;

			if (
				item.age >= ITEM_LIFETIME_MS ||
				item.y < DESPAWN_Y ||
				item.x < -WORLD_BOUNDARY ||
				item.x > WORLD_BOUNDARY ||
				item.y < -WORLD_BOUNDARY ||
				item.y > WORLD_BOUNDARY ||
				item.z < -WORLD_BOUNDARY ||
				item.z > WORLD_BOUNDARY
			) {
				this.items.delete(item.id);

				// This allocation is required by the public event shape.
				// Pooling these objects would retain references to despawned
				// items and could increase long-lived memory usage.
				events.push({
					kind: "despawn",
					item,
				});

				continue;
			}

			let vx = item.vx;
			let vy = item.vy + GRAVITY * dt;
			let vz = item.vz;

			const preVy = vy;

			vy = this.moveY(item, vy, vy * dt);
			const grounded = vy === 0 && preVy < 0;

			vx = this.moveX(item, vx, vx * dt);
			vz = this.moveZ(item, vz, vz * dt);

			const damping = grounded ? GROUND_DAMPING_PER_SEC : AIR_DAMPING_PER_SEC;
			const keep = Math.exp(-damping * dt);

			vx *= keep;
			vy *= keep;
			vz *= keep;

			if (vx > -MIN_SPEED && vx < MIN_SPEED) {
				vx = 0;
			}

			if (vy > -MIN_SPEED && vy < MIN_SPEED) {
				vy = 0;
			}

			if (vz > -MIN_SPEED && vz < MIN_SPEED) {
				vz = 0;
			}

			item.vx = vx;
			item.vy = vy;
			item.vz = vz;
		}

		return events;
	}
}
