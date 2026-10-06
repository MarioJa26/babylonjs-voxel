import {
	clampMaterialTier,
	type MaterialTier,
} from "@/code/Player/Inventory/Materials/MaterialTier";
import {
	getToolKind,
	getToolMiningLevel,
	getToolSpeedMultiplier,
	parseToolKind,
	type ToolKindId,
} from "@/code/Player/Inventory/ProceduralTools";
import blocksRaw from "../../../data/blocks.json";
import { BlockType } from "./BlockType";

export interface TextureDefinition {
	id: BlockType;
	name: string;
	path: string;
	hardness?: number;
	shape?: string;
	preferredTool?: ToolKindId;
	/**
	 * MaterialTier required to harvest this block, compared against
	 * `getToolMiningLevel()`. Omitted means hand-mineable.
	 *
	 * A too-weak tool still breaks the block — it just yields nothing, and
	 * slowly. That reads as a wall without ever producing a dead end.
	 */
	requiredLevel?: MaterialTier;
}

const BLOCKS_URL = "/data/blocks.json";

/**
 * The same data as the fetch below, bundled.
 *
 * `/data/blocks.json` is a root-relative URL, which `fetch` only accepts in a
 * browser. Under Node (tests, the headless checks) it rejects with
 * ERR_INVALID_URL, and because the load failure was swallowed the caller got an
 * empty definition list rather than an error — so every block silently fell back
 * to default hardness and looked unbreakable or unminable. Importing the file
 * directly, as `BlockShapes.ts` already does, keeps the definitions populated
 * everywhere. `public/data/blocks.json` stays the source of truth and is copied
 * to `src/data/blocks.json`.
 */
const BUNDLED_BLOCKS = blocksRaw as unknown;

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
	const data = await loadBlockData();

	if (!Array.isArray(data)) {
		console.warn("Blocks JSON must be an array; using bundled copy.");
		return normalizeBlockData(BUNDLED_BLOCKS);
	}

	return normalizeBlockData(data);
}

/**
 * Prefer the live file, fall back to the bundled copy.
 *
 * A failed fetch must not silently yield zero definitions — an empty list reads
 * as "every block has default hardness", which is a much harder failure to spot
 * than a loud one.
 */
async function loadBlockData(): Promise<unknown> {
	// A root-relative URL only resolves against a document/worker base. Under Node
	// there is none, so go straight to the bundled copy rather than provoking an
	// Invalid URL rejection on every load.
	if (typeof location === "undefined" || location.href === "") {
		return BUNDLED_BLOCKS;
	}

	try {
		const response = await fetch(BLOCKS_URL);

		if (!response.ok) {
			throw new Error(`Failed to load blocks: ${response.status}`);
		}

		return (await response.json()) as unknown;
	} catch (error) {
		console.warn("Falling back to bundled blocks.json:", error);
		return BUNDLED_BLOCKS;
	}
}

function normalizeBlockData(data: unknown): TextureDefinition[] {
	if (!Array.isArray(data)) return [];

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

		const preferred = parseToolKind(raw.preferredTool);
		if (preferred !== undefined) {
			definition.preferredTool = preferred;
		}

		if (raw.requiredLevel !== undefined) {
			const requiredLevel = clampMaterialTier(raw.requiredLevel);
			if (requiredLevel === undefined) {
				console.warn(
					`Block ${definition.name} has an out-of-range requiredLevel:`,
					raw.requiredLevel,
				);
			} else {
				definition.requiredLevel = requiredLevel;
			}
		}

		normalized.push(definition);
	}

	return normalized;
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

/**
 * Seconds to break a block. Distinct from {@link canHarvestBlock}: a block can
 * always be broken if it is finite-hardness, but a too-weak tool breaks it
 * slowly and drops nothing.
 */
export function getBlockBreakTime(id: number, toolItemId?: number): number {
	const def = TextureDefinitionMap.get(id);
	const hardness = def?.hardness ?? DEFAULT_BLOCK_HARDNESS;

	if (hardness === Infinity) {
		return Infinity;
	}

	if (!toolItemId) {
		return hardness * BREAK_TIME_SCALE;
	}

	const preferredTool = def?.preferredTool;
	const toolKind = getToolKind(toolItemId);
	const speedMultiplier = getToolSpeedMultiplier(toolItemId);

	// Block has a preferred tool: only correct tool kind gets its speed bonus.
	// Wrong tool or non-tool → hand speed (1x).
	if (preferredTool !== undefined) {
		if (toolKind !== preferredTool) {
			return hardness * BREAK_TIME_SCALE;
		}
		// Correct tool kind: apply its multiplier (fallback to default if unknown material)
		return (
			(hardness * BREAK_TIME_SCALE) /
			(speedMultiplier ?? DEFAULT_TOOL_SPEED_MULTIPLIER)
		);
	}

	// No preferred tool: any tool still speeds up (backward compatible).
	const effectiveSpeed = speedMultiplier ?? DEFAULT_TOOL_SPEED_MULTIPLIER;
	return (hardness * BREAK_TIME_SCALE) / effectiveSpeed;
}

/**
 * Whether the tool can harvest a block's drop.
 *
 * True when the block declares no `requiredLevel`, or when the tool's material
 * meets or exceeds it. Blocks with no blocks.json entry fall back to requiring
 * nothing so unregistered experimental ids stay collectable.
 *
 * A block with `hardness: Infinity` is never harvestable — you cannot harvest
 * what you cannot break.
 */
export function canHarvestBlock(id: number, toolItemId?: number): boolean {
	const def = TextureDefinitionMap.get(id);

	if (def?.hardness === Infinity) return false;

	const requiredLevel = def?.requiredLevel;

	if (requiredLevel === undefined) {
		return true;
	}

	return getToolMiningLevel(toolItemId) >= requiredLevel;
}

/**
 * MaterialTier needed to harvest a block, for HUD messaging.
 * Undefined when the block is not gated.
 */
export function getBlockRequiredLevel(id: number): MaterialTier | undefined {
	return TextureDefinitionMap.get(id)?.requiredLevel;
}

export function getBlockInfo(id: number): TextureDefinition | undefined {
	return TextureDefinitionMap.get(id);
}
