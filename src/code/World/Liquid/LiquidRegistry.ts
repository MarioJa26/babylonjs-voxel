// World/Liquid/LiquidRegistry.ts
//
// Single source of truth for every liquid in the game.
//
// A liquid binds a flowing block (level 0-7 stored in the low blockState
// nibble, 0 = source) to a filled bucket item, a render bucket, flow
// parameters and gameplay effects (light, damage, screen overlay, fog).
//
// To add a liquid:
//   1. add its block id to the BlockType enum (never renumber existing ids),
//   2. add a blocks.json entry (both public/data and src/data copies),
//   3. paint its atlas tile (blockId - 1) and add a LiquidDefinition below.
//
// Worker-safe: this module is imported by the voxel mesh pipeline workers,
// so it must not touch DOM/Babylon APIs. BlockType.ts is dependency-free.

import { BlockType } from "../Texture/BlockType";

export type LiquidRenderBucket =
	/** Rendered by the animated water material (waves, blending). */
	| "water"
	/** Rendered by the alpha-tested cutout material (opaque pass). */
	| "cutout";

/**
 * Solidification rule applied when this liquid touches another liquid:
 * a source block becomes `sourceResult`, a flowing block `flowingResult`
 * (the Minecraft water + lava -> obsidian / cobblestone rule).
 */
export interface LiquidReaction {
	/** The other liquid whose contact solidifies this one. */
	readonly with: LiquidDefinition;
	/** Block a source of this liquid turns into on contact. */
	readonly sourceResult: number;
	/** Block a flowing block of this liquid turns into on contact. */
	readonly flowingResult: number;
}

