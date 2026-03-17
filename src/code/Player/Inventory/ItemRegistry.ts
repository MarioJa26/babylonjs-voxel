import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import { packRotationSlice } from "@/code/World/BlockEncoding";
import { BlockType } from "@/code/World/BlockType";

export type ItemDefinition = {
  id: number;
  name: string;
  description?: string;
  icon?: string;
  materialFolder?: string;
  maxStack?: number;
  useAction?: string;
  blockId?: number;
  blockState?: number;
};

const DEFAULT_ITEMS_URL = "/data/items.json";

export class ItemRegistry {
  private static initialized = false;
  private static loadPromise: Promise<void> | null = null;
  private static definitions = new Map<number, ItemDefinition>();
  private static variantsInitialized = false;

  private static readonly COBBLE_VARIANTS = [
    { rotation: 0, slice: 4, label: "Cobble Slab (Bottom)" },
    { rotation: 4, slice: 4, label: "Cobble Slab (Top)" },
    { rotation: 1, slice: 4, label: "Cobble Half Wall (X-)" },
    { rotation: 5, slice: 4, label: "Cobble Half Wall (X+)" },
    { rotation: 2, slice: 4, label: "Cobble Half Wall (Z-)" },
    { rotation: 6, slice: 4, label: "Cobble Half Wall (Z+)" },
  ];

  static initDefaults(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const textureDef of TextureDefinitions) {
      this.register({
        id: textureDef.id,
        name: textureDef.name,
        description: `Shape: ${textureDef.shape || "cube"}`,
        materialFolder: textureDef.path,
        useAction: "place_block",
        blockId: textureDef.id,
        blockState: 0,
      });
    }
  }

  static async ensureLoaded(url = DEFAULT_ITEMS_URL): Promise<void> {
    this.initDefaults();

    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      await this.loadFromUrl(url);
      this.ensureBlockStateVariants();
    })();
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

  private static ensureBlockStateVariants(): void {
    if (this.variantsInitialized) return;
    this.variantsInitialized = true;

    let nextId = 1;
    for (const id of this.definitions.keys()) {
      if (id >= nextId) nextId = id + 1;
    }

    const cobbleDef = TextureDefinitions.find(
      (textureDef) => textureDef.id === BlockType.Cobble,
    );
    if (!cobbleDef) return;

    for (const variant of this.COBBLE_VARIANTS) {
      const state = packRotationSlice(variant.rotation, variant.slice);
      this.register({
        id: nextId++,
        name: variant.label,
        description: `Block: ${variant.label}`,
        materialFolder: cobbleDef.path,
        useAction: "place_block",
        blockId: cobbleDef.id,
        blockState: state,
      });
    }
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
