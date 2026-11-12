// ---------------------------------------------------------------------------
// StructureColumnTops: how high does a structure reach in a world column?
//
// WHY THIS EXISTS
// ---------------
// The streaming controller decides which chunk-Y layers of a column can be
// skipped as "provably empty sky". Its bound was the terrain heightmap —
// which knows nothing about structures. A tower is a solid cylinder 60-80
// blocks of stone standing ON the terrain, so it lives in exactly the layers
// that bound would skip.
//
// The consequences were asymmetric and confusing:
//   * the initial shell (join / teleport) has no such bound, so the tower's
//     upper chunks were created and showed up;
//   * the movement path and the LOD refresh DO have it, so once the player
//     moved those chunks were never created again, and the ones that did
//     exist were never re-evaluated — their LOD froze.
//
// This module answers the missing question: for a given world column, how
// high does any structure reach? Features opt in by implementing
// `IWorldFeature.columnTopHeight`.
//
// The query is only consulted for columns the streaming controller already
// has a profile for, and each feature memoises its own answer, so the cost
// is a region hash per feature per column — no heightmap sampling for the
// vast majority of columns.
// ---------------------------------------------------------------------------

import { createWorldFeatures } from "../WorldFeatures";
import type { IWorldFeature } from "./IWorldFeature";

const features: IWorldFeature[] = createWorldFeatures();

/**
 * Features that implement the column-top query. Most features never rise
 * above the terrain, so this list is short and the per-column cost is a
 * handful of region hashes.
 */
type HeightFeature = IWorldFeature &
	Required<Pick<IWorldFeature, "columnTopHeight">>;

const heightFeatures: HeightFeature[] = features.filter(
	(feature): feature is HeightFeature => feature.columnTopHeight !== undefined,
);

/**
 * Highest world Y a structure reaches in the column containing
 * (worldX, worldZ), or -1 when nothing stands above the terrain there.
 */
export function structureColumnTopY(
	worldX: number,
	worldZ: number,
	seed: number,
): number {
	let top = -1;

	for (let i = 0; i < heightFeatures.length; i++) {
		const feature = heightFeatures[i];
		const height = feature.columnTopHeight(worldX, worldZ, seed);
		if (height > top) {
			top = height;
		}
	}

	return top;
}
