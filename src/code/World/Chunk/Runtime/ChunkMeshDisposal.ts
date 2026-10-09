import { disposeMeshGpu, type Mesh, removeFromScene } from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { onGpuWorkDone } from "../../Light/liteGpuBuffer.js";

type Scene = Parameters<typeof removeFromScene>[0];

let pending: Mesh[] = [];
let scheduled = false;

function disposeBatch(batch: Mesh[]): void {
	for (let i = batch.length - 1; i >= 0; i--) {
		disposeMeshGpu(batch[i]);
	}
}

function schedule(): void {
	if (scheduled || pending.length === 0) return;

	const engine = Map1.engine;

	if (!engine) {
		const batch = pending;
		pending = [];
		disposeBatch(batch);
		return;
	}

	// Detach the current batch. Meshes deferred while the GPU wait is pending
	// remain in `pending` and receive their own subsequent fence.
	const batch = pending;
	pending = [];
	scheduled = true;

	void onGpuWorkDone(engine)
		.catch((error: unknown) => {
			console.warn(
				"Deferred mesh disposal waited on GPU work but failed",
				error,
			);
		})
		.finally(() => {
			disposeBatch(batch);
			scheduled = false;

			if (pending.length !== 0) {
				schedule();
			}
		});
}

export function deferMeshDisposal(mesh: Mesh): void {
	pending.push(mesh);
	schedule();
}

export function deferChunkMeshes(
	scene: Scene,
	opaque: Mesh | null,
	water: Mesh | null,
	cutout: Mesh | null,
): void {
	if (opaque !== null) {
		removeFromScene(scene, opaque);
		pending.push(opaque);
	}

	if (water !== null) {
		removeFromScene(scene, water);
		pending.push(water);
	}

	if (cutout !== null) {
		removeFromScene(scene, cutout);
		pending.push(cutout);
	}

	// Schedule once after all chunk meshes have been queued.
	schedule();
}
