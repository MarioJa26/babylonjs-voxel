import {
	FALLBACK_CUBE,
	getShapeForBlockId,
} from "@/code/World/Shape/BlockShapes";
import { getFaceAtlasTile } from "@/code/World/Texture/BlockTextures";
import { FaceName } from "@/code/World/Texture/FaceName";

export interface CubeIconOptions {
	radius?: number;
	ry?: number;
	heightRatio?: number;
	size?: number;
	topShade?: number;
	leftShade?: number;
	rightShade?: number;
}

// ─── Frozen defaults ───
const R_DEFAULT = 25;
const RY_DEFAULT = 16;
const SIZE_DEFAULT = 64;
const TOP_SHADE = 1.24;
const LEFT_SHADE = 0.79;
const RIGHT_SHADE = 0.37;
const TILE = 25;

// ─── Normal map atlas ───
const NORMAL_ATLAS_URL = "/texture/normal_atlas.png";
let _normalImg: HTMLImageElement | null = null;
let _normalReady = false;

// Diffuse atlas (same one Item.ts loads)
const DIFFUSE_ATLAS_URL = "/texture/diffuse_atlas.png";
let _diffuseImg: HTMLImageElement | null = null;
let _diffuseReady = false;

// Offscreen canvases for pixel reading
const _diffuseCanvas = document.createElement("canvas");
const _diffuseCtx = _diffuseCanvas.getContext("2d", {
	willReadFrequently: true,
});
const _normalCanvas = document.createElement("canvas");
const _normalCtx = _normalCanvas.getContext("2d", { willReadFrequently: true });

// Cache: lit tile canvas per (srcX, srcY) key
const _litTileCache = new Map<number, HTMLCanvasElement>();

// Fixed light direction (normalised): top-left-front
const _LX = 0.267;
const _LY = -0.6;
const _LZ = 0.54;
// Ambient floor: lowest brightness for a face turned fully away from light.
const _AMBIENT = 0.33;
// Power curve applied to the raw dot-product brightness. Values < 1 widen
// the contrast range so grooves read as much darker while flat surfaces
// stay near full brightness.
const _POWER = 1.6;
// Boost after the power curve so the overall image doesn't go too dark.
const _BOOST = 2.15;

function _loadAtlas(
	url: string,
	canvas: CanvasRenderingContext2D | null,
): HTMLImageElement {
	const img = new Image();
	img.onload = () => {
		if (canvas) {
			const cvs = canvas.canvas;
			cvs.width = img.width;
			cvs.height = img.height;
			canvas.drawImage(img, 0, 0);
		}
		if (url === DIFFUSE_ATLAS_URL) {
			_diffuseImg = img;
			_diffuseReady = true;
			_litTileCache.clear();
		} else {
			_normalImg = img;
			_normalReady = true;
			_litTileCache.clear();
		}
	};
	img.src = url;
	return img;
}

function _ensureAtlases(): void {
	if (!_diffuseImg) _loadAtlas(DIFFUSE_ATLAS_URL, _diffuseCtx);
	if (!_normalImg) _loadAtlas(NORMAL_ATLAS_URL, _normalCtx);
}

/**
 * Builds a lit tile canvas: draws the diffuse tile, reads normal map pixels,
 * computes per-pixel brightness, and multiplies into the diffuse RGB.
 * Result is cached by source position so each tile is processed at most once.
 */
