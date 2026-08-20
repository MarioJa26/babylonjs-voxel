/**
 * RemoteItemManager — client-side renderer for server-authoritative items.
 *
 * Registers a binary handler on the NetClient (same pattern as
 * RemoteMobManager) and turns the ItemSpawn / ItemUpdateBatch / ItemDespawn
 * messages into interpolated DroppedItem meshes. The server owns all item
 * positions and lifetimes; the client extrapolates between the ~10 Hz
 * position broadcasts using server-sent velocity and drives pickup back
 * to the server.
 */

import { DroppedItem } from "../Player/Inventory/DroppedItem";
import { Item } from "../Player/Inventory/Item";
import type { NetClient } from "./NetClient";
import {
	BinaryDecoder,
	decodeItemDespawn,
	decodeItemSpawn,
} from "./protocol/encoder";
import { MessageType } from "./protocol/messages";

/** Time since last server update before we stop extrapolating (seconds). */
const EXTRAPOLATION_WINDOW = 0.04;

interface RemoteItemInstance {
	dropped: DroppedItem;
	targetX: number;
	targetY: number;
	targetZ: number;
	currentX: number;
	currentY: number;
	currentZ: number;
	/** Server-sent velocity for extrapolation. */
	velX: number;
	velY: number;
	velZ: number;
	/** Timestamp (performance.now) of last position update from server. */
	lastUpdateMs: number;
}

export class RemoteItemManager {
	private readonly items = new Map<number, RemoteItemInstance>();
	private readonly decoder = new BinaryDecoder(new Uint8Array(0));
	private readonly handler: (data: Uint8Array) => void;

	constructor(private readonly client: NetClient) {
		this.handler = (data) => this.handleBinaryMessage(data);
		this.client.addBinaryHandler(this.handler);
	}

	get size(): number {
		return this.items.size;
	}

	private handleBinaryMessage(data: Uint8Array): void {
		if (data.byteLength < 1) return;

		switch (data[0]) {
			case MessageType.ItemSpawn: {
				const spawn = decodeItemSpawn(data);
				this.spawnItem(
					spawn.id,
					spawn.itemId,
					spawn.stackSize,
					spawn.x,
					spawn.y,
					spawn.z,
				);
				break;
			}

			case MessageType.ItemUpdateBatch: {
				this.decoder.setBuffer(data);
				this.decoder.readUint8(); // type
				const count = this.decoder.readUint8();
				const now = performance.now();

				for (let i = 0; i < count; i++) {
					const id = this.decoder.readUint32();
					const x = this.decoder.readFloat32();
					const y = this.decoder.readFloat32();
					const z = this.decoder.readFloat32();
					const vx = this.decoder.readFloat32();
					const vy = this.decoder.readFloat32();
					const vz = this.decoder.readFloat32();
					this.updateItem(id, x, y, z, vx, vy, vz, now);
				}
				break;
			}

			case MessageType.ItemDespawn: {
				this.despawnItem(decodeItemDespawn(data));
				break;
			}
		}
	}

	private spawnItem(
		id: number,
		itemId: number,
		stackSize: number,
		x: number,
		y: number,
		z: number,
	): void {
		// A duplicate spawn (e.g. a re-sent join snapshot) just refreshes state.
		const existing = this.items.get(id);
		if (existing) {
			existing.targetX = x;
			existing.targetY = y;
			existing.targetZ = z;
			existing.currentX = x;
			existing.currentY = y;
			existing.currentZ = z;
			existing.dropped.setRemotePosition(x, y, z);
			return;
		}

		let item: Item;
		try {
			item = Item.createById(itemId);
		} catch {
			// Unknown item id — the server is authoritative, but we can't
			// render something we don't have a definition for. Skip it.
			console.warn(`[RemoteItemManager] Unknown item id ${itemId}`);
			return;
		}
		item.stackSize = stackSize;

		const dropped = new DroppedItem(item, x, y, z);
		dropped.setRemote(id, (instanceId) =>
			this.client.sendItemPickup(instanceId),
		);

		this.items.set(id, {
			dropped,
			targetX: x,
			targetY: y,
			targetZ: z,
			currentX: x,
			currentY: y,
			currentZ: z,
			velX: 0,
			velY: 0,
			velZ: 0,
			lastUpdateMs: performance.now(),
		});
	}

	private updateItem(
		id: number,
		x: number,
		y: number,
		z: number,
		vx: number,
		vy: number,
		vz: number,
		now: number,
	): void {
		const inst = this.items.get(id);
		if (!inst) return;
		inst.targetX = x;
		inst.targetY = y;
		inst.targetZ = z;
		inst.velX = vx;
		inst.velY = vy;
		inst.velZ = vz;
		inst.lastUpdateMs = now;
	}

	private despawnItem(id: number): void {
		const inst = this.items.get(id);
		if (!inst) return;
		this.items.delete(id);
		inst.dropped.dispose();
	}

	/**
	 * Extrapolate + smooth every remote item toward its predicted server
	 * state. Called once per frame from the game loop.
	 *
	 * Between server updates the client extrapolates using the server-sent
	 * velocity (clamped to a short window so stale velocity doesn't cause
	 * runaway drift). Downward velocity is NOT extrapolated to prevent
	 * items from phasing through blocks between server updates. When a
	 * fresh update arrives the exponential smoothing pulls the visual
	 * position toward the new target.
	 */
	update(deltaMs: number): void {
		if (this.items.size === 0) return;

		const dt = deltaMs * 0.001;
		const now = performance.now();
		const alpha = 1 - Math.exp(-dt * 25);

		for (const inst of this.items.values()) {
			// Time since last server update.
			const age = (now - inst.lastUpdateMs) * 0.001;
			const t = Math.min(age, EXTRAPOLATION_WINDOW);

			// Extrapolate horizontally and upward only. Downward
			// extrapolation causes items to phase through blocks
			// between server position updates.
			const extrapolatedX = inst.targetX + inst.velX * t;
			const extrapolatedY = inst.targetY + (inst.velY > 0 ? inst.velY * t : 0);
			const extrapolatedZ = inst.targetZ + inst.velZ * t;

			// Smooth toward the extrapolated target.
			inst.currentX += (extrapolatedX - inst.currentX) * alpha;
			inst.currentY += (extrapolatedY - inst.currentY) * alpha;
			inst.currentZ += (extrapolatedZ - inst.currentZ) * alpha;
			inst.dropped.setRemotePosition(
				inst.currentX,
				inst.currentY,
				inst.currentZ,
			);
		}
	}

	dispose(): void {
		this.client.removeBinaryHandler(this.handler);
		for (const inst of this.items.values()) {
			inst.dropped.dispose();
		}
		this.items.clear();
	}
}
