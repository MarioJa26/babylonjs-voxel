import type { EngineContext, Texture2DArray } from "@babylonjs/lite";
import { createTexture2DArray, uploadImageToArrayLayer } from "@babylonjs/lite";

const DIFFUSE_URL = "/texture/diffuse_atlas.png";
const NORMAL_URL = "/texture/normal_atlas.png";

const TILE_SIZE = 25;
const ATLAS_SIZE = 16;

function mipLevelCount(w: number, h: number): number {
	return Math.floor(Math.log2(Math.max(w, h))) + 1;
}

async function loadImageBitmap(url: string): Promise<ImageBitmap> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
	const blob = await resp.blob();
	return createImageBitmap(blob);
}

function extractTile(
	src: Uint8ClampedArray,
	srcW: number,
	tx: number,
	ty: number,
): Uint8ClampedArray {
	const tile = TILE_SIZE;
	const out = new Uint8ClampedArray(tile * tile * 4);
	for (let y = 0; y < tile; y++) {
		const si = ((ty * tile + y) * srcW + tx * tile) * 4;
		const di = y * tile * 4;
		for (let x = 0; x < tile; x++) {
			out[di + x * 4] = src[si + x * 4];
			out[di + x * 4 + 1] = src[si + x * 4 + 1];
			out[di + x * 4 + 2] = src[si + x * 4 + 2];
			out[di + x * 4 + 3] = src[si + x * 4 + 3];
		}
	}
	return out;
}

function flipY(data: Uint8ClampedArray, w: number, h: number): void {
	const row = w * 4;
	const half = h >> 1;
	for (let y = 0; y < half; y++) {
		const a = y * row;
		const b = (h - 1 - y) * row;
		for (let x = 0; x < row; x++) {
			const t = data[a + x];
			data[a + x] = data[b + x];
			data[b + x] = t;
		}
	}
}

/**
 * Second pass: fill fully-transparent pixels (alpha === 0) with green.
 * These pixels are discarded by the shader anyway, so green prevents
 * black pixels from bleeding into lower mip levels during averaging.
 */
function fillTransparentPixels(data: Uint8ClampedArray): void {
	const n = data.length;
	for (let i = 0; i < n; i += 4) {
		if (data[i + 3] === 0) {
			data[i] = 72;
			data[i + 1] = 99;
			data[i + 2] = 41;
		}
	}
}

/**
 * Downsample one mip level using the article's recommended approach:
 *   - RGB: premultiplied-alpha averaging Σ(RGB·α) / Σ(α)
 *     — transparent pixels contribute zero colour, preventing black bleed.
 *   - Alpha: lerp average towards max α in the 2×2 block (coeff 0.75)
 *     — preserves overall shape instead of letting α drop below the discard
 *       threshold (Method 2 from the article).
 *
 * For fully-opaque tiles this is equivalent to a simple box filter.
 *
 * After averaging, a second pass (fillTransparentPixels) replaces any
 * zero-alpha pixels with green, preventing dark fringing.
 */
function downsampleMip(
	src: Uint8ClampedArray,
	w: number,
	h: number,
): { data: Uint8ClampedArray; w: number; h: number } {
	const nw = Math.max(1, w >> 1);
	const nh = Math.max(1, h >> 1);
	const dst = new Uint8ClampedArray(nw * nh * 4);

	for (let y = 0; y < nh; y++) {
		for (let x = 0; x < nw; x++) {
			let sumR = 0,
				sumG = 0,
				sumB = 0,
				sumA = 0;
			let maxA = 0,
				n = 0;

			for (let dy = 0; dy < 2; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					const sx = x * 2 + dx;
					const sy = y * 2 + dy;
					if (sx >= w || sy >= h) continue;

					const si = (sy * w + sx) * 4;
					const a = src[si + 3];
					sumR += src[si] * a;
					sumG += src[si + 1] * a;
					sumB += src[si + 2] * a;
					sumA += a;
					if (a > maxA) maxA = a;
					n++;
				}
			}

			const di = (y * nw + x) * 4;
			const inv = sumA > 0 ? 1 / sumA : 0;
			if (sumA > 0) {
				dst[di] = (sumR * inv + 0.5) | 0;
				dst[di + 1] = (sumG * inv + 0.5) | 0;
				dst[di + 2] = (sumB * inv + 0.5) | 0;
			} else {
				dst[di] = 72;
				dst[di + 1] = 99;
				dst[di + 2] = 41;
			}

			const avgA = sumA / n;
			dst[di + 3] = (avgA + (maxA - avgA) * 0.75 + 0.5) | 0;
		}
	}

	fillTransparentPixels(dst);

	return { data: dst, w: nw, h: nh };
}

