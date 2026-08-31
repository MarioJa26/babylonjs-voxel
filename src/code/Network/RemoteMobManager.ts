/**
 * RemoteMobManager: client-side renderer for server-authoritative mobs.
 *
 * Registers a binary handler on NetClient and turns MobSpawn,
 * MobUpdateBatch, and MobDespawn messages into shared thin-instance slots.
 */
import {
	CHICKEN_HIT_HALF,
	getChickenInstancePool,
} from "@/code/Entities/Mobs/Chicken";
import { COW_HIT_HALF, getCowInstancePool } from "@/code/Entities/Mobs/Cow";
import {
	FISH_COLORS,
	FISH_HIT_HALF,
	getFishInstancePool,
} from "@/code/Entities/Mobs/Fish";
import {
	getKrakenInstancePool,
	KRAKEN_HIT_HALF,
} from "@/code/Entities/Mobs/Kraken";
import { segmentMobHit } from "@/code/Entities/Mobs/MobHitTest";
import type {
	InstanceSlotHandle,
	MobInstancePool,
} from "@/code/Entities/Mobs/MobInstancePool";
import {
	registerMobLight,
	unregisterMobLight,
} from "@/code/Entities/Mobs/MobLighting";
import {
	getSheepInstancePool,
	SHEEP_COLORS,
	SHEEP_HIT_HALF,
} from "@/code/Entities/Mobs/Sheep";
import {
	getSquidInstancePool,
	SQUID_HIT_HALF,
} from "@/code/Entities/Mobs/Squid";
import {
	playLandingDust,
	playMobDamage,
} from "@/code/Maps/BlockBreakParticles";
import { MobTypeId } from "../Entities/MobConfig";
import type { NetClient } from "./NetClient";
import {
	BinaryDecoder,
	decodeMobDamage,
	decodeMobDespawn,
	decodeMobImpact,
	decodeMobSpawn,
} from "./protocol/encoder";
import { MessageType } from "./protocol/messages";

/** Server yaw byte, 0 to 255, converted to radians. */
const YAW_BYTE_TO_RAD = (Math.PI * 2) / 255;

/** Radians of walk phase accumulated per meter of horizontal travel. */
const WALK_STRIDE_FACTOR = 2;

/** Walk-phase decay rate per second while idle. */
const WALK_PHASE_DECAY = 6;

/** Squared movement threshold used before calculating a square root. */
const WALK_DISTANCE_EPSILON_SQ = 0.0001;

/** Phase below this value snaps back to rest. */
const WALK_PHASE_EPSILON = 0.01;

interface MutablePosition {
	x: number;
	y: number;
	z: number;
}

interface RemoteMobInstance {
	/** Stored so hit-test iteration does not need Map entry tuples. */
	id: number;

	slot: InstanceSlotHandle;
	pool: MobInstancePool;
	typeId: number;

	halfX: number;
	halfY: number;
	halfZ: number;

	currentX: number;
	currentY: number;
	currentZ: number;

	targetX: number;
	targetY: number;
	targetZ: number;

	currentYawRad: number;
	targetYawRad: number;

	walkPhase: number;
	prevX: number;
	prevZ: number;

	writtenX: number;
	writtenY: number;
	writtenZ: number;
	writtenYawRad: number;

	/**
	 * Reused by the lighting callback instead of creating a new position
	 * object every time MobLighting queries this mob.
	 */
	lightPosition: MutablePosition;

	/**
	 * Allocated once per mob because registerMobLight requires a callback.
	 * The callback returns lightPosition without allocating.
	 */
	getLightPosition: () => MutablePosition;
}

export class RemoteMobManager {
	private readonly mobs = new Map<number, RemoteMobInstance>();

	private readonly handler: (data: Uint8Array) => void;
	private readonly onDisconnected: () => void;

	private readonly decoder = new BinaryDecoder(new Uint8Array(0));

	constructor(private readonly client: NetClient) {
		/*
		 * These closures are allocated once per manager, rather than once per
		 * packet or frame.
		 */
		this.handler = (data) => {
			this.handleBinaryMessage(data);
		};

		this.onDisconnected = () => {
			this.clearAll();
		};

		client.addBinaryHandler(this.handler);
		client.addDisconnectListener(this.onDisconnected);
	}

	get size(): number {
		return this.mobs.size;
	}

