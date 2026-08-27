import type { SceneContext, Vec3 } from "@babylonjs/lite";
import { Map1 } from "../../Maps/Map1";
import { MOB_SPAWN_CONFIGS, MobTypeId } from "../MobConfig";
import { SpawnCoordinator } from "../SpawnCoordinator";
import { Chicken } from "./Chicken";
import { Cow } from "./Cow";
import { Fish } from "./Fish";
import { Kraken } from "./Kraken";
import type { Mob } from "./Mob";
import { MobRegistry, type MobSpawnConfig } from "./Mob";
import { Sheep } from "./Sheep";
import { Squid } from "./Squid";

type MobFactoryEntry = {
	readonly mobType: string;
	readonly factory: (
		x: number,
		y: number,
		z: number,
		scene: SceneContext,
	) => Mob;
};

/** Map MobTypeId to mob type name and factory function. */
const MOB_FACTORIES: Readonly<Partial<Record<number, MobFactoryEntry>>> = {
	[MobTypeId.Chicken]: {
		mobType: "chicken",
		factory: (x, y, z, scene) => new Chicken(x, y, z, scene),
	},
	[MobTypeId.Sheep]: {
		mobType: "sheep",
		factory: (x, y, z, scene) => new Sheep(x, y, z, scene),
	},
	[MobTypeId.Cow]: {
		mobType: "cow",
		factory: (x, y, z, scene) => new Cow(x, y, z, scene),
	},
	[MobTypeId.Squid]: {
		mobType: "squid",
		factory: (x, y, z, scene) => new Squid(x, y, z, scene),
	},
	[MobTypeId.Fish]: {
		mobType: "fish",
		factory: (x, y, z, scene) => new Fish(x, y, z, scene),
	},
	[MobTypeId.Kraken]: {
		mobType: "kraken",
		factory: (x, y, z, scene) => new Kraken(x, y, z, scene),
	},
};

/**
 * Build client spawn configurations once.
 *
 * The resulting objects are reused whenever a coordinator is created, avoiding
 * repeated factory lookup, key conversion, and configuration allocation.
 */
function buildClientSpawnConfigs(): readonly MobSpawnConfig[] {
	const typeIds = Object.keys(MOB_SPAWN_CONFIGS);
	const configs = new Array<MobSpawnConfig>(typeIds.length);

	for (let i = 0; i < typeIds.length; i++) {
		const typeId = Number(typeIds[i]);
		const factoryEntry = MOB_FACTORIES[typeId];

		if (!factoryEntry) {
			throw new Error(`Missing client mob factory for MobTypeId ${typeId}`);
		}

		const spawnConfig = MOB_SPAWN_CONFIGS[typeId];

		configs[i] = {
			...spawnConfig,
			mobType: factoryEntry.mobType,
			factory: factoryEntry.factory,
		};
	}

	return configs;
}

const MOB_SPAWN_CONFIGS_CLIENT = buildClientSpawnConfigs();

export function createMobCoordinator(
	scene: SceneContext,
	getPlayerPosition: () => Vec3,
): SpawnCoordinator {
	const registry = new MobRegistry();

	for (let i = 0; i < MOB_SPAWN_CONFIGS_CLIENT.length; i++) {
		registry.register(MOB_SPAWN_CONFIGS_CLIENT[i]);
	}

	Map1.mobRegistry = registry;

	return new SpawnCoordinator(scene, getPlayerPosition, registry);
}
