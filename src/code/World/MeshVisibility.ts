import { type Mesh, setMeshVisible } from "@babylonjs/lite";

/**
 * Two independent visibility gates:
 *
 *   visible = base && !culled
 *
 * All effective visibility changes must pass through `setMeshVisible` so
 * Babylon Lite can invalidate cached render bundles when necessary.
 */
interface GatedMesh extends Mesh {
	__visBase?: boolean;
	__visCulled?: boolean;
}

function applyMeshVisibility(mesh: GatedMesh): void {
	const visible = mesh.__visBase !== false && mesh.__visCulled !== true;

	// An undefined `visible` field has the same effective meaning as `true`.
	// Avoid an unnecessary initial write and visibility-epoch bump.
	if ((mesh.visible ?? true) === visible) return;

	setMeshVisible(mesh, visible);
}

/**
 * Updates the frustum/BFS culling gate.
 */
export function setMeshCulled(
	mesh: Mesh | null | undefined,
	culled: boolean,
): void {
	if (mesh == null) return;

	const gatedMesh = mesh as GatedMesh;
	if (gatedMesh.__visCulled === culled) return;

	gatedMesh.__visCulled = culled;
	applyMeshVisibility(gatedMesh);
}

/**
 * Updates the owning subsystem's visibility gate.
 */
export function setMeshBaseVisible(
	mesh: Mesh | null | undefined,
	base: boolean,
): void {
	if (mesh == null) return;

	const gatedMesh = mesh as GatedMesh;
	if (gatedMesh.__visBase === base) return;

	gatedMesh.__visBase = base;
	applyMeshVisibility(gatedMesh);
}

export function isMeshCulled(mesh: Mesh | null | undefined): boolean {
	return mesh != null && (mesh as GatedMesh).__visCulled === true;
}

/**
 * Transfers the current culling decision to a replacement mesh.
 */
export function carryMeshCulled(from: Mesh | null | undefined, to: Mesh): void {
	if (from == null || from === to) return;

	setMeshCulled(to, (from as GatedMesh).__visCulled === true);
}
