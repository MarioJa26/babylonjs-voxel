import type { SceneContext, Vec3 } from "@babylonjs/lite";
import { Map1 } from "../../Maps/Map1";
import { BlockType } from "../../World/Texture/BlockType";
import { SpawnCoordinator } from "../SpawnCoordinator";
import { Chicken } from "./Chicken";
import { Cow } from "./Cow";
import { Fish } from "./Fish";
import { Kraken } from "./Kraken";
import { MobRegistry, type MobSpawnConfig } from "./Mob";
import { Sheep } from "./Sheep";
import { Squid } from "./Squid";

const GRASS_SPAWN_BLOCK_ID = BlockType.Grass001;
const WATER_SPAWN_BLOCK_ID = BlockType.Water;

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
	{
		mobType: "cow",
		factory: (x: number, y: number, z: number, scene: SceneContext) =>
			new Cow(x, y, z, scene),
		maxCount: 10,
		spawnWeight: 1,
		spawnBlockId: GRASS_SPAWN_BLOCK_ID,
		despawnable: false,
		spawnYOffset: 0.3,
	},
	{
		mobType: "squid",
		factory: (x: number, y: number, z: number, scene: SceneContext) =>
			new Squid(x, y, z, scene),
		maxCount: 8,
		spawnWeight: 1,
		spawnBlockId: WATER_SPAWN_BLOCK_ID,
		despawnable: false,
		spawnYOffset: 0.5,
	},
	{
		mobType: "fish",
		factory: (x: number, y: number, z: number, scene: SceneContext) =>
			new Fish(x, y, z, scene),
		maxCount: 15,
		spawnWeight: 1.5,
		spawnBlockId: WATER_SPAWN_BLOCK_ID,
		despawnable: false,
		spawnYOffset: 0.5,
	},
	{
		mobType: "kraken",
		factory: (x: number, y: number, z: number, scene: SceneContext) =>
			new Kraken(x, y, z, scene),
		maxCount: 2,
		spawnWeight: 0.15,
		spawnBlockId: WATER_SPAWN_BLOCK_ID,
		despawnable: false,
		spawnYOffset: 0.5,
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
