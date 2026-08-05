import type { Vec3 } from "@babylonjs/lite";
import type { Quaternion } from "@/code/Lib/Math";

interface MountOptions {
	mountOffset?: Vec3;
	mountRotationOffset?: Quaternion;
}

export default MountOptions;
