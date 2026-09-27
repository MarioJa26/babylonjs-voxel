import { getPRNGBySeed } from "../Generation/NoiseAndParameters/Squirrel13";
import {
	MAYA_SEAL_HALF_EXTENT,
	type MayaLootTier,
	type MayaTempleLayout,
} from "../Generation/Structure/MayaTempleLayout";
import {
	buildTempleLayout,
	resolveTempleInRegion,
} from "../Generation/Structure/StructureSeal";
import { computeSeedAsInt } from "../Generation/WorldSeed";
import { CHUNK_SIZE } from "../Lib/VoxelMath";
import type { SavedBlockInventory } from "../World/BlockInventory/BlockInventoryManager";
import { getWorldNameFromUrl, worldSeedFor } from "../World/WorldContext";

// ---------------------------------------------------------------------------
// Deterministic loot for Maya temple caches.
//
// Neither container store ever rolls loot: BlockInventoryManager.getBlockInventory
// and ServerContainerStore.open both hand back a fresh empty grid, so every
// crate in the game is empty until a player puts something in it. Temple
// caches are the first thing that needs real loot, and they are the right place
// to introduce it.
//
// The roll is keyed on (templeId, cache position) rather than on the moment the
// crate is opened, so:
//   - a cache holds the same treasure every session and every player,
//   - two clients opening the same crate always agree,
//   - the server can reproduce it from the seed alone.
// ---------------------------------------------------------------------------

/** Item ids from public/data/items.json. */
const ITEM = {
	woodenSword: 1000,
	woodenPickaxe: 1002,
	stoneSword: 1006,
	stonePickaxe: 1008,
	apple: 1015,
	torch: 1017,
	ironIngot: 1021,
	bow: 1022,
	woodenArrow: 1023,
	goldIngot: 1025,
	copperIngot: 1026,
	ironSword: 1011,
	ironPickaxe: 1010,
	ironArrow: 1040,
	tntArrow: 1045,
	diamond: 1020,
	ruby: 1049,
	sapphire: 1050,
	emerald: 1051,
	coal: 1019,
	bone: 1115,
	rottenFlesh: 1110,
} as const;

type LootEntry = {
	itemId: number;
	min: number;
	max: number;
	/** Probability the entry appears at all. */
	weight: number;
};

type LootTable = readonly LootEntry[];

/**
 * Tier tables. `weight` is a 0..1 roll, and each table is sampled until the
 * crate's 18 slots are full, so a table's total weight roughly controls how
 * full the crate ends up.
 */
const TABLES: Record<MayaLootTier, LootTable> = {
	alcove: [
		{ itemId: ITEM.torch, min: 4, max: 12, weight: 0.9 },
		{ itemId: ITEM.woodenArrow, min: 4, max: 16, weight: 0.8 },
		{ itemId: ITEM.apple, min: 1, max: 4, weight: 0.6 },
		{ itemId: ITEM.coal, min: 2, max: 8, weight: 0.5 },
		{ itemId: ITEM.bone, min: 1, max: 4, weight: 0.4 },
		{ itemId: ITEM.stoneSword, min: 1, max: 1, weight: 0.15 },
		{ itemId: ITEM.stonePickaxe, min: 1, max: 1, weight: 0.12 },
		{ itemId: ITEM.copperIngot, min: 1, max: 4, weight: 0.2 },
	],
	vault: [
		{ itemId: ITEM.ironIngot, min: 2, max: 7, weight: 0.85 },
		{ itemId: ITEM.ironArrow, min: 6, max: 20, weight: 0.7 },
		{ itemId: ITEM.goldIngot, min: 1, max: 4, weight: 0.35 },
		{ itemId: ITEM.ironSword, min: 1, max: 1, weight: 0.25 },
		{ itemId: ITEM.ironPickaxe, min: 1, max: 1, weight: 0.22 },
		{ itemId: ITEM.tntArrow, min: 2, max: 8, weight: 0.3 },
		{ itemId: ITEM.sapphire, min: 1, max: 1, weight: 0.12 },
		{ itemId: ITEM.rottenFlesh, min: 1, max: 3, weight: 0.3 },
	],
	treasury: [
		{ itemId: ITEM.goldIngot, min: 3, max: 10, weight: 0.9 },
		{ itemId: ITEM.ironIngot, min: 5, max: 14, weight: 0.85 },
		{ itemId: ITEM.emerald, min: 1, max: 2, weight: 0.4 },
		{ itemId: ITEM.ruby, min: 1, max: 2, weight: 0.35 },
		{ itemId: ITEM.sapphire, min: 1, max: 2, weight: 0.35 },
		{ itemId: ITEM.ironSword, min: 1, max: 1, weight: 0.4 },
		{ itemId: ITEM.ironPickaxe, min: 1, max: 1, weight: 0.35 },
		{ itemId: ITEM.bow, min: 1, max: 1, weight: 0.3 },
		{ itemId: ITEM.tntArrow, min: 4, max: 14, weight: 0.4 },
	],
	boss: [
		// Diamond has no other producer in the game, which makes it the right
		// thing to hang on the thing that took 45 minutes to reach.
		{ itemId: ITEM.diamond, min: 1, max: 3, weight: 1 },
		{ itemId: ITEM.emerald, min: 2, max: 5, weight: 1 },
		{ itemId: ITEM.goldIngot, min: 8, max: 20, weight: 1 },
		{ itemId: ITEM.ironIngot, min: 10, max: 24, weight: 1 },
		{ itemId: ITEM.ruby, min: 1, max: 3, weight: 0.8 },
		{ itemId: ITEM.sapphire, min: 1, max: 3, weight: 0.8 },
		{ itemId: ITEM.tntArrow, min: 8, max: 24, weight: 0.6 },
	],
};

