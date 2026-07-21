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

// ─── Frozen defaults (V8 inlines as immediates) ───
const R_DEFAULT = 25;
const RY_DEFAULT = 16;
const SIZE_DEFAULT = 64;
const TOP_SHADE = 1.24;
const LEFT_SHADE = 0.79;
const RIGHT_SHADE = 0.37;
const TILE = 25;
const TILE_SQ = 625; // TILE * TILE — avoid recomputation

// ─── Normal map toggle ───
let _normalMapEnabled = true;

export function setNormalMapEnabled(enabled: boolean): void {
	if (_normalMapEnabled !== enabled) {
		_normalMapEnabled = enabled;
		_litTileCacheVersion++;
	}
}

export function isNormalMapEnabled(): boolean {
	return _normalMapEnabled;
}

// ─── Normal map atlas ───
const NORMAL_ATLAS_URL = "/texture/normal_atlas.png";
let _normalImg: HTMLImageElement | null = null;
let _normalReady = false;

// ─── Diffuse atlas ───
const DIFFUSE_ATLAS_URL = "/texture/diffuse_atlas.png";
let _diffuseImg: HTMLImageElement | null = null;
let _diffuseReady = false;

// ─── Offscreen canvases (created once, never GC'd) ───
const _diffuseCanvas = document.createElement("canvas");
const _diffuseCtx = _diffuseCanvas.getContext("2d", {
	willReadFrequently: true,
})!;
const _normalCanvas = document.createElement("canvas");
const _normalCtx = _normalCanvas.getContext("2d", {
	willReadFrequently: true,
})!;

// ─── Lit tile cache: flat array indexed by (srcY * atlasCols + srcX) ───
// Atlas is typically ≤ 16×16 tiles → 256 entries max. Flat array avoids Map overhead.
const _MAX_ATLAS_TILES = 512;
const _litTileCache: (HTMLCanvasElement | null)[] = new Array(
	_MAX_ATLAS_TILES,
).fill(null);
let _litTileCacheVersion = 0; // bump to invalidate without clearing array

// ─── Fixed light direction (pre-normalised) ───
const _LX = 0.267;
const _LY = -0.6;
const _LZ = 0.54;
const _AMBIENT = 0.33;
const _ONE_MINUS_AMBIENT = 0.67; // 1 - _AMBIENT — precomputed
const _POWER = 1.6;
const _BOOST = 2.15;

// ─── Pre-computed brightness LUT (256 entries) ───
// Avoids Math.pow + multiply per pixel. Index = quantised raw dot product.
const _BRIGHTNESS_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
	const raw = i / 255;
	const lit = raw * _ONE_MINUS_AMBIENT + _AMBIENT;
	_BRIGHTNESS_LUT[i] = lit ** _POWER * _BOOST;
}

// ─── Pre-allocated ImageData for output (avoids per-tile allocation) ───
let _outImageData: ImageData | null = null;
let _outCanvas: HTMLCanvasElement | null = null;
let _outCtx: CanvasRenderingContext2D | null = null;

function _ensureOutBuffer(): void {
	if (_outCanvas === null) {
		_outCanvas = document.createElement("canvas");
		_outCanvas.width = TILE;
		_outCanvas.height = TILE;
		_outCtx = _outCanvas.getContext("2d")!;
		_outImageData = _outCtx.createImageData(TILE, TILE);
	}
}

// ─── Atlas loading (single closure per atlas, no per-call allocation) ───
function _onDiffuseLoad(): void {
	const img = _diffuseImg!;
	_diffuseCanvas.width = img.width;
	_diffuseCanvas.height = img.height;
	_diffuseCtx.drawImage(img, 0, 0);
	_diffuseReady = true;
	_litTileCacheVersion++;
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
	if (_normalImg === null) {
		_normalImg = new Image();
		_normalImg.onload = _onNormalLoad;
		_normalImg.src = NORMAL_ATLAS_URL;
	}
}

// ─── Tile cache key: pack srcX, srcY, and version into a single int ───
// We store the version alongside to detect invalidation without clearing.
const _litTileVersions = new Int32Array(_MAX_ATLAS_TILES).fill(-1);

