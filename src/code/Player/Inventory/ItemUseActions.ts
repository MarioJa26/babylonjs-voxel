import { vec3 } from "@babylonjs/lite";
import { Arrow } from "@/code/Entities/Arrow";
import {
	ARROW_TYPES,
	getArrowTypeIndexByItemId,
} from "@/code/Entities/ArrowTypes";
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
import { Gamemodes } from "../PlayerStats";
import { getRegisteredItemById } from "./ItemRegistry";

export type ItemUseAction = (player: Player) => void;

/** Item IDs of every arrow ammunition type, in selection priority order. */
const ARROW_ITEM_IDS: readonly number[] = ARROW_TYPES.map((t) => t.itemId);

/** Item ID of the default (wooden) arrow used in creative mode. */
const DEFAULT_ARROW_ITEM_ID = ARROW_TYPES[0]!.itemId;

/** Arrow muzzle speed in blocks per second. */
const ARROW_SPEED = 30;

/** Distance between the camera and the arrow's initial position. */
const ARROW_SPAWN_OFFSET = 0.3;

/** Horizontal center offset when spawning entities inside a block. */
const BLOCK_CENTER_OFFSET = 0.5;

/** Default vertical offset used for server-spawned mobs. */
const DEFAULT_MOB_SPAWN_Y_OFFSET = 0.2;

/** Boat collision-check dimensions, measured from the target block. */
const BOAT_CHECK_MIN_X_OFFSET = -1;
const BOAT_CHECK_MAX_X_OFFSET = 1;
const BOAT_CHECK_MIN_Z_OFFSET = -2;
const BOAT_CHECK_MAX_Z_OFFSET = 2;
const BOAT_CHECK_HEIGHT = 2;

/**
 * Multiplayer spawn eggs reference the server's MobTypeId. Singleplayer
 * spawns locally through client MobRegistry configurations keyed by mobType.
 */
const SPAWN_EGG_MOB_TYPE_IDS: Readonly<Record<string, MobTypeId>> = {
	chicken: MobTypeId.Chicken,
	sheep: MobTypeId.Sheep,
};

function useTool(player: Player): void {
	// TODO: Implement tool-specific behavior such as mining, attacking,
	// or tilling.
	console.debug("use_tool invoked by", player);
}

function openCrafting(player: Player): void {
	// TODO: Implement crafting table opening.
	console.debug("open_crafting invoked by", player);
}

function useBow(player: Player): void {
	const inventory = player.playerInventory;
	const isCreative = player.stats.gamemode === Gamemodes.Creative;

	// Pick which arrow to fire: the selected hotbar item if it is an arrow,
	// otherwise the first available arrow type by priority order.
	let arrowItemId: number;

	if (isCreative) {
		const selected = inventory.getSelectedHotbarItem();
		arrowItemId =
			selected !== null && ARROW_ITEM_IDS.includes(selected.itemId)
				? selected.itemId
				: DEFAULT_ARROW_ITEM_ID;
	} else {
		const selected = inventory.getSelectedHotbarItem();
		const selectedId =
			selected !== null && ARROW_ITEM_IDS.includes(selected.itemId)
				? selected.itemId
				: null;

		arrowItemId =
			selectedId ?? ARROW_ITEM_IDS.find((id) => inventory.hasItem(id, 1)) ?? -1;

		if (arrowItemId < 0) return;
	}

	// Both camera getters may return shared scratch objects, so consume their
	// values synchronously without retaining the objects.
	const camera = player.playerCamera;
	const cameraPosition = camera.position;
	const forward = camera.getForwardDirection();

	const forwardX = forward.x;
	const forwardY = forward.y;
	const forwardZ = forward.z;

	const spawnX = cameraPosition.x + forwardX * ARROW_SPAWN_OFFSET;
	const spawnY = cameraPosition.y + forwardY * ARROW_SPAWN_OFFSET;
	const spawnZ = cameraPosition.z + forwardZ * ARROW_SPAWN_OFFSET;

	const velocityX = forwardX * ARROW_SPEED;
	const velocityY = forwardY * ARROW_SPEED;
	const velocityZ = forwardZ * ARROW_SPEED;

	const arrowTypeIndex = getArrowTypeIndexByItemId(arrowItemId);

	new Arrow(
		player,
		spawnX,
		spawnY,
		spawnZ,
		velocityX,
		velocityY,
		velocityZ,
		arrowTypeIndex,
	);

	// Multiplayer relays the trajectory so other clients render the same
	// arrow. The server excludes the shooter from the broadcast.
	const netClient = player.networkManager?.netClient;

	if (netClient?.isConnected) {
		netClient.sendArrowShoot(
			spawnX,
			spawnY,
			spawnZ,
			velocityX,
			velocityY,
			velocityZ,
			arrowTypeIndex,
		);
		Arrow.ensureNetworkHandler(netClient);
	}

	if (!isCreative) {
		inventory.removeItems(arrowItemId, 1);
	}
}

