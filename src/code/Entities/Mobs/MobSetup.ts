import type { SceneContext, Vec3 } from "@babylonjs/lite";
import { Map1 } from "../../Maps/Map1";
import { BlockType } from "../../World/Texture/BlockType";
import { SpawnCoordinator } from "../SpawnCoordinator";
import { Chicken } from "./Chicken";
import { MobRegistry, type MobSpawnConfig } from "./Mob";
import { Sheep } from "./Sheep";

const GRASS_SPAWN_BLOCK_ID = BlockType.Grass001;

const MOB_SPAWN_CONFIGS = [
	{
		mobType: "chicken",
		factory: (x: number, y: number, z: number, scene: SceneContext) =>
			new Chicken(x, y, z, scene),
		maxCount: 15,
		spawnWeight: 1,
		spawnBlockId: GRASS_SPAWN_BLOCK_ID,
		despawnable: false,
	},
	{
		mobType: "sheep",
		factory: (x: number, y: number, z: number, scene: SceneContext) =>
			new Sheep(x, y, z, scene),
		maxCount: 10,
		spawnWeight: 1,
		spawnBlockId: GRASS_SPAWN_BLOCK_ID,
		despawnable: false,
		spawnYOffset: 0.3,
	},
] satisfies MobSpawnConfig[];

export function createMobCoordinator(
	scene: SceneContext,
	getPlayerPosition: () => Vec3,
): SpawnCoordinator {
	const registry = new MobRegistry();

	for (const config of MOB_SPAWN_CONFIGS) {
		registry.register(config);
	}

	Map1.mobRegistry = registry;

	return new SpawnCoordinator(scene, getPlayerPosition, registry);
}
