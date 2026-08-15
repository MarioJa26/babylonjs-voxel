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
const TILE_SQ = TILE * TILE;
const TILE_BYTES = TILE_SQ << 2;

// ─── Normal map toggle ───
let _normalMapEnabled = true;

export function setNormalMapEnabled(enabled: boolean): void {
	if (_normalMapEnabled === enabled) return;

	_normalMapEnabled = enabled;
	_litTileCacheVersion++;

	if (enabled) {
		_ensureAtlases();
	}
}

export function isNormalMapEnabled(): boolean {
	return _normalMapEnabled;
}

// ─── Atlas URLs ───
const NORMAL_ATLAS_URL = "/texture/normal_atlas.png";
const DIFFUSE_ATLAS_URL = "/texture/diffuse_atlas.png";

// ─── Atlas images ───
let _normalImg: HTMLImageElement | null = null;
let _normalReady = false;

let _diffuseImg: HTMLImageElement | null = null;
let _diffuseReady = false;

// ─── Offscreen atlas canvases ───
const _diffuseCanvas = document.createElement("canvas");
const _diffuseCtx = _diffuseCanvas.getContext("2d", {
	willReadFrequently: true,
	alpha: false,
})!;

const _normalCanvas = document.createElement("canvas");
const _normalCtx = _normalCanvas.getContext("2d", {
	willReadFrequently: true,
	alpha: false,
})!;

// ─── Lit tile cache ───
// Indexed as tileY * _atlasCols + tileX.
// Dimension-aware indexing avoids the old implicit "max 32 columns" assumption.
let _atlasCols = 0;
let _atlasRows = 0;
let _litTileCache: (HTMLCanvasElement | null)[] = [];
let _litTileVersions = new Int32Array(0);
let _litTileCacheVersion = 0;

function _resizeLitCacheFromDiffuseAtlas(): void {
	_atlasCols = (_diffuseCanvas.width / TILE) | 0;
	_atlasRows = (_diffuseCanvas.height / TILE) | 0;

	const count = _atlasCols * _atlasRows;
	_litTileCache = new Array(count).fill(null);
	_litTileVersions = new Int32Array(count);
	_litTileVersions.fill(-1);
	_litTileCacheVersion++;
}

// ─── Fixed light direction ───
const _LX = 0.267;
const _LY = -0.6;
const _LZ = 0.54;

const _AMBIENT = 0.33;
const _ONE_MINUS_AMBIENT = 1 - _AMBIENT;
const _POWER = 1.5;
const _BOOST = 2.0;

// ─── Brightness LUT ───
const _BRIGHTNESS_LUT = new Float32Array(256);

for (let i = 0; i < 256; i++) {
	const raw = i / 255;
	const lit = raw * _ONE_MINUS_AMBIENT + _AMBIENT;
	_BRIGHTNESS_LUT[i] = lit ** _POWER * _BOOST;
}

// ─── Reused output buffer for building lit tiles ───
let _outImageData: ImageData | null = null;
let _outCanvas: HTMLCanvasElement | null = null;
let _outCtx: CanvasRenderingContext2D | null = null;

function _ensureOutBuffer(): void {
	if (_outCanvas !== null) return;

	_outCanvas = document.createElement("canvas");
	_outCanvas.width = TILE;
	_outCanvas.height = TILE;
	_outCtx = _outCanvas.getContext("2d")!;
	_outImageData = _outCtx.createImageData(TILE, TILE);
}

// ─── Atlas loading ───
function _onDiffuseLoad(): void {
	const img = _diffuseImg!;
	_diffuseCanvas.width = img.width;
	_diffuseCanvas.height = img.height;
	_diffuseCtx.drawImage(img, 0, 0);

	_diffuseReady = true;
	_resizeLitCacheFromDiffuseAtlas();
}

function _onNormalLoad(): void {
	const img = _normalImg!;
	_normalCanvas.width = img.width;
	_normalCanvas.height = img.height;
	_normalCtx.drawImage(img, 0, 0);

	_normalReady = true;
	_litTileCacheVersion++;
}