export interface LiquidDefinition {
	/** Stable string key (also used by save data / debugging). */
	readonly key: string;
	/** Display name. */
	readonly name: string;
	/** Flowing block id (BlockType.*). Level living in blockState bits 0-3. */
	readonly blockId: number;
	/** Item id of the filled bucket for this liquid. */
	readonly bucketItemId: number;
	/** Which chunk mesh bucket renders this liquid. */
	readonly renderBucket: LiquidRenderBucket;
	/** Block-light emission (0-15). Water/oil are dark; lava glows. */
	readonly lightEmission: number;
	/** Scheduler delay (in ticks) used by the flow simulation. */
	readonly flowDelay: number;
	/** True when two adjacent sources spawn a new source (water rule). */
	readonly infiniteSourceFromTwo: boolean;
	/** Contact damage per second applied to the player (0 = harmless). */
	readonly damagePerSecond: number;
	/** Full-screen overlay CSS when the eye is inside this liquid. */
	readonly overlayCss: string;
	/** Three shimmer accent colors layered over the overlay. */
	readonly shimmerCss: readonly [string, string, string];
	/** Fog color while the eye is inside this liquid. */
	readonly fogColor: readonly [number, number, number];
	/** Linear fog start distance inside this liquid. */
	readonly fogStart: number;
	/** Linear fog end distance inside this liquid. */
	readonly fogEnd: number;
	/**
	 * Optional solidification reaction. A reactive liquid with a partner in
	 * reach solidifies (see LiquidReaction); liquids without one are inert.
	 */
	readonly reaction?: LiquidReaction;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * Water: the original liquid. Flows fast (one step every 5 ticks = 0.25 s
 * at 20 TPS), creates infinite sources from two adjacent sources, renders
 * in the animated water bucket.
 */
export const WATER_LIQUID: LiquidDefinition = {
	key: "water",
	name: "Water",
	blockId: BlockType.Water,
	bucketItemId: 1052,
	renderBucket: "water",
	lightEmission: 0,
	flowDelay: 5,
	infiniteSourceFromTwo: true,
	damagePerSecond: 0,
	overlayCss:
		"radial-gradient(" +
		"ellipse at center, " +
		"rgba(20,90,140,0.18) 0%, " +
		"rgba(10,50,90,0.42) 70%, " +
		"rgba(5,30,60,0.6) 100%" +
		")",
	shimmerCss: [
		"rgba(180,230,255,0.12)",
		"rgba(180,230,255,0.10)",
		"rgba(200,240,255,0.08)",
	],
	fogColor: [0.6, 0.7, 0.9],
	fogStart: 1,
	fogEnd: 100,
};

/**
 * Lava: slow, glowing, hurts on contact and never forms infinite sources.
 * Routed to the cutout bucket because the water material animates waves.
 * Touching water solidifies it: sources become obsidian, flowing lava
 * becomes cobblestone.
 */
export const LAVA_LIQUID: LiquidDefinition = {
	key: "lava",
	name: "Lava",
	blockId: BlockType.Lava,
	bucketItemId: 1053,
	renderBucket: "cutout",
	lightEmission: 15,
	flowDelay: 20,
	infiniteSourceFromTwo: false,
	damagePerSecond: 4,
	overlayCss:
		"radial-gradient(" +
		"ellipse at center, " +
		"rgba(255,140,30,0.22) 0%, " +
		"rgba(200,60,10,0.5) 70%, " +
		"rgba(90,15,0,0.72) 100%" +
		")",
	shimmerCss: [
		"rgba(255,220,140,0.14)",
		"rgba(255,180,90,0.12)",
		"rgba(255,240,190,0.10)",
	],
	fogColor: [0.55, 0.14, 0.04],
	fogStart: 0.5,
	fogEnd: 32,
	reaction: {
		with: WATER_LIQUID,
		sourceResult: BlockType.Obsidian,
		flowingResult: BlockType.Cobble,
	},
};

/**
 * Oil: thick, dark, harmless. Slightly slower than water; no light.
 */
export const OIL_LIQUID: LiquidDefinition = {
	key: "oil",
	name: "Oil",
	blockId: BlockType.Oil,
	bucketItemId: 1054,
	renderBucket: "cutout",
	lightEmission: 0,
	flowDelay: 8,
	infiniteSourceFromTwo: false,
	damagePerSecond: 0,
	overlayCss:
		"radial-gradient(" +
		"ellipse at center, " +
		"rgba(40,34,28,0.3) 0%, " +
		"rgba(20,16,12,0.58) 70%, " +
		"rgba(8,6,4,0.76) 100%" +
		")",
	shimmerCss: [
		"rgba(120,110,95,0.08)",
		"rgba(100,92,80,0.07)",
		"rgba(140,130,110,0.06)",
	],
	fogColor: [0.07, 0.06, 0.05],
	fogStart: 0.5,
	fogEnd: 48,
};

/** All registered liquids. Cauldron type index = position + 1. */
export const LIQUIDS: readonly LiquidDefinition[] = [
	WATER_LIQUID,
	LAVA_LIQUID,
	OIL_LIQUID,
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const MAX_SOURCE_ID = 1024;
const VIRTUAL_BLOCK_ID_START = 500;
const VIRTUAL_SHAPE_COUNT = 5; // Must stay in sync with BlockMaterial.ts
const VIRTUAL_BLOCK_ID_END = VIRTUAL_BLOCK_ID_START + 100 * VIRTUAL_SHAPE_COUNT;

/*
 * Uint8Array avoids signed-value handling. Zero means “not a liquid”;
 * registered liquid indexes are stored as index + 1.
 *
 * This supports up to 255 registered liquids. The cauldron state currently
 * imposes a stricter limit of three liquids.
 */
const SOURCE_TO_LIQUID = new Uint8Array(MAX_SOURCE_ID);

for (let index = 0; index < LIQUIDS.length; index++) {
	const blockId = LIQUIDS[index]!.blockId;

	if (!Number.isInteger(blockId) || blockId < 0 || blockId >= MAX_SOURCE_ID) {
		throw new RangeError(
			`Liquid "${LIQUIDS[index]!.key}" has invalid block id ${blockId}`,
		);
	}

	if (SOURCE_TO_LIQUID[blockId] !== 0) {
		throw new Error(`Duplicate liquid block id ${blockId}`);
	}

	SOURCE_TO_LIQUID[blockId] = index + 1;
}

/**
 * Resolves a virtual mason variant id back to its source block id.
 * Out-of-range ids are returned unchanged.
 */
function resolveSourceId(blockId: number): number {
	if (blockId >= VIRTUAL_BLOCK_ID_START && blockId < VIRTUAL_BLOCK_ID_END) {
		return (((blockId - VIRTUAL_BLOCK_ID_START) / VIRTUAL_SHAPE_COUNT) | 0) + 1;
	}

	return blockId;
}

/** True for registered liquid source block IDs, without virtual resolution. */
export function isLiquidSourceId(sourceId: number): boolean {
	return (
		Number.isInteger(sourceId) &&
		sourceId >= 0 &&
		sourceId < MAX_SOURCE_ID &&
		SOURCE_TO_LIQUID[sourceId]! !== 0
	);
}

/** True for liquid blocks, including virtual mason variants. */
export function isLiquidBlockId(blockId: number): boolean {
	if (!Number.isInteger(blockId)) {
		return false;
	}

	const sourceId = resolveSourceId(blockId);

	return (
		sourceId >= 0 &&
		sourceId < MAX_SOURCE_ID &&
		SOURCE_TO_LIQUID[sourceId]! !== 0
	);
}

/** Liquid definition for a source block ID, or null. */
export function getLiquidDefinitionBySourceId(
	sourceId: number,
): LiquidDefinition | null {
	if (
		!Number.isInteger(sourceId) ||
		sourceId < 0 ||
		sourceId >= MAX_SOURCE_ID
	) {
		return null;
	}

	const encodedIndex = SOURCE_TO_LIQUID[sourceId]!;

	return encodedIndex === 0 ? null : (LIQUIDS[encodedIndex - 1] ?? null);
}

/** Liquid definition for a block ID, including virtual variants, or null. */
export function getLiquidDefinitionByBlockId(
	blockId: number,
): LiquidDefinition | null {
	if (!Number.isInteger(blockId)) {
		return null;
	}

	const sourceId = resolveSourceId(blockId);

	if (sourceId < 0 || sourceId >= MAX_SOURCE_ID) {
		return null;
	}

	const encodedIndex = SOURCE_TO_LIQUID[sourceId]!;

	return encodedIndex === 0 ? null : (LIQUIDS[encodedIndex - 1] ?? null);
}

/**
 * Returns the liquid level stored in block-state bits 0–3.
 * Non-liquid blocks return zero.
 */
export function getLiquidLevel(blockId: number, state: number): number {
	if (!Number.isInteger(blockId)) {
		return 0;
	}

	const sourceId = resolveSourceId(blockId);

	return sourceId >= 0 &&
		sourceId < MAX_SOURCE_ID &&
		SOURCE_TO_LIQUID[sourceId]! !== 0
		? state & 0xf
		: 0;
}

/** True when the block is a liquid whose level nibble is zero. */
export function isLiquidSourceBlock(blockId: number, state: number): boolean {
	if (!Number.isInteger(blockId) || (state & 0xf) !== 0) {
		return false;
	}

	const sourceId = resolveSourceId(blockId);

	return (
		sourceId >= 0 &&
		sourceId < MAX_SOURCE_ID &&
		SOURCE_TO_LIQUID[sourceId]! !== 0
	);
}
// ---------------------------------------------------------------------------
// Cauldron liquid storage (BlockType.Cauldron blockState bits)
//
//   bits 0-2: fill amount, 0 (empty) .. 4 (full bucket)
//   bits 3-4: liquid type index, 0 = none, else position + 1 in LIQUIDS
//
// A bucket pour adds a full bucket (water == 1/1 bucket); the layout leaves
// room for partial fills (bottles) later without touching persistence.
// ---------------------------------------------------------------------------

export const CAULDRON_AMOUNT_MASK = 0x7;
export const CAULDRON_LIQUID_TYPE_SHIFT = 3;
export const CAULDRON_LIQUID_TYPE_MASK = 0x3;

/** Fill amount added by one bucket pour. */
export const CAULDRON_BUCKET_AMOUNT = 4;
/** Maximum fill amount. */
export const CAULDRON_MAX_AMOUNT = 4;

/** Liquid surface height (in eighths of a block) by amount 0..4. */
export const CAULDRON_SURFACE_EIGHTHS: readonly number[] = [2, 3, 4, 5, 7];

export function getCauldronAmount(state: number): number {
	return state & CAULDRON_AMOUNT_MASK;
}

export function getCauldronLiquidType(state: number): number {
	return (state >>> CAULDRON_LIQUID_TYPE_SHIFT) & CAULDRON_LIQUID_TYPE_MASK;
}

export function makeCauldronState(liquidType: number, amount: number): number {
	return (
		((liquidType & CAULDRON_LIQUID_TYPE_MASK) << CAULDRON_LIQUID_TYPE_SHIFT) |
		(amount & CAULDRON_AMOUNT_MASK)
	);
}

/** Liquid definition currently stored in a cauldron state, or null. */
export function getCauldronLiquid(state: number): LiquidDefinition | null {
	const type = getCauldronLiquidType(state);
	if (type === 0) {
		return null;
	}

	return LIQUIDS[type - 1] ?? null;
}

/** Cauldron liquid type index for a liquid definition (1-based). */
export function getCauldronLiquidTypeFor(liquid: LiquidDefinition): number {
	const index = LIQUIDS.indexOf(liquid);
	return index >= 0 ? index + 1 : 0;
}
