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

	lastLX: number;
	lastLY: number;
	lastLZ: number;
	lastSampleMs: number;

	next: Entry;
	prev: Entry;
};

const entriesBySlot = new Map<InstanceSlotHandle, Entry>();

let entryCount = 0;

/**
 * Next entry to process.
 *
 * The entries form a circular doubly linked list, so advancing and removing
 * entries do not require shifting an array or repairing numeric indices.
 */
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

function readBaseColor(color: BaseColor): readonly [number, number, number] {
	if (Array.isArray(color)) {
		return [color[0], color[1], color[2]];
	}

	const rgb = color as {
		r: number;
		g: number;
		b: number;
	};

	return [rgb.r, rgb.g, rgb.b];
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

	const voxelChanged =
		lx !== entry.lastLX || ly !== entry.lastLY || lz !== entry.lastLZ;

	if (
		!force &&
		!voxelChanged &&
		now - entry.lastSampleMs < DAY_NIGHT_FORCE_MS
	) {
		return false;
	}

	const packed = getLightByWorldCoords(sampleX, sampleY, sampleZ);
	const light = packedLightToLightColor(packed);

	entry.pool.writeLitColor(
		entry.slot,
		entry.baseR * light[0],
		entry.baseG * light[1],
		entry.baseB * light[2],
	);

	entry.lastLX = lx;
	entry.lastLY = ly;
	entry.lastLZ = lz;
	entry.lastSampleMs = now;

	return true;
}

function tick(now: number): void {
	if (entryCount === 0 || cursor === null) {
		return;
	}

	const hzSetting = Number(SETTING_PARAMS.MOB_LIGHT_UPDATE_HZ);
	const hz = Number.isFinite(hzSetting) ? Math.max(0, hzSetting) : 0;

	if (hz > 0) {
		const intervalMs = 1000 / hz;

		if (now - lastTickMs < intervalMs) {
			return;
		}
	}

	lastTickMs = now;

	const budgetSetting = Number(SETTING_PARAMS.MOB_LIGHT_UPDATES_PER_FRAME);
	const configuredBudget = Number.isFinite(budgetSetting)
		? Math.floor(budgetSetting)
		: 0;

	const budget =
		configuredBudget > 0 ? Math.min(configuredBudget, entryCount) : entryCount;

	for (let processed = 0; processed < budget; processed++) {
		/*
		 * Advance before sampling. This keeps the cursor valid even if future
		 * sampling code indirectly unregisters the current entry.
		 */
		const entry: any = cursor;
		cursor = entry.next;

		refreshEntry(entry, now, false);

		if (entryCount === 0 || cursor === null) {
			break;
		}
	}
}

function appendEntry(entry: Entry): void {
	if (cursor === null) {
		entry.next = entry;
		entry.prev = entry;
		cursor = entry;
		entryCount = 1;
		return;
	}

	/*
	 * Append immediately before cursor. This preserves cursor as the next
	 * entry to process and adds the new entry at the end of the current cycle.
	 */
	const tail = cursor.prev;

	entry.prev = tail;
	entry.next = cursor;

	tail.next = entry;
	cursor.prev = entry;

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
	 * Break links so accidental reuse is easier to detect in debugging and
	 * removed entries do not retain the rest of the circular list.
	 */
	entry.next = entry;
	entry.prev = entry;
}

export function registerMobLight(entry: {
	pool: MobInstancePool;
	slot: InstanceSlotHandle;
	getPos: () => MobPosition;
	baseColor: BaseColor;
}): void {
	ensureObserver();

	/*
	 * Registering the same handle twice previously created duplicate work and
	 * made unregistration ambiguous. Update the existing registration instead.
	 */
	const existing = entriesBySlot.get(entry.slot);
	const [baseR, baseG, baseB] = readBaseColor(entry.baseColor);

	if (existing) {
		existing.pool = entry.pool;
		existing.getPos = entry.getPos;
		existing.baseR = baseR;
		existing.baseG = baseG;
		existing.baseB = baseB;

		refreshEntry(existing, performance.now(), true);
		return;
	}

	const now = performance.now();
	const pos = entry.getPos();

	const sampleX = pos.x;
	const sampleY = pos.y + LIGHT_Y_OFFSET;
	const sampleZ = pos.z;

	const packed = getLightByWorldCoords(sampleX, sampleY, sampleZ);
	const light = packedLightToLightColor(packed);

	entry.pool.writeLitColor(
		entry.slot,
		baseR * light[0],
		baseG * light[1],
		baseB * light[2],
	);

	/*
	 * next and prev are initialized to the entry itself and then connected by
	 * appendEntry().
	 */
	const lightingEntry = {
		pool: entry.pool,
		slot: entry.slot,
		getPos: entry.getPos,

		baseR,
		baseG,
		baseB,

		lastLX: Math.floor(sampleX),
		lastLY: Math.floor(sampleY),
		lastLZ: Math.floor(sampleZ),
		lastSampleMs: now,

		next: null as unknown as Entry,
		prev: null as unknown as Entry,
	} satisfies Entry;

	lightingEntry.next = lightingEntry;
	lightingEntry.prev = lightingEntry;

	entriesBySlot.set(entry.slot, lightingEntry);
	appendEntry(lightingEntry);
}

export function unregisterMobLight(slot: InstanceSlotHandle): void {
	const entry = entriesBySlot.get(slot);

	if (!entry) {
		return;
	}

	entriesBySlot.delete(slot);
	removeEntry(entry);
}

export function updateMobBaseColor(
	slot: InstanceSlotHandle,
	newBase: BaseColor,
): void {
	const entry = entriesBySlot.get(slot);

	if (!entry) {
		return;
	}

	const [baseR, baseG, baseB] = readBaseColor(newBase);

	if (entry.baseR === baseR && entry.baseG === baseG && entry.baseB === baseB) {
		return;
	}

	entry.baseR = baseR;
	entry.baseG = baseG;
	entry.baseB = baseB;

	/*
	 * Update immediately rather than waiting for the configured tick interval.
	 * This avoids displaying the old tint after a gameplay-driven color
	 * change, while still performing only one position and light lookup.
	 */
	refreshEntry(entry, performance.now(), true);
}

/** Force an immediate refresh of every registered mob. */
export function forceRefreshAll(): void {
	if (entryCount === 0 || cursor === null) {
		lastTickMs = Number.NEGATIVE_INFINITY;
		return;
	}

	const now = performance.now();
	const start = cursor;
	let entry = start;

	do {
		const next = entry.next;
		refreshEntry(entry, now, true);
		entry = next;
	} while (entryCount > 0 && cursor !== null && entry !== start);

	/*
	 * Preserve the original behavior where the next normal tick is not
	 * throttled by the forced refresh.
	 */
	lastTickMs = Number.NEGATIVE_INFINITY;
}

export function getMobLightingStats(): {
	total: number;
	budget: number;
	hz: number;
} {
	const budgetSetting = Number(SETTING_PARAMS.MOB_LIGHT_UPDATES_PER_FRAME);
	const hzSetting = Number(SETTING_PARAMS.MOB_LIGHT_UPDATE_HZ);

	return {
		total: entryCount,
		budget: Number.isFinite(budgetSetting) ? budgetSetting : 0,
		hz: Number.isFinite(hzSetting) ? hzSetting : 0,
	};
}
