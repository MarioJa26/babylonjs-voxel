import { TextureDefinitions } from "@/code/World/Texture/TextureDefinitions";
import { packRotationSlice } from "@/code/World/BlockEncoding";

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
  shape?: string;
};

const DEFAULT_ITEMS_URL = "/data/items.json";

export class ItemRegistry {
  private static initialized = false;
  private static loadPromise: Promise<void> | null = null;
  private static definitions = new Map<number, ItemDefinition>();
  private static variantsInitialized = false;

  private static readonly SLAB_VARIANTS = [
    { rotation: 0, slice: 4, suffix: "Slab (Bottom)" },
    { rotation: 4, slice: 4, suffix: "Slab (Top)" },
    { rotation: 1, slice: 4, suffix: "Half Wall" },
  ];

  private static toDisplayName(rawName: string): string {
    return (
      rawName
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ") || rawName
    );
  }

  static initDefaults(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const textureDef of TextureDefinitions) {
      const defaultState = 0;
      const baseLabel = this.toDisplayName(textureDef.name);
      const itemLabel =
        textureDef.shape === "slab" ? `${baseLabel} Full Block` : baseLabel;
      this.register({
        id: textureDef.id,
        name: itemLabel,
        description: `Shape: ${textureDef.shape || "cube"}\nID: ${textureDef.id}\nPath: ${textureDef.path}\nName: ${itemLabel}\nblockId: ${textureDef.id}\nblockState: ${defaultState}`,
        materialFolder: textureDef.path,
        useAction: "place_block",
        blockId: textureDef.id,
        blockState: defaultState,
        shape: textureDef.shape || "cube",
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

    const variantBases = TextureDefinitions.filter(
      (textureDef) => textureDef.shape === "slab",
    );

    for (const base of variantBases) {
      const baseLabel = this.toDisplayName(base.name) || `Block ${base.id}`;

      for (const variant of this.SLAB_VARIANTS) {
        const state = packRotationSlice(variant.rotation, variant.slice);
        const label = `${baseLabel} ${variant.suffix}`;
        this.register({
          id: nextId++,
          name: label,
          description: `Block: ${label}`,
          materialFolder: base.path,
          useAction: "place_block",
          blockId: base.id,
          blockState: state,
          shape: "variant",
        });
      }
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
