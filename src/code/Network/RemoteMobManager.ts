/**
 * RemoteMobManager — client-side renderer for server-authoritative mobs.
 *
 * Registers a binary handler on the NetClient (same pattern as
 * RemoteChunkProvider) and turns the MobSpawn / MobUpdateBatch / MobDespawn
 * messages into interpolated box meshes. The server owns all AI and positions;
 * the client only smooths between the ~10 Hz position broadcasts.
 *
 * Meshes are pooled per mob type so despawning and respawning doesn't churn
 * GPU buffers, and geometry/material are shared via createBoxMobMesh's caches.
 */

import { addToScene, type Mesh, removeFromScene } from "@babylonjs/lite";
import { createBoxMobMesh } from "@/code/Entities/Mobs/MobMesh";
import { Color3 } from "@/code/Lib/Math";
import { Map1 } from "@/code/Maps/Map1";
import type { NetClient } from "./NetClient";
import {
	decodeMobDespawn,
	decodeMobSpawn,
	decodeMobUpdateBatch,
} from "./protocol/encoder";
import { MessageType, MobTypeId } from "./protocol/messages";

interface RemoteMobConfig {
	width: number;
	height: number;
	depth: number;
	color: Color3;
	meshName: string;
}

/** Per-type visual config — mirrors the server's MobSimulation species. */
const REMOTE_MOB_CONFIGS: Record<number, RemoteMobConfig> = {
	[MobTypeId.Chicken]: {
		width: 0.5,
		height: 0.4,
		depth: 0.3,
		color: Color3.White(),
		meshName: "remoteChicken",
	},
	[MobTypeId.Sheep]: {
		width: 0.6,
		height: 0.6,
		depth: 0.9,
		color: new Color3(0.95, 0.95, 0.95),
		meshName: "remoteSheep",
	},
};

/** Server yaw byte (0-255) → radians (0..2π), matching MobSimulation. */
const YAW_BYTE_TO_RAD = (Math.PI * 2) / 255;

interface RemoteMobInstance {
	mesh: Mesh;
	typeId: number;
	targetX: number;
	targetY: number;
	targetZ: number;
	targetYawRad: number;
	currentYawRad: number;
}

export class RemoteMobManager {
	private readonly mobs = new Map<number, RemoteMobInstance>();
	// Freed meshes per type id, reused on the next spawn of that type.
	private readonly pool = new Map<number, Mesh[]>();
	private readonly handler: (data: Uint8Array) => void;

	constructor(private readonly client: NetClient) {
		this.handler = (data) => this.handleBinaryMessage(data);
		this.client.addBinaryHandler(this.handler);
	}

	get size(): number {
		return this.mobs.size;
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
				const entries = decodeMobUpdateBatch(data);
				for (let i = 0; i < entries.length; i++) {
					const e = entries[i];
					this.updateMob(e.mobId, e.x, e.y, e.z, e.yaw);
				}
				break;
			}

			case MessageType.MobDespawn: {
				this.despawnMob(decodeMobDespawn(data));
				break;
			}
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
		// A duplicate spawn (e.g. a re-sent join snapshot) just refreshes state.
		if (this.mobs.has(id)) {
			this.updateMob(id, x, y, z, yaw);
			return;
		}

		const config =
			REMOTE_MOB_CONFIGS[typeId] ?? REMOTE_MOB_CONFIGS[MobTypeId.Chicken];

		let mesh = this.pool.get(typeId)?.pop();
		if (!mesh) {
			mesh = createBoxMobMesh(
				config.meshName,
				config.width,
				config.height,
				config.depth,
				config.color,
				`${config.meshName}Mat`,
			);
			// Register the mesh in the scene exactly once. In this Babylon lite
			// build removeFromScene disposes the mesh, so we keep it resident and
			// toggle visibility with `visible` instead of add/remove.
			addToScene(Map1.mainScene, mesh);
		}

		const yawRad = yaw * YAW_BYTE_TO_RAD;
		mesh.position.set(x, y, z);
		mesh.rotation.y = yawRad;
		mesh.visible = true;

		this.mobs.set(id, {
			mesh,
			typeId,
			targetX: x,
			targetY: y,
			targetZ: z,
			targetYawRad: yawRad,
			currentYawRad: yawRad,
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
		mob.mesh.visible = false;

		let pool = this.pool.get(mob.typeId);
		if (!pool) {
			pool = [];
			this.pool.set(mob.typeId, pool);
		}
		pool.push(mob.mesh);
	}

	/**
	 * Interpolate every remote mob toward its latest server state. Called once
	 * per frame from the game loop. Exponential smoothing gives a stable
	 * catch-up that matches the server's 10 Hz position cadence.
	 */
	update(deltaMs: number): void {
		if (this.mobs.size === 0) return;

		const dt = deltaMs * 0.001;
		const alpha = 1 - Math.exp(-dt * 12);

		for (const mob of this.mobs.values()) {
			const mesh = mob.mesh;

			mesh.position.x += (mob.targetX - mesh.position.x) * alpha;
			mesh.position.y += (mob.targetY - mesh.position.y) * alpha;
			mesh.position.z += (mob.targetZ - mesh.position.z) * alpha;

			// Shortest-arc yaw interpolation.
			let diff = mob.targetYawRad - mob.currentYawRad;
			diff = Math.atan2(Math.sin(diff), Math.cos(diff));
			mob.currentYawRad += diff * alpha;
			mesh.rotation.y = mob.currentYawRad;
		}
	}

	dispose(): void {
		this.client.removeBinaryHandler(this.handler);

		for (const mob of this.mobs.values()) {
			removeFromScene(Map1.mainScene, mob.mesh);
		}
		// Pooled meshes are still registered in the scene; free them too.
		for (const list of this.pool.values()) {
			for (const mesh of list) {
				removeFromScene(Map1.mainScene, mesh);
			}
		}
		this.mobs.clear();
		this.pool.clear();
	}
}
