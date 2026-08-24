import {
	FACE_ALL,
	FACE_PX,
	FACE_PY,
	FACE_PZ,
	FALLBACK_CUBE,
	getShapeForBlockId,
	isCrossBlockId,
	isCrossDiagonalBlockId,
	type ShapeBox,
} from "@/code/World/Shape/BlockShapes";
import { getFaceAtlasTile } from "@/code/World/Texture/BlockTextures";
import { FaceName } from "@/code/World/Texture/FaceName";
import type { CubeIconOptions } from "./Types/InventoryTypes";

// ─── Frozen defaults ───
const R_DEFAULT = 25;
const RY_DEFAULT = 16;
const SIZE_DEFAULT = 64;
const TOP_SHADE = 1.24;
const LEFT_SHADE = 0.79;
const RIGHT_SHADE = 0.37;

// Vertical pixels per world unit. Box coordinates already encode partial
// heights (slab = 0.5), so the projection must stay at true scale.
const UNIT_HEIGHT = 30;

const TILE = 25;
const TILE_SQ = TILE * TILE;
const TILE_BYTES = TILE_SQ << 2;

// ─── Normal map toggle ───
let _normalMapEnabled = true;

export function setNormalMapEnabled(enabled: boolean): void {
	if (_normalMapEnabled === enabled) return;

	_normalMapEnabled = enabled;
	_litTileCacheVersion++;
	_shadedTileCache.clear();

	if (enabled) {
		_ensureAtlases();
	} else {
		// Normal maps no longer gate the ready promise.
		_notifyAtlasesReady();
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
// Diffuse must keep alpha: cutout textures (plants) become opaque black
// otherwise once baked into lit/shaded tiles.
const _diffuseCanvas = document.createElement("canvas");
const _diffuseCtx = _diffuseCanvas.getContext("2d", {
	willReadFrequently: true,
	alpha: true,
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
let _diffuseFailed = false;
let _normalFailed = false;

let _atlasesReadyResolve: (() => void) | null = null;

/**
 * Resolves once icon shading is fully available: the diffuse atlas canvas is
 * ready and the normal atlas is ready too (when normal maps are enabled), so
 * baked tiles include the normal-map lighting. Callers (Item) use this to
 * redraw icons that were rendered before the atlases finished loading and
 * therefore missed their lit-shading pass. Atlas load errors also resolve so
 * the redraw falls back to unlit shading instead of never firing.
 */
export const iconAtlasesReadyPromise: Promise<void> = new Promise<void>(
	(resolve) => {
		_atlasesReadyResolve = resolve;
	},
);

function _notifyAtlasesReady(): void {
	if (!_diffuseReady && !_diffuseFailed) return;
	if (_normalMapEnabled && !_normalReady && !_normalFailed) return;

	_atlasesReadyResolve?.();
	_atlasesReadyResolve = null;
}

function _onDiffuseLoad(): void {
	const img = _diffuseImg!;
	_diffuseCanvas.width = img.width;
	_diffuseCanvas.height = img.height;
	_diffuseCtx.drawImage(img, 0, 0);

	_diffuseReady = true;
	_shadedTileCache.clear();
	_resizeLitCacheFromDiffuseAtlas();
	_notifyAtlasesReady();
	_flushPendingIconRedraws();
}

function _onNormalLoad(): void {
	const img = _normalImg!;
	_normalCanvas.width = img.width;
	_normalCanvas.height = img.height;
	_normalCtx.drawImage(img, 0, 0);

	_normalReady = true;
	_shadedTileCache.clear();
	_litTileCacheVersion++;
	_notifyAtlasesReady();
	_flushPendingIconRedraws();
}

function _ensureAtlases(): void {
	if (_diffuseImg === null) {
		_diffuseImg = new Image();
		_diffuseImg.onload = _onDiffuseLoad;
		_diffuseImg.onerror = () => {
			_diffuseFailed = true;
			_notifyAtlasesReady();
		};
		_diffuseImg.src = DIFFUSE_ATLAS_URL;
	}

	if (_normalMapEnabled && _normalImg === null) {
		_normalImg = new Image();
		_normalImg.onload = _onNormalLoad;
		_normalImg.onerror = () => {
			_normalFailed = true;
			_notifyAtlasesReady();
			_flushPendingIconRedraws();
		};
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

// ─── Shaded tile cache ───
// Bakes the per-face shade into an isolated TILE-sized copy using
// source-atop compositing, so cutout alpha survives (filling the whole
// destination quad would tint transparent pixels and previously drawn
// geometry behind them).
const _shadedTileCache = new Map<number, HTMLCanvasElement>();

function _getShadedTile(
	srcX: number,
	srcY: number,
	shade: number,
): HTMLCanvasElement | null {
	if (!_diffuseReady) return null;

	const tileKey = _getTileCacheKey(srcX, srcY);
	if (tileKey < 0) return null;

	let bucket = (shade * 100) | 0;
	if (bucket < 0) bucket = 0;
	else if (bucket >= _SHADE_CACHE_SIZE) bucket = _SHADE_CACHE_SIZE - 1;

	const cacheKey = tileKey * _SHADE_CACHE_SIZE + bucket;
	const hit = _shadedTileCache.get(cacheKey);
	if (hit !== undefined) return hit;

	const base =
		_normalMapEnabled && _normalReady ? _buildLitTile(srcX, srcY) : null;

	const tile = document.createElement("canvas");
	tile.width = TILE;
	tile.height = TILE;
	const tileCtx = tile.getContext("2d")!;

	if (base !== null) tileCtx.drawImage(base, 0, 0);
	else
		tileCtx.drawImage(_diffuseCanvas, srcX, srcY, TILE, TILE, 0, 0, TILE, TILE);

	if (bucket !== 100) {
		tileCtx.globalCompositeOperation = "source-atop";
		tileCtx.fillStyle = getShadeFill(bucket * 0.01);
		tileCtx.fillRect(0, 0, TILE, TILE);
		tileCtx.globalCompositeOperation = "source-over";
	}

	_shadedTileCache.set(cacheKey, tile);
	return tile;
}

// ─── Pending icon redraws ───
// Icons drawn before the shading/normal atlases finish loading miss their
// lit pass. Every such draw registers a redraw closure here; the queue is
// flushed whenever atlas readiness improves. Bounded: entries only
// accumulate until the atlases load (or fail) once.
type PendingIconRedraw = () => void;
const _pendingIconRedraws: PendingIconRedraw[] = [];

function _shadingFullyReady(): boolean {
	return _diffuseReady && (!_normalMapEnabled || _normalReady || _normalFailed);
}

function _queueIconRedraw(redraw: PendingIconRedraw): void {
	_pendingIconRedraws.push(redraw);
}

function _flushPendingIconRedraws(): void {
	if (_pendingIconRedraws.length === 0) return;

	const pending = _pendingIconRedraws.slice();
	_pendingIconRedraws.length = 0;

	for (let i = 0; i < pending.length; i++) pending[i]();
}

/**
 * Draws a Minecraft-style isometric icon for an arbitrary multi-box block
 * shape. Each box of the shape definition is projected with the classic
 * dimetric cube projection (visible faces: +Y top, +Z left, +X right) at
 * true block scale, so stairs, slabs, fences, panes, walls etc. all show
 * their real proportions. Individual faces are depth-sorted so intersecting
 * boxes (cross walls) visibly overlap.
 */
export function drawCubeIcon(
	ctx: CanvasRenderingContext2D,
	blockId: number | null,
	atlasImage: HTMLImageElement | null,
	atlasReady: boolean,
	options?: CubeIconOptions,
): void {
	const R = options?.radius ?? R_DEFAULT;
	const ry = options?.ry ?? RY_DEFAULT;
	const size = options?.size ?? SIZE_DEFAULT;
	const topShade = options?.topShade ?? TOP_SHADE;
	const leftShade = options?.leftShade ?? LEFT_SHADE;
	const rightShade = options?.rightShade ?? RIGHT_SHADE;

	_ensureAtlases();

	ctx.imageSmoothingEnabled = false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, size, size);

	const H = UNIT_HEIGHT;
	const ry2 = ry + ry;

	// Diagonal cross plants render edge-on in this projection; show their
	// sprite flat instead, matching how they read in the world.
	if (blockId !== null && isCrossDiagonalBlockId(blockId)) {
		_drawFlatSprite(ctx, blockId, atlasImage, atlasReady, size);
		return;
	}

	let boxes: readonly ShapeBox[];
	let outlineBoxes: readonly ShapeBox[] | null = null;

	if (blockId !== null && isCrossBlockId(blockId)) {
		// Axis-aligned cross: two thin intersecting walls so the icon shows
		// them overlapping, mirroring the world emitter's crossed quads.
		const t = 0.0625;
		const c = 0.5 - t * 0.5;
		boxes = [
			{ min: [0, 0, c], max: [1, 1, c + t], faceMask: FACE_ALL },
			{ min: [c, 0, 0], max: [c + t, 1, 1], faceMask: FACE_ALL },
		];
	} else {
		const shape = getShapeForBlockId(blockId ?? 0);
		boxes =
			shape !== null && shape.boxes.length > 0
				? shape.boxes
				: FALLBACK_CUBE.boxes;
		outlineBoxes = boxes;
	}

	// Highest point of the shape: anchors the vertical projection so flipped
	// or partial shapes (top slabs, wall slices) stay aligned in the frame.
	let bboxMaxY = 0;
	for (let i = 0; i < boxes.length; i++) {
		if (boxes[i].max[1] > bboxMaxY) bboxMaxY = boxes[i].max[1];
	}
	if (bboxMaxY <= 0) bboxMaxY = 1;

	// Projected content bounds: centers the actual shape silhouette inside
	// the icon canvas instead of assuming a full cube footprint.
	let minSx = Infinity;
	let maxSx = -Infinity;
	let minSy = Infinity;
	let maxSy = -Infinity;

	for (let i = 0; i < boxes.length; i++) {
		const b = boxes[i];

		const sxLo = (b.min[0] - b.max[2]) * R;
		const sxHi = (b.max[0] - b.min[2]) * R;
		if (sxLo < minSx) minSx = sxLo;
		if (sxHi > maxSx) maxSx = sxHi;

		const syLo = (bboxMaxY - b.max[1]) * H + (b.min[0] + b.min[2]) * ry;
		const syHi = (bboxMaxY - b.min[1]) * H + (b.max[0] + b.max[2]) * ry;
		if (syLo < minSy) minSy = syLo;
		if (syHi > maxSy) maxSy = syHi;
	}

	if (
		minSx === Infinity ||
		maxSx === -Infinity ||
		minSy === Infinity ||
		maxSy === -Infinity ||
		maxSx <= minSx ||
		maxSy <= minSy
	) {
		minSx = -R;
		maxSx = R;
		minSy = 0;
		maxSy = ry2 + H;
	}

	const offX = ((size - (maxSx - minSx)) * 0.5 - minSx) | 0;
	const offY = ((size - (maxSy - minSy)) * 0.5 - minSy) | 0;

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

	// Collect every visible face as an independent quad, then depth-sort so
	// faces of intersecting boxes interleave instead of whole boxes hiding
	// each other. Depth approximates distance to the (+X,+Y,+Z) camera.
	type IconQuad = {
		d: number;
		x0: number;
		y0: number;
		x1: number;
		y1: number;
		x2: number;
		y2: number;
		x3: number;
		y3: number;
		tx: number;
		ty: number;
		shade: number;
	};

	const quads: IconQuad[] = [];

	for (let i = 0; i < boxes.length; i++) {
		const box = boxes[i];
		const x0 = box.min[0];
		const y0 = box.min[1];
		const z0 = box.min[2];
		const x1 = box.max[0];
		const y1 = box.max[1];
		const z1 = box.max[2];
		const mask = box.faceMask;

		// Isometric projection:
		//   sx = (x - z) * R + offX
		//   sy = (bboxMaxY - y) * H + (x + z) * ry + offY
		// Unique silhouette corners:
		//   A back-top (x0,y1,z0)   B right-top (x1,y1,z0)
		//   C front-top (x1,y1,z1)  D left-top (x0,y1,z1)
		//   E right-bot (x1,y0,z0)  F front-bot (x1,y0,z1)
		//   G left-bot  (x0,y0,z1)
		const ax = (x0 - z0) * R + offX;
		const ay = (bboxMaxY - y1) * H + (x0 + z0) * ry + offY;
		const bx = (x1 - z0) * R + offX;
		const by = (bboxMaxY - y1) * H + (x1 + z0) * ry + offY;
		const cx = (x1 - z1) * R + offX;
		const cy = (bboxMaxY - y1) * H + (x1 + z1) * ry + offY;
		const dx = (x0 - z1) * R + offX;
		const dy = (bboxMaxY - y1) * H + (x0 + z1) * ry + offY;
		const ex = (x1 - z0) * R + offX;
		const ey = (bboxMaxY - y0) * H + (x1 + z0) * ry + offY;
		const fx = (x1 - z1) * R + offX;
		const fy = (bboxMaxY - y0) * H + (x1 + z1) * ry + offY;
		const gx = (x0 - z1) * R + offX;
		const gy = (bboxMaxY - y0) * H + (x0 + z1) * ry + offY;

		if ((mask & FACE_PY) !== 0) {
			quads.push({
				d: (x0 + x1) * 0.5 + y1 + (z0 + z1) * 0.5,
				x0: ax,
				y0: ay,
				x1: bx,
				y1: by,
				x2: cx,
				y2: cy,
				x3: dx,
				y3: dy,
				tx: topTX,
				ty: topTY,
				shade: topShade,
			});
		}

		if ((mask & FACE_PZ) !== 0) {
			quads.push({
				d: (x0 + x1) * 0.5 + (y0 + y1) * 0.5 + z1,
				x0: dx,
				y0: dy,
				x1: cx,
				y1: cy,
				x2: fx,
				y2: fy,
				x3: gx,
				y3: gy,
				tx: leftTX,
				ty: leftTY,
				shade: leftShade,
			});
		}

		if ((mask & FACE_PX) !== 0) {
			quads.push({
				d: x1 + (y0 + y1) * 0.5 + (z0 + z1) * 0.5,
				x0: cx,
				y0: cy,
				x1: bx,
				y1: by,
				x2: ex,
				y2: ey,
				x3: fx,
				y3: fy,
				tx: rightTX,
				ty: rightTY,
				shade: rightShade,
			});
		}
	}

	quads.sort((a, b) => a.d - b.d);

	for (let i = 0; i < quads.length; i++) {
		const q = quads[i];
		_drawQuad(
			ctx,
			q.x0,
			q.y0,
			q.x1,
			q.y1,
			q.x2,
			q.y2,
			q.x3,
			q.y3,
			atlasImage,
			atlasReady,
			q.tx,
			q.ty,
			q.shade,
		);
	}

	if (outlineBoxes !== null && outlineBoxes.length > 0) {
		ctx.strokeStyle = "rgba(0,0,0,0.5)";
		ctx.lineWidth = 1.5;

		// Projected silhouette hexagon of each box, in stroke order:
		// back-top, right-top, right-bottom, front-bottom, left-bottom, left-top.
		const hexes: number[][] = [];
		for (let i = 0; i < outlineBoxes.length; i++) {
			hexes.push(
				_projectHexagon(outlineBoxes[i], R, ry, H, bboxMaxY, offX, offY),
			);
		}

		const multiBox = hexes.length > 1;

		for (let i = 0; i < hexes.length; i++) {
			const pts = hexes[i];

			ctx.beginPath();

			if (multiBox) {
				// Compound shape: draw each hexagon edge in short runs, culling
				// the parts buried inside another box so no internal seams show.
				for (let e = 0; e < 6; e++) {
					const e2 = (e + 1) % 6;
					const ax = pts[e * 2];
					const ay = pts[e * 2 + 1];
					const bx = pts[e2 * 2];
					const by = pts[e2 * 2 + 1];
					const dx = bx - ax;
					const dy = by - ay;
					const edgeLen = Math.sqrt(dx * dx + dy * dy);
					const steps = Math.min(8, Math.max(1, Math.ceil(edgeLen / 6)));

					let runActive = false;

					for (let s = 0; s < steps; s++) {
						const t0 = s / steps;
						const t1 = (s + 1) / steps;
						const mx = ax + dx * (t0 + t1) * 0.5;
						const my = ay + dy * (t0 + t1) * 0.5;

						let hidden = false;
						for (let h = 0; h < hexes.length; h++) {
							if (h !== i && _pointInHexagon(mx, my, hexes[h])) {
								hidden = true;
								break;
							}
						}

						if (hidden) {
							runActive = false;
							continue;
						}

						if (!runActive) {
							ctx.moveTo(ax + dx * t0, ay + dy * t0);
							runActive = true;
						}
						ctx.lineTo(ax + dx * t1, ay + dy * t1);
					}
				}
			} else {
				ctx.moveTo(pts[0], pts[1]);
				for (let p = 2; p < 12; p += 2) {
					ctx.lineTo(pts[p], pts[p + 1]);
				}
				ctx.closePath();
			}

			ctx.stroke();
		}
	}

	// If the shading/normal atlases are still loading, this draw was produced
	// without their baked lighting; redraw it once readiness improves.
	if (!_shadingFullyReady()) {
		_queueIconRedraw(() => {
			drawCubeIcon(ctx, blockId, atlasImage, atlasReady, options);
		});
	}
}

/**
 * Projects a shape box to its isometric silhouette hexagon (flat [x,y,...]).
 */
function _projectHexagon(
	box: ShapeBox,
	R: number,
	ry: number,
	H: number,
	bboxMaxY: number,
	offX: number,
	offY: number,
): number[] {
	const x0 = box.min[0];
	const y0 = box.min[1];
	const z0 = box.min[2];
	const x1 = box.max[0];
	const y1 = box.max[1];
	const z1 = box.max[2];

	return [
		(x0 - z0) * R + offX,
		(bboxMaxY - y1) * H + (x0 + z0) * ry + offY,
		(x1 - z0) * R + offX,
		(bboxMaxY - y1) * H + (x1 + z0) * ry + offY,
		(x1 - z0) * R + offX,
		(bboxMaxY - y0) * H + (x1 + z0) * ry + offY,
		(x1 - z1) * R + offX,
		(bboxMaxY - y0) * H + (x1 + z1) * ry + offY,
		(x0 - z1) * R + offX,
		(bboxMaxY - y0) * H + (x0 + z1) * ry + offY,
		(x0 - z1) * R + offX,
		(bboxMaxY - y1) * H + (x0 + z1) * ry + offY,
	];
}

/**
 * Ray-cast point-in-polygon test against a flat [x,y,...] hexagon.
 */
function _pointInHexagon(px: number, py: number, pts: number[]): boolean {
	let inside = false;
	for (let i = 0, j = 10; i < 12; j = i, i += 2) {
		const yi = pts[i + 1];
		const yj = pts[j + 1];
		if (yi > py !== yj > py) {
			const xi = pts[i];
			const xj = pts[j];
			if (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
				inside = !inside;
			}
		}
	}
	return inside;
}

/**
 * Draws a plant-style block as its flat cutout sprite, centered.
 */
function _drawFlatSprite(
	ctx: CanvasRenderingContext2D,
	blockId: number,
	img: HTMLImageElement | null,
	ready: boolean,
	size: number,
): void {
	const tile =
		getFaceAtlasTile(blockId, FaceName.Side) ??
		getFaceAtlasTile(blockId, FaceName.Top);
	if (tile === null) return;

	const srcX = tile[0] * TILE;
	const srcY = tile[1] * TILE;
	const s = Math.round(size * 0.72);
	const o = ((size - s) * 0.5) | 0;

	// Shade 1 = neutral: keeps the sprite unshaded.
	const shaded = _getShadedTile(srcX, srcY, 1);

	if (shaded !== null) {
		ctx.drawImage(shaded, 0, 0, TILE, TILE, o, o, s, s);
	} else if (ready && img !== null) {
		ctx.drawImage(img, srcX, srcY, TILE, TILE, o, o, s, s);
	} else {
		ctx.fillStyle = "#9a9a9a";
		ctx.fillRect(o, o, s, s);
	}
}

/**
 * Draws one textured quad with optional normal-map lighting.
 * The texture u-axis maps onto edge A→B and the v-axis onto edge A→D.
 */
function _drawQuad(
	ctx: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x3: number,
	y3: number,
	img: HTMLImageElement | null,
	ready: boolean,
	srcX: number,
	srcY: number,
	shade: number,
): void {
	ctx.save();

	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.lineTo(x3, y3);
	ctx.closePath();
	ctx.clip();

	const shadedTile = _getShadedTile(srcX, srcY, shade);

	if (shadedTile !== null) {
		ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
		ctx.drawImage(shadedTile, 0, 0, TILE, TILE, 0, 0, 1, 1);
	} else if (ready && img !== null) {
		// Transient fallback while the atlas canvases are still loading: draw
		// the raw tile and apply the face shade directly over the quad so the
		// icon never renders unshaded.
		ctx.setTransform(x1 - x0, y1 - y0, x3 - x0, y3 - y0, x0, y0);
		ctx.drawImage(img, srcX, srcY, TILE, TILE, 0, 0, 1, 1);

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = getShadeFill(shade);
		ctx.fill();
	} else {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = "#9a9a9a";
		ctx.fillRect(x0 - 40, y0 - 40, 80, 80);
	}

	ctx.restore();
}
