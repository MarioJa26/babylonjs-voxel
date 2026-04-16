import type { Quaternion, Vector3 } from "@babylonjs/core";

interface MountOptions {
	mountOffset?: Vector3;
	mountRotationOffset?: Quaternion;
}

export default MountOptions;