	/**
	 * Sweep a segment against every remote mob and return the nearest hit.
	 * No object is allocated unless a hit is found.
	 */
	findSegmentHit(
		startX: number,
		startY: number,
		startZ: number,
		endX: number,
		endY: number,
		endZ: number,
	): { id: number; x: number; y: number; z: number } | null {
		let bestT = Number.POSITIVE_INFINITY;
		let bestMob: RemoteMobInstance | null = null;

		/*
		 * values() avoids the entry pair yielded by:
		 *
		 *     for (const [id, mob] of this.mobs)
		 *
		 * The mob stores its own id, so the pair is not needed.
		 */
		const iterator = this.mobs.values();

		for (let result = iterator.next(); !result.done; result = iterator.next()) {
			const mob = result.value;

			const t = segmentMobHit(
				startX,
				startY,
				startZ,
				endX,
				endY,
				endZ,
				mob.currentX,
				mob.currentY,
				mob.currentZ,
				mob.currentYawRad,
				mob.halfX,
				mob.halfY,
				mob.halfZ,
			);

			if (t !== null && t < bestT) {
				bestT = t;
				bestMob = mob;
			}
		}

		if (bestMob === null) {
			return null;
		}

		return {
			id: bestMob.id,
			x: startX + (endX - startX) * bestT,
			y: startY + (endY - startY) * bestT,
			z: startZ + (endZ - startZ) * bestT,
		};
	}

	/**
	 * Return the current interpolated mob transform.
	 *
	 * This result must remain a new object because external callers may retain
	 * or mutate it. Reusing a shared result object would change public behavior.
	 */
	getMobPosition(
		id: number,
	): { x: number; y: number; z: number; yaw: number } | null {
		const mob = this.mobs.get(id);

		if (mob === undefined) {
			return null;
		}

		return {
			x: mob.currentX,
			y: mob.currentY,
			z: mob.currentZ,
			yaw: mob.currentYawRad,
		};
	}

	/**
	 * Debug-only aggregation. Allocations are intentionally retained because
	 * the returned arrays and objects are public callback-visible data.
	 */
	getDebugStats(): {
		total: number;
		perType: { typeId: number; count: number }[];
	} {
		const byType = new Map<number, number>();
		const mobIterator = this.mobs.values();

		for (
			let result = mobIterator.next();
			!result.done;
			result = mobIterator.next()
		) {
			const typeId = result.value.typeId;
			byType.set(typeId, (byType.get(typeId) ?? 0) + 1);
		}

		const perType: { typeId: number; count: number }[] = [];
		const typeIterator = byType.entries();

		for (
			let result = typeIterator.next();
			!result.done;
			result = typeIterator.next()
		) {
			const entry = result.value;

			perType.push({
				typeId: entry[0],
				count: entry[1],
			});
		}

		return {
			total: this.mobs.size,
			perType,
		};
	}

	private handleBinaryMessage(data: Uint8Array): void {
		if (data.byteLength === 0) {
			return;
		}

		const messageType = data[0];

		switch (messageType) {
			case MessageType.MobDamage: {
				const damage = decodeMobDamage(data);
				const mob = this.mobs.get(damage.mobId);
				if (mob !== undefined) {
					playMobDamage(
						mob.currentX,
						mob.currentY,
						mob.currentZ,
						damage.damage,
					);
				}
				return;
			}

			case MessageType.MobImpact: {
				const impact = decodeMobImpact(data);
				playLandingDust(impact.x, impact.y, impact.z, impact.fallDistance);
				return;
			}

			case MessageType.MobSpawn: {
				/*
				 * This decoder currently returns an object. Removing that
				 * allocation safely would require decodeMobSpawnFrom(decoder)
				 * or decodeMobSpawnInto(scratch).
				 */
				const spawn = decodeMobSpawn(data);

				this.spawnMob(
					spawn.mobId,
					spawn.mobType,
					spawn.x,
					spawn.y,
					spawn.z,
					spawn.yaw,
				);

				return;
			}

			case MessageType.MobUpdateBatch:
				this.handleMobUpdateBatch(data);
				return;

			case MessageType.MobDespawn:
				this.despawnMob(decodeMobDespawn(data));
				return;

			default:
				return;
		}
	}

