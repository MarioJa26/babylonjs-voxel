import type { SceneContext, Vec3 } from "@babylonjs/lite";
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

	lightR: number;
	lightG: number;
	lightB: number;

	owner: object | null;

	lastLX: number;
	lastLY: number;
	lastLZ: number;
	lastSampleMs: number;

	next: Entry;
	prev: Entry;
};

const entriesBySlot = new Map<InstanceSlotHandle, Entry>();
const entriesByOwner = new WeakMap<object, Entry>();

let entryCount = 0;
let cursor: Entry | null = null;

let lastTickMs = Number.NEGATIVE_INFINITY;
let observedScene: SceneContext | null = null;

function ensureObserver(): void {
	// Scene-tracked, not a boolean flag: Map1.mainScene is reassigned on
	// every world load, and a stuck flag would leave the new scene with no
	// lighting observer. The previous scene keeps a harmless observer over
	// the shared entry list (emptied by mob disposal).
	if (observedScene === Map1.mainScene) {
		return;
	}

	observedScene = Map1.mainScene;

	onBeforeRender(Map1.mainScene, () => {
		tick(performance.now());
	});
}

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
 * Writes the entry's current base color multiplied by its cached light.
 * This performs no voxel query and allocates nothing.
 */
function writeCachedColor(entry: Entry): void {
	entry.pool.writeLitColor(
		entry.slot,
		entry.baseR * entry.lightR,
		entry.baseG * entry.lightG,
		entry.baseB * entry.lightB,
	);
}

/**
 * Samples voxel lighting at an already-resolved position and writes it.
 */
function sampleAndWrite(
	entry: Entry,
	sampleX: number,
	sampleY: number,
	sampleZ: number,
	now: number,
): void {
	const packedLight = getLightByWorldCoords(sampleX, sampleY, sampleZ);
	const lightColor = packedLightToLightColor(packedLight);

	entry.lightR = lightColor[0];
	entry.lightG = lightColor[1];
	entry.lightB = lightColor[2];

	writeCachedColor(entry);

	entry.lastLX = Math.floor(sampleX);
	entry.lastLY = Math.floor(sampleY);
	entry.lastLZ = Math.floor(sampleZ);
	entry.lastSampleMs = now;
}

/**
 * Samples and writes an entry's lighting.
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

	sampleAndWrite(entry, sampleX, sampleY, sampleZ, now);

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
		const entry: Entry = cursor;

		/*
		 * Advance before invoking external code. If writeLitColor removes
		 * the current entry, traversal can continue from the next one.
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

	entry.next = entry;
	entry.prev = entry;
}

export function registerMobLight(registration: {
	pool: MobInstancePool;
	slot: InstanceSlotHandle;
	getPos: () => MobPosition;
	baseColor: BaseColor;
	owner?: object | null;
}): void {
	ensureObserver();

	const existing = entriesBySlot.get(registration.slot);
	const newOwner = registration.owner ?? null;

	if (existing !== undefined) {
		if (
			existing.owner !== null &&
			existing.owner !== newOwner &&
			entriesByOwner.get(existing.owner) === existing
		) {
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

	const entry = {} as Entry;

	entry.pool = registration.pool;
	entry.slot = registration.slot;
	entry.getPos = registration.getPos;

	entry.baseR = 0;
	entry.baseG = 0;
	entry.baseB = 0;

	entry.lightR = 1;
	entry.lightG = 1;
	entry.lightB = 1;

	entry.owner = newOwner;

	entry.lastLX = Math.floor(sampleX);
	entry.lastLY = Math.floor(sampleY);
	entry.lastLZ = Math.floor(sampleZ);
	entry.lastSampleMs = now;

	entry.next = entry;
	entry.prev = entry;

	assignBaseColor(entry, registration.baseColor);
	sampleAndWrite(entry, sampleX, sampleY, sampleZ, now);

	entriesBySlot.set(registration.slot, entry);

	if (newOwner !== null) {
		entriesByOwner.set(newOwner, entry);
	}

	appendEntry(entry);
}

/**
 * Single enforcement point for render-slot teardown. Lighting entries are
 * keyed by handle identity (stable across pool compaction), but the lookup
 * must still happen before `release` mutates `slot.index` to -1: after
 * release the handle no longer describes a live lane, so unregistering late
 * risks leaving a stale entry that keeps writing lit colors into a lane now
 * owned by a different mob.
 *
 * Recommended full disposal order: mark disposed → leave simulation and
 * registry → `releaseMobRenderSlot` (this: lighting, then slot) → unregister
 * chunk binding → dispose collision resources → clear external references.
 * Null-safe and idempotent: both halves no-op when already torn down, which
 * is what makes partially-constructed (`try { acquire… } catch { dispose }`)
 * rollback safe.
 */
export function releaseMobRenderSlot(slot: InstanceSlotHandle | null): void {
	if (slot === null) {
		return;
	}

	unregisterMobLight(slot);
	slot.pool.release(slot);
}

export function unregisterMobLight(slot: InstanceSlotHandle): void {
	const entry = entriesBySlot.get(slot);

	if (entry === undefined) {
		return;
	}

	entriesBySlot.delete(slot);

	if (entry.owner !== null) {
		if (entriesByOwner.get(entry.owner) === entry) {
			entriesByOwner.delete(entry.owner);
		}

		entry.owner = null;
	}

	removeEntry(entry);
}

export function getCachedLightColorForOwner(
	owner: object,
	out?: [number, number, number],
): readonly [number, number, number] | null {
	const entry = entriesByOwner.get(owner);

	if (entry === undefined || entriesBySlot.get(entry.slot) !== entry) {
		return null;
	}

	if (out !== undefined) {
		out[0] = entry.lightR;
		out[1] = entry.lightG;
		out[2] = entry.lightB;
		return out;
	}

	return [entry.lightR, entry.lightG, entry.lightB];
}

export function getCachedLightColor(
	slot: InstanceSlotHandle,
	out?: [number, number, number],
): readonly [number, number, number] | null {
	const entry = entriesBySlot.get(slot);

	if (entry === undefined) {
		return null;
	}

	if (out !== undefined) {
		out[0] = entry.lightR;
		out[1] = entry.lightG;
		out[2] = entry.lightB;
		return out;
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
	 * Preserve the original behavior by taking a fresh voxel sample instead
	 * of applying only the cached multiplier.
	 */
	refreshEntry(entry, performance.now(), true);
}

export function forceRefreshAll(): void {
	const initialCount = entryCount;
	let entry = cursor;

	if (initialCount === 0 || entry === null) {
		lastTickMs = Number.NEGATIVE_INFINITY;
		return;
	}

	const now = performance.now();
	let remaining = initialCount;

	while (remaining > 0 && entry !== null && entryCount > 0) {
		const current: Entry = entry;
		const next: Entry = current.next;

		if (entriesBySlot.get(current.slot) === current) {
			refreshEntry(current, now, true);
		}

		entry = entryCount > 0 ? next : null;
		remaining--;
	}

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
