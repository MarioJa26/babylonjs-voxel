import { getToolSpeedMultiplier } from "@/code/Player/Inventory/ProceduralTools";
import { BlockType } from "./BlockType";

export interface TextureDefinition {
	id: BlockType;
	name: string;
	path: string;
	hardness?: number;
	shape?: string;
}

const BLOCKS_URL = "/data/blocks.json";

const DEFAULT_BLOCK_HARDNESS = 0.5;
const BREAK_TIME_SCALE = 1.5;
const DEFAULT_TOOL_SPEED_MULTIPLIER = 1.5;

export const TextureDefinitions: TextureDefinition[] = [];
export const TextureDefinitionMap: Map<number, TextureDefinition> = new Map();

export const TextureDefinitionsReady: Promise<TextureDefinition[]> =
	loadAndPublishBlockDefinitions();

async function loadAndPublishBlockDefinitions(): Promise<TextureDefinition[]> {
	const definitions = await loadBlockDefinitions();

	// Preserve the exported array reference, but avoid spread/splice for large files.
	TextureDefinitions.length = definitions.length;
	TextureDefinitionMap.clear();

	for (let i = 0; i < definitions.length; i++) {
		const definition = definitions[i];
		TextureDefinitions[i] = definition;
		TextureDefinitionMap.set(definition.id, definition);
	}

	return TextureDefinitions;
}

async function loadBlockDefinitions(): Promise<TextureDefinition[]> {
	try {
		const response = await fetch(BLOCKS_URL);

		if (!response.ok) {
			throw new Error(`Failed to load blocks: ${response.status}`);
		}

		const data = (await response.json()) as unknown;

		if (!Array.isArray(data)) {
			throw new Error("Blocks JSON must be an array.");
		}

		const normalized: TextureDefinition[] = [];

		for (const entry of data) {
			if (!entry || typeof entry !== "object") {
				continue;
			}

			const raw = entry as Record<string, unknown>;
			const id = normalizeBlockId(raw.id);

			if (id === null) {
				console.warn("Skipping block with invalid id:", entry);
				continue;
			}

			if (typeof raw.name !== "string" || typeof raw.path !== "string") {
				console.warn("Skipping block with invalid fields:", entry);
				continue;
			}

			const definition: TextureDefinition = {
				id,
				name: raw.name,
				path: raw.path,
			};

			if (typeof raw.hardness === "number") {
				definition.hardness = raw.hardness;
			}

			if (typeof raw.shape === "string") {
				definition.shape = raw.shape;
			}

			normalized.push(definition);
		}

		return normalized;
	} catch (error) {
		console.warn("Block definitions failed to load:", error);
		return [];
	}
}

function normalizeBlockId(id: unknown): BlockType | null {
	if (typeof id === "number" && Number.isFinite(id)) {
		return id as BlockType;
	}

	if (typeof id === "string") {
		const mapped = (BlockType as unknown as Record<string, unknown>)[id];

		if (typeof mapped === "number") {
			return mapped as BlockType;
		}
	}

	return null;
}

export function getBlockBreakTime(id: number, toolItemId?: number): number {
	const hardness =
		TextureDefinitionMap.get(id)?.hardness ?? DEFAULT_BLOCK_HARDNESS;

	if (hardness === Infinity) {
		return Infinity;
	}

	const speedMultiplier = toolItemId
		? (getToolSpeedMultiplier(toolItemId) ?? DEFAULT_TOOL_SPEED_MULTIPLIER)
		: 1;

	return (hardness * BREAK_TIME_SCALE) / speedMultiplier;
}

export function getBlockInfo(id: number): TextureDefinition | undefined {
	return TextureDefinitionMap.get(id);
}
