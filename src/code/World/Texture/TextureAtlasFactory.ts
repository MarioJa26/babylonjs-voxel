import { type Scene, Texture } from "@babylonjs/core";
import { GLOBAL_VALUES } from "../GlobalValues";
import { MaterialFactory } from "../Texture/MaterialFactory";

export type TileUV = {
	u: number;
	v: number;
	tileSize: number;
};

export class TextureAtlasFactory {
	private static diffuseAtlas: Texture | null = null;
	private static normalAtlas: Texture | null = null;
	private static uvMap: Record<string, TileUV> = {};

	public static readonly tileSize = 25;
	public static readonly atlasSize = 16;
	public static readonly atlasTileSize = 1 / this.atlasSize;

	/**
	 * Build both diffuse and normal atlases
	 */
	static async buildAtlas(
		scene: Scene,
		images: { name: string; path: string }[],
		tileSize = TextureAtlasFactory.tileSize,
		atlasSize = TextureAtlasFactory.atlasSize,
	) {
		const totalSize = tileSize * atlasSize;

		// --- Create canvases for diffuse and normal maps ---
		const diffuseCanvas = document.createElement("canvas");
		const normalCanvas = document.createElement("canvas");
		diffuseCanvas.width = normalCanvas.width = totalSize;
		diffuseCanvas.height = normalCanvas.height = totalSize;

		if (!diffuseCanvas || !normalCanvas) return;

		const diffuseCtx = diffuseCanvas.getContext("2d")!;
		const normalCtx = normalCanvas.getContext("2d")!;

		// --- Load all diffuse + normal images ---
		const loadedImages = await Promise.all(
			images.map(async (img) => {
				const diffuseSrc = MaterialFactory.getTexturePathFromFolder(img.path)!;
				const normalSrc = MaterialFactory.getTexturePathFromFolder(
					img.path,
					"nor",
				)!;

				const [diffuseImg, normalImg] = await Promise.all([
					TextureAtlasFactory.loadImage(diffuseSrc),
					TextureAtlasFactory.loadImageSafe(normalSrc),
				]);

				return { name: img.name, diffuseImg, normalImg };
			}),
		);

		loadedImages.forEach((entry, i) => {
			const col = i % atlasSize;
			const row = Math.floor(i / atlasSize);
			const x = col * tileSize;
			const y = row * tileSize;

			diffuseCtx.drawImage(entry.diffuseImg, x, y, tileSize, tileSize);
			if (entry.normalImg) {
				normalCtx.drawImage(entry.normalImg, x, y, tileSize, tileSize);
			}

			const u = col / atlasSize;
			const v = row / atlasSize;
			TextureAtlasFactory.uvMap[entry.name] = { u, v, tileSize: 1 / atlasSize };
		});

		// --- Create Babylon textures ---
		const diffuseTex = new Texture(
			diffuseCanvas.toDataURL("image/png"),
			scene,
			false, // noMipmap -> false to enable mipmaps
			true, // invertY
			Texture.NEAREST_SAMPLINGMODE, // mag: NEAREST, min: LINEAR, mip: LINEAR
		);
		diffuseTex.wrapU = Texture.CLAMP_ADDRESSMODE;
		diffuseTex.wrapV = Texture.CLAMP_ADDRESSMODE;

		const normalTex = new Texture(
			normalCanvas.toDataURL("image/png"),
			scene,
			false, // noMipmap -> false to enable mipmaps
			true, // invertY
			Texture.NEAREST_SAMPLINGMODE, // mag: NEAREST, min: LINEAR, mip: LINEAR
		);
		normalTex.wrapU = Texture.CLAMP_ADDRESSMODE;
		normalTex.wrapV = Texture.CLAMP_ADDRESSMODE;

		// --- Cache ---
		TextureAtlasFactory.diffuseAtlas = diffuseTex;
		TextureAtlasFactory.normalAtlas = normalTex;

		// --- Save atlas to file if requested ---
		if (GLOBAL_VALUES.CREATE_ATLAS) {
			TextureAtlasFactory.saveCanvasAsImage(diffuseCanvas, "diffuse_atlas.png");
			TextureAtlasFactory.saveCanvasAsImage(normalCanvas, "normal_atlas.png");
		}

		return {
			diffuse: TextureAtlasFactory.diffuseAtlas,
			normal: TextureAtlasFactory.normalAtlas,
			uvMap: TextureAtlasFactory.uvMap,
		};
	}

	/**
	 * Triggers a browser download for a canvas content.
	 */
	private static saveCanvasAsImage(
		canvas: HTMLCanvasElement,
		filename: string,
	) {
		const link = document.createElement("a");
		link.download = filename;
		link.href = canvas
			.toDataURL("image/png")
			.replace("image/png", "image/octet-stream");
		link.click();
	}
	private static async loadImageSafe(
		src: string,
	): Promise<HTMLImageElement | null> {
		try {
			return await TextureAtlasFactory.loadImage(src);
		} catch {
			console.warn("Missing normal map:", src);
			return null;
		}
	}

	/** Standard image loader */
	private static loadImage(src: string): Promise<HTMLImageElement> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = (e) => reject(e);
			img.src = src;
		});
	}

	static getUV(name: string): TileUV | undefined {
		return TextureAtlasFactory.uvMap[name];
	}

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