	/**
	 * Decode updates directly into local primitives.
	 *
	 * This avoids creating a batch array and avoids creating one
	 * MobUpdateBatchEntry object per mob.
	 */
	private handleMobUpdateBatch(data: Uint8Array): void {
		const decoder = this.decoder;
		decoder.setBuffer(data);

		decoder.readUint8();
		const count = decoder.readUint8();

		for (let i = 0; i < count; i++) {
			const mobId = decoder.readUint16();
			const x = decoder.readFloat32();
			const y = decoder.readFloat32();
			const z = decoder.readFloat32();
			const yaw = decoder.readUint8();

			const mob = this.mobs.get(mobId);

			if (mob === undefined) {
				continue;
			}

			mob.targetX = x;
			mob.targetY = y;
			mob.targetZ = z;
			mob.targetYawRad = yaw * YAW_BYTE_TO_RAD;
		}
	}

	private poolFor(typeId: number): MobInstancePool {
		switch (typeId) {
			case MobTypeId.Sheep:
				return getSheepInstancePool();

			case MobTypeId.Cow:
				return getCowInstancePool();

			case MobTypeId.Squid:
				return getSquidInstancePool();

			case MobTypeId.Fish:
				return getFishInstancePool();

			case MobTypeId.Kraken:
				return getKrakenInstancePool();

			case MobTypeId.Chicken:
			default:
				return getChickenInstancePool();
		}
	}

	private halfFor(
		typeId: number,
	): Readonly<{ x: number; y: number; z: number }> {
		switch (typeId) {
			case MobTypeId.Sheep:
				return SHEEP_HIT_HALF;

			case MobTypeId.Cow:
				return COW_HIT_HALF;

			case MobTypeId.Squid:
				return SQUID_HIT_HALF;

			case MobTypeId.Fish:
				return FISH_HIT_HALF;

			case MobTypeId.Kraken:
				return KRAKEN_HIT_HALF;

			case MobTypeId.Chicken:
			default:
				return CHICKEN_HIT_HALF;
		}
	}

	private spawnMob(
		id: number,
		typeId: number,
		x: number,
		y: number,
		z: number,
		yaw: number,
	): void {
		const existing = this.mobs.get(id);

		if (existing !== undefined) {
			existing.targetX = x;
			existing.targetY = y;
			existing.targetZ = z;
			existing.targetYawRad = yaw * YAW_BYTE_TO_RAD;
			return;
		}

		const pool = this.poolFor(typeId);
		const slot = pool.acquire(null);
		const half = this.halfFor(typeId);
		const yawRad = yaw * YAW_BYTE_TO_RAD;

		/*
		 * Keep RGB in primitives first. This avoids allocating the default
		 * [1, 1, 1] tuple and then replacing it for sheep or fish.
		 */
		let colorR = 1;
		let colorG = 1;
		let colorB = 1;

		if (typeId === MobTypeId.Sheep) {
			const colorCount = SHEEP_COLORS.length;
			const colorIndex = ((id % colorCount) + colorCount) % colorCount;
			const wool = SHEEP_COLORS[colorIndex]!.color;

			colorR = wool.r;
			colorG = wool.g;
			colorB = wool.b;
		} else if (typeId === MobTypeId.Fish) {
			const colorCount = FISH_COLORS.length;
			const colorIndex = ((id % colorCount) + colorCount) % colorCount;
			const scales = FISH_COLORS[colorIndex]!;

			colorR = scales.r;
			colorG = scales.g;
			colorB = scales.b;
		}

		pool.writeColor(slot, colorR, colorG, colorB, 0);
		pool.writeMatrix(slot, x, y, z, yawRad);

		const lightPosition: MutablePosition = { x, y, z };

		/*
		 * Assign in two steps because getLightPosition needs to close over the
		 * position object. The closure is allocated once for the mob and never
		 * allocates when invoked.
		 */
		const entry: RemoteMobInstance = {
			id,
			slot,
			pool,
			typeId,

			halfX: half.x,
			halfY: half.y,
			halfZ: half.z,

			currentX: x,
			currentY: y,
			currentZ: z,

			targetX: x,
			targetY: y,
			targetZ: z,

			currentYawRad: yawRad,
			targetYawRad: yawRad,

			walkPhase: 0,
			prevX: x,
			prevZ: z,
			writtenX: x,
			writtenY: y,
			writtenZ: z,
			writtenYawRad: yawRad,

			lightPosition,
			getLightPosition: () => lightPosition,
		};

		this.mobs.set(id, entry);

		/*
		 * baseColor remains a new tuple because MobLighting may retain it.
		 * Only one tuple is allocated, including for sheep and fish.
		 */
		registerMobLight({
			pool,
			slot,
			getPos: entry.getLightPosition,
			baseColor: [colorR, colorG, colorB],
		});
	}

