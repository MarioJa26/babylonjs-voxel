import { Map1 } from "@/code/Maps/Map1";
import { VoxelAabbCollider } from "@/code/World/Collision/VoxelAabbCollider";
import { VoxelObbCollider } from "@/code/World/Collision/VoxelObbCollider";
import { GLOBAL_VALUES } from "@/code/World/GLOBAL_VALUES";
import { PlayerHud } from "../Hud/PlayerHud";

export class DebugControlHelper {
	public static KEY_F2 = ["f2"];
	public static KEY_F3 = ["f3"];
	public static KEY_F4 = ["f4"];

	public static handleKey(key: string): boolean {
		if (DebugControlHelper.KEY_F2.includes(key)) {
			GLOBAL_VALUES.DEBUG = !GLOBAL_VALUES.DEBUG;
			Map1.setDebug(GLOBAL_VALUES.DEBUG);
			return true;
		} else if (DebugControlHelper.KEY_F3.includes(key)) {
			PlayerHud.toggleDebugInfo();
			return true;
		} else if (DebugControlHelper.KEY_F4.includes(key)) {
			console.log("Toggling bounding box debug");
			Map1.mainScene.forceShowBoundingBoxes = false;
			VoxelAabbCollider.toggleDebugEnabled();
			VoxelObbCollider.toggleDebugEnabled();
			return true;
		}
		return false;
	}
}
