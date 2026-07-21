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

// ─── Frozen defaults: V8 can inline these as constants ───
const R_DEFAULT = 25;
const RY_DEFAULT = 16;
const SIZE_DEFAULT = 64;
const TOP_SHADE = 1.24;
const LEFT_SHADE = 0.79;
const RIGHT_SHADE = 0.37;
const TILE = 25;

// ─── Pre-allocated scratch buffers (module-level, zero GC in hot path) ───
// 7 vertices × 2 coords = 14 floats for local space
const _lx = new Float64Array(7);
const _ly = new Float64Array(7);
// Transformed screen coords
const _sx = new Float64Array(7);
const _sy = new Float64Array(7);

// Pre-computed shade overlay strings (avoid template literal allocation per frame)
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

// ─── Face index tables (avoid per-call array allocation) ───
// topFace: [0,1,3,2] → indices into vertex array
// leftFace: [2,3,6,4]
// rightFace: [3,1,5,6]
const TOP_FACE = [0, 1, 3, 2] as const;
const LEFT_FACE = [2, 3, 6, 4] as const;
const RIGHT_FACE = [3, 1, 5, 6] as const;

// Vertex indices: 0=top, 1=topR, 2=topL, 3=topB, 4=botL, 5=botR, 6=botF

/**
 * Draws a Minecraft-style isometric cube icon. Zero-allocation hot path.
 */
export function drawCubeIcon(
	ctx: CanvasRenderingContext2D,
	blockId: number | null,
	atlasImage: HTMLImageElement | null,
	atlasReady: boolean,
	heightScale: number,
	options?: CubeIconOptions,
): void {
	// Inline defaults — avoid object spread allocation
	const R = options?.radius ?? R_DEFAULT;
	const ry = options?.ry ?? RY_DEFAULT;
	const size = options?.size ?? SIZE_DEFAULT;
	const topShade = options?.topShade ?? TOP_SHADE;
	const leftShade = options?.leftShade ?? LEFT_SHADE;
	const rightShade = options?.rightShade ?? RIGHT_SHADE;

	const H = 30.0 * heightScale;
	const ry2 = ry + ry; // 2*ry, avoid multiply

	// ─── Compute local-space vertices into pre-allocated buffers ───
	// 0: top (0,0)
	_lx[0] = 0;
	_ly[0] = 0;
	// 1: topR (R, ry)
	_lx[1] = R;
	_ly[1] = ry;
	// 2: topL (-R, ry)
	_lx[2] = -R;
	_ly[2] = ry;
	// 3: topB (0, 2*ry)
	_lx[3] = 0;
	_ly[3] = ry2;
	// 4: botL (-R, ry+H)
	_lx[4] = -R;
	_ly[4] = ry + H;
	// 5: botR (R, ry+H)
	_lx[5] = R;
	_ly[5] = ry + H;
	// 6: botF (0, 2*ry+H)
	_lx[6] = 0;
	_ly[6] = ry2 + H;

	// ─── Compute bounding box without spread (avoid temp array + iterator) ───
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

	// Centering offset
	const offX = ((size - (maxX - minX)) * 0.5 - minX) | 0;
	const offY = ((size - (maxY - minY)) * 0.5 - minY) | 0;

	// ─── Transform to screen space ───
	for (let i = 0; i < 7; i++) {
		_sx[i] = _lx[i] + offX;
		_sy[i] = _ly[i] + offY;
	}

	// ─── Reset canvas state once ───
	ctx.imageSmoothingEnabled = false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, size, size);

	// ─── Resolve atlas tiles (branchless fallback chain) ───
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

	// ─── Draw faces (top → left → right, painter's order) ───
	_drawFace(ctx, TOP_FACE, atlasImage, atlasReady, topTX, topTY, topShade);
	_drawFace(ctx, LEFT_FACE, atlasImage, atlasReady, leftTX, leftTY, leftShade);
	_drawFace(
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
 * Draws one parallelogram face. Uses pre-allocated screen coords.
 * Minimal save/restore — only one pair for clip+transform, one for shade.
 */
function _drawFace(
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

	// ─── Clip + texture (single save/restore) ───
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.lineTo(x3, y3);
	ctx.closePath();
	ctx.clip();

	if (ready && img) {
		// Affine transform: unit square → parallelogram
		// U axis: i0→i1, V axis: i0→i3
		ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
		ctx.drawImage(img, srcX, srcY, TILE, TILE, 0, 0, 1, 1);
	} else {
		// Fallback: flat grey (single fillRect in identity space)
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = "#9a9a9a";
		ctx.fillRect(x0 - 40, y0 - 40, 80, 80);
	}
	ctx.restore();

	// ─── Shade overlay (identity transform, cached fill string) ───
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
	// Clamp without Math.max/min (avoids function call overhead in V8)
	return maxH < 0.25 ? 0.25 : maxH > 1 ? 1 : maxH;
}
