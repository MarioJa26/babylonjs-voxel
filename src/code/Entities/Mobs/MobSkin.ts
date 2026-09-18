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
export const MOB_COW_SKIN_PATH = "/texture/mobs/cow.png";
export const MOB_SQUID_SKIN_PATH = "/texture/mobs/squid.png";
export const MOB_FISH_SKIN_PATH = "/texture/mobs/fish.png";
export const MOB_KRAKEN_SKIN_PATH = "/texture/mobs/kraken.png";
export const MOB_ZOMBIE_SKIN_PATH = "/texture/mobs/zombie.png";
export const MOB_SKELETON_SKIN_PATH = "/texture/mobs/skeleton.png";
export const MOB_BIRD_SKIN_PATH = "/texture/mobs/bird.png";
export const MOB_SONGBIRD_SKIN_PATH = "/texture/mobs/songbird.png";
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

// ─── Cow ────────────────────────────────────────────────────────────────────

/** Cow body: box 16x12x24 texels. */
export const COW_BODY_UV = boxUvSet(0, 0, 16, 12, 24);
/** Cow head: box 10x10x10 texels. */
export const COW_HEAD_UV = boxUvSet(0, 40, 10, 10, 10);
/** Cow horns: boxes 2x2x4 texels. */
export const COW_HORN_L_UV = boxUvSet(72, 40, 2, 2, 4);
export const COW_HORN_R_UV = boxUvSet(72, 48, 2, 2, 4);
/** Four legs, each with its own region: box 6x14x6 texels. */
export const COW_LEG_FL_UV = boxUvSet(56, 40, 6, 14, 6);
export const COW_LEG_FR_UV = boxUvSet(88, 40, 6, 14, 6);
export const COW_LEG_BL_UV = boxUvSet(64, 64, 6, 14, 6);
export const COW_LEG_BR_UV = boxUvSet(96, 64, 6, 14, 6);

// ─── Squid ──────────────────────────────────────────────────────────────────

/** Squid mantle (body): box 14x10x14 texels. */
export const SQUID_BODY_UV = boxUvSet(0, 0, 14, 10, 14);
/** Squid head: box 10x6x10 texels. */
export const SQUID_HEAD_UV = boxUvSet(0, 38, 10, 6, 10);
/** Eight tentacles: each box 2x10x2 texels, own region for coloring. */
export const SQUID_TENTACLE_UVS = [
	boxUvSet(40, 0, 2, 10, 2),
	boxUvSet(48, 0, 2, 10, 2),
	boxUvSet(56, 0, 2, 10, 2),
	boxUvSet(64, 0, 2, 10, 2),
	boxUvSet(40, 16, 2, 10, 2),
	boxUvSet(48, 16, 2, 10, 2),
	boxUvSet(56, 16, 2, 10, 2),
	boxUvSet(64, 16, 2, 10, 2),
] as const;

// ─── Fish ───────────────────────────────────────────────────────────────────

/** Fish body: box 10x6x8 texels. */
export const FISH_BODY_UV = boxUvSet(0, 0, 10, 6, 8);
/** Fish tail: box 6x6x2 texels. */
export const FISH_TAIL_UV = boxUvSet(36, 0, 6, 6, 2);
/** Dorsal fin: box 4x4x1 texels. */
export const FISH_FIN_TOP_UV = boxUvSet(36, 10, 4, 4, 1);
/** Pectoral fins: boxes 3x3x1 texels. */
export const FISH_FIN_L_UV = boxUvSet(48, 10, 3, 3, 1);
export const FISH_FIN_R_UV = boxUvSet(56, 10, 3, 3, 1);

// ─── Kraken ────────────────────────────────────────────────────────────────

/** Kraken mantle: box 24x16x24 texels. */
export const KRAKEN_BODY_UV = boxUvSet(0, 0, 24, 16, 24);
/** Kraken head: box 18x12x18 texels. */
export const KRAKEN_HEAD_UV = boxUvSet(0, 48, 18, 12, 18);
/** Kraken beak: box 4x4x4 texels. */
export const KRAKEN_BEAK_UV = boxUvSet(72, 48, 4, 4, 4);
/** Eight large tentacles: each box 4x18x4 texels. */
export const KRAKEN_TENTACLE_UVS = [
	boxUvSet(72, 0, 4, 18, 4),
	boxUvSet(84, 0, 4, 18, 4),
	boxUvSet(96, 0, 4, 18, 4),
	boxUvSet(108, 0, 4, 18, 4),
	boxUvSet(72, 24, 4, 18, 4),
	boxUvSet(84, 24, 4, 18, 4),
	boxUvSet(96, 24, 4, 18, 4),
	boxUvSet(108, 24, 4, 18, 4),
] as const;