function _buildLitTile(srcX: number, srcY: number): HTMLCanvasElement | null {
	if (!_diffuseReady || !_normalReady || !_diffuseCtx || !_normalCtx)
		return null;

	const key = srcY * 400 + srcX;
	const cached = _litTileCache.get(key);
	if (cached) return cached;

	// Read diffuse tile pixels
	const diffData = _diffuseCtx.getImageData(srcX, srcY, TILE, TILE).data;
	// Read normal tile pixels
	const normData = _normalCtx.getImageData(srcX, srcY, TILE, TILE).data;

	const out = document.createElement("canvas");
	out.width = TILE;
	out.height = TILE;
	const octx = out.getContext("2d")!;
	const outImg = octx.createImageData(TILE, TILE);
	const outData = outImg.data;

	for (let i = 0; i < diffData.length; i += 4) {
		// Normal map RGB → [-1,1] range
		const nx = (normData[i] / 255) * 2 - 1;
		const ny = (normData[i + 1] / 255) * 2 - 1;
		const nz = (normData[i + 2] / 255) * 2 - 1;

		// Raw dot product with light direction → 0..1
		const raw = Math.max(0, nx * _LX + ny * _LY + nz * _LZ);
		// Mix with ambient, apply power curve to widen contrast, boost to
		// compensate overall darkening.
		const lit = raw * (1 - _AMBIENT) + _AMBIENT;
		const brightness = lit ** _POWER * _BOOST;

		outData[i] = Math.min(255, (diffData[i] * brightness) | 0);
		outData[i + 1] = Math.min(255, (diffData[i + 1] * brightness) | 0);
		outData[i + 2] = Math.min(255, (diffData[i + 2] * brightness) | 0);
		outData[i + 3] = diffData[i + 3]; // preserve alpha
	}

	octx.putImageData(outImg, 0, 0);
	_litTileCache.set(key, out);
	return out;
}

// ─── Pre-allocated scratch buffers ───
const _lx = new Float64Array(7);
const _ly = new Float64Array(7);
const _sx = new Float64Array(7);
const _sy = new Float64Array(7);

const _shadeCache = new Map<number, string>();
function getShadeFill(shade: number): string {
	let cached = _shadeCache.get(shade);
	if (cached !== undefined) return cached;
	if (shade >= 1) {
		cached = `rgba(255,255,255,${((shade - 1) * 0.18).toFixed(4)})`;
	} else {
		cached = `rgba(0,0,0,${((1 - shade) * 0.62).toFixed(4)})`;
	}
	_shadeCache.set(shade, cached);
	return cached;
}

// ─── Face index tables ───
const TOP_FACE = [0, 1, 3, 2] as const;
const LEFT_FACE = [2, 3, 6, 4] as const;
const RIGHT_FACE = [3, 1, 5, 6] as const;
// Vertex indices: 0=top, 1=topR, 2=topL, 3=topB, 4=botL, 5=botR, 6=botF

/**
 * Draws a Minecraft-style isometric cube icon.
 */
export function drawCubeIcon(
	ctx: CanvasRenderingContext2D,
	blockId: number | null,
	atlasImage: HTMLImageElement | null,
	atlasReady: boolean,
	heightScale: number,
	options?: CubeIconOptions,
): void {
	const R = options?.radius ?? R_DEFAULT;
	const ry = options?.ry ?? RY_DEFAULT;
	const size = options?.size ?? SIZE_DEFAULT;
	const topShade = options?.topShade ?? TOP_SHADE;
	const leftShade = options?.leftShade ?? LEFT_SHADE;
	const rightShade = options?.rightShade ?? RIGHT_SHADE;

	_ensureAtlases();

	const H = 30.0 * heightScale;
	const ry2 = ry + ry;

	// ─── Compute local-space vertices ───
	_lx[0] = 0;
	_ly[0] = 0; // top
	_lx[1] = R;
	_ly[1] = ry; // topR
	_lx[2] = -R;
	_ly[2] = ry; // topL
	_lx[3] = 0;
	_ly[3] = ry2; // topB
	_lx[4] = -R;
	_ly[4] = ry + H; // botL
	_lx[5] = R;
	_ly[5] = ry + H; // botR
	_lx[6] = 0;
	_ly[6] = ry2 + H; // botF

	// ─── Bounding box ───
	let minX = _lx[0],
		maxX = _lx[0];
	let minY = _ly[0],
		maxY = _ly[0];
	for (let i = 1; i < 7; i++) {
		const x = _lx[i];
		const y = _ly[i];
		if (x < minX) minX = x;
		else if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		else if (y > maxY) maxY = y;
	}

	const offX = ((size - (maxX - minX)) * 0.5 - minX) | 0;
	const offY = ((size - (maxY - minY)) * 0.5 - minY) | 0;

	for (let i = 0; i < 7; i++) {
		_sx[i] = _lx[i] + offX;
		_sy[i] = _ly[i] + offY;
	}

	// ─── Reset canvas ───
	ctx.imageSmoothingEnabled = false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, size, size);

	// ─── Resolve atlas tiles ───
	const topTile = getFaceAtlasTile(blockId, FaceName.Top);
	const topTX = topTile ? topTile[0] * TILE : 0;
	const topTY = topTile ? topTile[1] * TILE : 0;

	const leftTile =
		getFaceAtlasTile(blockId, FaceName.West) ??
		getFaceAtlasTile(blockId, FaceName.Side);
	const leftTX = leftTile ? leftTile[0] * TILE : topTX;
	const leftTY = leftTile ? leftTile[1] * TILE : topTY;

	const rightTile =
		getFaceAtlasTile(blockId, FaceName.East) ??
		getFaceAtlasTile(blockId, FaceName.South) ??
		getFaceAtlasTile(blockId, FaceName.Side);
	const rightTX = rightTile ? rightTile[0] * TILE : topTX;
	const rightTY = rightTile ? rightTile[1] * TILE : topTY;

	// ─── Draw faces with normal-map lighting ───
	_drawLitFace(ctx, TOP_FACE, atlasImage, atlasReady, topTX, topTY, topShade);
	_drawLitFace(
		ctx,
		LEFT_FACE,
		atlasImage,
		atlasReady,
		leftTX,
		leftTY,
		leftShade,
	);
	_drawLitFace(
		ctx,
		RIGHT_FACE,
		atlasImage,
		atlasReady,
		rightTX,
		rightTY,
		rightShade,
	);

	// ─── Silhouette outline ───
	ctx.strokeStyle = "rgba(0,0,0,0.5)";
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(_sx[0], _sy[0]);
	ctx.lineTo(_sx[1], _sy[1]);
	ctx.lineTo(_sx[5], _sy[5]);
	ctx.lineTo(_sx[6], _sy[6]);
	ctx.lineTo(_sx[4], _sy[4]);
	ctx.lineTo(_sx[2], _sy[2]);
	ctx.closePath();
	ctx.stroke();
}

