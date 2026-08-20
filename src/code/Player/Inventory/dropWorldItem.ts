import type { Player } from "../Player";
import { DroppedItem } from "./DroppedItem";
import type { Item } from "./Item";

/**
 * Drop a world item.
 *
 * In multiplayer the drop is server-authoritative: we send an ItemDrop to the
 * server (which broadcasts ItemSpawn to every client, including this one) and
 * do NOT create a local DroppedItem. In singleplayer we create a local
 * DroppedItem with the given velocity, exactly as before.
 *
 * Returns the local DroppedItem (singleplayer) or null (multiplayer).
 */
export function dropWorldItem(
	item: Item,
	x: number,
	y: number,
	z: number,
	vx: number,
	vy: number,
	vz: number,
	player?: Player,
): DroppedItem | null {
	const net = player?.networkManager?.netClient;
	if (net?.isConnected) {
		net.sendItemDrop(item.itemId, item.stackSize, x, y, z, vx, vy, vz);
		return null;
	}

	const dropped = new DroppedItem(item, x, y, z);
	dropped.addVelocity(vx, vy, vz);
	return dropped;
}
