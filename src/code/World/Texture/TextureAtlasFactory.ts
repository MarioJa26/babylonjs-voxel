import type { Texture } from "@babylonjs/core";

export type TileUV = {
	u: number;
	v: number;
	tileSize: number;
};

let diffuseAtlas: Texture | null = null;
let normalAtlas: Texture | null = null;

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