/**
 * Draws one parallelogram face. The diffuse tile is lit by the normal map
 * (per-pixel brightness), then drawn onto the face via affine transform.
 * A directional shade overlay is applied on top.
 */
function _drawLitFace(
	ctx: CanvasRenderingContext2D,
	faceIdx: readonly number[],
	img: HTMLImageElement | null,
	ready: boolean,
	srcX: number,
	srcY: number,
	shade: number,
): void {
	const i0 = faceIdx[0];
	const i1 = faceIdx[1];
	const i2 = faceIdx[2];
	const i3 = faceIdx[3];

	const x0 = _sx[i0],
		y0 = _sy[i0];
	const x1 = _sx[i1],
		y1 = _sy[i1];
	const x2 = _sx[i2],
		y2 = _sy[i2];
	const x3 = _sx[i3],
		y3 = _sy[i3];

	// ─── Clip + texture ───
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.lineTo(x3, y3);
	ctx.closePath();
	ctx.clip();

	if (ready) {
		// Try to build a lit tile from the normal map
		const litTile = _buildLitTile(srcX, srcY);
		if (litTile) {
			// Draw the lit tile canvas (already has per-pixel lighting baked in)
			ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
			ctx.drawImage(litTile, 0, 0, TILE, TILE, 0, 0, 1, 1);
		} else if (img) {
			// Normal map not ready yet — fall back to raw diffuse tile
			ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
			ctx.drawImage(img, srcX, srcY, TILE, TILE, 0, 0, 1, 1);
		}
	} else {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = "#9a9a9a";
		ctx.fillRect(x0 - 40, y0 - 40, 80, 80);
	}
	ctx.restore();

	// ─── Shade overlay ───
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.lineTo(x3, y3);
	ctx.closePath();
	ctx.fillStyle = getShadeFill(shade);
	ctx.fill();
	ctx.restore();
}

/** Computes the 0..1 height scale for a block from its shape definition. */
export function getShapeHeightScale(blockId: number | null): number {
	const shape = getShapeForBlockId(blockId ?? 0);
	const boxes =
		shape && shape.boxes.length > 0 ? shape.boxes : FALLBACK_CUBE.boxes;
	let maxH = 0;
	const len = boxes.length;
	for (let i = 0; i < len; i++) {
		const b = boxes[i];
		const h = b.max[1] - b.min[1];
		if (h > maxH) maxH = h;
	}
	return maxH < 0.25 ? 0.25 : maxH > 1 ? 1 : maxH;
}
