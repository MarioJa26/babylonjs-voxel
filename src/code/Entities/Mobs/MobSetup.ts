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

/** Map MobTypeId to mob type name and factory function. */
const MOB_FACTORIES: Record<
	number,
	{
		mobType: string;
		factory: (x: number, y: number, z: number, scene: SceneContext) => Mob;
	}
> = {
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

/** Build client spawn configs from centralized MobConfig. */
const MOB_SPAWN_CONFIGS_CLIENT: MobSpawnConfig[] = Object.entries(
	MOB_SPAWN_CONFIGS,
).map(([typeId, spawnConfig]) => {
	const factory = MOB_FACTORIES[Number(typeId)];
	return {
		mobType: factory.mobType,
		factory: factory.factory,
		...spawnConfig,
	};
});

export function createMobCoordinator(
	scene: SceneContext,
	getPlayerPosition: () => Vec3,
): SpawnCoordinator {
	const registry = new MobRegistry();

	for (const config of MOB_SPAWN_CONFIGS_CLIENT) {
		registry.register(config);
	}

	Map1.mobRegistry = registry;

	return new SpawnCoordinator(scene, getPlayerPosition, registry);
}
