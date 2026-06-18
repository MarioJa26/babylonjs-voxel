import type { Scene, Vector3 } from "@babylonjs/core";
import { Map1 } from "../../Maps/Map1";
import { BlockType } from "../../World/Texture/BlockType";
import { SpawnCoordinator } from "../SpawnCoordinator";
import { Chicken } from "./Chicken";
import { MobRegistry } from "./Mob";
import { Sheep } from "./Sheep";

export function createMobCoordinator(
	scene: Scene,
	getPlayerPosition: () => Vector3,
): SpawnCoordinator {
	const registry = new MobRegistry();

	registry.register({
		mobType: "chicken",
		factory: (x, y, z, scene) => new Chicken(x, y, z, scene),
		maxCount: 15,
		spawnWeight: 1,
		spawnBlockId: BlockType.Grass001,
		despawnable: false,
	});

	registry.register({
		mobType: "sheep",
		factory: (x, y, z, scene) => new Sheep(x, y, z, scene),
		maxCount: 10,
		spawnWeight: 1,
		spawnBlockId: BlockType.Grass001,
		despawnable: false,
		spawnYOffset: 0.3,
	});

	Map1.mobRegistry = registry;
	return new SpawnCoordinator(scene, getPlayerPosition, registry);
}
