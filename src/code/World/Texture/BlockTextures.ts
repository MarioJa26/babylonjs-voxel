import { TextureDefinitions } from "./TextureDefinitions";

type BlockTextureDef = {
	top?: number[];
	bottom?: number[];
	side?: number[];
	all?: number[];
	[key: string]: number[] | undefined;
};

// Build BlockTextures from TextureDefinitions index order.
// UV coordinates are initially based on index position in the atlas.
export const BlockTextures: (BlockTextureDef | null)[] = buildBlockTextures();

function buildBlockTextures(): (BlockTextureDef | null)[] {
	const result: (BlockTextureDef | null)[] = [null]; // index 0 = air

	for (let i = 0; i < TextureDefinitions.length; i++) {
		const def = TextureDefinitions[i];
		if (!def) {
			result.push(null);
			continue;
		}
		// Calculate UV based on index position (col, row in 16x16 atlas)
		const col = i % 16;
		const row = Math.floor(i / 16);
		result.push({ all: [col, row] });
	}

	return result;
}

// Call this after the atlas is built to update UV coordinates
// Pass the UV map from TextureAtlasFactory to avoid importing it (worker compatibility)
export function updateBlockTexturesUV(uvMap: Record<string, { u: number; v: number; tileSize: number }>): void {
	if (BlockTextures.length <= 1) return;

	for (let i = 1; i < BlockTextures.length && i <= TextureDefinitions.length; i++) {
		const def = TextureDefinitions[i - 1];
		if (!def || !BlockTextures[i]) continue;

		const uv = uvMap[def.name];
		if (uv) {
			BlockTextures[i] = { all: [Math.round(uv.u * 16), Math.round(uv.v * 16)] };
		}
	}
}
export function getAtlasTile(blockId: number | null): [number, number] | null {
	if (blockId === null) return null;

	const blockTexture = BlockTextures[blockId];
	if (!blockTexture) return null;

	const uv =
		blockTexture.all ??
		blockTexture.side ??
		blockTexture.top ??
		blockTexture.bottom;

	if (!uv || uv.length < 2) return null;
	return [uv[0], uv[1]];
}
