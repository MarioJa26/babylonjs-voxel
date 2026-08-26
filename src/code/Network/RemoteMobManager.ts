/**
 * RemoteMobManager — client-side renderer for server-authoritative mobs.
 *
 * Registers a binary handler on the NetClient (same pattern as
 * RemoteChunkProvider) and turns the MobSpawn / MobUpdateBatch / MobDespawn
 * messages into slots in the shared textured thin-instance pools (the same
 * meshes local Chicken/Sheep render through — one draw call per species).
 * The server owns all AI and positions; the client only smooths between the
 * ~10 Hz position broadcasts and repacks interpolated transforms into its
 * instance lanes.
 */

import {
	CHICKEN_HIT_HALF,
	getChickenInstancePool,
} from "@/code/Entities/Mobs/Chicken";
import { segmentMobHit } from "@/code/Entities/Mobs/MobHitTest";
import type {
	InstanceSlotHandle,
	MobInstancePool,
} from "@/code/Entities/Mobs/MobInstancePool";
import {
	getSheepInstancePool,
	SHEEP_HIT_HALF,
} from "@/code/Entities/Mobs/Sheep";
import { Color3 } from "@/code/Lib/Math";
import type { NetClient } from "./NetClient";
import {
	BinaryDecoder,
	decodeMobDespawn,
	decodeMobSpawn,
} from "./protocol/encoder";
import {
	MessageType,
	MobTypeId,
	type MobUpdateBatchEntry,
} from "./protocol/messages";

/** Server yaw byte (0-255) → radians (0..2π), matching MobSimulation. */
const YAW_BYTE_TO_RAD = (Math.PI * 2) / 255;

/** Radians of walk-swing phase accumulated per meter of horizontal travel. */
const WALK_STRIDE_FACTOR = 2.0;
/** Phase decay rate (per second) when idle — legs ease back to rest. */
const WALK_PHASE_DECAY = 6.0;

/** Default wool tint for remote sheep (server sends no color). */
const REMOTE_SHEEP_WOOL = new Color3(0.95, 0.95, 0.95);

interface RemoteMobInstance {
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
	/** Walk-swing phase (radians) advanced by horizontal travel distance. */
	walkPhase: number;
	prevX: number;
	prevZ: number;
	/** Last transform written to the instance lane — unchanged mobs skip the
	 * write entirely (no dirty marking, no GPU upload). NaN sentinels at
	 * spawn-time are replaced by real values immediately. */
	writtenX: number;
	writtenY: number;
	writtenZ: number;
	writtenYawRad: number;
}

export class RemoteMobManager {
	private readonly mobs = new Map<number, RemoteMobInstance>();
	private readonly handler: (data: Uint8Array) => void;

	private readonly decoder = new BinaryDecoder(new Uint8Array(0));

	private readonly mobUpdateScratch: MobUpdateBatchEntry[] = [];

	private readonly onDisconnected: () => void;

	constructor(private readonly client: NetClient) {
		this.handler = (data) => this.handleBinaryMessage(data);
		this.client.addBinaryHandler(this.handler);

		// Clear ghost mobs when the connection dies — server mob ids restart
		// per room instance, so stale entries would collide after reconnect.
		this.onDisconnected = () => this.clearAll();
		this.client.addDisconnectListener(this.onDisconnected);
	}

	get size(): number {
		return this.mobs.size;
	}

	/**
	 * Precise hit test: sweep the segment start→end against every remote
	 * mob's yaw-oriented body box. Returns the NEAREST hit (mob id + exact
	 * world-space impact point, derived from the entry parameter), or null
	 * on miss. Allocation-free until a hit is actually found.
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
		let bestId: number | null = null;
		let bestMob: RemoteMobInstance | null = null;

		for (const [id, mob] of this.mobs) {
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
				bestId = id;
				bestMob = mob;
			}
		}

		if (bestId === null || !bestMob) return null;

		return {
			id: bestId,
			x: startX + (endX - startX) * bestT,
			y: startY + (endY - startY) * bestT,
			z: startZ + (endZ - startZ) * bestT,
		};
	}

	/** Live interpolated transform of a server mob, or null once it despawns
	 * (lets stuck arrows stop following their target). */
	getMobPosition(
		id: number,
	): { x: number; y: number; z: number; yaw: number } | null {
		const mob = this.mobs.get(id);
		if (!mob) return null;
		return {
			x: mob.currentX,
			y: mob.currentY,
			z: mob.currentZ,
			yaw: mob.currentYawRad,
		};
	}

	getDebugStats(): {
		total: number;
		perType: { typeId: number; count: number }[];
	} {
		const byType = new Map<number, number>();
		for (const mob of this.mobs.values()) {
			byType.set(mob.typeId, (byType.get(mob.typeId) ?? 0) + 1);
		}

		const perType: { typeId: number; count: number }[] = [];
		for (const [typeId, count] of byType) {
			perType.push({ typeId, count });
		}

		return { total: this.mobs.size, perType };
	}

