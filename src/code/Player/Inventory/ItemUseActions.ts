import { vec3 } from "@babylonjs/lite";
import { CustomBoat } from "@/code/Entities/CustomBoat";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import { getBlockByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { BlockType, isCollidableBlock } from "@/code/World/Texture/BlockType";
import { pickWaterTarget } from "../Hud/BlockHighlight/BlockRaycaster";
import type { Player } from "../Player";

export type ItemUseAction = (player: Player) => void;

export const ItemUseActions: Record<string, ItemUseAction> = {
	use_tool: (player: Player) => {
		// TODO: implement tool-specific behavior (mining, attacking, tilling).
		console.debug("use_tool invoked by", player);
	},
	open_crafting: (player: Player) => {
		// TODO: implement crafting table open.
		console.debug("open_crafting invoked by", player);
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
