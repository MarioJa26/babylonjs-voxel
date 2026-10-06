import { BlockType } from "@/code/World/Texture/BlockType";
import type { ItemStack, StationKind, StationState } from "./StationTypes";

/**
 * Per-position station state and its persistence.
 *
 * Mirrors `BlockInventoryManager` (crate contents) rather than the multiplayer
 * `ContainerSimulation`, because Phase 3a is singleplayer only: Phase 3b adds the
 * server-side store and the `0x36`–`0x3a` messages, reusing this shape.
 *
 * State is keyed by world position, so breaking a station and replacing it leaves
 * orphaned state behind until it is overwritten. That is acceptable — the record
 * is tiny — but it means `forgetStation` should be called when a station block is
 * broken, or the smoke test for stale records will trip.
 */

const STORAGE_KEY = "b102.stations.v1";

/** On-disk shape. Version-tagged so a future schema change can migrate. */
interface SavedStation {
	v: 1;
	kind: StationKind;
	capTier: number;
	input: ItemStack | null;
	fuel: ItemStack | null;
	output: ItemStack | null;
	smeltProgress: number;
	burnRemaining: number;
}

let allStations: Map<string, SavedStation> | null = null;

function posKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

function loadAll(): Map<string, SavedStation> {
	if (allStations !== null) return allStations;
	allStations = new Map<string, SavedStation>();
	if (typeof window === "undefined") return allStations;

	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw === null) return allStations;

		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return allStations;

		for (const [key, value] of Object.entries(
			parsed as Record<string, unknown>,
		)) {
			if (isValidSavedStation(value)) allStations.set(key, value);
		}
	} catch (error) {
		console.warn("StationManager: failed to load saved stations.", error);
	}

	return allStations;
}

function saveAll(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(Object.fromEntries(loadAll())),
		);
	} catch (error) {
		console.warn("StationManager: failed to save stations.", error);
	}
}

function isStack(value: unknown): value is ItemStack | null {
	if (value === null) return true;
	if (typeof value !== "object") return false;
	const stack = value as Partial<ItemStack>;
	return Number.isInteger(stack.itemId) && Number.isInteger(stack.stackSize);
}

function isValidSavedStation(value: unknown): value is SavedStation {
	if (value === null || typeof value !== "object") return false;
	const station = value as Partial<SavedStation>;

	if (station.v !== 1) return false;
	if (typeof station.kind !== "string") return false;
	if (!Number.isInteger(station.capTier)) return false;

	// Read through locals so the arithmetic below is on `number`, not
	// `number | undefined` — Number.isInteger is not a type guard.
	const smeltProgress: number = station.smeltProgress ?? -1;
	const burnRemaining: number = station.burnRemaining ?? -1;
	if (!Number.isInteger(smeltProgress) || !Number.isInteger(burnRemaining)) {
		return false;
	}

	// Tolerate a bad stack by dropping it rather than discarding the whole
	// station: one corrupt slot should not cost the player their smelted ingots.
	if (
		!isStack(station.input) ||
		!isStack(station.fuel) ||
		!isStack(station.output)
	) {
		return false;
	}

	const emptyStacks =
		station.input === null && station.fuel === null && station.output === null;
	if (emptyStacks && (smeltProgress > 0 || burnRemaining > 0)) {
		// No items but a running smelt is corrupt — it would be free progress.
		return false;
	}

	return true;
}

/** Discard any cached state. Test-only. */
export function resetStationStoreForTests(): void {
	allStations = null;
}

/** Read-through, creating an empty station if none exists. */
export function getStationState(
	x: number,
	y: number,
	z: number,
	kind: StationKind,
): StationState {
	const key = posKey(x, y, z);
	const store = loadAll();
	const saved = store.get(key);

	if (saved === undefined) {
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

	return {
		kind: saved.kind,
		capTier: saved.capTier,
		input: saved.input === null ? null : { ...saved.input },
		fuel: saved.fuel === null ? null : { ...saved.fuel },
		output: saved.output === null ? null : { ...saved.output },
		smeltProgress: saved.smeltProgress,
		burnRemaining: saved.burnRemaining,
	};
}

export function saveStationState(
	x: number,
	y: number,
	z: number,
	state: StationState,
): void {
	loadAll().set(posKey(x, y, z), {
		v: 1,
		kind: state.kind,
		capTier: state.capTier,
		input: state.input === null ? null : { ...state.input },
		fuel: state.fuel === null ? null : { ...state.fuel },
		output: state.output === null ? null : { ...state.output },
		smeltProgress: state.smeltProgress,
		burnRemaining: state.burnRemaining,
	});
	saveAll();
}

/** Called when a station block is broken, so its record does not linger. */
export function forgetStation(x: number, y: number, z: number): void {
	if (loadAll().delete(posKey(x, y, z))) saveAll();
}

/** Block id -> station kind, for the interaction switch. */
export const STATION_KIND_BY_BLOCK: Readonly<
	Partial<Record<BlockType, StationKind>>
> = {
	[BlockType.Kiln]: "kiln",
	[BlockType.Furnace]: "furnace",
	[BlockType.Whetstone]: "whetstone",
	[BlockType.Crucible]: "crucible",
	[BlockType.Anvil]: "anvil",
	[BlockType.Smeltery]: "smeltery",
};

export function stationKindForBlock(blockId: number): StationKind | undefined {
	return STATION_KIND_BY_BLOCK[blockId as BlockType];
}

export function isStationBlock(blockId: number): boolean {
	return stationKindForBlock(blockId) !== undefined;
}
