// Kept dependency-free so the smelt maths stays testable under node. `BlockType`
// is a bare enum with no imports of its own, so this costs nothing.
import { BlockType } from "@/code/World/Texture/BlockType";

// ─── Stations ───
//
// Kiln, furnace, crucible, anvil, whetstone and smeltery share one model: a
// block with persistent per-position state that turns input into output over
// time, optionally burning fuel to do it.
//
// Kept free of DOM, `Item` and the block registry so the smelt maths can be
// tested directly — `StationManager` needs all three and is therefore not
// loadable under node.
//
// Design note: a station has no intrinsic power of its own. It has a *cap*
// (Phase 3c, raised by placing a tool nearby) and the work area supplies the
// *tool tier*; the effective tier is `min(cap, toolTier)`. Phase 3a has no tool
// blocks, so recipes here carry no `minTier` and every station works at full.

export type StationKind =
	| "kiln"
	| "whetstone"
	| "furnace"
	| "crucible"
	| "anvil"
	| "smeltery";

export const STATION_KINDS: readonly StationKind[] = [
	"kiln",
	"whetstone",
	"furnace",
	"crucible",
	"anvil",
	"smeltery",
];

/**
 * Station kinds that exist in Phase 3c.
 *
 * Previously only three kinds shipped and the server refused the rest; all six
 * are now declared and have a block. Kept as a named export because the server
 * uses it to gate `StationOpen`.
 */
export const PHASE_3A_STATION_KINDS: readonly StationKind[] = STATION_KINDS;

/** Ticks per second. Matches BlockTickScheduler's 20 Hz ring. */
export const STATION_TICKS_PER_SECOND = 20;

export type ItemStack = { itemId: number; stackSize: number };

/**
 * One thing a station can do.
 *
 * `inputId` 0 means "no input slot needed" — a kiln turns wood into charcoal
 * with nothing but fuel, and a whetstone repairs whatever tool is present.
 * `resultId` 0 marks a repair-only station.
 */
export interface StationRecipe {
	kind: StationKind;
	inputId: number;
	resultId: number;
	resultCount: number;
	/** Ticks of work per craft. */
	smeltTicks: number;
	/** Whether this station needs fuel in the fuel slot to work at all. */
	usesFuel: boolean;
	/**
	 * When true the fuel slot *is* the material slot: one unit per craft,
	 * consumed on completion, and the burn timer is only a lit/flame indicator.
	 * A kiln burns wood into charcoal this way — there is nothing to put in an
	 * input slot.
	 *
	 * When false, fuel is fuel: one unit is consumed when a burn starts and
	 * supplies many ticks, while the input slot supplies the material.
	 */
	fuelIsMaterial?: boolean;
	/** Durability restored per craft, for repair-only stations. */
	repairAmount?: number;
	/** Minimum material tier, checked against `min(cap, toolTier)`. Phase 3c. */
	minTier?: number;
}

/**
 * Burn ticks granted per unit of fuel.
 *
 * Sized so a single unit of the cheapest fuel covers a whole typical craft:
 * one plank must finish one iron ore (240 ticks). Being short makes a player
 * watch fuel evaporate for no result, which reads as a bug rather than a cost.
 */
export const FUELS: Readonly<Record<number, number>> = {
	35: 240, // Wood Planks
	10: 240, // Bark (Willow)
	19: 240, // Pine Bark
	14: 240, // Bark Brown 02
	1016: 100, // Stick
	1124: 800, // Charcoal
	1019: 1600, // Coal
};

export function fuelValueFor(itemId: number): number {
	return FUELS[itemId] ?? 0;
}

export function isFuel(itemId: number): boolean {
	return fuelValueFor(itemId) > 0;
}

// ─── Item ids used by the Phase 3a recipes ───
export const ITEM_PLANKS = 35;
export const ITEM_COAL = 1019;
export const ITEM_CHARCOAL = 1124;
export const ITEM_IRON_INGOT = 1021;
export const ITEM_GOLD_INGOT = 1025;
export const ITEM_COPPER_INGOT = 1026;

// Block ids of the smeltable ores, which match their auto-registered items.
export const ORE_COAL = 96;
export const ORE_COPPER = 97;
export const ORE_GOLD = 98;
export const ORE_IRON = 99;