function _ensureAtlases(): void {
	if (_diffuseImg === null) {
		_diffuseImg = new Image();
		_diffuseImg.onload = _onDiffuseLoad;
		_diffuseImg.src = DIFFUSE_ATLAS_URL;
	}

	if (_normalMapEnabled && _normalImg === null) {
		_normalImg = new Image();
		_normalImg.onload = _onNormalLoad;
		_normalImg.src = NORMAL_ATLAS_URL;
	}
}

function _getTileCacheKey(srcX: number, srcY: number): number {
	if (_atlasCols <= 0 || _atlasRows <= 0) return -1;

	const tileX = (srcX / TILE) | 0;
	const tileY = (srcY / TILE) | 0;

	if (
		tileX < 0 ||
		tileY < 0 ||
		tileX >= _atlasCols ||
		tileY >= _atlasRows ||
		srcX + TILE > _diffuseCanvas.width ||
		srcY + TILE > _diffuseCanvas.height ||
		srcX + TILE > _normalCanvas.width ||
		srcY + TILE > _normalCanvas.height
	) {
		return -1;
	}

	return tileY * _atlasCols + tileX;
}

function _mulClamp255(value: number, brightness: number): number {
	const out = value * brightness;
	return out >= 255 ? 255 : out | 0;
}

function _buildLitTile(srcX: number, srcY: number): HTMLCanvasElement | null {
	if (!_diffuseReady || !_normalReady || !_normalMapEnabled) return null;

	const key = _getTileCacheKey(srcX, srcY);
	if (key < 0) return null;

	if (_litTileVersions[key] === _litTileCacheVersion) {
		return _litTileCache[key];
	}

	_ensureOutBuffer();

	const diffData = _diffuseCtx.getImageData(srcX, srcY, TILE, TILE).data;
	const normData = _normalCtx.getImageData(srcX, srcY, TILE, TILE).data;
	const outData = _outImageData!.data;

	for (let i = 0; i < TILE_BYTES; i += 4) {
		const nx = normData[i] * 0.00784313725490196 - 1; // 2/255
		const ny = normData[i + 1] * 0.00784313725490196 - 1;
		const nz = normData[i + 2] * 0.00784313725490196 - 1;

		let raw = nx * _LX + ny * _LY + nz * _LZ;
		if (raw < 0) raw = 0;
		else if (raw > 1) raw = 1;

		const brightness = _BRIGHTNESS_LUT[(raw * 255 + 0.5) | 0];

		outData[i] = _mulClamp255(diffData[i], brightness);
		outData[i + 1] = _mulClamp255(diffData[i + 1], brightness);
		outData[i + 2] = _mulClamp255(diffData[i + 2], brightness);
		outData[i + 3] = diffData[i + 3];
	}

	const tileCanvas = document.createElement("canvas");
	tileCanvas.width = TILE;
	tileCanvas.height = TILE;

	const tileCtx = tileCanvas.getContext("2d")!;
	tileCtx.putImageData(_outImageData!, 0, 0);

	_litTileCache[key] = tileCanvas;
	_litTileVersions[key] = _litTileCacheVersion;

	return tileCanvas;
}

// ─── Reused scratch buffers ───
const _lx = new Float64Array(7);
const _ly = new Float64Array(7);
const _sx = new Float64Array(7);
const _sy = new Float64Array(7);

// ─── Shade fill cache ───
// 0.00..1.63 in 0.01 steps.
const _SHADE_CACHE_SIZE = 164;
const _shadeCache: (string | undefined)[] = new Array(_SHADE_CACHE_SIZE);

function getShadeFill(shade: number): string {
	let idx = (shade * 100) | 0;
	if (idx < 0) idx = 0;
	else if (idx >= _SHADE_CACHE_SIZE) idx = _SHADE_CACHE_SIZE - 1;

	let cached = _shadeCache[idx];
	if (cached !== undefined) return cached;

	// Important: compute from quantised shade, not the original shade.
	// This keeps cache entries stable for out-of-range values too.
	const qShade = idx * 0.01;

	cached =
		qShade >= 1
			? `rgba(255,255,255,${((qShade - 1) * 0.18).toFixed(4)})`
			: `rgba(0,0,0,${((1 - qShade) * 0.62).toFixed(4)})`;

	_shadeCache[idx] = cached;
	return cached;
}

