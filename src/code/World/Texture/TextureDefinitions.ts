import { BlockType } from "../BlockType";

export interface TextureDefinition {
	id: BlockType;
	name: string;
	path: string;
	hardness?: number;
	shape?: string;
}

type RawBlockDefinition = {
	id: number | string;
	name: string;
	path: string;
	hardness?: number | null;
	shape?: string | null;
};

const BLOCKS_URL = "/data/blocks.json";

export const TextureDefinitions: TextureDefinition[] =
	await loadBlockDefinitions();

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
		for (const entry of data as RawBlockDefinition[]) {
			if (!entry || typeof entry !== "object") continue;
			const id = normalizeBlockId(entry.id);
			if (id === null) {
				console.warn("Skipping block with invalid id:", entry);
				continue;
			}
			if (typeof entry.name !== "string" || typeof entry.path !== "string") {
				console.warn("Skipping block with invalid fields:", entry);
				continue;
			}
			normalized.push({
				id,
				name: entry.name,
				path: entry.path,
				hardness: entry.hardness ?? undefined,
				shape: entry.shape ?? undefined,
			});
		}

		return normalized;
	} catch (error) {
		console.warn("Block definitions failed to load:", error);
		return [];
	}
}

function normalizeBlockId(id: number | string): BlockType | null {
	if (typeof id === "number" && Number.isFinite(id)) {
		return id as BlockType;
	}
	if (typeof id === "string") {
		const mapped = (BlockType as unknown as Record<string, number>)[id];
		if (typeof mapped === "number") {
			return mapped as BlockType;
		}
	}
	return null;
}

export function getBlockBreakTime(id: number, toolItemId?: number): number {
	const def = getBlockInfo(id);
	const hardness = def?.hardness ?? 0.5;

	if (hardness === Infinity) return Infinity;

	let speedMultiplier = 1;
	if (toolItemId) {
		speedMultiplier = 1.5;
	}

	return (hardness * 1.5) / speedMultiplier;
}

export function getBlockInfo(id: number): TextureDefinition | undefined {
	return TextureDefinitions.find((d) => d.id === id);
}