/** Mirrors the crate grid in both container stores. */
const CRATE_COLS = 3;
const CRATE_ROWS = 6;

/** Cursor-based stream so each cache's roll is independent but reproducible. */
class LootRandom {
	private cursor: number;

	constructor(
		base: number,
		private readonly seed: number,
	) {
		this.cursor = base | 0 || 1;
	}

	private next(): number {
		this.cursor = (this.cursor + 0x9e3779b9) | 0;
		return Math.abs(getPRNGBySeed(this.cursor, this.seed)) / 2147483648;
	}

	unit(): number {
		return this.next();
	}

	range(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1));
	}

	pick<T>(values: readonly T[]): T {
		return values[Math.floor(this.next() * values.length)];
	}
}

/**
 * Build the saved-inventory shape for a temple cache. One item per slot, since
 * the game's stack model keeps tools unstackable anyway and a mixed crate reads
 * better than a grid of identical stacks.
 */
export function rollTempleCrate(
	templeId: number,
	seed: number,
	tier: MayaLootTier,
	x: number,
	y: number,
	z: number,
): SavedBlockInventory {
	const rng = new LootRandom(
		templeId * 31 + x * 73856093 + y * 19349663 + z * 83492791,
		seed,
	);
	const table = TABLES[tier];

	const slots: (SavedBlockInventoryItem | null)[][] = [];
	for (let r = 0; r < CRATE_ROWS; r++) {
		const row: (SavedBlockInventoryItem | null)[] = [];
		for (let c = 0; c < CRATE_COLS; c++) row.push(null);
		slots.push(row);
	}

	const entries = table.filter((entry) => rng.unit() < entry.weight);
	if (entries.length === 0) {
		// Never hand out a literally empty crate — fall back to something small.
		entries.push(table[0]);
	}

	let slot = 0;
	for (let pass = 0; pass < 3 && slot < CRATE_COLS * CRATE_ROWS; pass++) {
		for (const entry of entries) {
			if (slot >= CRATE_COLS * CRATE_ROWS) break;
			const row = Math.floor(slot / CRATE_COLS);
			const col = slot % CRATE_COLS;
			slots[row][col] = {
				itemId: entry.itemId,
				stackSize: rng.range(entry.min, entry.max),
			};
			slot++;
		}
	}

	return { width: CRATE_COLS, height: CRATE_ROWS, slots };
}

type SavedBlockInventoryItem = {
	itemId: number;
	stackSize: number;
};

export type TempleCacheLookup = {
	templeId: number;
	layout: MayaTempleLayout;
	tier: MayaLootTier;
	/** Index of the cache inside `layout.caches`. */
	index: number;
};

/**
 * Look up the temple cache at a world position, or null when the position is
 * not a temple cache.
 *
 * Used when the player opens a crate: the crate block itself carries no
 * identity, so the position is the key. This mirrors exactly what
 * MayaTempleFeature wrote, because both go through `buildTempleLayout`.
 */
export function findTempleCacheAt(
	worldX: number,
	worldY: number,
	worldZ: number,
	seedAsInt: number,
): TempleCacheLookup | null {
	const chunkX = Math.floor(worldX / CHUNK_SIZE);
	const chunkZ = Math.floor(worldZ / CHUNK_SIZE);

	// A cache can only exist where a temple's seal reaches, and a temple is
	// only ever emitted by chunks within SEARCH_RADIUS of its centre chunk.
	for (let dx = -2; dx <= 2; dx++) {
		for (let dz = -2; dz <= 2; dz++) {
			const resolved = resolveTempleInRegion(
				chunkX + dx,
				chunkZ + dz,
				CHUNK_SIZE,
				seedAsInt,
			);
			if (!resolved) continue;

			if (
				Math.abs(resolved.centerX - worldX) > MAYA_SEAL_HALF_EXTENT ||
				Math.abs(resolved.centerZ - worldZ) > MAYA_SEAL_HALF_EXTENT
			) {
				continue;
			}

			const layout = buildTempleLayout(resolved, seedAsInt);
			for (let i = 0; i < layout.caches.length; i++) {
				const cache = layout.caches[i];
				if (cache.x !== worldX || cache.y + 1 !== worldY) continue;
				if (cache.z !== worldZ) continue;
				return {
					templeId: resolved.templeId,
					layout,
					tier: cache.tier,
					index: i,
				};
			}
		}
	}

	return null;
}

/** The active world's seed, folded to the int32 worldgen features hash against. */
export function currentWorldSeedAsInt(worldName: string): number {
	return computeSeedAsInt(worldSeedFor(worldName));
}

let _activeSeedAsInt: number | null = null;

/**
 * Seed for the world the player is currently in, resolved lazily from the URL.
 *
 * Cached because it is read on every crate open, and because the terrain seed
 * cannot change while a world is loaded. Multiplay does not use this path — the
 * server owns crate contents there.
 */
export function activeWorldSeedAsInt(): number {
	if (_activeSeedAsInt === null) {
		const worldName = getWorldNameFromUrl();
		_activeSeedAsInt =
			worldName === null ? 0 : currentWorldSeedAsInt(worldName);
	}
	return _activeSeedAsInt;
}

/** Drop the cached seed. Only needed if a world is swapped without a reload. */
export function resetActiveWorldSeed(): void {
	_activeSeedAsInt = null;
}

/** Re-exported so callers do not need to reach into the item table. */
export const TEMPLE_LOOT_ITEM_IDS = ITEM;
