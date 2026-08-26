/**
 * Mob skin layouts — one Minecraft-style box-unwrap PNG PER MOB
 * (/texture/mobs/chicken.png and /texture/mobs/sheep.png, 128x128 each),
 * mirroring how PlayerModel maps its 64x64 skin.
 *
 * Every box part owns a `MobUvSet`: six pixel rects (top/bottom/left/front/
 * right/back) laid out as the standard Minecraft box unwrap:
 *
 *          ┌──────┬──────┐
 *          │ top  │bottom│            (row height = D)
 *          ├──────┼──────┬───────┬──────┤
 *          │ left │front │ right │ back │   (row height = H)
 *          └──────┴──────┴───────┴──────┘
 *            ←D→  ←─W─→  ←─D──→  ←─W─→
 *
 * Edit each PNG in any image editor; the rects below are the map.
 * Keep this table in sync with scripts/gen-mob-skin.mjs (the generator).
 */

export const MOB_CHICKEN_SKIN_PATH = "/texture/mobs/chicken.png";
export const MOB_SHEEP_SKIN_PATH = "/texture/mobs/sheep.png";
export const MOB_SKIN_SIZE = 128;

/** Pixel rect [x0, y0, x1, y1]; y0 is the TOP edge of the rect. */
export type UvRect = readonly [number, number, number, number];

export interface MobUvSet {
	readonly front: UvRect;
	readonly back: UvRect;
	readonly right: UvRect;
	readonly left: UvRect;
	readonly top: UvRect;
	readonly bottom: UvRect;
}

/** Compute the Minecraft box unwrap for a W×H×D box at pixel offset (ox,oy). */
export function boxUvSet(
	ox: number,
	oy: number,
	width: number,
	height: number,
	depth: number,
): MobUvSet {
	const { W, H, D } = { W: width, H: height, D: depth };
	return {
		top: [ox + D, oy, ox + D + W, oy + D],
		bottom: [ox + D + W, oy, ox + D + 2 * W, oy + D],
		left: [ox, oy + D, ox + D, oy + D + H],
		front: [ox + D, oy + D, ox + D + W, oy + D + H],
		right: [ox + D + W, oy + D, ox + D + W + D, oy + D + H],
		back: [ox + D + W + D, oy + D, ox + 2 * (D + W), oy + D + H],
	};
}

// ─── Sheep ──────────────────────────────────────────────────────────────────

/** Wool body: box 16x12x24 texels. */
export const SHEEP_BODY_UV = boxUvSet(0, 0, 16, 12, 24);
/** Wool head: box 12x12x12 texels. */
export const SHEEP_HEAD_UV = boxUvSet(0, 40, 12, 12, 12);
/** Four legs, each with its own region: box 6x14x6 texels. */
export const SHEEP_LEG_FL_UV = boxUvSet(56, 40, 6, 14, 6);
export const SHEEP_LEG_FR_UV = boxUvSet(88, 40, 6, 14, 6);
export const SHEEP_LEG_BL_UV = boxUvSet(64, 64, 6, 14, 6);
export const SHEEP_LEG_BR_UV = boxUvSet(96, 64, 6, 14, 6);

// ─── Chicken ────────────────────────────────────────────────────────────────

/** Feathered body: box 10x8x6 texels. */
export const CHICKEN_BODY_UV = boxUvSet(0, 72, 10, 8, 6);
/** Feathered head: box 6x8x6 texels (paint eyes on `front`). */
export const CHICKEN_HEAD_UV = boxUvSet(40, 72, 6, 8, 6);
/** Beak: box 4x2x3 texels. */
export const CHICKEN_BEAK_UV = boxUvSet(40, 88, 4, 2, 3);
/** Wings: thin boxes 2x8x10 texels. */
export const CHICKEN_WING_L_UV = boxUvSet(0, 96, 2, 8, 10);
export const CHICKEN_WING_R_UV = boxUvSet(32, 96, 2, 8, 10);
/** Legs: boxes 3x8x3 texels. */
export const CHICKEN_LEG_L_UV = boxUvSet(64, 96, 3, 8, 3);
export const CHICKEN_LEG_R_UV = boxUvSet(84, 96, 3, 8, 3);