function useSpawnEgg(player: Player): void {
	const inventory = player.playerInventory;
	const hotbar = inventory.inventory[0];
	const selectedSlot = hotbar?.[player.playerHud.selectedHotbarSlot];
	const item = selectedSlot?.item;

	if (item == null) {
		return;
	}

	const itemDefinition = getRegisteredItemById(item.itemId);
	const mobType = itemDefinition?.spawnMobType;

	if (!mobType) {
		return;
	}

	const hit = pickTarget(player);

	if (!hit) {
		return;
	}

	const cellX = hit.x + hit.nx;
	const cellY = hit.y + hit.ny;
	const cellZ = hit.z + hit.nz;

	// Require both the spawn cell and headroom to be air. This prevents mobs
	// from spawning inside solid blocks or water.
	if (
		getBlockByWorldCoords(cellX, cellY, cellZ) !== BlockType.Air ||
		getBlockByWorldCoords(cellX, cellY + 1, cellZ) !== BlockType.Air
	) {
		return;
	}

	const spawnX = cellX + BLOCK_CENTER_OFFSET;
	const spawnZ = cellZ + BLOCK_CENTER_OFFSET;
	const netClient = player.networkManager?.netClient;

	if (netClient?.isConnected) {
		// Multiplayer mobs are server-authoritative.
		const typeId = SPAWN_EGG_MOB_TYPE_IDS[mobType];

		if (typeId === undefined) {
			return;
		}

		netClient.sendMobSpawnRequest(
			typeId,
			spawnX,
			cellY + DEFAULT_MOB_SPAWN_Y_OFFSET,
			spawnZ,
		);
	} else {
		// Singleplayer spawns locally through the client MobRegistry.
		const registry = Map1.mobRegistry;

		if (registry == null) {
			return;
		}

		const config = registry.getConfig(mobType);

		if (!config) {
			console.warn(`Spawn egg references unknown mob type: ${mobType}`);
			return;
		}

		const spawnY = cellY + (config.spawnYOffset ?? DEFAULT_MOB_SPAWN_Y_OFFSET);

		const mob = config.factory(spawnX, spawnY, spawnZ, Map1.mainScene);

		// Egg-spawned mobs are exempt from the natural-spawn mob cap.
		mob.countsTowardMobCap = false;
		registry.addMob(mob);
	}

	inventory.removeItems(item.itemId, 1);
}

function placeBoat(player: Player): void {
	const hit = pickWaterTarget(player);

	if (!hit) {
		return;
	}

	const hitX = hit.x;
	const hitY = hit.y;
	const hitZ = hit.z;

	if (getBlockByWorldCoords(hitX, hitY, hitZ) !== BlockType.Water) {
		return;
	}

	const spawnBlockY = hitY + 1;

	// Validate the entire boat volume before allocating its spawn vector or
	// constructing the boat.
	for (
		let checkY = spawnBlockY;
		checkY < spawnBlockY + BOAT_CHECK_HEIGHT;
		checkY++
	) {
		for (
			let checkX = hitX + BOAT_CHECK_MIN_X_OFFSET;
			checkX <= hitX + BOAT_CHECK_MAX_X_OFFSET;
			checkX++
		) {
			for (
				let checkZ = hitZ + BOAT_CHECK_MIN_Z_OFFSET;
				checkZ <= hitZ + BOAT_CHECK_MAX_Z_OFFSET;
				checkZ++
			) {
				const blockId = getBlockByWorldCoords(checkX, checkY, checkZ);

				if (isCollidableBlock(blockId)) {
					return;
				}
			}
		}
	}

	const spawnPosition = vec3(
		hitX + BLOCK_CENTER_OFFSET,
		spawnBlockY + BLOCK_CENTER_OFFSET,
		hitZ + BLOCK_CENTER_OFFSET,
	);

	new CustomBoat(player, GenerationParams.SEA_LEVEL, spawnPosition);
}

export const ItemUseActions: Readonly<Record<string, ItemUseAction>> = {
	use_tool: useTool,
	open_crafting: openCrafting,
	use_bow: useBow,
	use_spawn_egg: useSpawnEgg,
	place_boat: placeBoat,
};
