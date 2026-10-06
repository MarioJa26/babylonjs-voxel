/**
 * StationSimulation — server-authoritative kilns, furnaces and whetstones.
 *
 * Mirrors `ContainerSimulation` in shape (a per-position store, memory first
 * then durable storage) but not in contents: a station is an explicit
 * input / fuel / result triple plus two progress counters, and — critically —
 * **the server ticks the smelt**. Clients never report progress. They request a
 * view, write a slot, and receive authoritative snapshots. A client that claimed
 * its own smelt progress would be a trivial way to mint ingots.
 *
 * Babylon-free: pure data + persistence, driven by VoxelRoom handlers.
 */

import {
	type ItemStack,
	isLit,
	PHASE_3A_STATION_KINDS,
	type StationKind,
	type StationState,
	tickStation,
} from "@/code/World/BlockInventory/StationTypes.ts";
import type {
	PersistedStation,
	ServerWorldStorage,
} from "./ServerWorldStorage.ts";

/** Mirrors the VoxelRoom item caps (itemId u16, stack u16 range). */
export const MAX_STATION_ITEM_ID = 65535;
export const MAX_STATION_STACK = 1024;

/** Station slot indices, matching StationSlotIndex in the protocol. */
export const SLOT_INPUT = 0;
export const SLOT_FUEL = 1;
export const SLOT_RESULT = 2;

/** Fixed smelt interval, matching the client's 20 Hz station tick. */
export const STATION_TICK_MS = 50;

export interface ServerStation {
	x: number;
	y: number;
	z: number;
	/** Bumped on every accepted write; lets clients drop out-of-order updates. */
	version: number;
	kind: StationKind;
	capTier: number;
	input: ItemStack | null;
	fuel: ItemStack | null;
	output: ItemStack | null;
	smeltProgress: number;
	burnRemaining: number;
}

export function stationKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

function normalizeStack(itemId: number, stackSize: number): ItemStack | null {
	if (
		!Number.isInteger(itemId) ||
		itemId < 0 ||
		itemId > MAX_STATION_ITEM_ID ||
		!Number.isInteger(stackSize) ||
		stackSize < 0 ||
		stackSize > MAX_STATION_STACK ||
		itemId === 0 ||
		stackSize === 0
	) {
		return null;
	}
	return { itemId, stackSize };
}

function restoreStack(
	value: { itemId: number; stackSize: number } | undefined,
): ItemStack | null {
	if (value === undefined) return null;
	return normalizeStack(value.itemId, value.stackSize);
}

export class ServerStationStore {
	private readonly stations = new Map<string, ServerStation>();
	/** Stations with a live craft, so idle ones cost nothing to skip. */
	private readonly active = new Set<string>();

	constructor(private readonly storage: ServerWorldStorage) {}

	async open(
		x: number,
		y: number,
		z: number,
		kind: StationKind,
	): Promise<ServerStation> {
		const key = stationKey(x, y, z);
		const live = this.stations.get(key);
		if (live !== undefined) return live;

		let restored: PersistedStation | null = null;
		try {
			restored = await this.storage.loadStation(x, y, z);
		} catch (error) {
			console.error(`[StationStore] load failed for ${key}:`, error);
		}

		const station: ServerStation = {
			x,
			y,
			z,
			version: restored?.version ?? 0,
			// Trust the block on disk over the save: a player could place a
			// different station at these coords after the record was written.
			kind,
			capTier: restored?.capTier ?? 0,
			input: restoreStack(restored?.input),
			fuel: restoreStack(restored?.fuel),
			output: restoreStack(restored?.output),
			smeltProgress: restored?.smeltProgress ?? 0,
			burnRemaining: restored?.burnRemaining ?? 0,
		};

		this.stations.set(key, station);
		if (station.smeltProgress > 0 || station.burnRemaining > 0) {
			this.active.add(key);
		}
		return station;
	}

	get(x: number, y: number, z: number): ServerStation | undefined {
		return this.stations.get(stationKey(x, y, z));
	}

	/**
	 * Apply one validated slot write.
	 *
	 * The result slot is server-owned: clients read it but never write it, so a
	 * modified client cannot fabricate ingots by writing the output directly.
	 */
	setSlot(
		x: number,
		y: number,
		z: number,
		slot: number,
		itemId: number,
		stackSize: number,
	): {
		station: ServerStation | null;
		rejected: "notfound" | "badslot" | "readonly" | null;
	} {
		const key = stationKey(x, y, z);
		const station = this.stations.get(key);
		if (station === undefined) return { station: null, rejected: "notfound" };
		if (!Number.isInteger(slot) || slot < SLOT_INPUT || slot > SLOT_RESULT) {
			return { station: null, rejected: "badslot" };
		}
		if (slot === SLOT_RESULT) return { station: null, rejected: "readonly" };

		const stack = normalizeStack(itemId, stackSize);
		if (slot === SLOT_INPUT) station.input = stack;
		else station.fuel = stack;

		// Writing a slot invalidates any progress banked against the old one.
		// Letting it stand would let a player swap ore mid-craft and have it
		// complete for free.
		station.smeltProgress = 0;

		station.version = (station.version + 1) >>> 0;
		this.refreshActivity(key, station);
		this.persist(station);
		return { station, rejected: null };
	}