// ─── Item ids introduced by Phase 3c ───
export const ITEM_TIN_INGOT = 1125;
export const ITEM_BRONZE_INGOT = 1126;
export const ITEM_IRON_WIRE = 1127;
export const ITEM_LEATHER_CHAIN = 1128;
export const ITEM_BRONZE_CHAIN = 1129;
export const ITEM_IRON_CHAIN = 1130;
export const ITEM_UNDERWORLD_CHAIN = 1131;

export const STATION_RECIPES: readonly StationRecipe[] = [
	// Kiln: burns whatever fuel is in the slot into charcoal.
	//
	// Only one kiln recipe, deliberately. Recipes are indexed by `inputId`, and a
	// fuel-as-material station has no input — so two kiln recipes would share the
	// key 0 and the second would silently overwrite the first. Fuel varies, the
	// product does not.
	{
		kind: "kiln",
		inputId: 0,
		resultId: ITEM_CHARCOAL,
		resultCount: 1,
		smeltTicks: 160,
		usesFuel: true,
		fuelIsMaterial: true,
	},
	// Furnace: ore -> ingot. Needs both an input and a fuel.
	{
		kind: "furnace",
		inputId: ORE_COAL,
		resultId: ITEM_COAL,
		resultCount: 1,
		smeltTicks: 200,
		usesFuel: true,
	},
	{
		kind: "furnace",
		inputId: ORE_IRON,
		resultId: ITEM_IRON_INGOT,
		resultCount: 1,
		smeltTicks: 240,
		usesFuel: true,
	},
	{
		kind: "furnace",
		inputId: ORE_COPPER,
		resultId: ITEM_COPPER_INGOT,
		resultCount: 1,
		smeltTicks: 200,
		usesFuel: true,
	},
	{
		kind: "furnace",
		inputId: ORE_GOLD,
		resultId: ITEM_GOLD_INGOT,
		resultCount: 1,
		smeltTicks: 280,
		usesFuel: true,
	},
	{
		kind: "furnace",
		inputId: BlockType.TinOre,
		resultId: ITEM_TIN_INGOT,
		resultCount: 1,
		smeltTicks: 220,
		usesFuel: true,
	},
	// Whetstone: repairs whatever tool sits in the input slot. `resultId: 0`
	// marks it as a repair and `repairAmount` says how much comes back. This is
	// the only catch-all, which is why `findStationRecipe` may fall back to it
	// for a non-empty slot.
	{
		kind: "whetstone",
		inputId: 0,
		resultId: 0,
		resultCount: 0,
		smeltTicks: 60,
		usesFuel: false,
		repairAmount: 25,
	},
	// ─── Crucible (Phase 3c) ───
	// Melts an ingot back to raw metal so a mis-smelt is recoverable, and
	// repairs in one pass instead of the whetstone's four. Alloys themselves are
	// crafting recipes gated on this station, not smelts: mixing two metals does
	// not fit a single input slot.
	{
		kind: "crucible",
		inputId: ITEM_IRON_INGOT,
		resultId: ORE_IRON,
		resultCount: 1,
		smeltTicks: 120,
		usesFuel: true,
		minTier: 3,
	},
	{
		kind: "crucible",
		inputId: ITEM_COPPER_INGOT,
		resultId: ORE_COPPER,
		resultCount: 1,
		smeltTicks: 120,
		usesFuel: true,
		minTier: 3,
	},
	{
		kind: "crucible",
		inputId: ITEM_GOLD_INGOT,
		resultId: ORE_GOLD,
		resultCount: 1,
		smeltTicks: 160,
		usesFuel: true,
		minTier: 3,
	},
	{
		kind: "crucible",
		inputId: ITEM_BRONZE_INGOT,
		resultId: ITEM_BRONZE_INGOT,
		resultCount: 1,
		smeltTicks: 90,
		usesFuel: true,
		minTier: 3,
	},
	{
		kind: "crucible",
		inputId: 0,
		resultId: 0,
		resultCount: 0,
		smeltTicks: 100,
		usesFuel: false,
		repairAmount: 100,
	},
	// ─── Anvil (Phase 3c) ───
	// Chainmaking is two station steps rather than two crafting recipes, because
	// both are single-input transforms that fit a station slot: draw the wire,
	// then weave it. Alloys stay in CraftMenu because mixing two metals does not.
	{
		kind: "anvil",
		inputId: ITEM_IRON_INGOT,
		resultId: ITEM_IRON_WIRE,
		resultCount: 2,
		smeltTicks: 120,
		usesFuel: false,
		minTier: 4,
	},
	{
		kind: "anvil",
		inputId: ITEM_IRON_WIRE,
		resultId: ITEM_IRON_CHAIN,
		resultCount: 1,
		smeltTicks: 160,
		usesFuel: false,
		minTier: 4,
	},
	{
		kind: "anvil",
		inputId: ITEM_BRONZE_INGOT,
		resultId: ITEM_BRONZE_CHAIN,
		resultCount: 1,
		smeltTicks: 200,
		usesFuel: false,
		minTier: 3,
	},
	{
		kind: "anvil",
		inputId: 1119, // Leather
		resultId: ITEM_LEATHER_CHAIN,
		resultCount: 1,
		smeltTicks: 100,
		usesFuel: false,
		minTier: 2,
	},
	// ─── Smeltery (Phase 3c) ───
	// T6+: the reinforced alloys and a full repair in one pass.
	{
		kind: "smeltery",
		inputId: 0,
		resultId: 0,
		resultCount: 0,
		smeltTicks: 200,
		usesFuel: false,
		repairAmount: 65535,
		minTier: 6,
	},
];