// ─── Zombie ─────────────────────────────────────────────────────────────────
// Humanoid: torso + head + two arms + two legs. Own 128x128 file, so the
// layout only has to be self-consistent (and match generate-mob-skins.mjs).

/** Zombie torso: box 8x12x4 texels (player-sized). */
export const ZOMBIE_BODY_UV = boxUvSet(0, 0, 8, 12, 4);
/** Zombie head: box 8x8x8 texels (player-sized). */
export const ZOMBIE_HEAD_UV = boxUvSet(0, 32, 8, 8, 8);
/** Zombie arms: boxes 4x12x4 texels (player-sized). */
export const ZOMBIE_ARM_L_UV = boxUvSet(48, 32, 4, 12, 4);
export const ZOMBIE_ARM_R_UV = boxUvSet(68, 32, 4, 12, 4);
/** Zombie legs: boxes 4x12x4 texels (player-sized). */
export const ZOMBIE_LEG_L_UV = boxUvSet(48, 56, 4, 12, 4);
export const ZOMBIE_LEG_R_UV = boxUvSet(80, 56, 4, 12, 4);

// ─── Skeleton ───────────────────────────────────────────────────────────────
// Same humanoid layout as the zombie (own file).

/** Skeleton ribcage: box 16x12x8 texels. */
export const SKELETON_BODY_UV = boxUvSet(0, 0, 16, 12, 8);
/** Skeleton skull: box 10x10x10 texels. */
export const SKELETON_HEAD_UV = boxUvSet(0, 32, 10, 10, 10);
/** Skeleton arms: boxes 5x12x5 texels. */
export const SKELETON_ARM_L_UV = boxUvSet(48, 32, 5, 12, 5);
export const SKELETON_ARM_R_UV = boxUvSet(68, 32, 5, 12, 5);
/** Skeleton legs: boxes 6x14x6 texels. */
export const SKELETON_LEG_L_UV = boxUvSet(48, 56, 6, 14, 6);
export const SKELETON_LEG_R_UV = boxUvSet(80, 56, 6, 14, 6);

// ─── Bird ───────────────────────────────────────────────────────────────────
// Small flier: body + head + beak + tail + two flapping wings + tiny legs.
// Own 128x128 file, so the layout only has to be self-consistent (and match
// scripts/generate-mob-skins.mjs).

/** Bird body: box 8x6x10 texels. */
export const BIRD_BODY_UV = boxUvSet(0, 0, 8, 6, 10);
/** Bird head: box 6x6x6 texels. */
export const BIRD_HEAD_UV = boxUvSet(0, 20, 6, 6, 6);
/** Bird beak: box 3x2x2 texels. */
export const BIRD_BEAK_UV = boxUvSet(0, 36, 3, 2, 2);
/** Bird tail: box 6x2x4 texels. */
export const BIRD_TAIL_UV = boxUvSet(0, 44, 6, 2, 4);
/** Bird wings: thin boxes 8x2x6 texels, animated with partIds 5/6. */
export const BIRD_WING_L_UV = boxUvSet(40, 0, 8, 2, 6);
export const BIRD_WING_R_UV = boxUvSet(40, 12, 8, 2, 6);
/** Bird legs: tiny boxes 2x3x2 texels (dangle in flight, stand perched). */
export const BIRD_LEG_L_UV = boxUvSet(72, 0, 2, 3, 2);
export const BIRD_LEG_R_UV = boxUvSet(72, 8, 2, 3, 2);

// ─── Songbird ───────────────────────────────────────────────────────────────
// Same small-flier layout as the bird (own file, warmer palette).

/** Songbird body: box 7x5x9 texels. */
export const SONGBIRD_BODY_UV = boxUvSet(0, 0, 7, 5, 9);
/** Songbird head: box 5x5x5 texels. */
export const SONGBIRD_HEAD_UV = boxUvSet(0, 20, 5, 5, 5);
/** Songbird beak: box 2x2x2 texels. */
export const SONGBIRD_BEAK_UV = boxUvSet(0, 36, 2, 2, 2);
/** Songbird tail: box 5x2x4 texels. */
export const SONGBIRD_TAIL_UV = boxUvSet(0, 44, 5, 2, 4);
/** Songbird wings: thin boxes 7x2x5 texels, animated with partIds 5/6. */
export const SONGBIRD_WING_L_UV = boxUvSet(40, 0, 7, 2, 5);
export const SONGBIRD_WING_R_UV = boxUvSet(40, 12, 7, 2, 5);
/** Songbird legs: tiny boxes 2x3x2 texels. */
export const SONGBIRD_LEG_L_UV = boxUvSet(72, 0, 2, 3, 2);
export const SONGBIRD_LEG_R_UV = boxUvSet(72, 8, 2, 3, 2);