// ─── Face index tables ───
const TOP_FACE = [0, 1, 3, 2] as const;
const LEFT_FACE = [2, 3, 6, 4] as const;
const RIGHT_FACE = [3, 1, 5, 6] as const;

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

	_lx[0] = 0;
	_ly[0] = 0;

	_lx[1] = R;
	_ly[1] = ry;

	_lx[2] = -R;
	_ly[2] = ry;

	_lx[3] = 0;
	_ly[3] = ry2;

	_lx[4] = -R;
	_ly[4] = ry + H;

	_lx[5] = R;
	_ly[5] = ry + H;

	_lx[6] = 0;
	_ly[6] = ry2 + H;

	const offX = ((size - (R + R)) * 0.5 + R) | 0;
	const offY = ((size - (ry2 + H)) * 0.5) | 0;

	for (let i = 0; i < 7; i++) {
		_sx[i] = _lx[i] + offX;
		_sy[i] = _ly[i] + offY;
	}

	ctx.imageSmoothingEnabled = false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, size, size);

	const topTile = getFaceAtlasTile(blockId, FaceName.Top);
	const topTX = topTile !== null ? topTile[0] * TILE : 0;
	const topTY = topTile !== null ? topTile[1] * TILE : 0;

	const leftTile =
		getFaceAtlasTile(blockId, FaceName.West) ??
		getFaceAtlasTile(blockId, FaceName.Side);

	const leftTX = leftTile !== null ? leftTile[0] * TILE : topTX;
	const leftTY = leftTile !== null ? leftTile[1] * TILE : topTY;

	const rightTile =
		getFaceAtlasTile(blockId, FaceName.East) ??
		getFaceAtlasTile(blockId, FaceName.South) ??
		getFaceAtlasTile(blockId, FaceName.Side);

	const rightTX = rightTile !== null ? rightTile[0] * TILE : topTX;
	const rightTY = rightTile !== null ? rightTile[1] * TILE : topTY;

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
 * Draws one parallelogram face with optional normal-map lighting.
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

	const x0 = _sx[i0];
	const y0 = _sy[i0];
	const x1 = _sx[i1];
	const y1 = _sy[i1];
	const x2 = _sx[i2];
	const y2 = _sy[i2];
	const x3 = _sx[i3];
	const y3 = _sy[i3];

	ctx.save();

	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.lineTo(x3, y3);
	ctx.closePath();
	ctx.clip();

	if (ready) {
		const litTile = _normalMapEnabled ? _buildLitTile(srcX, srcY) : null;

		if (litTile !== null) {
			ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
			ctx.drawImage(litTile, 0, 0, TILE, TILE, 0, 0, 1, 1);
		} else if (img !== null) {
			ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
			ctx.drawImage(img, srcX, srcY, TILE, TILE, 0, 0, 1, 1);
		}
	} else {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = "#9a9a9a";
		ctx.fillRect(x0 - 40, y0 - 40, 80, 80);
	}

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.fillStyle = getShadeFill(shade);
	ctx.fill();

	ctx.restore();
}

/**
 * Computes the 0..1 height scale for a block from its shape definition.
 */
export function getShapeHeightScale(blockId: number | null): number {
	const shape = getShapeForBlockId(blockId ?? 0);
	const boxes =
		shape !== null && shape.boxes.length > 0
			? shape.boxes
			: FALLBACK_CUBE.boxes;

	let maxH = 0;

	for (let i = 0, len = boxes.length; i < len; i++) {
		const box = boxes[i];
		const h = box.max[1] - box.min[1];
		if (h > maxH) maxH = h;
	}

	return maxH < 0.25 ? 0.25 : maxH > 1 ? 1 : maxH;
}

// ─── EAGER LOAD ───
_ensureAtlases();