/** Recipes for one station kind, indexed by input item id for O(1) lookup. */
const RECIPES_BY_KIND = new Map<StationKind, Map<number, StationRecipe>>();

for (const recipe of STATION_RECIPES) {
	let byInput = RECIPES_BY_KIND.get(recipe.kind);
	if (byInput === undefined) {
		byInput = new Map<number, StationRecipe>();
		RECIPES_BY_KIND.set(recipe.kind, byInput);
	}
	if (byInput.has(recipe.inputId)) {
		// Two recipes sharing an index key means one is unreachable. Surface it
		// loudly rather than letting a later entry silently win.
		throw new Error(
			`StationTypes: duplicate recipe key ${recipe.kind}/${recipe.inputId}`,
		);
	}
	byInput.set(recipe.inputId, recipe);
}

/**
 * Recipe for `kind` given the current input item.
 *
 * Falls back to the `inputId: 0` entry in two cases only:
 *   - the slot is empty; or
 *   - that entry is a repair station (resultId 0), which by definition accepts
 *     any item.
 *
 * Never falls back for a slot holding something the station cannot otherwise
 * process — quietly burning a diamond ore in a kiln would be worse than doing
 * nothing.
 */
export function findStationRecipe(
	kind: StationKind,
	inputItemId: number,
): StationRecipe | undefined {
	const byInput = RECIPES_BY_KIND.get(kind);
	if (byInput === undefined) return undefined;

	const exact = byInput.get(inputItemId);
	if (exact !== undefined) return exact;

	const catchAll = byInput.get(0);
	if (catchAll === undefined) return undefined;

	if (inputItemId === 0) return catchAll;
	return catchAll.resultId === 0 ? catchAll : undefined;
}

/** Whether a station accepts an item into its input slot. */
export function canProcess(kind: StationKind, itemId: number): boolean {
	const byInput = RECIPES_BY_KIND.get(kind);
	if (byInput === undefined) return false;
	if (byInput.has(itemId)) return true;
	// A repair-only station (resultId 0) takes anything, but the caller still
	// has to check the item is actually durable.
	const catchAll = byInput.get(0);
	return catchAll !== undefined && catchAll.resultId === 0;
}

// ─── Runtime state ───

export interface StationState {
	kind: StationKind;
	/** Material tier ceiling. Raised by placing a tool; Phase 3c. */
	capTier: number;
	input: ItemStack | null;
	fuel: ItemStack | null;
	output: ItemStack | null;
	/** Ticks of work done toward the current craft. */
	smeltProgress: number;
	/** Ticks of fuel left in the current burn. Lit only while > 0. */
	burnRemaining: number;
}

export function createStationState(kind: StationKind): StationState {
	return {
		kind,
		capTier: 0,
		input: null,
		fuel: null,
		output: null,
		smeltProgress: 0,
		burnRemaining: 0,
	};
}

