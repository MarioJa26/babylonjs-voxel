// ─── Smithing tools as placed blocks ───
//
// A smithing tool is both a held item and a placeable block. Placing one in a
// station's work area raises what that station can do — Valheim's model, where
// your workshop's power depends on the gear around it rather than on what your
// hand is holding.
//
// The wear lives in the block's `blockState`, which costs nothing:
//
//   bits 0-2  wear tier, 0 (fresh) to 7 (spent)
//   bits 3-5  free
//
// `Item.place` passes `item.blockState` through untouched for a shape with
// neither `usesSliceState` nor `rotateY`, so a plain cube tool block keeps all six
// bits (verified: TextureDefinitions/Item.place leave it alone for non-slice
// shapes). Block state is part of the packed chunk voxel, so it persists through
// the normal save path and replicates over the wire for free. That is why this
// needs no per-block store, unlike smelt progress.

import { MaterialTier } from "@/code/Player/Inventory/Materials/MaterialTier";
import { BlockType } from "@/code/World/Texture/BlockType";

/** Bits 0-2 hold the wear tier. */
export const TOOL_WEAR_MASK = 7;
/** First blockState value at which a placed tool has stopped contributing. */
export const TOOL_SPENT_WEAR = 7;

/** Kinds of smithing tool, in a stable order that the block ids follow. */
export type SmithToolKind =
	| "hammer"
	| "tongs"
	| "chisel"
	| "graver"
	| "burin"
	| "rune_engraver"
	| "underworldbrand";

export const SMITH_TOOL_KINDS: readonly SmithToolKind[] = [
	"hammer",
	"tongs",
	"chisel",
	"graver",
	"burin",
	"rune_engraver",
	"underworldbrand",
];

/**
 * Base block id for placed smithing tools. Each (kind, tier) pair is its own
 * block so the tier is visible in the world — a stone hammer and an iron hammer
 * that look identical would defeat the point of placing them.
 */
export const SMITH_TOOL_BLOCK_BASE = BlockType.SmithToolHammer;
export const SMITH_TOOL_TIER_COUNT = 6;

/** The six tiers a smithing tool can be made at, ascending. */
export const SMITH_TOOL_TIERS: readonly MaterialTier[] = [
	MaterialTier.Stone, // 2
	MaterialTier.Bronze, // 3
	MaterialTier.Iron, // 4
	MaterialTier.ReinforcedIron, // 5
	MaterialTier.ReinforcedSilver, // 7
	MaterialTier.UnderworldIron, // 8
];

export interface SmithToolDef {
	kind: SmithToolKind;
	tier: MaterialTier;
	blockId: BlockType;
	/** Item id placed when the block is broken back out. */
	itemId: number;
}

/** Block id -> definition, so the work-area scan is a lookup rather than math. */
const BY_BLOCK = new Map<number, SmithToolDef>();
const BY_ITEM = new Map<number, SmithToolDef>();
/** Block ids per kind, ascending by tier, for "best tool of this kind nearby". */
const BLOCKS_BY_KIND = new Map<SmithToolKind, number[]>();

function register(def: SmithToolDef): void {
	BY_BLOCK.set(def.blockId, def);
	BY_ITEM.set(def.itemId, def);
	const list = BLOCKS_BY_KIND.get(def.kind);
	if (list === undefined) BLOCKS_BY_KIND.set(def.kind, [def.blockId]);
	else list.push(def.blockId);
}

// The table is generated from the two kind/tier lists so the block enum, the
// item ids and the definitions cannot drift apart. Item ids are allocated from
// the Phase 3c block: SmithToolHammer base.
for (let kindIndex = 0; kindIndex < SMITH_TOOL_KINDS.length; kindIndex++) {
	const kind = SMITH_TOOL_KINDS[kindIndex]!;
	for (let tierIndex = 0; tierIndex < SMITH_TOOL_TIERS.length; tierIndex++) {
		const offset = kindIndex * SMITH_TOOL_TIER_COUNT + tierIndex;
		register({
			kind,
			tier: SMITH_TOOL_TIERS[tierIndex]!,
			blockId: (SMITH_TOOL_BLOCK_BASE + offset) as BlockType,
			itemId: SMITH_TOOL_BLOCK_BASE + offset,
		});
	}
}

export function smithToolForBlock(blockId: number): SmithToolDef | undefined {
	return BY_BLOCK.get(blockId);
}

export function smithToolForItem(itemId: number): SmithToolDef | undefined {
	return BY_ITEM.get(itemId);
}

export function isSmithToolBlock(blockId: number): boolean {
	return BY_BLOCK.has(blockId);
}

/** Every block id of a given kind, ascending by tier. */
export function smithToolBlocksForKind(kind: SmithToolKind): readonly number[] {
	return BLOCKS_BY_KIND.get(kind) ?? [];
}

// ─── blockState wear ───

export function wearFromBlockState(blockState: number): number {
	return blockState & TOOL_WEAR_MASK;
}

/** A placed tool that has reached the last wear tier. */
export function isBlockStateSpent(blockState: number): boolean {
	return wearFromBlockState(blockState) >= TOOL_SPENT_WEAR;
}

/** Fresh tool: wear 0. */
export function freshBlockState(): number {
	return 0;
}

/**
 * Increment the wear tier. Returns the same state when already spent, so a
 * craft on a dead tool cannot overflow the field.
 */
export function advanceBlockState(blockState: number): number {
	const wear = wearFromBlockState(blockState);
	if (wear >= TOOL_SPENT_WEAR) return blockState;
	return (blockState & ~TOOL_WEAR_MASK) | (wear + 1);
}

/** Remaining durability fraction, for a durability bar on a placed tool. */
export function wearFraction(blockState: number): number {
	return 1 - wearFromBlockState(blockState) / TOOL_SPENT_WEAR;
}

/**
 * Mapping from placed-tool wear back to an item durability on retrieval.
 *
 * A spent tool must not come back pristine: breaking a dead hammer and picking it
 * up would be a free repair.
 */
export function durabilityFromWear(
	blockState: number,
	maxDurability: number,
): number {
	return Math.round(wearFraction(blockState) * maxDurability);
}
