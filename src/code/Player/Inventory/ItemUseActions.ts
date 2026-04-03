import { Vector3 } from "@babylonjs/core";
import { Player } from "../Player";
import { CrossHair } from "../Hud/CrossHair";
import { BlockType } from "@/code/World/BlockType";
import { ChunkLoadingSystem } from "@/code/World/Chunk/ChunkLoadingSystem";
import { CustomBoat } from "@/code/Entities/CustomBoat";
import { Map1 } from "@/code/Maps/Map1";
import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";

export type ItemUseAction = (player: Player) => void;

export const ItemUseActions: Record<string, ItemUseAction> = {
  place_boat: (player: Player) => {
    const hit = CrossHair.pickWaterPlacementTarget(player);
    if (!hit) return;

    const blockAtHit = ChunkLoadingSystem.getBlockByWorldCoords(
      hit.x,
      hit.y,
      hit.z,
    );

    if (blockAtHit !== BlockType.Water) {
      console.log("Boat must be placed on water.");
      return;
    }

    const spawnY = hit.y + 1;
    const spawnPos = new Vector3(hit.x + 0.5, spawnY + 0.5, hit.z + 0.5);

    const halfWidth = 1;
    const halfHeight = 1;
    const halfDepth = 2;

    for (let y = 0; y < halfHeight * 2; y++) {
      for (let x = -halfWidth; x <= halfWidth; x++) {
        for (let z = -halfDepth; z <= halfDepth; z++) {
          const checkX = hit.x + x;
          const checkY = spawnY + y;
          const checkZ = hit.z + z;

          const blockId = ChunkLoadingSystem.getBlockByWorldCoords(
            checkX,
            checkY,
            checkZ,
          );

          if (blockId !== BlockType.Air && blockId !== BlockType.Water) {
            console.log("Not enough space to place the boat.");
            return;
          }
        }
      }
    }

    new CustomBoat(
      Map1.mainScene,
      player,
      GenerationParams.SEA_LEVEL,
      spawnPos,
    );
  },
};
