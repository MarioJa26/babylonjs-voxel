import { type Mesh, setMeshVisible } from "@babylonjs/lite";

/**
 * Two independent visibility gates:
 *
 *   visible = baseVisible && !culled
 *
 * Default values are represented by missing properties:
 *
 *   __visBase === undefined   means true
 *   __visCulled === undefined means false
 *
 * All effective visibility changes pass through setMeshVisible so Babylon
 * Lite can invalidate cached render bundles when necessary.
 */
interface GatedMesh extends Mesh {
	__visBase?: false;
	__visCulled?: true;
}

function applyMeshVisibility(mesh: GatedMesh): void {
	const shouldBeVisible = mesh.__visBase !== false && mesh.__visCulled !== true;

	/*
	 * An undefined visible field has the same effective meaning as true.
	 * Avoid unnecessary writes and Babylon visibility-epoch invalidation.
	 */
	if ((mesh.visible ?? true) === shouldBeVisible) {
		return;
	}

	setMeshVisible(mesh, shouldBeVisible);
}

/**
 * Updates the frustum/BFS culling gate.
 */
export function setMeshCulled(
	mesh: Mesh | null | undefined,
	culled: boolean,
): void {
	if (mesh == null) {
		return;
	}

	const gatedMesh = mesh as GatedMesh;
	const currentlyCulled = gatedMesh.__visCulled === true;

	if (currentlyCulled !== culled) {
		/*
		 * Store only the non-default state. Deleting the property restores
		 * the default without retaining an explicit false value.
		 */
		if (culled) {
			gatedMesh.__visCulled = true;
		} else {
			delete gatedMesh.__visCulled;
		}
	}

	/*
	 * Apply even when the gate is unchanged. Another subsystem could have
	 * changed mesh.visible directly since the previous call.
	 */
	applyMeshVisibility(gatedMesh);
}

/**
 * Updates the owning subsystem's visibility gate.
 */
export function setMeshBaseVisible(
	mesh: Mesh | null | undefined,
	baseVisible: boolean,
): void {
	if (mesh == null) {
		return;
	}

	const gatedMesh = mesh as GatedMesh;
	const currentlyBaseVisible = gatedMesh.__visBase !== false;

	if (currentlyBaseVisible !== baseVisible) {
		/*
		 * Store only false because true is the default represented by an
		 * absent property.
		 */
		if (baseVisible) {
			delete gatedMesh.__visBase;
		} else {
			gatedMesh.__visBase = false;
		}
	}

	applyMeshVisibility(gatedMesh);
}

export function isMeshCulled(mesh: Mesh | null | undefined): boolean {
	return mesh != null && (mesh as GatedMesh).__visCulled === true;
}

/**
 * Transfers the current culling decision to a replacement mesh.
 *
 * The destination mesh keeps its own base-visibility gate.
 */
export function carryMeshCulled(from: Mesh | null | undefined, to: Mesh): void {
	if (from == null || from === to) {
		return;
	}

	setMeshCulled(to, (from as GatedMesh).__visCulled === true);
}
