import type { Vec3 } from "@babylonjs/lite";
import { getBlockByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	forgetStation,
	getStationState,
	isStationBlock,
	saveStationState,
	stationKindForBlock,
} from "./StationManager";
import type { StationKind, StationState } from "./StationTypes";
import { findStationRecipe, isLit, tickStation } from "./StationTypes";

/**
 * Drives every loaded station.
 *
 * Phase 3a is singleplayer-only: there is no server-side station simulation, so
 * this owns the authoritative state in the client and writes it to
 * localStorage. Phase 3b replaces the storage calls with the server store and
 * adds the `0x36`â€“`0x3a` messages, leaving this loop unchanged.
 *
 * Only stations near the player are ticked. A world can hold thousands of them
 * and none of them should matter while the player is on the other side of it.
 */

const SCAN_RADIUS = 6;
const SAVE_INTERVAL_SEC = 2;

export interface TrackedStation {
	x: number;
	y: number;
	z: number;
	kind: StationKind;
	state: StationState;
}

const tracked = new Map<string, TrackedStation>();
let saveAccumulator = 0;
/** Notified when any tracked station changes, so the open UI can redraw. */
let onChanged: (() => void) | null = null;
/**
 * Notified when a whetstone finishes a repair. The panel owns the live Item, so
 * it performs the durability write; the runtime only holds ids.
 */
let onWhetstoneRepair: (() => void) | null = null;

function key(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

export function setStationChangeHandler(handler: (() => void) | null): void {
	onChanged = handler;
}

/** Forget every tracked station. Test/teardown helper. */
export function clearStationTracking(): void {
	tracked.clear();
	saveAccumulator = 0;
	onChanged = null;
	onWhetstoneRepair = null;
}

export function getTrackedStations(): readonly TrackedStation[] {
	return [...tracked.values()];
}

/**
 * Advance every station near the player by `dtSec`.
 *
 * Re-scans on a slow cadence rather than every frame: walking from one station
 * to the next is not instant, and a per-frame neighbourhood scan is pure waste.
 */
export function tickStationRuntime(dtSec: number, position: Vec3): void {
	if (dtSec <= 0) return;

	const px = Math.floor(position.x);
	const py = Math.floor(position.y);
	const pz = Math.floor(position.z);

	rescan(px, py, pz);
	prune(px, py, pz);

	const ticks = dtSec * 20;
	let anyChanged = false;

	for (const station of tracked.values()) {
		const result = tickStation(station.state, ticks);
		// A whetstone craft mutates an Item rather than producing a new one, so
		// the panel applies the durability write; the runtime just notes it.
		if (result.completed && station.kind === "whetstone") {
			onWhetstoneRepair?.();
		}
		if (result.changed) anyChanged = true;
	}

	// Persist on a timer rather than per tick: a furnace writes to localStorage
	// on every inventory mutation already, and smelt progress is recoverable.
	saveAccumulator += dtSec;
	if (saveAccumulator >= SAVE_INTERVAL_SEC) {
		saveAccumulator = 0;
		for (const station of tracked.values()) {
			saveStationState(station.x, station.y, station.z, station.state);
		}
	}

	if (anyChanged) onChanged?.();
}

/**
 * Restore durability to the tool in the whetstone's input slot.
 *
 * A station stores item ids, not live `Item` instances, so the repair is applied
 * by the panel, which does hold them. Called on completion so the player sees the
 * durability bar move.
 */
export function setWhetstoneRepairHandler(handler: (() => void) | null): void {
	onWhetstoneRepair = handler;
}

/** Rebuild the tracked set if the player moved to a different neighbourhood. */
let lastScanX = Number.NaN;
let lastScanY = Number.NaN;
let lastScanZ = Number.NaN;

function rescan(px: number, py: number, pz: number): void {
	if (
		px === lastScanX &&
		py === lastScanY &&
		pz === lastScanZ &&
		tracked.size > 0
	) {
		return;
	}
	lastScanX = px;
	lastScanY = py;
	lastScanZ = pz;

	const r = SCAN_RADIUS;
	for (let dy = -r; dy <= r; dy++) {
		const y = py + dy;
		for (let dz = -r; dz <= r; dz++) {
			for (let dx = -r; dx <= r; dx++) {
				const x = px + dx;
				const z = pz + dz;

				const blockId = getBlockByWorldCoords(x, y, z);
				if (blockId === 0 || blockId === undefined) continue;
				if (!isStationBlock(blockId)) continue;

				const kind = stationKindForBlock(blockId);
				if (kind === undefined) continue;

				const k = key(x, y, z);
				if (tracked.has(k)) continue;

				tracked.set(k, {
					x,
					y,
					z,
					kind,
					state: getStationState(x, y, z, kind),
				});
			}
		}
	}
}

function prune(px: number, py: number, pz: number): void {
	if (tracked.size === 0) return;
	const r = SCAN_RADIUS + 2;
	for (const [k, station] of tracked) {
		const dx = station.x - px;
		const dy = station.y - py;
		const dz = station.z - pz;
		if (Math.abs(dx) <= r && Math.abs(dy) <= r && Math.abs(dz) <= r) continue;
		// Flush before dropping, so an in-progress smelt survives walking away.
		saveStationState(station.x, station.y, station.z, station.state);
		tracked.delete(k);
	}
}

/** Force a save of every tracked station. Called on scene teardown. */
export function flushStationRuntime(): void {
	for (const station of tracked.values()) {
		saveStationState(station.x, station.y, station.z, station.state);
	}
}

/** Called when a station block is broken, so no stale record lingers. */
export function notifyStationBlockBroken(
	x: number,
	y: number,
	z: number,
): void {
	const k = key(x, y, z);
	const station = tracked.get(k);
	if (station !== undefined) {
		tracked.delete(k);
	}
	forgetStation(x, y, z);
}

/** Whether a station is lit, for the UI flame indicator. */
export { isLit };
