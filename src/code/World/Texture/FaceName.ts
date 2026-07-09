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
const FACE_NAME_LUT: FaceName[][] = [
	[FaceName.West, FaceName.East],
	[FaceName.Top, FaceName.Bottom],
	[FaceName.South, FaceName.North],
];

export function getFaceName(axis: number, isBackFace: boolean): FaceName {
	return FACE_NAME_LUT[axis][+isBackFace];
}
