import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";

export type ItemDefinition = {
  id: number;
  name: string;
  description?: string;
  icon?: string;
  materialFolder?: string;
  maxStack?: number;
  useAction?: string;
};

const DEFAULT_ITEMS_URL = "/data/items.json";

export class ItemRegistry {
  private static initialized = false;
  private static loadPromise: Promise<void> | null = null;
  private static definitions = new Map<number, ItemDefinition>();

  static initDefaults(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const textureDef of TextureDefinitions) {
      this.register({
        id: textureDef.id,
        name: textureDef.name,
        description: `Block: ${textureDef.name}`,
        materialFolder: textureDef.path,
        useAction: "place_block",
      });
    }
  }

  static async ensureLoaded(url = DEFAULT_ITEMS_URL): Promise<void> {
    this.initDefaults();

    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFromUrl(url);
    return this.loadPromise;
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
        if (!this.isValidDefinition(entry)) {
          console.warn("Skipping invalid item definition:", entry);
          continue;
        }
        this.register(entry);
      }
    } catch (error) {
      console.warn("ItemRegistry load failed:", error);
    }
  }

  static register(def: ItemDefinition): void {
    const existing = this.definitions.get(def.id);
    const merged = existing ? { ...existing, ...def } : def;
    this.definitions.set(def.id, merged);
  }

  static get(id: number): ItemDefinition | undefined {
    this.initDefaults();
    return this.definitions.get(id);
  }

  static getAll(): ItemDefinition[] {
    this.initDefaults();
    return [...this.definitions.values()].sort((a, b) => a.id - b.id);
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
