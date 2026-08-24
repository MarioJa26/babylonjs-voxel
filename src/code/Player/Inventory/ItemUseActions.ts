import { vec3 } from "@babylonjs/lite";
import { CustomBoat } from "@/code/Entities/CustomBoat";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { Map1 } from "@/code/Maps/Map1";
import { MobTypeId } from "@/code/Network/protocol/messages";
import { getBlockByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import {
	pickTarget,
	pickWaterTarget,
} from "../Hud/BlockHighlight/BlockRaycaster";
import type { Player } from "../Player";
import { getRegisteredItemById } from "./ItemRegistry";

export type ItemUseAction = (player: Player) => void;

/**
 * Multiplayer spawn eggs reference the server's MobTypeId; singleplayer
 * spawns locally via the client MobRegistry configs (keyed by mobType).
 */
const SPAWN_EGG_MOB_TYPE_IDS: Record<string, number> = {
	chicken: MobTypeId.Chicken,
	sheep: MobTypeId.Sheep,
};

export const ItemUseActions: Record<string, ItemUseAction> = {
	use_tool: (player: Player) => {
		// TODO: implement tool-specific behavior (mining, attacking, tilling).
		console.debug("use_tool invoked by", player);
	},
	open_crafting: (player: Player) => {
		// TODO: implement crafting table open.
		console.debug("open_crafting invoked by", player);
	},
	use_spawn_egg: (player: Player) => {
		// The held item identifies which mob to spawn (def.spawnMobType).
		const hotbar = player.playerInventory.inventory[0];
		const slot = hotbar?.[player.playerHud.selectedHotbarSlot];
		const item = slot?.item;
		if (item === null || item === undefined) return;

		const mobType = getRegisteredItemById(item.itemId)?.spawnMobType;
		if (!mobType) return;

		const hit = pickTarget(player);
		if (!hit) return;

		const cellX = hit.x + hit.nx;
		const cellY = hit.y + hit.ny;
		const cellZ = hit.z + hit.nz;

		// Require the spawn cell plus headroom to be air so the mob does
		// not spawn stuck inside blocks (or inside water).
		if (getBlockByWorldCoords(cellX, cellY, cellZ) !== BlockType.Air) return;
		if (getBlockByWorldCoords(cellX, cellY + 1, cellZ) !== BlockType.Air) {
			return;
		}

		const net = player.networkManager?.netClient;

		if (net?.isConnected) {
			// Multiplayer: mobs are server-authoritative. Ask the server to
			// spawn a cap-exempt mob; it broadcasts MobSpawn to every client
			// (including this one), which renders it via RemoteMobManager.
			const typeId = SPAWN_EGG_MOB_TYPE_IDS[mobType];
			if (typeId === undefined) return;

			net.sendMobSpawnRequest(typeId, cellX + 0.5, cellY + 0.2, cellZ + 0.5);
		} else {
			// Singleplayer: spawn locally through the client MobRegistry.
			const registry = Map1.mobRegistry;
			if (registry === null || registry === undefined) return;

			const config = registry.getConfig(mobType);
			if (!config) {
				console.warn(`Spawn egg references unknown mob type: ${mobType}`);
				return;
			}

			const mob = config.factory(
				cellX + 0.5,
				cellY + (config.spawnYOffset ?? 0.2),
				cellZ + 0.5,
				Map1.mainScene,
			);

			// Egg-spawned mobs are cap-exempt: the mob cap only limits
			// naturally spawned mobs.
			mob.countsTowardMobCap = false;
			registry.addMob(mob);
		}

		player.playerInventory.removeItems(item.itemId, 1);
	},
	place_boat: (player: Player) => {
		const hit = pickWaterTarget(player);
		if (!hit) return;

		const blockAtHit = getBlockByWorldCoords(hit.x, hit.y, hit.z);

		if (blockAtHit !== BlockType.Water) {
			return;
		}

		const spawnY = hit.y + 1;
		const spawnPos = vec3(hit.x + 0.5, spawnY + 0.5, hit.z + 0.5);

		const halfWidth = 1;
		const halfHeight = 1;
		const halfDepth = 2;

		for (let y = 0; y < halfHeight * 2; y++) {
			for (let x = -halfWidth; x <= halfWidth; x++) {
				for (let z = -halfDepth; z <= halfDepth; z++) {
					const checkX = hit.x + x;
					const checkY = spawnY + y;
					const checkZ = hit.z + z;

					const blockId = getBlockByWorldCoords(checkX, checkY, checkZ);

					if (isCollidableBlock(blockId)) {
						return;
					}
				}
			}
		}

		new CustomBoat(player, GenerationParams.SEA_LEVEL, spawnPos);
	},
};
