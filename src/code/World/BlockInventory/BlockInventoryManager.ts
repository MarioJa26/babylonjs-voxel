import { Item } from "@/code/Player/Inventory/Item";
import { ItemSlot } from "@/code/Player/Inventory/ItemSlot";

const STORAGE_KEY = "b102.blockInventories.v1";
const DEFAULT_COLS = 3;
const DEFAULT_ROWS = 6;

export interface SavedBlockInventoryItem {
	itemId: number;
	stackSize: number;
}

export interface SavedBlockInventory {
	width: number;
	height: number;
	slots: (SavedBlockInventoryItem | null)[][];
}

function posKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

let allInventories: Map<string, SavedBlockInventory> | null = null;

function loadAll(): Map<string, SavedBlockInventory> {
	if (allInventories) return allInventories;
	allInventories = new Map();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const obj = JSON.parse(raw) as Record<string, SavedBlockInventory>;
			for (const [k, v] of Object.entries(obj)) {
				allInventories.set(k, v);
			}
		}
	} catch {
		// corrupt data — start fresh
	}
	return allInventories;
}

function saveAll(): void {
	if (!allInventories) return;
	const obj: Record<string, SavedBlockInventory> = {};
	for (const [k, v] of allInventories) {
		obj[k] = v;
	}
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
	} catch {
		// storage full — silently ignore
	}
}

export function getBlockInventory(
	x: number,
	y: number,
	z: number,
): SavedBlockInventory {
	const map = loadAll();
	const key = posKey(x, y, z);
	let inv = map.get(key);
	if (!inv) {
		inv = createEmptyInventory(DEFAULT_COLS, DEFAULT_ROWS);
		map.set(key, inv);
		saveAll();
	}
	return inv;
}

export function saveBlockInventory(
	x: number,
	y: number,
	z: number,
	inv: SavedBlockInventory,
): void {
	const map = loadAll();
	map.set(posKey(x, y, z), inv);
	saveAll();
}

export function createEmptyInventory(
	width: number,
	height: number,
): SavedBlockInventory {
	const slots: (SavedBlockInventoryItem | null)[][] = [];
	for (let r = 0; r < height; r++) {
		const row: (SavedBlockInventoryItem | null)[] = [];
		for (let c = 0; c < width; c++) {
			row.push(null);
		}
		slots.push(row);
	}
	return { width, height, slots };
}

/**
 * Build a live ItemSlot grid from a saved block inventory state.
 * Returns the 2D array of ItemSlots that can be appended to the DOM.
 */
export function buildBlockInventorySlots(
	saved: SavedBlockInventory,
): ItemSlot[][] {
	const grid: ItemSlot[][] = [];
	for (let r = 0; r < saved.height; r++) {
		const row: ItemSlot[] = [];
		for (let c = 0; c < saved.width; c++) {
			const slot = new ItemSlot(r, c);
			const savedItem = saved.slots[r]?.[c];
			if (savedItem) {
				try {
					const item = Item.createById(savedItem.itemId, r, c);
					item.stackSize = savedItem.stackSize;
					slot.item = item;
					slot.divItemSlot.appendChild(item.div);
				} catch {
					// item id no longer valid — skip
				}
			}
			row.push(slot);
		}
		grid.push(row);
	}
	return grid;
}

/**
 * Serialize a live ItemSlot grid back to a SavedBlockInventory.
 */
export function serializeBlockSlots(grid: ItemSlot[][]): SavedBlockInventory {
	const slots: (SavedBlockInventoryItem | null)[][] = [];
	for (const row of grid) {
		const savedRow: (SavedBlockInventoryItem | null)[] = [];
		for (const slot of row) {
			if (slot.item) {
				savedRow.push({
					itemId: slot.item.itemId,
					stackSize: slot.item.stackSize,
				});
			} else {
				savedRow.push(null);
			}
		}
		slots.push(savedRow);
	}
	return {
		width: grid[0]?.length ?? DEFAULT_COLS,
		height: grid.length,
		slots,
	};
}
