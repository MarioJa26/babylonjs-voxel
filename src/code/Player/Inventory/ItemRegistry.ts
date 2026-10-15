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
// Numeric nested maps avoid string-key allocation during registration and lookup.
const blockIndex = new Map<number, Map<number, ItemDefinition>>();

// Cached sorted snapshot, invalidated whenever `definitions` changes.
let sortedCache: ItemDefinition[] | null = null;

function getBlockState(definition: ItemDefinition): number {
	return definition.blockState ?? 0;
}

function setBlockIndex(
	blockId: number,
	blockState: number,
	definition: ItemDefinition,
): void {
	let stateMap = blockIndex.get(blockId);

	if (stateMap === undefined) {
		stateMap = new Map<number, ItemDefinition>();

		blockIndex.set(blockId, stateMap);
	}

	stateMap.set(blockState, definition);
}

/**
 * Removes an index entry only when it is still owned by the supplied
 * definition.
 *
 * Multiple item IDs may temporarily claim the same block/state pair. Because
 * the most recently registered definition owns that reverse-index entry,
 * re-registering an older definition must not delete the newer owner's entry.
 */
function deleteBlockIndex(
	blockId: number,
	blockState: number,
	expectedDefinition: ItemDefinition,
): void {
	const stateMap = blockIndex.get(blockId);

	if (stateMap === undefined) {
		return;
	}

	if (stateMap.get(blockState) !== expectedDefinition) {
		return;
	}

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

/**
 * Registers block-backed default items from the texture definitions.
 *
 * initialized is set before registration to make this function re-entry-safe
 * if registration code performs a registry lookup.
 */
function initDefaults(): void {
	if (initialized) {
		return;
	}

	if (import.meta.env?.DEV && loadPromise === null) {
		console.warn(
			"ItemRegistry: reading definitions before " +
				"ensureItemRegistryLoaded() has been called. " +
				"TextureDefinitions may be incomplete.",
		);
	}

	initialized = true;

	for (
		let index = 0, length = TextureDefinitions.length;
		index < length;
		index++
	) {
		const textureDefinition = TextureDefinitions[index];

		const blockState = 0;
		const shape = textureDefinition.shape || "cube";

		const baseLabel = registerItemToDisplayName(textureDefinition.name);

		const itemLabel = shape === "slab" ? `${baseLabel} Full Block` : baseLabel;

		registerItem({
			id: textureDefinition.id,
			name: itemLabel,
			description:
				`Shape: ${shape}\n` +
				`ID: ${textureDefinition.id}\n` +
				`Path: ${textureDefinition.path}\n` +
				`Name: ${itemLabel}\n` +
				`blockId: ${textureDefinition.id}\n` +
				`blockState: ${blockState}`,
			useAction: "place_block",
			blockId: textureDefinition.id,
			blockState,
			shape,
		});
	}
}

/**
 * Loads the registry once.
 *
 * Concurrent calls share one promise. The URL supplied by the first caller
 * owns the registry load for the lifetime of this module.
 */
export function ensureItemRegistryLoaded(
	url = DEFAULT_ITEMS_URL,
): Promise<void> {
	if (loadPromise !== null) {
		if (loadedUrl !== null && loadedUrl !== url) {
			console.warn(
				"ItemRegistry: ensureItemRegistryLoaded " +
					`already started with "${loadedUrl}"; ` +
					`ignoring second call with "${url}".`,
			);
		}

		return loadPromise;
	}

	loadedUrl = url;

	loadPromise = loadItemRegistry(url);
	return loadPromise;
}

async function loadItemRegistry(url: string): Promise<void> {
	await TextureDefinitionsReady;

	initDefaults();

	await loadRegisteredItemsFromUrl(url);

	registerProceduralTools(registerItem);
}

async function loadRegisteredItemsFromUrl(url: string): Promise<void> {
	try {
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(
				`Failed to load items from "${url}": ` +
					`${response.status} ${response.statusText}`,
			);
		}

		const data: unknown = await response.json();

		if (!Array.isArray(data)) {
			throw new Error("Items JSON must contain an array.");
		}

		for (let index = 0, length = data.length; index < length; index++) {
			const entry: unknown = data[index];

			if (!isValidDefinition(entry)) {
				console.warn("ItemRegistry: skipping invalid item definition:", entry);

				continue;
			}

			registerItem(entry);
		}
	} catch (error) {
		console.warn(`ItemRegistry: failed to load "${url}":`, error);
	}
}

/**
 * Registers or updates an item definition.
 *
 * Existing definitions are shallowly merged so partial programmatic
 * registrations continue to preserve fields omitted by the incoming
 * definition.
 */
export function registerItem(definition: ItemDefinition): void {
	const existing = definitions.get(definition.id);

	if (existing !== undefined && existing.blockId !== definition.blockId) {
		console.warn(
			`ItemRegistry: item id ${definition.id} was registered ` +
				"twice with different blockIds. " +
				`Existing "${existing.name}" uses blockId ` +
				`${String(existing.blockId)}; incoming ` +
				`"${definition.name}" uses blockId ` +
				`${String(definition.blockId)}. ` +
				"One of the data sources may be using an item ID " +
				"range it does not own.",
		);
	}

	if (existing !== undefined && existing.blockId !== undefined) {
		deleteBlockIndex(existing.blockId, getBlockState(existing), existing);
	}

	const registeredDefinition =
		existing === undefined
			? definition
			: {
					...existing,
					...definition,
				};

	definitions.set(definition.id, registeredDefinition);

	sortedCache = null;

	if (registeredDefinition.blockId !== undefined) {
		setBlockIndex(
			registeredDefinition.blockId,
			getBlockState(registeredDefinition),
			registeredDefinition,
		);
	}
}

export function getRegisteredItemById(id: number): ItemDefinition | undefined {
	initDefaults();

	return definitions.get(id);
}

/**
 * Finds the item that places the supplied block/state pair.
 *
 * Lookup complexity is O(1) through the nested numeric reverse index.
 */
export function getItemByBlock(
	blockId: number,
	blockState = 0,
): ItemDefinition | undefined {
	initDefaults();

	return blockIndex.get(blockId)?.get(blockState);
}

/**
 * Returns the cached ID-sorted registry snapshot.
 *
 * Callers must treat the returned array as read-only. The ItemDefinition[]
 * return type is retained for compatibility with existing call sites.
 */
export function getAllRegisteredItems(): ItemDefinition[] {
	initDefaults();

	if (sortedCache === null) {
		sortedCache = Array.from(definitions.values());

		sortedCache.sort(compareItemIds);
	}

	return sortedCache;
}

function compareItemIds(first: ItemDefinition, second: ItemDefinition): number {
	return first.id - second.id;
}

function isValidDefinition(value: unknown): value is ItemDefinition {
	if (value === null || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<ItemDefinition>;

	if (
		!Number.isInteger(candidate.id) ||
		typeof candidate.name !== "string" ||
		candidate.name.length === 0
	) {
		return false;
	}

	if (candidate.blockId !== undefined && !Number.isInteger(candidate.blockId)) {
		return false;
	}

	if (
		candidate.blockState !== undefined &&
		!Number.isInteger(candidate.blockState)
	) {
		return false;
	}

	return true;
}
