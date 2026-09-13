import {
	TextureDefinitions,
	TextureDefinitionsReady,
} from "@/code/World/Texture/TextureDefinitions";
import { registerProceduralTools } from "./ProceduralTools";
import type { ItemDefinition } from "./Types/InventoryTypes";

const DEFAULT_ITEMS_URL = "/data/items.json";

let initialized = false;
let loadPromise: Promise<void> | null = null;
let loadedUrl: string | null = null;

const definitions = new Map<number, ItemDefinition>();

// Reverse index:
// blockId -> blockState -> item definition
// Avoids string-key allocation on register and lookup.
const blockIndex = new Map<number, Map<number, ItemDefinition>>();

// Cached sorted snapshot; invalidated on any write to `definitions`.
let sortedCache: ItemDefinition[] | null = null;

function getBlockState(def: ItemDefinition): number {
	return def.blockState ?? 0;
}

function setBlockIndex(
	blockId: number,
	blockState: number,
	def: ItemDefinition,
): void {
	let stateMap = blockIndex.get(blockId);
	if (stateMap === undefined) {
		stateMap = new Map<number, ItemDefinition>();
		blockIndex.set(blockId, stateMap);
	}
	stateMap.set(blockState, def);
}

function deleteBlockIndex(blockId: number, blockState: number): void {
	const stateMap = blockIndex.get(blockId);
	if (stateMap === undefined) return;

	stateMap.delete(blockState);

	if (stateMap.size === 0) {
		blockIndex.delete(blockId);
	}
}

export function registerItemToDisplayName(rawName: string): string {
	return (
		rawName
			.split("_")
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ") || rawName
	);
}

function initDefaults(): void {
	if (initialized) return;

	if (import.meta.env?.DEV && loadPromise === null) {
		console.warn(
			"ItemRegistry: reading definitions before ensureItemRegistryLoaded() " +
				"has been called. TextureDefinitions may be incomplete.",
		);
	}

	initialized = true;

	for (let i = 0, len = TextureDefinitions.length; i < len; i++) {
		const textureDef = TextureDefinitions[i];
		const defaultState = 0;
		const shape = textureDef.shape || "cube";
		const baseLabel = registerItemToDisplayName(textureDef.name);
		const itemLabel = shape === "slab" ? `${baseLabel} Full Block` : baseLabel;

		registerItem({
			id: textureDef.id,
			name: itemLabel,
			description:
				`Shape: ${shape}\n` +
				`ID: ${textureDef.id}\n` +
				`Path: ${textureDef.path}\n` +
				`Name: ${itemLabel}\n` +
				`blockId: ${textureDef.id}\n` +
				`blockState: ${defaultState}`,
			useAction: "place_block",
			blockId: textureDef.id,
			blockState: defaultState,
			shape,
		});
	}
}

export async function ensureItemRegistryLoaded(
	url = DEFAULT_ITEMS_URL,
): Promise<void> {
	if (loadPromise !== null) {
		if (loadedUrl !== null && loadedUrl !== url) {
			console.warn(
				`ItemRegistry: ensureItemRegistryLoaded already loaded from "${loadedUrl}"; ` +
					`ignoring second call with "${url}".`,
			);
		}
		return loadPromise;
	}

	loadedUrl = url;

	loadPromise = (async () => {
		await TextureDefinitionsReady;
		initDefaults();
		await loadRegisteredItemFromUrl(url);
		registerProceduralTools(registerItem);
	})();

	return loadPromise;
}

async function loadRegisteredItemFromUrl(url: string): Promise<void> {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to load items: ${response.status}`);
		}

		const data = (await response.json()) as unknown;
		if (!Array.isArray(data)) {
			throw new Error("Items JSON must be an array.");
		}

		for (let i = 0, len = data.length; i < len; i++) {
			const entry = data[i];

			if (!isValidDefinition(entry)) {
				console.warn("Skipping invalid item definition:", entry);
				continue;
			}

			registerItem(entry);
		}
	} catch (error) {
		console.warn("ItemRegistry load failed:", error);
	}
}

export function registerItem(def: ItemDefinition): void {
	const existing = definitions.get(def.id);

	if (existing !== undefined && existing.blockId !== undefined) {
		deleteBlockIndex(existing.blockId, getBlockState(existing));
	}

	const merged = existing === undefined ? def : { ...existing, ...def };

	definitions.set(def.id, merged);
	sortedCache = null;

	if (merged.blockId !== undefined) {
		setBlockIndex(merged.blockId, getBlockState(merged), merged);
	}
}

export function getRegisteredItemById(id: number): ItemDefinition | undefined {
	initDefaults();
	return definitions.get(id);
}

/**
 * Reverse lookup: find the item that places a given block/state pair.
 * O(1) via nested numeric index instead of scanning all definitions.
 */
export function getItemByBlock(
	blockId: number,
	blockState = 0,
): ItemDefinition | undefined {
	initDefaults();

	const stateMap = blockIndex.get(blockId);
	return stateMap === undefined ? undefined : stateMap.get(blockState);
}

export function getAllRegisteredItems(): ItemDefinition[] {
	initDefaults();

	if (sortedCache === null) {
		sortedCache = [...definitions.values()].sort(compareItemIds);
	}

	return sortedCache;
}

function compareItemIds(a: ItemDefinition, b: ItemDefinition): number {
	return a.id - b.id;
}

function isValidDefinition(value: unknown): value is ItemDefinition {
	if (value === null || typeof value !== "object") return false;

	const candidate = value as Partial<ItemDefinition>;

	return (
		Number.isInteger(candidate.id) &&
		typeof candidate.name === "string" &&
		candidate.name.length > 0
	);
}
