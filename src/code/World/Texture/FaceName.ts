// World/Texture/FaceName.ts

/**
 * Numeric enum for block-face identifiers used by the mesh pipeline.
 *
 * - Cardinal cube faces (Top/Bottom/North/South/East/West) and the cross
 *   shape literals (PX/NX/PZ/NZ) are produced by the emitters via
 *   `getFaceName(axis, isBackFace)` or hard-coded literals.
 * - `Side` is a generic fallback slot used by `getAtlasTile` and the
 *   particle-system texture lookup; it is never produced as a `faceName`
 *   value.
 * - `All` is the universal fallback; every populated `BlockTextureDef`
 *   has this slot set, and the hot-path lookup falls through to it when
 *   the per-face slot is `undefined`.
 *
 * Slot order is stable. `Count` is the array length used to size
 * `BlockTextureDef` arrays.
 */
export const enum FaceName {
	Top,
	Bottom,
	North,
	South,
	East,
	West,
	Side,
	PX,
	NX,
	PZ,
	NZ,
	All,
	Count,
}
export function getFaceName(axis: number, isBackFace: boolean): FaceName {
	if (axis === 0) {
		return isBackFace ? FaceName.East : FaceName.West;
	}
	if (axis === 1) {
		return isBackFace ? FaceName.Bottom : FaceName.Top;
	}
	return isBackFace ? FaceName.North : FaceName.South;
}
