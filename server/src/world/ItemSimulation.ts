/**
 * ItemSimulation — server-authoritative dropped-item physics.
 *
 * Babylon-free: runs on the fixed-rate room tick using synchronous cached
 * block lookups. Clients render remote interpolated items from server events.
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
	/** Milliseconds the item has been alive. */
	age: number;
}

export interface ServerItemEvent {
	kind: "despawn";
	item: ServerItem;
}

const GRAVITY = -18;
const HALF_SIZE = 0.15;
const AIR_DAMPING_PER_SEC = 1.8;
const GROUND_DAMPING_PER_SEC = 8;
const MIN_SPEED = 0.03;

const ITEM_LIFETIME_MS = 5 * 60 * 1000;
const DESPAWN_Y = -64;
const WORLD_BOUNDARY = 1_000_000;

const STEP_SIZE = 0.2;
const COLLISION_EPSILON = 1e-8;
const AABB_SKIN = 0.001;

/*
 * This sampler relies on the current 32³ chunk layout.
 *
 * Signed right shift provides floor division by 32 for coordinates inside the
 * signed 32-bit range, including negative coordinates. Item world bounds are
 * much smaller than that range.
 */
const CHUNK_SHIFT = 5;
const CHUNK_MASK = CHUNK_SIZE - 1;

type ItemAxis = 0 | 1 | 2;

/**
 * Block sampler for one simulation tick.
 *
 * Chunk arrays and negative cache entries are reused throughout the tick.
 */
class ItemBlockSampler {
	private readonly chunkCache = new Map<
		number,
		Uint8Array | Uint16Array | null
	>();

	constructor(private readonly storage: ServerWorldStorage) {}

	begin(): void {
		/*
		 * Reuse the Map object. Most JavaScript engines retain at least part of
		 * its internal capacity after clear().
		 */
		this.chunkCache.clear();
	}

