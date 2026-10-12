import {
	disposeMeshGpu,
	disposeStorageBuffer,
	type Mesh,
	type StorageBuffer,
} from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";
import { onGpuWorkDone } from "@/code/World/Light/liteGpuBuffer";

/**
 * One GPU fence for all deferred resource retirement, instead of one promise
 * per resource.
 *
 * PERF/BUGFIX: `disposeMeshGpu()` and `disposeStorageBuffer()` destroy GPU
 * memory immediately, but the GPU may still be reading those buffers from a
 * command buffer submitted before the destruction — which surfaces as
 * "buffer used in submit while destroyed". Every retirement site therefore had
 * to wait for `onGpuWorkDone()` first.
 *
 * Previously each site did that independently, which meant a chunk unload that
 * released three meshes and an arena regrow that released one storage buffer
 * created four promises and four fences, and the fences resolved in arbitrary
 * order. This queue coalesces them into a single fence per frame: one promise,
 * deterministic ordering, and a bounded number of in-flight waits regardless of
 * how many resources are retired.
 *
 * Ordering is FIFO within a kind. That matters because arena growth frees the
 * old buffer after installing the new one, and freeing out of order can strand
 * a buffer the new mesh still references.
 */
class GpuRetirementQueue {
	private meshes: Mesh[] = [];
	private storageBuffers: StorageBuffer[] = [];
	private scheduled = false;

	retireMesh(mesh: Mesh): void {
		this.meshes.push(mesh);
		this.schedule();
	}

	retireStorageBuffer(buffer: StorageBuffer): void {
		this.storageBuffers.push(buffer);
		this.schedule();
	}

	/**
	 * Retire a whole set in one call, which also guarantees one fence for the set.
	 *
	 * The caller is responsible for having already detached the meshes from the
	 * scene (see `deferChunkMeshes`), so no new submission can reference them
	 * between this call and the fence.
	 */
	retireMeshes(meshes: readonly (Mesh | null | undefined)[]): void {
		let queued = 0;
		for (let i = 0; i < meshes.length; i++) {
			const mesh = meshes[i];
			if (mesh == null) continue;
			this.meshes.push(mesh);
			queued++;
		}
		if (queued !== 0) this.schedule();
	}

	/** Meshes and buffers awaiting the current fence. For HUD diagnostics. */
	pendingCount(): number {
		return this.meshes.length + this.storageBuffers.length;
	}

	private schedule(): void {
		// Already waiting on a fence. Anything pushed meanwhile joins the next
		// batch; there is no benefit to starting a second concurrent wait.
		if (this.scheduled) return;

		this.scheduled = true;

		const engine = Map1.engine;

		if (!engine) {
			// No engine means nothing was ever submitted against these
			// resources, so there is no fence to wait for.
			this.flush();
			return;
		}

		void onGpuWorkDone(engine)
			.catch((error: unknown) => {
				// A failed fence must not strand the batch. Disposing late is
				// what we wanted anyway; leaking is worse.
				console.warn("GPU retirement fence failed; flushing anyway", error);
			})
			.then(() => this.flush());
	}

	private flush(): void {
		this.scheduled = false;

		for (let i = 0; i < this.meshes.length; i++) {
			disposeMeshGpu(this.meshes[i]);
		}
		for (let i = 0; i < this.storageBuffers.length; i++) {
			disposeStorageBuffer(this.storageBuffers[i]);
		}

		this.meshes.length = 0;
		this.storageBuffers.length = 0;
	}
}

export const GPU_RETIREMENT_QUEUE = new GpuRetirementQueue();
