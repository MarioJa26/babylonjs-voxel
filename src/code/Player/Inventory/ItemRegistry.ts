import {
	TextureDefinitions,
	TextureDefinitionsReady,
} from "@/code/World/Texture/TextureDefinitions";
import { registerProceduralTools } from "./ProceduralTools";

export type ItemDefinition = {
	id: number;
	name: string;
	description?: string;
	icon?: string;
	maxStack?: number;
	useAction?: string;
	blockId?: number;
	blockState?: number;
	shape?: string;
};

const DEFAULT_ITEMS_URL = "/data/items.json";

let initialized = false;
let loadPromise: Promise<void> | null = null;
let loadedUrl: string | null = null;

const definitions = new Map<number, ItemDefinition>();
// Reverse index for "what item places this block state" lookups
// (e.g. hover tooltips), avoiding an O(n) scan of `definitions`.
const blockIndex = new Map<string, ItemDefinition>();

// Cached sorted snapshot; invalidated on any write to `definitions`.
let sortedCache: ItemDefinition[] | null = null;

function blockKey(blockId: number, blockState: number): string {
	return `${blockId}:${blockState}`;
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

	if (import.meta.env?.DEV && !loadPromise) {
		console.warn(
			"ItemRegistry: reading definitions before ensureItemRegistryLoaded() " +
				"has been called. TextureDefinitions may be incomplete.",
		);
	}

	initialized = true;

	for (const textureDef of TextureDefinitions) {
		const defaultState = 0;
		const baseLabel = registerItemToDisplayName(textureDef.name);
		const itemLabel =
			textureDef.shape === "slab" ? `${baseLabel} Full Block` : baseLabel;
		registerItem({
			id: textureDef.id,
			name: itemLabel,
			description: `Shape: ${textureDef.shape || "cube"}\nID: ${textureDef.id}\nPath: ${textureDef.path}\nName: ${itemLabel}\nblockId: ${textureDef.id}\nblockState: ${defaultState}`,
			useAction: "place_block",
			blockId: textureDef.id,
			blockState: defaultState,
			shape: textureDef.shape || "cube",
		});
	}
}

export async function ensureItemRegistryLoaded(
	url = DEFAULT_ITEMS_URL,
): Promise<void> {
	if (loadPromise) {
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

		for (const entry of data) {
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
	const merged = existing ? { ...existing, ...def } : def;
	definitions.set(def.id, merged);
	sortedCache = null;

	if (merged.blockId !== undefined) {
		blockIndex.set(blockKey(merged.blockId, merged.blockState ?? 0), merged);
	}
}

export function getRegisteredItemById(id: number): ItemDefinition | undefined {
	initDefaults();
	return definitions.get(id);
}

/**
 * Reverse lookup: find the item that places a given block/state pair.
 * O(1) via index instead of scanning all definitions.
 */
export function getItemByBlock(
	blockId: number,
	blockState = 0,
): ItemDefinition | undefined {
	initDefaults();
	return blockIndex.get(blockKey(blockId, blockState));
}

export function getAllRegisteredItems(): ItemDefinition[] {
	initDefaults();
	if (sortedCache === null) {
		sortedCache = [...definitions.values()].sort((a, b) => a.id - b.id);
	}
	return sortedCache;
}

function isValidDefinition(value: unknown): value is ItemDefinition {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ItemDefinition>;
	return (
		Number.isInteger(candidate.id) &&
		typeof candidate.name === "string" &&
		candidate.name.length > 0
	);
}
