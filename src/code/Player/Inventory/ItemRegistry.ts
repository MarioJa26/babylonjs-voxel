import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";

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

export class ItemRegistry {
	private static initialized = false;
	private static loadPromise: Promise<void> | null = null;
	private static definitions = new Map<number, ItemDefinition>();

	private static toDisplayName(rawName: string): string {
		return (
			rawName
				.split("_")
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(" ") || rawName
		);
	}

	static initDefaults(): void {
		if (ItemRegistry.initialized) return;
		ItemRegistry.initialized = true;

		for (const textureDef of TextureDefinitions) {
			const defaultState = 0;
			const baseLabel = ItemRegistry.toDisplayName(textureDef.name);
			const itemLabel =
				textureDef.shape === "slab" ? `${baseLabel} Full Block` : baseLabel;
			ItemRegistry.register({
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

	static async ensureLoaded(url = DEFAULT_ITEMS_URL): Promise<void> {
		ItemRegistry.initDefaults();

		if (ItemRegistry.loadPromise) return ItemRegistry.loadPromise;
		ItemRegistry.loadPromise = (async () => {
			await ItemRegistry.loadFromUrl(url);
		})();
		return ItemRegistry.loadPromise;
	}

	static async loadFromUrl(url: string): Promise<void> {
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
				if (!ItemRegistry.isValidDefinition(entry)) {
					console.warn("Skipping invalid item definition:", entry);
					continue;
				}
				ItemRegistry.register(entry);
			}
		} catch (error) {
			console.warn("ItemRegistry load failed:", error);
		}
	}

	static register(def: ItemDefinition): void {
		const existing = ItemRegistry.definitions.get(def.id);
		const merged = existing ? { ...existing, ...def } : def;
		ItemRegistry.definitions.set(def.id, merged);
	}

	static get(id: number): ItemDefinition | undefined {
		ItemRegistry.initDefaults();
		return ItemRegistry.definitions.get(id);
	}

	static getAll(): ItemDefinition[] {
		ItemRegistry.initDefaults();
		return [...ItemRegistry.definitions.values()].sort((a, b) => a.id - b.id);
	}

	private static isValidDefinition(value: unknown): value is ItemDefinition {
		if (!value || typeof value !== "object") return false;
		const candidate = value as Partial<ItemDefinition>;
		return (
			Number.isInteger(candidate.id) &&
			typeof candidate.name === "string" &&
			candidate.name.length > 0
		);
	}
}