export interface StationTickResult {
	/** The craft finished this tick. */
	completed: boolean;
	/** A fuel unit was consumed to light the station. */
	burnedFuel: boolean;
	/** Anything changed at all, so the UI knows to redraw. */
	changed: boolean;
}

const NO_CHANGE: StationTickResult = {
	completed: false,
	burnedFuel: false,
	changed: false,
};

/** Whether the station is lit, derived rather than stored so it cannot drift. */
export function isLit(state: StationState): boolean {
	return state.burnRemaining > 0;
}

/**
 * Advance one station by one tick. Mutates `state` in place.
 *
 * Two fuel shapes, which must not be confused — see `fuelIsMaterial`:
 *   - fuel-as-material (kiln): one unit per craft, consumed on completion.
 *     Progress does not need a burn, because the wood being converted is the heat.
 *   - fuel-as-fuel (furnace): one unit when a burn starts, supplying many
 *     ticks; progress needs a live burn; the input slot supplies the material.
 */
export function tickStation(
	state: StationState,
	ticks = 1,
	toolTier = Number.POSITIVE_INFINITY,
): StationTickResult {
	const recipe = findStationRecipe(state.kind, state.input?.itemId ?? 0);

	if (recipe === undefined) {
		// Nothing to do. Reset progress rather than freezing it, so removing the
		// input does not bank progress towards a later craft.
		if (state.smeltProgress > 0) {
			state.smeltProgress = 0;
			return { completed: false, burnedFuel: false, changed: true };
		}
		return NO_CHANGE;
	}

	// Phase 3c: a tool gates the work. `toolTier` is min(cap, placed tool tier).
	if (recipe.minTier !== undefined && toolTier < recipe.minTier) {
		return NO_CHANGE;
	}

	const isRepair = recipe.resultId === 0;
	const fuelIsMaterial = recipe.fuelIsMaterial === true;

	// Refuse to start work with nowhere to put the result. This is what stops an
	// output-full furnace from eating ore.
	if (!isRepair && state.output !== null) {
		return NO_CHANGE;
	}

	if (isRepair && state.input === null) return NO_CHANGE;

	// Light a fuel-as-fuel station before letting it work.
	if (recipe.usesFuel && !fuelIsMaterial && state.burnRemaining <= 0) {
		if (state.fuel === null) return NO_CHANGE;

		const value = fuelValueFor(state.fuel.itemId);
		if (value <= 0) return NO_CHANGE;

		state.fuel.stackSize -= 1;
		if (state.fuel.stackSize <= 0) state.fuel = null;
		state.burnRemaining = value;

		return { completed: false, burnedFuel: true, changed: true };
	}

	// Fuel only burns while work is actually happening. Draining it on an idle
	// station would evaporate a stack of coal the moment the player walked away.
	if (state.burnRemaining > 0) {
		state.burnRemaining = Math.max(0, state.burnRemaining - ticks);
	}

	state.smeltProgress += ticks;
	if (state.smeltProgress < recipe.smeltTicks) {
		return { completed: false, burnedFuel: false, changed: true };
	}

	state.smeltProgress = 0;

	// A repair leaves the tool in the slot; the caller writes the durability.
	if (isRepair) {
		return { completed: true, burnedFuel: false, changed: true };
	}

	if (fuelIsMaterial) {
		if (state.fuel === null) return NO_CHANGE;
		state.fuel.stackSize -= 1;
		if (state.fuel.stackSize <= 0) state.fuel = null;
		// Keep the flame alive while the kiln still has fuel.
		state.burnRemaining = Math.max(state.burnRemaining, 1);
	} else if (state.input !== null) {
		state.input.stackSize -= 1;
		if (state.input.stackSize <= 0) state.input = null;
	}

	state.output = { itemId: recipe.resultId, stackSize: recipe.resultCount };
	return { completed: true, burnedFuel: false, changed: true };
}

/** Progress toward the current craft, 0..1. */
export function stationProgress(state: StationState): number {
	const recipe = findStationRecipe(state.kind, state.input?.itemId ?? 0);
	if (recipe === undefined || recipe.smeltTicks <= 0) return 0;
	const frac = state.smeltProgress / recipe.smeltTicks;
	return frac > 1 ? 1 : frac < 0 ? 0 : frac;
}
