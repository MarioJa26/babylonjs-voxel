import { Map1 } from "@/code/Maps/Map1";
import { VoxelAabbCollider } from "@/code/World/Collision/VoxelAabbCollider";
import { VoxelObbCollider } from "@/code/World/Collision/VoxelObbCollider";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { PlayerHud } from "../Hud/PlayerHud";

const handlers: Record<string, () => void> = {
	f1: () => {
		PlayerHud.toggleHud();
	},

	f2: () => {
		GLOBAL_VALUES.DEBUG = !GLOBAL_VALUES.DEBUG;
		Map1.setDebug(GLOBAL_VALUES.DEBUG);
	},

	f3: () => {
		PlayerHud.toggleDebugInfo();
	},

	f4: () => {
		(
			Map1.mainScene as unknown as { forceShowBoundingBoxes: boolean }
		).forceShowBoundingBoxes = false;
		VoxelAabbCollider.toggleDebugEnabled();
		VoxelObbCollider.toggleDebugEnabled();
	},
};

export function handleDebugKey(key: string): boolean {
	const handler = handlers[key];
	if (!handler) return false;

	handler();
	return true;
}
