import type { EngineContext, Texture2D } from "@babylonjs/lite";
import { createTexture2DFromPixels, loadTexture2D } from "@babylonjs/lite";

const DIFFUSE_URL = "/texture/diffuse_atlas.png";
const NORMAL_URL = "/texture/normal_atlas.png";

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`Failed to load ${url}`));
		img.src = url;
	});
}

function readPixels(img: HTMLImageElement): Uint8Array {
	const c = new OffscreenCanvas(img.width, img.height);
	const ctx = c.getContext("2d")!;
	ctx.drawImage(img, 0, 0);
	return new Uint8Array(
		ctx.getImageData(0, 0, img.width, img.height).data.buffer,
	);
}

export async function packAtlas(
	engine: EngineContext,
): Promise<{ opaque: Texture2D; transparent: Texture2D }> {
	const [diffuseImg, normalImg] = await Promise.all([
		loadImage(DIFFUSE_URL),
		loadImage(NORMAL_URL),
	]);

	if (
		diffuseImg.width !== normalImg.width ||
		diffuseImg.height !== normalImg.height
	) {
		throw new Error(
			`Atlas dimensions mismatch: diffuse ${diffuseImg.width}x${diffuseImg.height} vs normal ${normalImg.width}x${normalImg.height}`,
		);
	}

	const w = diffuseImg.width;
	const h = diffuseImg.height;
	const diffuse = readPixels(diffuseImg);
	const normal = readPixels(normalImg);

	const rowBytes = w * 4;
	const packed = new Uint8Array(w * h * 4);

	for (let y = 0; y < h; y++) {
		const srcRow = y;
		const dstRow = h - 1 - y;
		const srcOff = srcRow * rowBytes;
		const dstOff = dstRow * rowBytes;
		for (let x = 0; x < w; x++) {
			const sp = srcOff + x * 4;
			const dp = dstOff + x * 4;
			packed[dp] = diffuse[sp];
			packed[dp + 1] = diffuse[sp + 1];
			packed[dp + 2] = diffuse[sp + 2];
			packed[dp + 3] = normal[sp];
		}
	}

	const opaque = createTexture2DFromPixels(engine, packed, w, h, {
		magFilter: "nearest",
		minFilter: "nearest",
	});

	const transparent = await loadTexture2D(engine, DIFFUSE_URL, {
		mipMaps: false,
		magFilter: "nearest",
		minFilter: "nearest",
	});

	return { opaque, transparent };
}