	/**
	 * Hand the result stack to a client.
	 *
	 * The take is atomic and server-side: the stack is removed from the station
	 * here and returned to the caller, so two clients reaching for the same output
	 * cannot both receive it. The caller is responsible for checking reach and for
	 * actually granting the item to the player.
	 */
	claimResult(
		x: number,
		y: number,
		z: number,
	): {
		station: ServerStation | null;
		claimed: ItemStack | null;
		rejected: "notfound" | null;
	} {
		const key = stationKey(x, y, z);
		const station = this.stations.get(key);
		if (station === undefined)
			return { station: null, claimed: null, rejected: "notfound" };

		const output = station.output;
		if (output === null || output.stackSize <= 0) {
			return { station, claimed: null, rejected: null };
		}

		station.output = null;
		station.version = (station.version + 1) >>> 0;
		this.refreshActivity(key, station);
		this.persist(station);
		return { station, claimed: output, rejected: null };
	}

	/**
	 * Raise the station cap.
	 *
	 * Monotonic only, and only to a tier the caller is allowed to claim. Phase 3c
	 * adds the placed-tool check; until then the cap is capped at the station's
	 * own kind ceiling so a client cannot set an arbitrary tier.
	 */
	upgradeCap(
		x: number,
		y: number,
		z: number,
		capTier: number,
	): {
		station: ServerStation | null;
		rejected: "notfound" | "badupgrade" | null;
	} {
		const station = this.stations.get(stationKey(x, y, z));
		if (station === undefined) return { station: null, rejected: "notfound" };

		if (
			!Number.isInteger(capTier) ||
			capTier <= station.capTier ||
			capTier > MAX_STATION_CAP_TIER
		) {
			return { station: null, rejected: "badupgrade" };
		}

		station.capTier = capTier;
		station.version = (station.version + 1) >>> 0;
		this.persist(station);
		return { station, rejected: null };
	}

	/**
	 * Advance every active station.
	 *
	 * @returns stations whose visible state changed, so the room can fan out a
	 *   `StationSlotUpdate` only for those.
	 */
	tick(): ServerStation[] {
		const changed: ServerStation[] = [];

		for (const key of this.active) {
			const station = this.stations.get(key);
			if (station === undefined) {
				this.active.delete(key);
				continue;
			}

			const before =
				`${station.input?.itemId ?? 0}:${station.input?.stackSize ?? 0}|` +
				`${station.output?.itemId ?? 0}:${station.output?.stackSize ?? 0}|` +
				`${station.smeltProgress}|${station.burnRemaining}`;

			tickStation(station as unknown as StationState, 1);

			const after =
				`${station.input?.itemId ?? 0}:${station.input?.stackSize ?? 0}|` +
				`${station.output?.itemId ?? 0}:${station.output?.stackSize ?? 0}|` +
				`${station.smeltProgress}|${station.burnRemaining}`;

			if (before !== after) {
				station.version = (station.version + 1) >>> 0;
				changed.push(station);
			}

			this.refreshActivity(key, station);
		}

		return changed;
	}

	/**
	 * Remove a station and return its spillable contents.
	 *
	 * The result slot is deliberately excluded: returning a finished smelt on
	 * break would bank progress for free by replacing the block.
	 */
	takeAll(x: number, y: number, z: number): ItemStack[] {
		const key = stationKey(x, y, z);
		const station = this.stations.get(key);
		this.stations.delete(key);
		this.active.delete(key);
		void this.storage.deleteStation(x, y, z).catch((error) => {
			console.error(`[StationStore] delete failed for ${key}:`, error);
		});
		if (station === undefined) return [];
		return [station.input, station.fuel].filter(
			(s): s is ItemStack => s !== null && s.stackSize > 0,
		);
	}

	/** Every tracked station, for reach checks and break handling. */
	all(): readonly ServerStation[] {
		return [...this.stations.values()];
	}

	clear(): void {
		this.stations.clear();
		this.active.clear();
	}

	/** Force a write of every station. Room teardown. */
	flush(): void {
		for (const station of this.stations.values()) this.persist(station);
	}

	/** Whether the station is lit, for the wire. */
	isStationLit(station: ServerStation): boolean {
		return isLit(station as unknown as StationState);
	}

	private refreshActivity(key: string, station: ServerStation): void {
		const busy =
			station.smeltProgress > 0 ||
			station.burnRemaining > 0 ||
			station.input !== null ||
			station.fuel !== null;

		if (busy) this.active.add(key);
		else this.active.delete(key);
	}

	private persist(station: ServerStation): void {
		const snapshot: PersistedStation = {
			version: station.version,
			kind: STATION_KIND_IDS.indexOf(station.kind),
			capTier: station.capTier,
			input: station.input ?? { itemId: 0, stackSize: 0 },
			fuel: station.fuel ?? { itemId: 0, stackSize: 0 },
			output: station.output ?? { itemId: 0, stackSize: 0 },
			smeltProgress: station.smeltProgress,
			burnRemaining: station.burnRemaining,
		};

		void this.storage
			.saveStation(station.x, station.y, station.z, snapshot)
			.catch((error) => {
				console.error(
					`[StationStore] save failed for ${stationKey(station.x, station.y, station.z)}:`,
					error,
				);
			});
	}
}

/** Wire form of a StationKind, matching StationTypes.STATION_KINDS order. */
export const STATION_KIND_IDS: readonly StationKind[] = [
	"kiln",
	"whetstone",
	"furnace",
	"crucible",
	"anvil",
	"smeltery",
];

export { PHASE_3A_STATION_KINDS };

/** Hard ceiling on a client-claimed cap until Phase 3c validates placed tools. */
export const MAX_STATION_CAP_TIER = 9;

export function stationKindFromId(id: number): StationKind | undefined {
	return STATION_KIND_IDS[id];
}
