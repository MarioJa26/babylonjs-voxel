import { type Mesh, setMeshVisible } from "@babylonjs/lite";

/**
 * Two independent visibility gates per mesh, composed into one flag:
 *
 *   visible = base && !culled
 *
 * lite's draw path reads ONLY `mesh.visible` (`render-task-base.js` skips a
 * binding whose `mesh.visible === false`, and the opaque render bundle is
 * re-recorded only when the visibility epoch bumps). A Babylon-style
 * `isVisible` field is never read by the engine, and a raw `mesh.visible = x`
 * write does not re-record an already-cached bundle — so every write must go
 * through `setMeshVisible`, which bumps that epoch exactly when the value
 * changes.
 *
 * `base` is the owning subsystem's toggle (F6 far tiles, F7 packed chunks, the
 * arena-failure hide in PackedChunkMesh). `culled` is the per-mesh cull
 * decision (frustum / BFS reachability). Keeping them separate means a
 * diagnostic toggle cannot resurrect a culled mesh, and a remesh that re-applies
 * `base` cannot either.
 */
interface GatedMesh extends Mesh {
	__visBase?: boolean;
	__visCulled?: boolean;
}

function applyMeshVisibility(mesh: GatedMesh): void {
	const want = mesh.__visBase !== false && mesh.__visCulled !== true;

	// `visible` starts undefined (= visible), so compare against that default
	// instead of forcing a write that would bump the epoch on first use.
	if ((mesh.visible ?? true) !== want) setMeshVisible(mesh, want);
}

/**
 * Cull decision (frustum / BFS reachability). Composes with the base gate.
 * Group mesh refs are `null` while a layer has no geometry yet — nothing to
 * gate, and the next sweep re-applies once a mesh exists (`groupsMutated`
 * forces that sweep), so this is a pure no-op rather than an error.
 */
export function setMeshCulled(
	mesh: Mesh | null | undefined,
	culled: boolean,
): void {
	if (!mesh) return;
	const m = mesh as GatedMesh;
	if (m.__visCulled === culled) return;
	m.__visCulled = culled;
	applyMeshVisibility(m);
}

/** Subsystem toggle: F6 far tiles, F7 packed chunks, arena-failure hide. */
export function setMeshBaseVisible(
	mesh: Mesh | null | undefined,
	base: boolean,
): void {
	if (!mesh) return;
	const m = mesh as GatedMesh;
	if (m.__visBase === base) return;
	m.__visBase = base;
	applyMeshVisibility(m);
}

export function isMeshCulled(mesh: Mesh | null | undefined): boolean {
	return !!mesh && (mesh as GatedMesh).__visCulled === true;
}

/**
 * Carry the cull decision onto a replacement mesh object. A rebuild that has
 * to allocate a fresh mesh starts from `culled === undefined`, which would
 * draw the group for a frame until the next sweep happens to revisit it —
 * and rebuilds run constantly during streaming, so that frame is not rare.
 */
export function carryMeshCulled(from: Mesh | null | undefined, to: Mesh): void {
	if (!from || from === to) return;
	setMeshCulled(to, (from as GatedMesh).__visCulled === true);
}
