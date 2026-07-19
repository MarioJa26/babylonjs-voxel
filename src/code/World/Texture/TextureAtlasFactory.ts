import type { Texture2D } from "@babylonjs/lite";

export type TileUV = {
	u: number;
	v: number;
	tileSize: number;
};

let diffuseAtlasLite: Texture2D | null = null;
let normalAtlasLite: Texture2D | null = null;

export const tileSize = 25;
export const atlasSize = 16;
export const atlasTileSize = 1 / atlasSize;

export function getDiffuse(): Texture2D | null {
	return diffuseAtlasLite;
}
export function setDiffuse(texture: Texture2D) {
	diffuseAtlasLite = texture;
}

export function getNormal(): Texture2D | null {
	return normalAtlasLite;
}
export function setNormal(texture: Texture2D) {
	normalAtlasLite = texture;
}

export function getDiffuseTexture2D(): Texture2D | null {
	return diffuseAtlasLite;
}
export function setDiffuseTexture2D(texture: Texture2D) {
	diffuseAtlasLite = texture;
}
