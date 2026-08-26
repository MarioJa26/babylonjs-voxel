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
	 * world-space impact point), or null on miss.
	 */
	findSegmentHit(
		startX: number,
		startY: number,
		startZ: number,
		endX: number,
		endY: number,
		endZ: number,
	): { id: number; x: number; y: number; z: number } | null {
		let bestId: number | null = null;
		let bestT = Number.POSITIVE_INFINITY;
		let bestLx = 0;
		let bestLy = 0;
		let bestLz = 0;
		let bestMob: RemoteMobInstance | null = null;

		for (const [id, mob] of this.mobs) {
			const hit = segmentMobHit(
				startX,
				startY,
				startZ,
				endX,
				endY,
				endZ,
				{ x: mob.currentX, y: mob.currentY, z: mob.currentZ },
				mob.currentYawRad,
				{ x: mob.halfX, y: mob.halfY, z: mob.halfZ },
			);

			if (hit && hit.t < bestT) {
				bestT = hit.t;
				bestId = id;
				bestLx = hit.lx;
				bestLy = hit.ly;
				bestLz = hit.lz;
				bestMob = mob;
			}
		}

		if (bestId === null || !bestMob) return null;

		const c = Math.cos(bestMob.currentYawRad);
		const s = Math.sin(bestMob.currentYawRad);
		return {
			id: bestId,
			x: bestMob.currentX + c * bestLx + s * bestLz,
			y: bestMob.currentY + bestLy,
			z: bestMob.currentZ - s * bestLx + c * bestLz,
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
		if (typeId === MobTypeId.Sheep) {
			pool.writeColor(
				slot,
				REMOTE_SHEEP_WOOL.r,
				REMOTE_SHEEP_WOOL.g,
				REMOTE_SHEEP_WOOL.b,
			);
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

			mob.pool.writeMatrix(
				mob.slot,
				mob.currentX,
				mob.currentY,
				mob.currentZ,
				mob.currentYawRad,
			);
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