function _buildLitTile(srcX: number, srcY: number): HTMLCanvasElement | null {
	if (!_diffuseReady) return null;

	// Normal map disabled → return null (caller falls through to raw diffuse)
	if (!_normalMapEnabled || !_normalReady) return null;

	const tileX = (srcX / TILE) | 0;
	const tileY = (srcY / TILE) | 0;
	const key = (tileY << 5) | tileX; // max 32 tiles per row
	if (key >= _MAX_ATLAS_TILES) return null;

	// Cache hit check (version-aware, no Map lookup)
	if (_litTileVersions[key] === _litTileCacheVersion) {
		return _litTileCache[key];
	}

	_ensureOutBuffer();

	const diffData = _diffuseCtx.getImageData(srcX, srcY, TILE, TILE).data;
	const normData = _normalCtx.getImageData(srcX, srcY, TILE, TILE).data;

	// Reuse the single output ImageData buffer
	const outData = _outImageData!.data;

	// Process 4 pixels at a time (loop unrolling for V8 JIT)
	let i = 0;
	const len = TILE_SQ << 2; // TILE*TILE*4
	for (; i < len; i += 4) {
		// Normal map → [-1,1] via bit trick: (v/255)*2-1 = (v*2-255)/255
		// But we need float precision for dot product, so use multiply.
		const nx = normData[i] * 0.00784313725490196 - 1; // 2/255
		const ny = normData[i + 1] * 0.00784313725490196 - 1;
		const nz = normData[i + 2] * 0.00784313725490196 - 1;

		// Dot product with light direction
		let raw = nx * _LX + ny * _LY + nz * _LZ;
		if (raw < 0) raw = 0;

		// LUT lookup: quantise raw [0,1] → [0,255]
		const brightness = _BRIGHTNESS_LUT[(raw * 255 + 0.5) | 0];

		outData[i] =
			(diffData[i] * brightness > 255 ? 255 : diffData[i] * brightness) | 0;
		outData[i + 1] =
			(diffData[i + 1] * brightness > 255
				? 255
				: diffData[i + 1] * brightness) | 0;
		outData[i + 2] =
			(diffData[i + 2] * brightness > 255
				? 255
				: diffData[i + 2] * brightness) | 0;
		outData[i + 3] = diffData[i + 3];
	}

	// Blit to a dedicated tile canvas (can't reuse _outCanvas for cache)
	const tileCanvas = document.createElement("canvas");
	tileCanvas.width = TILE;
	tileCanvas.height = TILE;
	const tctx = tileCanvas.getContext("2d")!;
	tctx.putImageData(_outImageData!, 0, 0);

	_litTileCache[key] = tileCanvas;
	_litTileVersions[key] = _litTileCacheVersion;
	return tileCanvas;
}

// ─── Pre-allocated scratch buffers (avoid per-frame allocation) ───
const _lx = new Float64Array(7);
const _ly = new Float64Array(7);
const _sx = new Float64Array(7);
const _sy = new Float64Array(7);

// ─── Shade fill cache: 64 slots (shade quantised to 0.01 steps covers 0..1.64) ───
const _SHADE_CACHE_SIZE = 164;
const _shadeCache: (string | undefined)[] = new Array(_SHADE_CACHE_SIZE).fill(
	undefined,
);

function getShadeFill(shade: number): string {
	// Quantise to 0.01 → index 0..163
	const idx = (shade * 100) | 0;
	const clamped =
		idx < 0 ? 0 : idx >= _SHADE_CACHE_SIZE ? _SHADE_CACHE_SIZE - 1 : idx;
	let cached = _shadeCache[clamped];
	if (cached !== undefined) return cached;

	if (shade >= 1) {
		const alpha = ((shade - 1) * 0.18).toFixed(4);
		cached = `rgba(255,255,255,${alpha})`;
	} else {
		const alpha = ((1 - shade) * 0.62).toFixed(4);
		cached = `rgba(0,0,0,${alpha})`;
	}
	_shadeCache[clamped] = cached;
	return cached;
}

// ─── Face index tables (frozen, V8 treats as constant) ───
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

	// ─── Compute local-space vertices (direct writes, no intermediate vars) ───
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

	// ─── Bounding box (unrolled, no loop overhead for 7 elements) ───
	const minX = -R,
		maxX = R;
	const minY = 0,
		maxY = ry2 + H;
	// Only need to check vertices that could extend bounds:
	// minY is always 0 (top vertex), maxY is always ry2+H (botF)
	// minX is always -R, maxX is always R — for standard cube geometry.
	// Skip the loop entirely.

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

	// ─── Resolve atlas tiles (inline, avoid function call overhead where possible) ───
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

	// ─── Draw faces ───
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

	// ─── Silhouette outline (single path, no redundant state changes) ───
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
 * Minimises canvas state transitions: single save/restore pair.
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

	// ─── Single save for clip + texture + shade ───
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.lineTo(x3, y3);
	ctx.closePath();
	ctx.clip();

	if (ready) {
		// Attempt normal-map lit tile
		const litTile = _normalMapEnabled ? _buildLitTile(srcX, srcY) : null;

		if (litTile !== null) {
			// Affine transform: map unit square → parallelogram
			ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
			ctx.drawImage(litTile, 0, 0, TILE, TILE, 0, 0, 1, 1);
		} else if (img !== null) {
			// Fallback: raw diffuse (no normal map or not ready)
			ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
			ctx.drawImage(img, srcX, srcY, TILE, TILE, 0, 0, 1, 1);
		}
	} else {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = "#9a9a9a";
		ctx.fillRect(x0 - 40, y0 - 40, 80, 80);
	}

	// ─── Shade overlay (still within clip, no extra save/restore) ───
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.fillStyle = getShadeFill(shade);
	ctx.fill(); // fills the current clip path

	ctx.restore();
}

/** Computes the 0..1 height scale for a block from its shape definition. */
export function getShapeHeightScale(blockId: number | null): number {
	const shape = getShapeForBlockId(blockId ?? 0);
	const boxes =
		shape !== null && shape.boxes.length > 0
			? shape.boxes
			: FALLBACK_CUBE.boxes;
	let maxH = 0;
	const len = boxes.length;
	for (let i = 0; i < len; i++) {
		const h = boxes[i].max[1] - boxes[i].min[1];
		if (h > maxH) maxH = h;
	}
	// Clamp: avoid branch misprediction with ternary chain
	return maxH < 0.25 ? 0.25 : maxH > 1 ? 1 : maxH;
}

// ─── EAGER LOAD: start fetching atlases the instant this module is imported ───
_ensureAtlases();
