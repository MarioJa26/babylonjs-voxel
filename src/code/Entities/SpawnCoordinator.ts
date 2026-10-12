import { onBeforeRender, type SceneContext, type Vec3 } from "@babylonjs/lite";
import { frameProfiler } from "@/code/Lib/FrameProfiler";
import { Map1 } from "../Maps/Map1";
import {
	getLightByWorldCoords,
	type ResolvedBlock,
	resolveBlockAtWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import { SETTING_PARAMS } from "../World/SETTINGS_PARAMS";
import { BlockType } from "../World/Texture/BlockType";
import { isNightTimeFraction } from "./MobConfig";
import { Bird } from "./Mobs/Bird";
import type { Mob, MobRegistry, MobSpawnConfig } from "./Mobs/Mob";

const SPAWN_MIN_RADIUS = 24;
const SPAWN_MAX_RADIUS = 96;
const SPAWN_RADIUS_RANGE = SPAWN_MAX_RADIUS - SPAWN_MIN_RADIUS;

const DESPAWN_INSTANT_RADIUS = 128;
const DESPAWN_INSTANT_RADIUS_SQ =
	DESPAWN_INSTANT_RADIUS * DESPAWN_INSTANT_RADIUS;

const DESPAWN_GRADUAL_INNER = 32;
const DESPAWN_GRADUAL_INNER_SQ = DESPAWN_GRADUAL_INNER * DESPAWN_GRADUAL_INNER;

const DESPAWN_GRADUAL_OUTER = 128;
const DESPAWN_GRADUAL_RANGE = DESPAWN_GRADUAL_OUTER - DESPAWN_GRADUAL_INNER;

const DESPAWN_CHANCE_PER_SEC = 0.3;
const SPAWN_CHECK_INTERVAL = 3_000;

const DESPAWN_CHECK_CHANCE_SCALE =
	DESPAWN_CHANCE_PER_SEC * (SPAWN_CHECK_INTERVAL / 1_000);

const MIN_SPAWN_HEIGHT = 1;
const MAX_SPAWN_HEIGHT = 200;

const FLOCK_ALTITUDE_MIN = 12;
const FLOCK_ALTITUDE_MAX = 20;
const FLOCK_ALTITUDE_RANGE = FLOCK_ALTITUDE_MAX - FLOCK_ALTITUDE_MIN;

const NATURAL_SPAWN_ATTEMPTS = 3;
const TWO_PI = Math.PI * 2;

const SEA_LEVEL = 62;

/**
 * Shared scratch arrays.
 *
 * SpawnCoordinator runs on the main thread, so one module-level snapshot is
 * sufficient. The snapshot is rebuilt after despawning and then reused by all
 * spawn-position searches during that cycle.
 */
const mobSnapshot: Mob[] = [];

/**
 * Voxel lookup snapshots must be copied because resolveBlockAtWorldCoords()
 * returns a shared scratch object whose fields are overwritten by the next
 * lookup.
 */
const lowerBlockScratch: ResolvedBlock = {
	blockId: 0,
	blockState: 0,
	loaded: false,
	unloaded: false,
};

function copyResolvedBlock(
	source: ResolvedBlock,
	destination: ResolvedBlock,
): void {
	destination.blockId = source.blockId;
	destination.blockState = source.blockState;
	destination.loaded = source.loaded;
	destination.unloaded = source.unloaded;
}

function isNightNow(): boolean {
	const environment = Map1.environment;

	if (environment === null || environment === undefined) {
		return true;
	}

	return isNightTimeFraction(
		environment.getTimeOfDayMs() / SETTING_PARAMS.DAY_DURATION_MS,
	);
}

function randomSpawnCoordinate(playerPosition: Vec3): { x: number; z: number } {
	const angle = Math.random() * TWO_PI;
	const distance = SPAWN_MIN_RADIUS + Math.random() * SPAWN_RADIUS_RANGE;

	return {
		x: Math.floor(playerPosition.x + Math.cos(angle) * distance),
		z: Math.floor(playerPosition.z + Math.sin(angle) * distance),
	};
}

export class SpawnCoordinator {
	readonly #scene: SceneContext;
	readonly #getPlayerPosition: () => Vec3;
	readonly #registry: MobRegistry;

	/**
	 * Configured total cap is normally static for the lifetime of the registry,
	 * so compute it once rather than scanning every config every spawn cycle.
	 */
	readonly #totalCap: number;

	#lastSpawnCheck = 0;
	#disposed = false;

	public constructor(
		scene: SceneContext,
		getPlayerPosition: () => Vec3,
		registry: MobRegistry,
	) {
		this.#scene = scene;
		this.#getPlayerPosition = getPlayerPosition;
		this.#registry = registry;

		let totalCap = 0;

		for (const config of registry.getConfigs()) {
			totalCap += config.maxCount;
		}

		this.#totalCap = totalCap;

		onBeforeRender(scene, (): void => {
			if (this.#disposed) {
				return;
			}

			frameProfiler.begin("mobSpawn");

			try {
				this.#tick();
			} finally {
				frameProfiler.end("mobSpawn");
			}
		});
	}

	public get registry(): MobRegistry {
		return this.#registry;
	}

	public dispose(): void {
		this.#disposed = true;
	}

	#tick(): void {
		const nowMs = performance.now();

		if (nowMs - this.#lastSpawnCheck < SPAWN_CHECK_INTERVAL) {
			return;
		}

		this.#lastSpawnCheck = nowMs;

		const playerPosition = this.#getPlayerPosition();

		/*
		 * Updating player references and despawning share the same initial
		 * registry traversal.
		 */
		this.#updateAndDespawnMobs(playerPosition);

		/*
		 * Rebuild once after disposal. All spawn attempts in this cycle use the
		 * same snapshot, with newly spawned mobs appended as they are created.
		 */
		this.#buildMobSnapshot();
		this.#trySpawn(playerPosition);
	}

	#updateAndDespawnMobs(playerPosition: Vec3): void {
		const registry = this.#registry;
		const playerX = playerPosition.x;
		const playerY = playerPosition.y;
		const playerZ = playerPosition.z;

		mobSnapshot.length = 0;

		/*
		 * Snapshot before disposing because disposal can mutate the registry.
		 */
		for (const mob of registry.getAllMobs()) {
			mobSnapshot.push(mob);
		}

		for (let index = 0; index < mobSnapshot.length; index++) {
			const mob = mobSnapshot[index];

			mob.setPlayerPosition(playerPosition);

			const config = registry.getConfig(mob.mobType);

			if (config?.despawnable === false) {
				continue;
			}

			const position = mob.position;
			const dx = position.x - playerX;
			const dy = position.y - playerY;
			const dz = position.z - playerZ;

			const distanceSq = dx * dx + dy * dy + dz * dz;

			if (distanceSq > DESPAWN_INSTANT_RADIUS_SQ) {
				mob.dispose();
				continue;
			}

			if (distanceSq <= DESPAWN_GRADUAL_INNER_SQ) {
				continue;
			}

			const distance = Math.sqrt(distanceSq);
			const normalizedDistance =
				(distance - DESPAWN_GRADUAL_INNER) / DESPAWN_GRADUAL_RANGE;

			if (Math.random() < DESPAWN_CHECK_CHANCE_SCALE * normalizedDistance) {
				mob.dispose();
			}
		}
	}

	#buildMobSnapshot(): void {
		mobSnapshot.length = 0;

		for (const mob of this.#registry.getAllMobs()) {
			mobSnapshot.push(mob);
		}
	}

	#trySpawn(playerPosition: Vec3): void {
		const registry = this.#registry;
		const totalCap = this.#totalCap;

		let naturalTotal = registry.getNaturalTotal();

		if (naturalTotal >= totalCap) {
			return;
		}

		const night = isNightNow();

		for (let attempt = 0; attempt < NATURAL_SPAWN_ATTEMPTS; attempt++) {
			if (naturalTotal >= totalCap) {
				return;
			}

			const config = registry.pickSpawnType();

			if (config === null || config === undefined) {
				return;
			}

			if (config.nightSpawn && !night) {
				continue;
			}

			if (config.daySpawn && night) {
				continue;
			}

			if (config.flockSize !== undefined && config.mobType === "bird") {
				const position = this.#findAirSpawnPosition(playerPosition);

				if (position === null) {
					continue;
				}

				const flock = config.flockSize;
				const requestedCount =
					flock.min + Math.floor(Math.random() * (flock.max - flock.min + 1));

				/*
				 * Do not intentionally exceed the natural cap with a flock.
				 */
				const available = totalCap - naturalTotal;

				const count = Math.min(requestedCount, available);

				if (count <= 0) {
					return;
				}

				Bird.createFlock(
					position.x,
					position.y,
					position.z,
					this.#scene,
					count,
					registry,
				);

				naturalTotal += count;

				/*
				 * Rebuild because Bird.createFlock owns mob construction and
				 * registration, so its created objects are not returned here.
				 */
				this.#buildMobSnapshot();
				continue;
			}

			const position = this.#findGroundSpawnPosition(playerPosition, config);

			if (position === null) {
				continue;
			}

			const mob = config.factory(
				position.x,
				position.y,
				position.z,
				this.#scene,
			);

			registry.addMob(mob);
			mobSnapshot.push(mob);
			naturalTotal++;
		}
	}

	#findGroundSpawnPosition(
		playerPosition: Vec3,
		config: MobSpawnConfig,
	): { x: number; y: number; z: number } | null {
		const coordinate = randomSpawnCoordinate(playerPosition);

		const worldX = coordinate.x;
		const worldZ = coordinate.z;

		if (config.spawnBlockId === BlockType.Water) {
			return this.#findWaterSpawnPosition(worldX, worldZ, config);
		}

		/*
		 * Prime the rolling upper sample. For each descending Y:
		 *
		 *   lower = block at Y
		 *   upper = previous lower, block at Y + 1
		 *
		 * This changes the scan from two block resolutions per height to one
		 * after the initial lookup.
		 */
		const upper = resolveBlockAtWorldCoords(
			worldX,
			MAX_SPAWN_HEIGHT + 1,
			worldZ,
		);

		if (!upper.loaded) {
			return null;
		}

		let upperBlockId = upper.blockId;

		for (let worldY = MAX_SPAWN_HEIGHT; worldY >= MIN_SPAWN_HEIGHT; worldY--) {
			const resolvedLower = resolveBlockAtWorldCoords(worldX, worldY, worldZ);

			/*
			 * Copy before the next lookup because resolveBlockAtWorldCoords
			 * uses one shared result object.
			 */
			copyResolvedBlock(resolvedLower, lowerBlockScratch);

			if (!lowerBlockScratch.loaded) {
				return null;
			}

			if (
				lowerBlockScratch.blockId === config.spawnBlockId &&
				upperBlockId === BlockType.Air
			) {
				if (!config.nightSpawn) {
					const packedLight = getLightByWorldCoords(worldX, worldY + 1, worldZ);

					const skyLight = (packedLight >>> 4) & 0x0f;

					if (skyLight < 8) {
						upperBlockId = lowerBlockScratch.blockId;
						continue;
					}
				}

				if (!this.#isMobTooClose(worldX, worldZ, 4)) {
					return {
						x: worldX + 0.5,
						y: worldY + 1 + (config.spawnYOffset ?? 0.2),
						z: worldZ + 0.5,
					};
				}
			}

			upperBlockId = lowerBlockScratch.blockId;
		}

		return null;
	}

	/**
	 * Find a loaded air cell at flock cruise altitude.
	 */
	#findAirSpawnPosition(
		playerPosition: Vec3,
	): { x: number; y: number; z: number } | null {
		const coordinate = randomSpawnCoordinate(playerPosition);

		const worldY =
			Math.floor(playerPosition.y) +
			FLOCK_ALTITUDE_MIN +
			Math.floor(Math.random() * FLOCK_ALTITUDE_RANGE);

		const cell = resolveBlockAtWorldCoords(coordinate.x, worldY, coordinate.z);

		if (!cell.loaded || cell.blockId !== BlockType.Air) {
			return null;
		}

		return {
			x: coordinate.x + 0.5,
			y: worldY + 0.5,
			z: coordinate.z + 0.5,
		};
	}

	#findWaterSpawnPosition(
		worldX: number,
		worldZ: number,
		config: MobSpawnConfig,
	): { x: number; y: number; z: number } | null {
		const isKraken = config.mobType === "kraken";

		const startY = isKraken ? SEA_LEVEL - 2 : SEA_LEVEL + 2;

		const endY = isKraken ? SEA_LEVEL - 12 : SEA_LEVEL - 4;

		const upper = resolveBlockAtWorldCoords(worldX, startY + 1, worldZ);

		if (!upper.loaded) {
			return null;
		}

		let upperBlockId = upper.blockId;

		for (let worldY = startY; worldY >= endY; worldY--) {
			const lower = resolveBlockAtWorldCoords(worldX, worldY, worldZ);

			copyResolvedBlock(lower, lowerBlockScratch);

			if (!lowerBlockScratch.loaded) {
				return null;
			}

			if (
				lowerBlockScratch.blockId === BlockType.Water &&
				upperBlockId === BlockType.Water &&
				!this.#isMobTooClose(worldX, worldZ, 9)
			) {
				return {
					x: worldX + 0.5,
					y: worldY + (config.spawnYOffset ?? 0.5),
					z: worldZ + 0.5,
				};
			}

			upperBlockId = lowerBlockScratch.blockId;
		}

		return null;
	}

	#isMobTooClose(
		worldX: number,
		worldZ: number,
		minimumDistanceSq: number,
	): boolean {
		for (let index = 0; index < mobSnapshot.length; index++) {
			const position = mobSnapshot[index].position;

			const dx = position.x - worldX;
			const dz = position.z - worldZ;

			if (dx * dx + dz * dz < minimumDistanceSq) {
				return true;
			}
		}

		return false;
	}
}
