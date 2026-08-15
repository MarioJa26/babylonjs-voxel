import type { SceneContext, Vec3 } from "@babylonjs/lite";
import { Map1 } from "../../Maps/Map1";
import { BlockType } from "../../World/Texture/BlockType";
import { SpawnCoordinator } from "../SpawnCoordinator";
import { Chicken } from "./Chicken";
import { MobRegistry, type MobSpawnConfig } from "./Mob";
import { Sheep } from "./Sheep";

const GRASS_SPAWN_BLOCK_ID = BlockType.Grass001;

const createChickenMob: MobSpawnConfig["factory"] = (x, y, z, scene) =>
	new Chicken(x, y, z, scene);

const createSheepMob: MobSpawnConfig["factory"] = (x, y, z, scene) =>
	new Sheep(x, y, z, scene);

function registerDefaultMobs(registry: MobRegistry): void {
	registry.register({
		mobType: "chicken",
		factory: createChickenMob,
		maxCount: 15,
		spawnWeight: 1,
		spawnBlockId: GRASS_SPAWN_BLOCK_ID,
		despawnable: false,
	});

	registry.register({
		mobType: "sheep",
		factory: createSheepMob,
		maxCount: 10,
		spawnWeight: 1,
		spawnBlockId: GRASS_SPAWN_BLOCK_ID,
		despawnable: false,
		spawnYOffset: 0.3,
	});
}

export function createMobCoordinator(
	scene: SceneContext,
	getPlayerPosition: () => Vec3,
): SpawnCoordinator {
	const registry = new MobRegistry();

	registerDefaultMobs(registry);

	Map1.mobRegistry = registry;

	return new SpawnCoordinator(scene, getPlayerPosition, registry);
}
