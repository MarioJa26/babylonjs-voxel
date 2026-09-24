import { disposeMeshGpu, type Mesh, removeFromScene } from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { onGpuWorkDone } from "../../Light/liteGpuBuffer.js";

const pending: Mesh[] = [];
let scheduled = false;

function drain(): void {
	while (pending.length !== 0) {
		const mesh = pending.pop();
		if (mesh !== undefined) disposeMeshGpu(mesh);
	}
}

function afterWait(): void {
	scheduled = false;
	drain();
	if (pending.length !== 0) schedule();
}

function onWaitError(error: unknown): void {
	console.warn("Deferred mesh disposal waited on GPU work but failed", error);
}

function schedule(): void {
	if (scheduled) return;

	const engine = Map1.engine;
	if (!engine) {
		drain();
		return;
	}

	scheduled = true;
	void onGpuWorkDone(engine).catch(onWaitError).finally(afterWait);
}

export function deferMeshDisposal(mesh: Mesh): void {
	if (!mesh) return;
	pending.push(mesh);
	if (!scheduled) schedule();
}

export function deferChunkMeshes(
	scene: Parameters<typeof removeFromScene>[0],
	opaque: Mesh | null,
	water: Mesh | null,
	cutout: Mesh | null,
): void {
	if (opaque !== null) {
		removeFromScene(scene, opaque);
		deferMeshDisposal(opaque);
	}
	if (water !== null) {
		removeFromScene(scene, water);
		deferMeshDisposal(water);
	}
	if (cutout !== null) {
		removeFromScene(scene, cutout);
		deferMeshDisposal(cutout);
	}
}