/**
 * Load the diffuse atlas with a CPU-generated mip chain that avoids the
 * two classic alpha-tested texture problems:
 *   1. Black fringe from transparent pixels bleeding into mip colours
 *      → fixed by alpha-weighted (premultiplied) RGB averaging
 *   2. Shape shrinking / disappearing at distance
 *      → fixed by lerping α towards the max in each 2×2 block
 *
 * Each mip level is uploaded directly via `writeTexture`, bypassing the
 * canvas context entirely so that the premultiplied-alpha shenanigans of
 * 2D canvases never touch the pixel data.
 */
async function loadDiffuseTilesIntoArray(
	engine: EngineContext,
	url: string,
): Promise<Texture2DArray> {
	const bitmap = await loadImageBitmap(url);

	const tmpCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const tmpCtx = tmpCanvas.getContext("2d")!;
	tmpCtx.drawImage(bitmap, 0, 0);
	const srcData = tmpCtx.getImageData(0, 0, bitmap.width, bitmap.height).data;

	const texArray = createTexture2DArray(
		engine,
		TILE_SIZE,
		TILE_SIZE,
		ATLAS_SIZE * ATLAS_SIZE,
		{ mipMaps: true, magFilter: "nearest", minFilter: "nearest" },
	);

	const device = (engine as any)._device as GPUDevice;
	const gpuTex = texArray.texture;
	const mipCount = mipLevelCount(TILE_SIZE, TILE_SIZE);

	for (let id = 0; id < ATLAS_SIZE * ATLAS_SIZE; id++) {
		const tx = id % ATLAS_SIZE;
		const ty = (id / ATLAS_SIZE) | 0;

		let mipPixels = extractTile(srcData, bitmap.width, tx, ty);

		fillTransparentPixels(mipPixels);

		flipY(mipPixels, TILE_SIZE, TILE_SIZE);
		let mw = TILE_SIZE,
			mh = TILE_SIZE;

		for (let mip = 0; mip < mipCount; mip++) {
			device.queue.writeTexture(
				{ texture: gpuTex, mipLevel: mip, origin: [0, 0, id] },
				mipPixels,
				{ bytesPerRow: mw * 4, rowsPerImage: mh },
				[mw, mh, 1],
			);

			if (mip + 1 < mipCount) {
				const down = downsampleMip(mipPixels, mw, mh);
				mipPixels = down.data;
				mw = down.w;
				mh = down.h;
			}
		}
	}

	return texArray;
}

/**
 * Load the normal atlas via the standard lite helper (GPU auto-generates
 * mipmaps) — normal maps don't have transparency, so no special care needed.
 */
async function loadNormalTilesIntoArray(
	engine: EngineContext,
	url: string,
): Promise<Texture2DArray> {
	const bitmap = await loadImageBitmap(url);

	const texArray = createTexture2DArray(
		engine,
		TILE_SIZE,
		TILE_SIZE,
		ATLAS_SIZE * ATLAS_SIZE,
		{ mipMaps: true, magFilter: "nearest", minFilter: "nearest" },
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
		loadDiffuseTilesIntoArray(engine, DIFFUSE_URL),
		loadNormalTilesIntoArray(engine, NORMAL_URL),
	]);

	return { diffuse, normal, transparent: diffuse };
}
