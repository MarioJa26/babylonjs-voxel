import type { Texture } from "@babylonjs/core";

export type TileUV = {
	u: number;
	v: number;
	tileSize: number;
};

export class TextureAtlasFactory {
	private static diffuseAtlas: Texture | null = null;
	private static normalAtlas: Texture | null = null;

	public static readonly tileSize = 25;
	public static readonly atlasSize = 16;
	public static readonly atlasTileSize = 1 / this.atlasSize;

	static getDiffuse(): Texture | null {
		return TextureAtlasFactory.diffuseAtlas;
	}
	static setDiffuse(texture: Texture) {
		TextureAtlasFactory.diffuseAtlas = texture;
	}

	static getNormal(): Texture | null {
		return TextureAtlasFactory.normalAtlas;
	}
	static setNormal(texture: Texture) {
		TextureAtlasFactory.normalAtlas = texture;
	}
}