	private updateMob(
		id: number,
		x: number,
		y: number,
		z: number,
		yaw: number,
	): void {
		const mob = this.mobs.get(id);

		if (mob === undefined) {
			return;
		}

		mob.targetX = x;
		mob.targetY = y;
		mob.targetZ = z;
		mob.targetYawRad = yaw * YAW_BYTE_TO_RAD;
	}

	private despawnMob(id: number): void {
		const mob = this.mobs.get(id);

		if (mob === undefined) {
			return;
		}

		this.mobs.delete(id);
		unregisterMobLight(mob.slot);
		mob.pool.release(mob.slot);
	}

	/**
	 * Interpolate every mob and update its thin-instance lane.
	 */
	update(deltaMs: number): void {
		if (this.mobs.size === 0) {
			return;
		}

		const dt = deltaMs * 0.001;
		const alpha = 1 - Math.exp(-dt * 12);
		const idlePhaseMultiplier = Math.max(0, 1 - WALK_PHASE_DECAY * dt);

		const iterator = this.mobs.values();

		for (let result = iterator.next(); !result.done; result = iterator.next()) {
			const mob = result.value;

			const currentX = mob.currentX + (mob.targetX - mob.currentX) * alpha;
			const currentY = mob.currentY + (mob.targetY - mob.currentY) * alpha;
			const currentZ = mob.currentZ + (mob.targetZ - mob.currentZ) * alpha;

			/*
			 * Preserve the original shortest-arc interpolation calculation.
			 */
			let yawDifference = mob.targetYawRad - mob.currentYawRad;

			yawDifference = Math.atan2(
				Math.sin(yawDifference),
				Math.cos(yawDifference),
			);

			const currentYawRad = mob.currentYawRad + yawDifference * alpha;

			const dx = currentX - mob.prevX;
			const dz = currentZ - mob.prevZ;
			const distanceSquared = dx * dx + dz * dz;

			if (distanceSquared > WALK_DISTANCE_EPSILON_SQ) {
				mob.walkPhase += Math.sqrt(distanceSquared) * WALK_STRIDE_FACTOR;
			} else {
				mob.walkPhase *= idlePhaseMultiplier;

				if (mob.walkPhase < WALK_PHASE_EPSILON) {
					mob.walkPhase = 0;
				}
			}

			mob.currentX = currentX;
			mob.currentY = currentY;
			mob.currentZ = currentZ;
			mob.currentYawRad = currentYawRad;

			mob.prevX = currentX;
			mob.prevZ = currentZ;

			/*
			 * Keep the lighting position synchronized without allocating a
			 * temporary object.
			 */
			const lightPosition = mob.lightPosition;
			lightPosition.x = currentX;
			lightPosition.y = currentY;
			lightPosition.z = currentZ;

			/*
			 * Preserve the existing behavior exactly. In particular, the walk
			 * phase is not written if the transform itself did not change.
			 */
			if (
				currentX === mob.writtenX &&
				currentY === mob.writtenY &&
				currentZ === mob.writtenZ &&
				currentYawRad === mob.writtenYawRad
			) {
				continue;
			}

			const pool = mob.pool;
			const slot = mob.slot;

			pool.writeMatrix(slot, currentX, currentY, currentZ, currentYawRad);

			pool.writeWalkPhase(slot, mob.walkPhase);

			mob.writtenX = currentX;
			mob.writtenY = currentY;
			mob.writtenZ = currentZ;
			mob.writtenYawRad = currentYawRad;
		}
	}

	/** Release every tracked mob's instance lane. */
	clearAll(): void {
		if (this.mobs.size === 0) {
			return;
		}

		const iterator = this.mobs.values();

		for (let result = iterator.next(); !result.done; result = iterator.next()) {
			const mob = result.value;

			unregisterMobLight(mob.slot);
			mob.pool.release(mob.slot);
		}

		this.mobs.clear();
	}

	dispose(): void {
		this.client.removeBinaryHandler(this.handler);
		this.client.removeDisconnectListener(this.onDisconnected);
		this.clearAll();
	}
}
