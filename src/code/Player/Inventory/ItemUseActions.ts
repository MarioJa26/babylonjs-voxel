import { vec3 } from "@babylonjs/lite";
import { Arrow } from "@/code/Entities/Arrow/Arrow";
import {
	ARROW_TYPES,
	getArrowTypeIndexByItemId,
} from "@/code/Entities/Arrow/ArrowTypes";
import { CustomBoat } from "@/code/Entities/CustomBoat";
import { MobTypeId } from "@/code/Entities/MobConfig";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { Map1 } from "@/code/Maps/Map1";
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

/** Distance between the camera and the arrow's initial position. */
const ARROW_SPAWN_OFFSET = 0.3;

// ---------------------------------------------------------------------------
// Bow draw mechanic
// ---------------------------------------------------------------------------

/** Seconds of holding right-click to reach a full draw (progress = 1.0). */
export const BOW_DRAW_TIME = 0.8;

/** Minimum draw time before a shot is allowed; releasing earlier cancels it. */
export const BOW_MIN_DRAW_TIME = 0.2;

/** Arrow speed (blocks/sec) at the minimum valid draw. */
export const ARROW_SPEED_MIN = 8;

/** Arrow speed (blocks/sec) at a full draw. */
export const ARROW_SPEED_MAX = 40;

/**
 * Linearly interpolate arrow speed from draw progress (0-1).
 * Exported so the HUD / tests can reuse the same curve.
 */
export function arrowSpeedForDrawProgress(drawProgress: number): number {
	const t = drawProgress < 0 ? 0 : drawProgress > 1 ? 1 : drawProgress;
	return ARROW_SPEED_MIN + (ARROW_SPEED_MAX - ARROW_SPEED_MIN) * t;
}