	/**
	 * Sample an integer world-block coordinate.
	 */
	sampleBlock(x: number, y: number, z: number): number | null {
		/*
		 * Coordinates passed by collision code are integers and constrained to
		 * ±WORLD_BOUNDARY, so signed 32-bit bit operations are safe here.
		 *
		 * Right shift matches Math.floor(value / 32), including negatives.
		 */
		const chunkX = x >> CHUNK_SHIFT;
		const chunkY = y >> CHUNK_SHIFT;
		const chunkZ = z >> CHUNK_SHIFT;

		const key = packChunkKeyFast(chunkX, chunkY, chunkZ);

		let blocks = this.chunkCache.get(key);

		if (blocks === undefined) {
			blocks = this.storage.getCachedChunkBlocks(chunkX, chunkY, chunkZ);

			this.chunkCache.set(key, blocks);
		}

		if (blocks === null) {
			return null;
		}

		/*
		 * Masking produces the correct 0..31 local coordinate for negative and
		 * positive signed integer coordinates.
		 */
		const localX = x & CHUNK_MASK;
		const localY = y & CHUNK_MASK;
		const localZ = z & CHUNK_MASK;

		const index =
			localX + (localY << CHUNK_SHIFT) + (localZ << (CHUNK_SHIFT * 2));

		return unpackBlockId(blocks[index]);
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
	private readonly sampler: ItemBlockSampler;

	private nextId = 1;

	/**
	 * Reused across ticks. Consumers must read the returned array synchronously
	 * before the next tick.
	 */
	private readonly eventScratch: ServerItemEvent[] = [];

	constructor(readonly storage: ServerWorldStorage) {
		this.sampler = new ItemBlockSampler(storage);
	}

	/**
	 * Check whether an AABB overlaps any collidable block.
	 */
	private overlapsAABB(
		x: number,
		y: number,
		z: number,
		hx: number,
		hy: number,
		hz: number,
	): boolean {
		const minX = Math.floor(x - hx + AABB_SKIN);
		const maxX = Math.floor(x + hx - AABB_SKIN);
		const minY = Math.floor(y - hy + AABB_SKIN);
		const maxY = Math.floor(y + hy - AABB_SKIN);
		const minZ = Math.floor(z - hz + AABB_SKIN);
		const maxZ = Math.floor(z + hz - AABB_SKIN);

		const sampler = this.sampler;

		/*
		 * Keep Y as the innermost loop. Dropped-item AABBs normally span one or
		 * two vertical blocks, and floor/ground collisions are the common case.
		 */
		for (let blockX = minX; blockX <= maxX; blockX++) {
			for (let blockZ = minZ; blockZ <= maxZ; blockZ++) {
				for (let blockY = minY; blockY <= maxY; blockY++) {
					const id = sampler.sampleBlock(blockX, blockY, blockZ);

					if (id !== null && id !== BlockType.Water && isCollidableBlock(id)) {
						return true;
					}
				}
			}
		}

		return false;
	}

	/**
	 * Move an item along one axis and return the resulting velocity.
	 *
	 * Y movement preserves the original downward collision snap behavior.
	 */
	private moveAxis(
		item: ServerItem,
		axis: ItemAxis,
		velocity: number,
		delta: number,
	): number {
		if (delta === 0) {
			return velocity;
		}

		const direction = delta > 0 ? 1 : -1;
		let remaining = Math.abs(delta);

		while (remaining > COLLISION_EPSILON) {
			const step = remaining > STEP_SIZE ? STEP_SIZE : remaining;

			const movement = step * direction;

			let nextX = item.x;
			let nextY = item.y;
			let nextZ = item.z;

			if (axis === 0) {
				nextX += movement;
			} else if (axis === 1) {
				nextY += movement;
			} else {
				nextZ += movement;
			}

			if (
				this.overlapsAABB(nextX, nextY, nextZ, HALF_SIZE, HALF_SIZE, HALF_SIZE)
			) {
				/*
				 * When falling, place the item's bottom face on the top of the
				 * collided block when that snapped position is itself clear.
				 */
				if (axis === 1 && direction < 0) {
					const blockTop = Math.floor(nextY - HALF_SIZE) + 1;

					const snappedY = blockTop + HALF_SIZE;

					if (
						!this.overlapsAABB(
							item.x,
							snappedY,
							item.z,
							HALF_SIZE,
							HALF_SIZE,
							HALF_SIZE,
						)
					) {
						item.y = snappedY;
					}
				}

				return 0;
			}

			if (axis === 0) {
				item.x = nextX;
			} else if (axis === 1) {
				item.y = nextY;
			} else {
				item.z = nextZ;
			}

			remaining -= step;
		}

		return velocity;
	}

	get size(): number {
		return this.items.size;
	}

	/**
	 * Fill a reusable array with current items for a join snapshot.
	 */
	snapshotInto(target: ServerItem[]): ServerItem[] {
		target.length = 0;

		for (const item of this.items.values()) {
			target.push(item);
		}

		return target;
	}

	/**
	 * Create a dropped item and assign a server instance ID.
	 */
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

	/**
	 * Remove an item by instance ID.
	 */
	remove(id: number): boolean {
		return this.items.delete(id);
	}

	/**
	 * Look up an item by instance ID.
	 */
	get(id: number): ServerItem | undefined {
		return this.items.get(id);
	}

	/**
	 * Advance the simulation and return despawn events for this tick.
	 *
	 * The returned array is reused by the next tick.
	 */
	tick(deltaMs: number): ServerItemEvent[] {
		const events = this.eventScratch;
		events.length = 0;

		const dt = deltaMs * 0.001;
		const gravityDelta = GRAVITY * dt;

		/*
		 * These values are invariant for every item in the tick. Previously,
		 * Math.exp was called once per item.
		 */
		const airVelocityRetention = Math.exp(-AIR_DAMPING_PER_SEC * dt);

		const groundVelocityRetention = Math.exp(-GROUND_DAMPING_PER_SEC * dt);

		const items = this.items;
		this.sampler.begin();

		for (const item of items.values()) {
			item.age += deltaMs;

			const x = item.x;
			const y = item.y;
			const z = item.z;

			/*
			 * DESPAWN_Y is above the negative world boundary, so a separate
			 * y < -WORLD_BOUNDARY test is redundant.
			 */
			if (
				item.age >= ITEM_LIFETIME_MS ||
				y < DESPAWN_Y ||
				x < -WORLD_BOUNDARY ||
				x > WORLD_BOUNDARY ||
				y > WORLD_BOUNDARY ||
				z < -WORLD_BOUNDARY ||
				z > WORLD_BOUNDARY
			) {
				items.delete(item.id);

				events.push({
					kind: "despawn",
					item,
				});

				continue;
			}

			let velocityX = item.vx;
			let velocityY = item.vy + gravityDelta;
			let velocityZ = item.vz;

			const falling = velocityY < 0;

			velocityY = this.moveAxis(item, 1, velocityY, velocityY * dt);

			const grounded = falling && velocityY === 0;

			velocityX = this.moveAxis(item, 0, velocityX, velocityX * dt);

			velocityZ = this.moveAxis(item, 2, velocityZ, velocityZ * dt);

			const velocityRetention = grounded
				? groundVelocityRetention
				: airVelocityRetention;

			velocityX *= velocityRetention;
			velocityY *= velocityRetention;
			velocityZ *= velocityRetention;

			if (velocityX > -MIN_SPEED && velocityX < MIN_SPEED) {
				velocityX = 0;
			}

			if (velocityY > -MIN_SPEED && velocityY < MIN_SPEED) {
				velocityY = 0;
			}

			if (velocityZ > -MIN_SPEED && velocityZ < MIN_SPEED) {
				velocityZ = 0;
			}

			item.vx = velocityX;
			item.vy = velocityY;
			item.vz = velocityZ;
		}

		return events;
	}
}
