/**
 * MobLighting: voxel light sampling for thin-instanced mobs.
 *
 * Mirrors DroppedItem lighting:
 * getLightByWorldCoords -> packedLightToLightColor -> instance color
 *
 * Tunables:
 *   SETTING_PARAMS.MOB_LIGHT_UPDATES_PER_FRAME (0 = all)
 *   SETTING_PARAMS.MOB_LIGHT_UPDATE_HZ (0 = every frame)
 *
 * Entries are stored in a circular doubly linked list:
 *   - O(1) registration
 *   - O(1) unregistration
 *   - O(1) base-color lookup
 *   - fair round-robin traversal without array compaction
 */

import type { Vec3 } from "@babylonjs/lite";
import { onBeforeRender } from "@babylonjs/lite";

import { Map1 } from "@/code/Maps/Map1";
import { packedLightToLightColor } from "@/code/Player/PlayerModel";
import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";

import type { InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";

/** Y offset for light sampling, matching Player chest sampling. */
const LIGHT_Y_OFFSET = 0.5;

/** Stationary mobs must periodically resample for day/night lighting. */
const DAY_NIGHT_FORCE_MS = 1000;

type MobPosition =
	| Vec3
	| {
			x: number;
			y: number;
			z: number;
	  };

type BaseColor =
	| readonly [number, number, number]
	| {
			r: number;
			g: number;
			b: number;
	  };

type Entry = {
	pool: MobInstancePool;
	slot: InstanceSlotHandle;
	getPos: () => MobPosition;

	baseR: number;
	baseG: number;
	baseB: number;

	/**
	 * Last computed voxel-light multiplier (0-1 RGB), copied out of the
	 * packedLightToLightColor scratch tuple. Stored separately from the
	 * base color so stuck projectiles can reuse the host mob's light
	 * without a second voxel query: arrowTint = arrowBase * cachedLight.
	 */
	lightR: number;
	lightG: number;
	lightB: number;

	/** Optional owner (local Mob instance or remote mob entry) for O(1) lookup. */
	owner: object | null;

	lastLX: number;
	lastLY: number;
	lastLZ: number;
	lastSampleMs: number;

	/**
	 * Entries remain self-linked after removal. Membership is determined by
	 * entriesBySlot, not by inspecting these links.
	 */
	next: Entry;
	prev: Entry;
};

const entriesBySlot = new Map<InstanceSlotHandle, Entry>();

/** Owner (Mob instance / remote mob entry) -> lighting entry. Weak so mob disposal GCs. */
const entriesByOwner = new WeakMap<object, Entry>();

let entryCount = 0;

/** Next entry to process in the circular list. */
let cursor: Entry | null = null;

let lastTickMs = Number.NEGATIVE_INFINITY;
let observerRegistered = false;

function ensureObserver(): void {
	if (observerRegistered) {
		return;
	}

	observerRegistered = true;

	onBeforeRender(Map1.mainScene, () => {
		tick(performance.now());
	});
}

/**
 * Reads a BaseColor without allocating a temporary tuple.
 *
 * Array.isArray does not narrow readonly tuples reliably in all TypeScript
 * configurations, so the object branch is narrowed explicitly.
 */
function assignBaseColor(entry: Entry, color: BaseColor): void {
	if (Array.isArray(color)) {
		entry.baseR = color[0];
		entry.baseG = color[1];
		entry.baseB = color[2];
		return;
	}

	const rgb = color as { r: number; g: number; b: number };

	entry.baseR = rgb.r;
	entry.baseG = rgb.g;
	entry.baseB = rgb.b;
}

function baseColorEquals(entry: Entry, color: BaseColor): boolean {
	if (Array.isArray(color)) {
		return (
			entry.baseR === color[0] &&
			entry.baseG === color[1] &&
			entry.baseB === color[2]
		);
	}

	const rgb = color as { r: number; g: number; b: number };

	return (
		entry.baseR === rgb.r && entry.baseG === rgb.g && entry.baseB === rgb.b
	);
}

/**
 * Sample and write an entry's lighting.
 *
 * Returns true when a light sample was performed and false when the cached
 * voxel remains valid.
 */
function refreshEntry(entry: Entry, now: number, force: boolean): boolean {
	const pos = entry.getPos();

	const sampleX = pos.x;
	const sampleY = pos.y + LIGHT_Y_OFFSET;
	const sampleZ = pos.z;

	const lx = Math.floor(sampleX);
	const ly = Math.floor(sampleY);
	const lz = Math.floor(sampleZ);

	if (
		!force &&
		lx === entry.lastLX &&
		ly === entry.lastLY &&
		lz === entry.lastLZ &&
		now - entry.lastSampleMs < DAY_NIGHT_FORCE_MS
	) {
		return false;
	}

	const packedLight = getLightByWorldCoords(sampleX, sampleY, sampleZ);
	const lightColor = packedLightToLightColor(packedLight);

	entry.lightR = lightColor[0];
	entry.lightG = lightColor[1];
	entry.lightB = lightColor[2];

	entry.pool.writeLitColor(
		entry.slot,
		entry.baseR * lightColor[0],
		entry.baseG * lightColor[1],
		entry.baseB * lightColor[2],
	);

	entry.lastLX = lx;
	entry.lastLY = ly;
	entry.lastLZ = lz;
	entry.lastSampleMs = now;

	return true;
}

function tick(now: number): void {
	if (cursor === null) {
		return;
	}

	const hz = SETTING_PARAMS.MOB_LIGHT_UPDATE_HZ;

	if (hz > 0 && now - lastTickMs < 1000 / hz) {
		return;
	}

	lastTickMs = now;

	const configuredBudget = SETTING_PARAMS.MOB_LIGHT_UPDATES_PER_FRAME;
	const budget =
		configuredBudget === 0
			? entryCount
			: Math.min(configuredBudget, entryCount);

	for (let processed = 0; processed < budget; processed++) {
		const entry: any = cursor;

		/*
		 * Advance before invoking external code. If writeLitColor indirectly
		 * unregisters this entry, cursor already points at another entry.
		 */
		cursor = entry.next;

		refreshEntry(entry, now, false);

		if (cursor === null) {
			return;
		}
	}
}

function appendEntry(entry: Entry): void {
	const currentCursor = cursor;

	if (currentCursor === null) {
		entry.next = entry;
		entry.prev = entry;

		cursor = entry;
		entryCount = 1;
		return;
	}

	/*
	 * Append immediately before cursor. Cursor remains the next entry to
	 * process, while the new entry is placed at the end of the current cycle.
	 */
	const tail = currentCursor.prev;

	entry.prev = tail;
	entry.next = currentCursor;

	tail.next = entry;
	currentCursor.prev = entry;

	entryCount++;
}

function removeEntry(entry: Entry): void {
	if (entryCount === 1) {
		cursor = null;
		entryCount = 0;
	} else {
		entry.prev.next = entry.next;
		entry.next.prev = entry.prev;

		if (cursor === entry) {
			cursor = entry.next;
		}

		entryCount--;
	}

	/*
	 * Break references to the remaining list. Self-linking also makes an
	 * accidentally reused removed entry easier to identify while debugging.
	 */
	entry.next = entry;
	entry.prev = entry;
}

export function registerMobLight(registration: {
	pool: MobInstancePool;
	slot: InstanceSlotHandle;
	getPos: () => MobPosition;
	baseColor: BaseColor;
	/**
	 * Optional owner for O(1) reverse lookup (local Mob instance or remote
	 * mob entry). Lets stuck projectiles reuse this entry's cached light
	 * without a second voxel query.
	 */
	owner?: object | null;
}): void {
	ensureObserver();

	const existing = entriesBySlot.get(registration.slot);

	if (existing !== undefined) {
		const newOwner = registration.owner ?? null;

		if (existing.owner !== null && existing.owner !== newOwner) {
			entriesByOwner.delete(existing.owner);
		}

		existing.pool = registration.pool;
		existing.getPos = registration.getPos;
		existing.owner = newOwner;

		if (newOwner !== null) {
			entriesByOwner.set(newOwner, existing);
		}

		assignBaseColor(existing, registration.baseColor);

		refreshEntry(existing, performance.now(), true);
		return;
	}

	const now = performance.now();
	const pos = registration.getPos();

	const sampleX = pos.x;
	const sampleY = pos.y + LIGHT_Y_OFFSET;
	const sampleZ = pos.z;

	/*
	 * Construct first, then self-link. This avoids null placeholders and
	 * unsafe casts while preserving the circular-list invariant.
	 */
	const lightingEntry = {
		pool: registration.pool,
		slot: registration.slot,
		getPos: registration.getPos,

		baseR: 0,
		baseG: 0,
		baseB: 0,

		lightR: 1,
		lightG: 1,
		lightB: 1,

		owner: registration.owner ?? null,

		lastLX: Math.floor(sampleX),
		lastLY: Math.floor(sampleY),
		lastLZ: Math.floor(sampleZ),
		lastSampleMs: now,

		next: undefined as unknown as Entry,
		prev: undefined as unknown as Entry,
	};

	lightingEntry.next = lightingEntry;
	lightingEntry.prev = lightingEntry;

	assignBaseColor(lightingEntry, registration.baseColor);

	const packedLight = getLightByWorldCoords(sampleX, sampleY, sampleZ);
	const lightColor = packedLightToLightColor(packedLight);

	lightingEntry.lightR = lightColor[0];
	lightingEntry.lightG = lightColor[1];
	lightingEntry.lightB = lightColor[2];

	registration.pool.writeLitColor(
		registration.slot,
		lightingEntry.baseR * lightColor[0],
		lightingEntry.baseG * lightColor[1],
		lightingEntry.baseB * lightColor[2],
	);

	entriesBySlot.set(registration.slot, lightingEntry);

	if (lightingEntry.owner !== null) {
		entriesByOwner.set(lightingEntry.owner, lightingEntry);
	}

	appendEntry(lightingEntry);
}

export function unregisterMobLight(slot: InstanceSlotHandle): void {
	const entry = entriesBySlot.get(slot);

	if (entry === undefined) {
		return;
	}

	entriesBySlot.delete(slot);

	if (entry.owner !== null) {
		/*
		 * Only delete when the map still points at this entry. A slot handle
		 * is never reused across owners, but the guard keeps re-registration
		 * races from dropping a newer entry's mapping.
		 */
		if (entriesByOwner.get(entry.owner) === entry) {
			entriesByOwner.delete(entry.owner);
		}

		entry.owner = null;
	}

	removeEntry(entry);
}

/**
 * Cached voxel-light multiplier (0-1 RGB) for an owner passed as
 * `owner` to registerMobLight. Returns null when the owner has no live
 * lighting entry. The caller multiplies its own base color by this value.
 */
export function getCachedLightColorForOwner(
	owner: object,
): readonly [number, number, number] | null {
	const entry = entriesByOwner.get(owner);

	if (entry === undefined || entriesBySlot.get(entry.slot) !== entry) {
		return null;
	}

	return [entry.lightR, entry.lightG, entry.lightB];
}

/**
 * Cached voxel-light multiplier (0-1 RGB) for a lighting slot.
 * Returns null when the slot has no live lighting entry.
 */
export function getCachedLightColor(
	slot: InstanceSlotHandle,
): readonly [number, number, number] | null {
	const entry = entriesBySlot.get(slot);

	if (entry === undefined) {
		return null;
	}

	return [entry.lightR, entry.lightG, entry.lightB];
}

export function updateMobBaseColor(
	slot: InstanceSlotHandle,
	newBase: BaseColor,
): void {
	const entry = entriesBySlot.get(slot);

	if (entry === undefined || baseColorEquals(entry, newBase)) {
		return;
	}

	assignBaseColor(entry, newBase);

	/*
	 * Apply gameplay-driven color changes immediately instead of waiting for
	 * the configured lighting tick.
	 */
	refreshEntry(entry, performance.now(), true);
}

/** Force an immediate refresh of every currently registered mob. */
export function forceRefreshAll(): void {
	const initialCount = entryCount;

	if (initialCount === 0 || cursor === null) {
		lastTickMs = Number.NEGATIVE_INFINITY;
		return;
	}

	/*
	 * Use a bounded count rather than a sentinel entry. A sentinel can become
	 * invalid if refreshEntry indirectly unregisters the starting entry.
	 * Newly registered entries are intentionally left for the next normal
	 * tick, matching snapshot-style traversal.
	 */
	let remaining = initialCount;
	let entry: Entry | null = cursor;
	const now = performance.now();

	while (remaining > 0 && entry !== null && entryCount > 0) {
		const next: Entry = entry.next;

		/*
		 * The map check prevents refreshing an entry that was removed by an
		 * earlier callback during this traversal.
		 */
		if (entriesBySlot.get(entry.slot) === entry) {
			refreshEntry(entry, now, true);
		}

		entry = entryCount > 0 ? next : null;
		remaining--;
	}

	/*
	 * A forced refresh must not throttle the next scheduled lighting tick.
	 */
	lastTickMs = Number.NEGATIVE_INFINITY;
}

export function getMobLightingStats(): {
	total: number;
	budget: number;
	hz: number;
} {
	return {
		total: entryCount,
		budget: SETTING_PARAMS.MOB_LIGHT_UPDATES_PER_FRAME,
		hz: SETTING_PARAMS.MOB_LIGHT_UPDATE_HZ,
	};
}