	private handleBinaryMessage(data: Uint8Array): void {
		if (data.byteLength < 1) return;

		switch (data[0]) {
			case MessageType.MobSpawn: {
				const spawn = decodeMobSpawn(data);
				this.spawnMob(
					spawn.mobId,
					spawn.mobType,
					spawn.x,
					spawn.y,
					spawn.z,
					spawn.yaw,
				);
				break;
			}

			case MessageType.MobUpdateBatch: {
				this.decoder.setBuffer(data);

				this.decoder.readUint8(); // type
				const count = this.decoder.readUint8();

				for (let i = 0; i < count; i++) {
					const mobId = this.decoder.readUint16();
					const x = this.decoder.readFloat32();
					const y = this.decoder.readFloat32();
					const z = this.decoder.readFloat32();
					const yaw = this.decoder.readUint8();

					this.updateMob(mobId, x, y, z, yaw);
				}

				break;
			}

			case MessageType.MobDespawn: {
				this.despawnMob(decodeMobDespawn(data));
				break;
			}
		}
	}

	private poolFor(typeId: number): MobInstancePool {
		return typeId === MobTypeId.Sheep
			? getSheepInstancePool()
			: getChickenInstancePool();
	}

	private spawnMob(
		id: number,
		typeId: number,
		x: number,
		y: number,
		z: number,
		yaw: number,
	): void {
		// A duplicate spawn (e.g. a re-sent join snapshot) just refreshes state.
		if (this.mobs.has(id)) {
			this.updateMob(id, x, y, z, yaw);
			return;
		}

		const pool = this.poolFor(typeId);
		const slot = pool.acquire(null);
		// Both pools now use thin-instance colors: walk phase is packed into
		// the alpha channel, RGB carries the tint (white for chicken, wool for
		// sheep).
		if (typeId === MobTypeId.Sheep) {
			pool.writeColor(
				slot,
				REMOTE_SHEEP_WOOL.r,
				REMOTE_SHEEP_WOOL.g,
				REMOTE_SHEEP_WOOL.b,
				0,
			);
		} else {
			pool.writeColor(slot, 1, 1, 1, 0);
		}

		// Hit box matches the shared species model (see Chicken/Sheep exports).
		const half = typeId === MobTypeId.Sheep ? SHEEP_HIT_HALF : CHICKEN_HIT_HALF;

		const yawRad = yaw * YAW_BYTE_TO_RAD;
		pool.writeMatrix(slot, x, y, z, yawRad);

		this.mobs.set(id, {
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
			// Matches the just-written matrix, so the next update() skips the
			// redundant write until the mob actually moves.
			writtenX: x,
			writtenY: y,
			writtenZ: z,
			writtenYawRad: yawRad,
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
		if (!mob) return;
		mob.targetX = x;
		mob.targetY = y;
		mob.targetZ = z;
		mob.targetYawRad = yaw * YAW_BYTE_TO_RAD;
	}

	private despawnMob(id: number): void {
		const mob = this.mobs.get(id);
		if (!mob) return;

		this.mobs.delete(id);
		mob.pool.release(mob.slot);
	}

	/**
	 * Interpolate every remote mob toward its latest server state and repack
	 * the result into its instance lane. Called once per frame from the game
	 * loop. Exponential smoothing gives a stable catch-up that matches the
	 * server's 10 Hz position cadence.
	 */
	update(deltaMs: number): void {
		if (this.mobs.size === 0) return;

		const dt = deltaMs * 0.001;
		const alpha = 1 - Math.exp(-dt * 12);

		for (const mob of this.mobs.values()) {
			mob.currentX += (mob.targetX - mob.currentX) * alpha;
			mob.currentY += (mob.targetY - mob.currentY) * alpha;
			mob.currentZ += (mob.targetZ - mob.currentZ) * alpha;

			// Shortest-arc yaw interpolation.
			let diff = mob.targetYawRad - mob.currentYawRad;
			diff = Math.atan2(Math.sin(diff), Math.cos(diff));
			mob.currentYawRad += diff * alpha;

			// Advance walk-swing phase by horizontal distance traveled.
			const dx = mob.currentX - mob.prevX;
			const dz = mob.currentZ - mob.prevZ;
			const distSq = dx * dx + dz * dz;
			if (distSq > 0.0001) {
				mob.walkPhase += Math.sqrt(distSq) * WALK_STRIDE_FACTOR;
			} else {
				mob.walkPhase *= Math.max(0, 1 - WALK_PHASE_DECAY * dt);
				if (mob.walkPhase < 0.01) mob.walkPhase = 0;
			}
			mob.prevX = mob.currentX;
			mob.prevZ = mob.currentZ;

			// Skip the lane write (and its dirty marking / GPU upload) while
			// the interpolated transform hasn't changed — stationary mobs cost
			// nothing per frame.
			if (
				mob.currentX === mob.writtenX &&
				mob.currentY === mob.writtenY &&
				mob.currentZ === mob.writtenZ &&
				mob.currentYawRad === mob.writtenYawRad
			) {
				continue;
			}

			mob.pool.writeMatrix(
				mob.slot,
				mob.currentX,
				mob.currentY,
				mob.currentZ,
				mob.currentYawRad,
			);
			mob.pool.writeWalkPhase(mob.slot, mob.walkPhase);
			mob.writtenX = mob.currentX;
			mob.writtenY = mob.currentY;
			mob.writtenZ = mob.currentZ;
			mob.writtenYawRad = mob.currentYawRad;
		}
	}

	/** Release every tracked remote mob's instance lane. */
	clearAll(): void {
		for (const mob of this.mobs.values()) {
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
