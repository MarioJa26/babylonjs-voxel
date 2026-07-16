import type { Quaternion } from "@babylonjs/core";
import type { Vec3 } from "@babylonjs/lite";

interface MountOptions {
	mountOffset?: Vec3;
	mountRotationOffset?: Quaternion;
}

export default MountOptions;
