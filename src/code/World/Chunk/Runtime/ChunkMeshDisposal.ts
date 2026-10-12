import { type Mesh, removeFromScene } from "@babylonjs/lite";
import { GPU_RETIREMENT_QUEUE } from "@/code/Lib/GpuRetirementQueue";

type Scene = Parameters<typeof removeFromScene>[0];

/**
 * Deferred GPU disposal for non-merged chunk meshes.
 *
 * This delegates to the shared retirement queue, which is also used by the
 * packed-mesh layer. That matters because a chunk teardown can release BOTH in
 * the same frame — a non-merged LOD mesh here plus a packed arena there — and
 * two independent fences gave the two sets arbitrary completion order.
 */
export function deferMeshDisposal(mesh: Mesh): void {
	GPU_RETIREMENT_QUEUE.retireMesh(mesh);
}

export function deferChunkMeshes(
	scene: Scene,
	opaque: Mesh | null,
	water: Mesh | null,
	cutout: Mesh | null,
): void {
	// Detach from the scene synchronously. A mesh still attached could be
	// picked up by this frame's render list, and the fence would then be
	// waiting on work submitted *after* the disposal decision — exactly the
	// race the fence exists to prevent.
	if (opaque !== null) {
		removeFromScene(scene, opaque);
	}
	if (water !== null) {
		removeFromScene(scene, water);
	}
	if (cutout !== null) {
		removeFromScene(scene, cutout);
	}

	// One call, so all three share a single fence.
	GPU_RETIREMENT_QUEUE.retireMeshes([opaque, water, cutout]);
}
