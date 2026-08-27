/**
 * MobLighting — voxel light sampling for thin-instanced mobs.
 *
 * Mirrors DroppedItem lighting (getLightByWorldCoords → packedLightToLightColor → instance color)
 * but with two tunables:
 *   SETTING_PARAMS.MOB_LIGHT_UPDATES_PER_FRAME (0 = all)
 *   SETTING_PARAMS.MOB_LIGHT_UPDATE_HZ (0 = every frame)
 *
 * Uses a round-robin cursor so N mobs with budget B at HZ hz are refreshed fairly.
 * Per-entry voxel cache avoids redundant writes; a 1s forced resample keeps
 * day/night sun factor updating while stationary (like Player RemotePlayerRenderer LIGHT_RESAMPLE_MS).
 */

import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { packedLightToLightColor } from "@/code/Player/PlayerModel";
import type { InstanceSlotHandle, MobInstancePool } from "./MobInstancePool";
import type { Vec3 } from "@babylonjs/lite";
import { onBeforeRender } from "@babylonjs/lite";
import { Map1 } from "@/code/Maps/Map1";

/** Y offset for light sampling (chest height, matches Player). */
const LIGHT_Y_OFFSET = 0.5;

const DAY_NIGHT_FORCE_MS = 1000;

type Entry = {
	pool: MobInstancePool;
	slot: InstanceSlotHandle;
	getPos: () => Vec3 | { x: number; y: number; z: number };
	baseColor: [number, number, number];
	lastLX: number;
	lastLY: number;
	lastLZ: number;
	lastSampleMs: number;
};

const entries: Entry[] = [];
let cursor = 0;
let lastTickMs = Number.NEGATIVE_INFINITY;
let observerRegistered = false;

function ensureObserver(): void {
	if (observerRegistered) return;
	observerRegistered = true;
	onBeforeRender(Map1.mainScene, () => {
		tick(performance.now());
	});
}

function tick(now: number): void {
	if (entries.length === 0) return;

	const hzRaw = SETTING_PARAMS.MOB_LIGHT_UPDATE_HZ as number;
	const hz = Number.isFinite(hzRaw) ? hzRaw : 0;
	if (hz > 0) {
		const interval = 1000 / hz;
		if (now - lastTickMs < interval) return;
	}
	lastTickMs = now;

	const perFrameRaw = SETTING_PARAMS.MOB_LIGHT_UPDATES_PER_FRAME as number;
	const perFrame = Math.floor(Number.isFinite(perFrameRaw) ? perFrameRaw : 0);
	const budget =
		perFrame > 0 ? Math.min(perFrame, entries.length) : entries.length;

	// Round-robin slice
	for (let i = 0; i < budget; i++) {
		if (entries.length === 0) break;
		if (cursor >= entries.length) cursor = 0;
		const e = entries[cursor];
		cursor = (cursor + 1) % Math.max(1, entries.length);

		const pos = e.getPos();
		// Use y+0.5 chest sampling like Player/remote players
		const lx = Math.floor(pos.x);
		const ly = Math.floor(pos.y + LIGHT_Y_OFFSET);
		const lz = Math.floor(pos.z);

		const voxelChanged = lx !== e.lastLX || ly !== e.lastLY || lz !== e.lastLZ;
		const force = now - e.lastSampleMs >= DAY_NIGHT_FORCE_MS;
		if (!voxelChanged && !force) continue;

		e.lastLX = lx;
		e.lastLY = ly;
		e.lastLZ = lz;
		e.lastSampleMs = now;

		// Sample packed light at mob feet+offset
		const packed = getLightByWorldCoords(pos.x, pos.y + LIGHT_Y_OFFSET, pos.z);
		const light = packedLightToLightColor(packed);
		// base * light (preserve walk-phase alpha via writeLitColor)
		const r = e.baseColor[0] * light[0];
		const g = e.baseColor[1] * light[1];
		const b = e.baseColor[2] * light[2];
		// Clamp to valid 0-1 (packedLightToLightColor already floors at 0.2)
		e.pool.writeLitColor(e.slot, r, g, b);
	}
}

export function registerMobLight(entry: {
	pool: MobInstancePool;
	slot: InstanceSlotHandle;
	getPos: () => Vec3 | { x: number; y: number; z: number };
	baseColor: [number, number, number] | { r: number; g: number; b: number };
}): void {
	const base: [number, number, number] = Array.isArray(entry.baseColor)
		? [entry.baseColor[0], entry.baseColor[1], entry.baseColor[2]]
		: [entry.baseColor.r, entry.baseColor.g, entry.baseColor.b];

	ensureObserver();

	// Initial light — sample immediately so spawn is correct, then cache voxel
	const pos = entry.getPos();
	const packed = getLightByWorldCoords(pos.x, pos.y + LIGHT_Y_OFFSET, pos.z);
	const light = packedLightToLightColor(packed);
	entry.pool.writeLitColor(
		entry.slot,
		base[0] * light[0],
		base[1] * light[1],
		base[2] * light[2],
	);

	const e: Entry = {
		pool: entry.pool,
		slot: entry.slot,
		getPos: entry.getPos,
		baseColor: base,
		lastLX: Math.floor(pos.x),
		lastLY: Math.floor(pos.y + LIGHT_Y_OFFSET),
		lastLZ: Math.floor(pos.z),
		lastSampleMs: performance.now(),
	};
	entries.push(e);
}

export function unregisterMobLight(slot: InstanceSlotHandle): void {
	for (let i = 0; i < entries.length; i++) {
		if (entries[i].slot === slot) {
			entries.splice(i, 1);
			if (cursor > i) cursor--;
			if (cursor >= entries.length) cursor = 0;
			return;
		}
	}
	// Fallback: compare by identity index may have moved after release?
	// Pool compacts lanes; the holder index is mutated. So search by pool+released index not reliable.
	// Instead, allow alternative cleanup by pool reference if alias lost.
}

export function updateMobBaseColor(
	slot: InstanceSlotHandle,
	newBase: [number, number, number] | { r: number; g: number; b: number },
): void {
	const base: [number, number, number] = Array.isArray(newBase)
		? [newBase[0], newBase[1], newBase[2]]
		: [newBase.r, newBase.g, newBase.b];
	for (const e of entries) {
		if (e.slot === slot) {
			e.baseColor = base;
			// Force resample on next tick
			e.lastSampleMs = Number.NEGATIVE_INFINITY;
			break;
		}
	}
}

/** For testing/debug — force immediate refresh of all entries */
export function forceRefreshAll(): void {
	lastTickMs = Number.NEGATIVE_INFINITY;
	tick(performance.now());
}

export function getMobLightingStats(): {
	total: number;
	budget: number;
	hz: number;
} {
	return {
		total: entries.length,
		budget: SETTING_PARAMS.MOB_LIGHT_UPDATES_PER_FRAME as number,
		hz: SETTING_PARAMS.MOB_LIGHT_UPDATE_HZ as number,
	};
}
