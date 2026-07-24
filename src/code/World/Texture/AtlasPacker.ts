import type { EngineContext, Texture2DArray } from "@babylonjs/lite";
import { createTexture2DArray, uploadImageToArrayLayer } from "@babylonjs/lite";

const DIFFUSE_URL = "/texture/diffuse_atlas.png";
const NORMAL_URL = "/texture/normal_atlas.png";

const TILE_SIZE = 25;
const ATLAS_SIZE = 16;

async function loadImageBitmap(url: string): Promise<ImageBitmap> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
	const blob = await resp.blob();
	return createImageBitmap(blob);
}

async function loadTilesIntoArray(
	engine: EngineContext,
	url: string,
): Promise<Texture2DArray> {
	const bitmap = await loadImageBitmap(url);

	const texArray = createTexture2DArray(
		engine,
		TILE_SIZE,
		TILE_SIZE,
		ATLAS_SIZE * ATLAS_SIZE,
		{
			mipMaps: true,
			magFilter: "nearest",
			minFilter: "nearest",
		},
	);

	for (let ty = 0; ty < ATLAS_SIZE; ty++) {
		for (let tx = 0; tx < ATLAS_SIZE; tx++) {
			const layer = ty * ATLAS_SIZE + tx;
			const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(
				bitmap,
				tx * TILE_SIZE,
				ty * TILE_SIZE,
				TILE_SIZE,
				TILE_SIZE,
				0,
				0,
				TILE_SIZE,
				TILE_SIZE,
			);
			uploadImageToArrayLayer(engine, texArray, layer, canvas);
		}
	}

	return texArray;
}

export async function packAtlas(engine: EngineContext): Promise<{
	diffuse: Texture2DArray;
	normal: Texture2DArray;
	transparent: Texture2DArray;
}> {
	const [diffuse, normal] = await Promise.all([
		loadTilesIntoArray(engine, DIFFUSE_URL),
		loadTilesIntoArray(engine, NORMAL_URL),
	]);

	return { diffuse, normal, transparent: diffuse };
}
