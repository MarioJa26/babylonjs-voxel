import type { Mesh, Vec3 } from "@babylonjs/lite";

/**
 * Duck-typed "hit landed on a dynamically-moved boat chunk" payload carried
 * in BlockRaycastHit.dynamicContext. Shared by the highlight, cracking and
 * actual block-edit paths, which must all validate it the same way before
 * trusting it.
 */
export type BoatBlockHitContext = {
	kind: "boatChunk";
	boatChunk: {
		visualRoot: Mesh;
		center: Vec3;
		setBlockLocal(
			x: number,
			y: number,
			z: number,
			blockId: number,
			blockState?: number,
		): void;
	};
	localX: number;
	localY: number;
	localZ: number;
};

/**
 * Validate an unknown dynamicContext as a boat hit context. Returns null
 * unless the shape matches (kind, numeric locals, and a boatChunk exposing
 * the visual root and center the renderers parent to).
 */
export function resolveBoatBlockContext(
	context: unknown,
): BoatBlockHitContext | null {
	if (!context || typeof context !== "object") return null;

	const value = context as {
		kind?: unknown;
		boatChunk?: {
			visualRoot?: unknown;
			center?: unknown;
		};
		localX?: unknown;
		localY?: unknown;
		localZ?: unknown;
	};

	if (value.kind !== "boatChunk" || !value.boatChunk) return null;

	if (!value.boatChunk.visualRoot || !value.boatChunk.center) return null;

	if (
		typeof value.localX !== "number" ||
		typeof value.localY !== "number" ||
		typeof value.localZ !== "number"
	) {
		return null;
	}

	return {
		kind: "boatChunk",
		boatChunk: value.boatChunk as BoatBlockHitContext["boatChunk"],
		localX: value.localX,
		localY: value.localY,
		localZ: value.localZ,
	};
}
