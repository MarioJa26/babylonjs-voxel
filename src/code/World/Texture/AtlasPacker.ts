import type { EngineContext, Texture2D } from "@babylonjs/lite";
import { loadTexture2D } from "@babylonjs/lite";

const DIFFUSE_URL = "/texture/diffuse_atlas.png";
const NORMAL_URL = "/texture/normal_atlas.png";

export async function packAtlas(
	engine: EngineContext,
): Promise<{ diffuse: Texture2D; normal: Texture2D; transparent: Texture2D }> {
	const [diffuse, normal] = await Promise.all([
		loadTexture2D(engine, DIFFUSE_URL, {
			mipMaps: false,
			magFilter: "nearest",
			minFilter: "nearest",
		}),
		loadTexture2D(engine, NORMAL_URL, {
			mipMaps: false,
			magFilter: "nearest",
			minFilter: "nearest",
		}),
	]);

	const transparent = await loadTexture2D(engine, DIFFUSE_URL, {
		mipMaps: false,
		magFilter: "nearest",
		minFilter: "nearest",
	});

	return { diffuse, normal, transparent };
}