/** True if the player has at least one arrow (or is in creative mode). */
export function playerHasArrows(player: Player): boolean {
	if (player.stats.gamemode === Gamemodes.Creative) return true;
	return ARROW_ITEM_IDS.some((id) => player.playerInventory.hasItem(id, 1));
}

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
const SPAWN_EGG_MOB_TYPE_IDS: Readonly<Record<string, number>> = {
	chicken: MobTypeId.Chicken,
	sheep: MobTypeId.Sheep,
	cow: MobTypeId.Cow,
	squid: MobTypeId.Squid,
	fish: MobTypeId.Fish,
	kraken: MobTypeId.Kraken,
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

export function useBow(player: Player, drawProgress: number = 1.0): void {
	const inventory = player.playerInventory;
	const isCreative = player.stats.gamemode === Gamemodes.Creative;

	// Arrow selection priority (Minecraft-like):
	// 1. Slot to the right of the bow in the hotbar
	// 2. Slot to the left of the bow in the hotbar
	// 3. Full inventory search by priority order (wood → iron → gold → ...)
	// Creative always falls back to wood (unlimited ammo).
	let arrowItemId: number;

	const hotbarRow = inventory.inventory[0];
	const bowSlot = player.playerHud.selectedHotbarSlot;
	const slotCount = hotbarRow.length;

	// Return the arrow item id if the slot holds an arrow, else null.
	const arrowAtSlot = (slotIndex: number): number | null => {
		if (slotIndex < 0 || slotIndex >= slotCount) return null;
		const item = hotbarRow[slotIndex]?.item;
		if (item === null || item === undefined) return null;
		return ARROW_ITEM_IDS.includes(item.itemId) ? item.itemId : null;
	};

	// Use the arrow in the slot *closest* to the bow. Scan outward by
	// distance from the bow slot (1, 2, 3, …), checking the right side
	// first then the left. This guarantees the nearest ammunition is
	// consumed, so the dropped arrow keeps the type you actually fired.
	const maxDistance = Math.max(bowSlot, slotCount - 1 - bowSlot);
	let selected: number | null = null;

	for (let d = 1; d <= maxDistance && selected === null; d++) {
		selected = arrowAtSlot(bowSlot + d) ?? arrowAtSlot(bowSlot - d);
	}

	// Fall back to any arrow anywhere in the inventory if no hotbar slot
	// holds one.
	if (selected === null) {
		selected = ARROW_ITEM_IDS.find((id) => inventory.hasItem(id, 1)) ?? -1;
	}

	arrowItemId = selected;

	// Creative fallback: unlimited wood arrows if no arrow found
	if (arrowItemId < 0 && isCreative) {
		arrowItemId = DEFAULT_ARROW_ITEM_ID;
	}

	if (arrowItemId < 0) return;

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

	const speed = arrowSpeedForDrawProgress(drawProgress);

	const velocityX = forwardX * speed;
	const velocityY = forwardY * speed;
	const velocityZ = forwardZ * speed;

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
	const isCreative = player.stats.gamemode === Gamemodes.Creative;
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

	// Aquatic mobs (squid/fish/kraken) must be spawned in water, so hit-test
	// against water when needed. Try the preferred hit first, fall back to the
	// other so land mobs can still be placed on a water-adjacent block etc.
	const WATER_MOB_TYPES = new Set(["squid", "fish", "kraken"]);
	const isAquatic = WATER_MOB_TYPES.has(mobType);

	let hit = isAquatic ? pickWaterTarget(player) : pickTarget(player);
	if (!hit) {
		hit = isAquatic ? pickTarget(player) : pickWaterTarget(player);
	}
	if (!hit) return;

	// For aquatic eggs, spawn inside the water block that was hit (center of
	// that voxel), not one block above it. For land eggs keep the usual
	// face-offset (cell = hit + normal) so the mob appears on top of the block.
	let cellX: number;
	let cellY: number;
	let cellZ: number;
	if (isAquatic && hit.blockId === BlockType.Water) {
		cellX = hit.x;
		cellY = hit.y;
		cellZ = hit.z;
	} else {
		cellX = hit.x + hit.nx;
		cellY = hit.y + hit.ny;
		cellZ = hit.z + hit.nz;
	}

	if (isAquatic) {
		// Aquatic eggs: spawn cell must be water (or water surface).
		// Headroom may be water or air so the mob doesn't suffocate in a wall.
		const block = getBlockByWorldCoords(cellX, cellY, cellZ);
		const above = getBlockByWorldCoords(cellX, cellY + 1, cellZ);
		const blockIsWater = block === BlockType.Water;
		const aboveIsClear = above === BlockType.Water || above === BlockType.Air;
		if (!blockIsWater || !aboveIsClear) {
			// If player hit land next to water, try to nudge into adjacent water
			// (check same Y and one below, since the ray's face-offset is one
			// above the ground while water sits at ground level).
			const candidates: [number, number, number][] = [
				[1, 0, 0],
				[-1, 0, 0],
				[0, 0, 1],
				[0, 0, -1],
				[1, -1, 0],
				[-1, -1, 0],
				[0, -1, 1],
				[0, -1, -1],
				[0, -1, 0],
			];
			for (const [dx, dy, dz] of candidates) {
				const cx = cellX + dx;
				const cy = cellY + dy;
				const cz = cellZ + dz;
				if (
					getBlockByWorldCoords(cx, cy, cz) === BlockType.Water &&
					(getBlockByWorldCoords(cx, cy + 1, cz) === BlockType.Water ||
						getBlockByWorldCoords(cx, cy + 1, cz) === BlockType.Air)
				) {
					const spawnX2 = cx + BLOCK_CENTER_OFFSET;
					const spawnZ2 = cz + BLOCK_CENTER_OFFSET;
					const spawnY2 = cy;
					const netClient2 = player.networkManager?.netClient;
					if (netClient2?.isConnected) {
						const typeId = SPAWN_EGG_MOB_TYPE_IDS[mobType];
						if (typeId === undefined) return;
						const registry2 = Map1.mobRegistry;
						const cfg2 = registry2?.getConfig(mobType);
						const yOff2 = cfg2?.spawnYOffset ?? DEFAULT_MOB_SPAWN_Y_OFFSET;
						netClient2.sendMobSpawnRequest(
							typeId,
							spawnX2,
							spawnY2 + yOff2,
							spawnZ2,
						);
					} else {
						const registry = Map1.mobRegistry;
						if (!registry) return;
						const config = registry.getConfig(mobType);
						if (!config) return;
						const spawnY =
							spawnY2 + (config.spawnYOffset ?? DEFAULT_MOB_SPAWN_Y_OFFSET);
						const mob = config.factory(
							spawnX2,
							spawnY,
							spawnZ2,
							Map1.mainScene,
						);
						mob.countsTowardMobCap = false;
						registry.addMob(mob);
					}
					if (!isCreative) {
						inventory.removeItems(item.itemId, 1);
					}
					return;
				}
			}
			return;
		}
	} else {
		// Land mobs (chicken/sheep/cow): require air headroom.
		if (
			getBlockByWorldCoords(cellX, cellY, cellZ) !== BlockType.Air ||
			getBlockByWorldCoords(cellX, cellY + 1, cellZ) !== BlockType.Air
		) {
			return;
		}
	}

	const spawnX = cellX + BLOCK_CENTER_OFFSET;
	const spawnZ = cellZ + BLOCK_CENTER_OFFSET;
	const netClient = player.networkManager?.netClient;

	if (netClient?.isConnected) {
		const typeId = SPAWN_EGG_MOB_TYPE_IDS[mobType];
		if (typeId === undefined) return;
		// Use the mob's configured Y offset even for server spawns so aquatic
		// mobs sit correctly in the water column.
		const registry = Map1.mobRegistry;
		const cfg = registry?.getConfig(mobType);
		const yOff = cfg?.spawnYOffset ?? DEFAULT_MOB_SPAWN_Y_OFFSET;
		netClient.sendMobSpawnRequest(typeId, spawnX, cellY + yOff, spawnZ);
	} else {
		const registry = Map1.mobRegistry;
		if (registry == null) return;
		const config = registry.getConfig(mobType);
		if (!config) {
			console.warn(`Spawn egg references unknown mob type: ${mobType}`);
			return;
		}
		const spawnY = cellY + (config.spawnYOffset ?? DEFAULT_MOB_SPAWN_Y_OFFSET);
		const mob = config.factory(spawnX, spawnY, spawnZ, Map1.mainScene);
		mob.countsTowardMobCap = false;
		registry.addMob(mob);
	}

	if (!isCreative) {
		inventory.removeItems(item.itemId, 1);
	}
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
