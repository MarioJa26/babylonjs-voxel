import type { Scene } from "@babylonjs/core";
import { onBeforeRender, type Vec3 } from "@babylonjs/lite";
import {
	getBlockByWorldCoords,
	getLightByWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import type { Mob, MobRegistry, MobSpawnConfig } from "./Mobs/Mob";

const SPAWN_MIN_RADIUS = 24;
const SPAWN_MAX_RADIUS = 96;
const DESPAWN_INSTANT_RADIUS = 128;
const DESPAWN_INSTANT_RADIUS_SQ =
	DESPAWN_INSTANT_RADIUS * DESPAWN_INSTANT_RADIUS;
const DESPAWN_GRADUAL_INNER = 32;
const DESPAWN_GRADUAL_INNER_SQ = DESPAWN_GRADUAL_INNER * DESPAWN_GRADUAL_INNER;
const DESPAWN_GRADUAL_OUTER = 128;
const DESPAWN_CHANCE_PER_SEC = 0.3;
const SPAWN_CHECK_INTERVAL = 3000;
const MIN_SPAWN_HEIGHT = 1;
const MAX_SPAWN_HEIGHT = 200;

const _mobSnapshot: Mob[] = [];

export class SpawnCoordinator {
	#scene: Scene;
	#getPlayerPosition: () => Vec3;
	#lastSpawnCheck = 0;
	#disposed = false;
	readonly #registry: MobRegistry;

	constructor(
		scene: Scene,
		getPlayerPosition: () => Vec3,
		registry: MobRegistry,
	) {
		this.#scene = scene;
		this.#getPlayerPosition = getPlayerPosition;
		this.#registry = registry;

		onBeforeRender(this.#scene, () => {
			if (this.#disposed) return;
			this.#tick();
		});
	}

	get registry(): MobRegistry {
		return this.#registry;
	}

	dispose(): void {
		this.#disposed = true;
	}

	#tick(): void {
		const now = performance.now();
		if (now - this.#lastSpawnCheck < SPAWN_CHECK_INTERVAL) return;
		this.#lastSpawnCheck = now;

		const playerPos = this.#getPlayerPosition();
		this.#updatePlayerPositions(playerPos);
		this.#despawnDistant(playerPos);
		this.#trySpawn(playerPos);
	}

	#updatePlayerPositions(playerPos: Vec3): void {
		for (const mob of this.#registry.getAllMobs()) {
			mob.setPlayerPosition(playerPos);
		}
	}

	#despawnDistant(playerPos: Vec3): void {
		_mobSnapshot.length = 0;
		for (const mob of this.#registry.getAllMobs()) {
			_mobSnapshot.push(mob);
		}
		for (let i = 0; i < _mobSnapshot.length; i++) {
			const mob = _mobSnapshot[i];
			if (!mob) continue;
			const config = this.#registry.getConfig(mob.mobType);
			if (config && config.despawnable === false) continue;

			const dx = mob.position.x - playerPos.x;
			const dy = mob.position.y - playerPos.y;
			const dz = mob.position.z - playerPos.z;
			const distSq = dx * dx + dy * dy + dz * dz;
			if (distSq > DESPAWN_INSTANT_RADIUS_SQ) {
				mob.dispose();
				continue;
			}
			if (distSq > DESPAWN_GRADUAL_INNER_SQ) {
				const dist = Math.sqrt(distSq);
				const t =
					(dist - DESPAWN_GRADUAL_INNER) /
					(DESPAWN_GRADUAL_OUTER - DESPAWN_GRADUAL_INNER);
				if (
					Math.random() <
					DESPAWN_CHANCE_PER_SEC * t * (SPAWN_CHECK_INTERVAL / 1000)
				) {
					mob.dispose();
				}
			}
		}
	}

	#trySpawn(playerPos: Vec3): void {
		const totalCap = this.#getTotalCap();
		if (this.#registry.getTotalCount() >= totalCap) return;

		const attempts = 3;
		for (let i = 0; i < attempts; i++) {
			if (this.#registry.getTotalCount() >= totalCap) return;

			const config = this.#registry.pickSpawnType();
			if (!config) return;

			const pos = this.#findSpawnPosition(playerPos, config);
			if (pos) {
				const mob = config.factory(pos.x, pos.y, pos.z, this.#scene);
				this.#registry.addMob(mob);
			}
		}
	}

	#getTotalCap(): number {
		let cap = 0;
		for (const config of this.#registry.getConfigs()) {
			cap += config.maxCount;
		}
		return cap;
	}

	#findSpawnPosition(
		playerPos: Vec3,
		config: MobSpawnConfig,
	): { x: number; y: number; z: number } | null {
		const angle = Math.random() * Math.PI * 2;
		const dist =
			SPAWN_MIN_RADIUS + Math.random() * (SPAWN_MAX_RADIUS - SPAWN_MIN_RADIUS);

		const wx = Math.floor(playerPos.x + Math.cos(angle) * dist);
		const wz = Math.floor(playerPos.z + Math.sin(angle) * dist);

		_mobSnapshot.length = 0;
		for (const mob of this.#registry.getAllMobs()) {
			_mobSnapshot.push(mob);
		}

		for (let wy = MAX_SPAWN_HEIGHT; wy >= MIN_SPAWN_HEIGHT; wy--) {
			const blockBelow = getBlockByWorldCoords(wx, wy, wz);
			const blockAbove = getBlockByWorldCoords(wx, wy + 1, wz);

			if (blockBelow === config.spawnBlockId && blockAbove === 0) {
				const light = getLightByWorldCoords(wx, wy + 1, wz);
				const skyLight = (light >> 4) & 0xf;
				if (skyLight < 8) continue;

				const spawnY = wy + 1;
				let tooClose = false;
				for (let i = 0; i < _mobSnapshot.length; i++) {
					const existing = _mobSnapshot[i];
					if (!existing) continue;
					const dx = existing.position.x - wx;
					const dz = existing.position.z - wz;
					if (dx * dx + dz * dz < 4) {
						tooClose = true;
						break;
					}
				}
				if (tooClose) continue;

				return {
					x: wx + 0.5,
					y: spawnY + (config.spawnYOffset ?? 0.2),
					z: wz + 0.5,
				};
			}
		}

		return null;
	}
}
