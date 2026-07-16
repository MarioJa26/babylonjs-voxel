import type { Texture } from "@babylonjs/core";
import type { Texture2D } from "@babylonjs/lite";

export type TileUV = {
	u: number;
	v: number;
	tileSize: number;
};

let diffuseAtlas: Texture | null = null;
let normalAtlas: Texture | null = null;
let diffuseAtlasLite: Texture2D | null = null;

export const tileSize = 25;
export const atlasSize = 16;
export const atlasTileSize = 1 / atlasSize;

export function getDiffuse(): Texture | null {
	return diffuseAtlas;
}
export function setDiffuse(texture: Texture) {
	diffuseAtlas = texture;
}

export function getNormal(): Texture | null {
	return normalAtlas;
}
export function setNormal(texture: Texture) {
	normalAtlas = texture;
}

export function getDiffuseTexture2D(): Texture2D | null {
	return diffuseAtlasLite;
}
export function setDiffuseTexture2D(texture: Texture2D) {
	diffuseAtlasLite = texture;
}
