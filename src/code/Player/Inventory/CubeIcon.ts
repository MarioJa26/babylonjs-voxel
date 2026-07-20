import {
	FALLBACK_CUBE,
	getShapeForBlockId,
} from "@/code/World/Shape/BlockShapes";
import { getFaceAtlasTile } from "@/code/World/Texture/BlockTextures";
import { FaceName } from "@/code/World/Texture/FaceName";

export type Vec2 = [number, number];

export interface CubeIconOptions {
	/** Horizontal half-width of the top rhombus. Bigger = wider cube. */
	radius?: number;
	/** Vertical half-height of the top rhombus. */
	ry?: number;
	/** Side-face height multiplier applied to 2*radius (1 => full cube). */
	heightRatio?: number;
	/** Target canvas pixel size (square). */
	size?: number;
	/** Shade factors per face (1 = neutral, >1 brighter, <1 darker). */
	topShade?: number;
	leftShade?: number;
	rightShade?: number;
}

const DEFAULTS: Required<CubeIconOptions> = {
	radius: 23,
	ry: 12,
	heightRatio: 1.5,
	size: 64,
	topShade: 1.24,
	leftShade: 0.79,
	rightShade: 0.37,
};

/**
 * Draws a Minecraft-style isometric cube icon onto `ctx`, centred in the
 * `size`x`size` canvas. Each visible face is textured from the block's real
 * per-face atlas tile and shaded with the classic top-bright / left-medium /
 * right-dark look. The transform is fully deterministic, so the texture never
 * skews or drifts. `heightScale` (0..1) shortens slabs and other flat shapes.
 */
export function drawCubeIcon(
	ctx: CanvasRenderingContext2D,
	blockId: number | null,
	atlasImage: HTMLImageElement | null,
	atlasReady: boolean,
	heightScale: number,
	options: CubeIconOptions = {},
): void {
	const cfg = { ...DEFAULTS, ...options };
	const R = cfg.radius;
	const ry = cfg.ry;
	const H = 1.5 * R * heightScale;
	const tile = 25;
	const size = cfg.size;

	ctx.imageSmoothingEnabled = false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, size, size);

	// Map exported visible faces to atlas face slots.
	const topTile = getFaceAtlasTile(blockId, FaceName.Top) ?? [0, 0];
	const leftTile =
		getFaceAtlasTile(blockId, FaceName.West) ??
		getFaceAtlasTile(blockId, FaceName.Side) ??
		topTile;
	const rightTile =
		getFaceAtlasTile(blockId, FaceName.East) ??
		getFaceAtlasTile(blockId, FaceName.South) ??
		getFaceAtlasTile(blockId, FaceName.Side) ??
		topTile;

	// Local-space cube points (origin = top-front vertex), then centre.
	const Ltop: Vec2 = [0, 0];
	const LtopR: Vec2 = [R, ry];
	const LtopL: Vec2 = [-R, ry];
	const LtopB: Vec2 = [0, 2 * ry];
	const LbotL: Vec2 = [-R, ry + H];
	const LbotR: Vec2 = [R, ry + H];
	const LbotF: Vec2 = [0, 2 * ry + H];

	const xs = [
		Ltop[0],
		LtopR[0],
		LtopL[0],
		LtopB[0],
		LbotL[0],
		LbotR[0],
		LbotF[0],
	];
	const ys = [
		Ltop[1],
		LtopR[1],
		LtopL[1],
		LtopB[1],
		LbotL[1],
		LbotR[1],
		LbotF[1],
	];
	const offX =
		(size - (Math.max(...xs) - Math.min(...xs))) / 2 - Math.min(...xs);
	const offY =
		(size - (Math.max(...ys) - Math.min(...ys))) / 2 - Math.min(...ys);
	const T = (p: Vec2): Vec2 => [p[0] + offX, p[1] + offY];

	const top = T(Ltop);
	const topR = T(LtopR);
	const topL = T(LtopL);
	const topB = T(LtopB);
	const botL = T(LbotL);
	const botR = T(LbotR);
	const botF = T(LbotF);

	const topFace = [top, topR, topB, topL];
	const leftFace = [topL, topB, botF, botL];
	const rightFace = [topB, topR, botR, botF];

	const srcTop: Vec2 = [topTile[0] * tile, topTile[1] * tile];
	const srcLeft: Vec2 = [leftTile[0] * tile, leftTile[1] * tile];
	const srcRight: Vec2 = [rightTile[0] * tile, rightTile[1] * tile];

	drawRhombusFace(
		ctx,
		topFace,
		atlasImage,
		atlasReady,
		srcTop,
		tile,
		cfg.topShade,
	);
	drawRhombusFace(
		ctx,
		leftFace,
		atlasImage,
		atlasReady,
		srcLeft,
		tile,
		cfg.leftShade,
	);
	drawRhombusFace(
		ctx,
		rightFace,
		atlasImage,
		atlasReady,
		srcRight,
		tile,
		cfg.rightShade,
	);

	// Outline the whole silhouette.
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.strokeStyle = "rgba(0,0,0,0.5)";
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(top[0], top[1]);
	ctx.lineTo(topR[0], topR[1]);
	ctx.lineTo(botR[0], botR[1]);
	ctx.lineTo(botF[0], botF[1]);
	ctx.lineTo(botL[0], botL[1]);
	ctx.lineTo(topL[0], topL[1]);
	ctx.closePath();
	ctx.stroke();
}

/**
 * Maps the unit square (0..1) onto a parallelogram face via setTransform,
 * then draws the atlas tile into it. Deterministic transform => no drift.
 * Clipping to the face quad prevents neighbour bleed.
 */
function drawRhombusFace(
	ctx: CanvasRenderingContext2D,
	pts: Vec2[],
	img: HTMLImageElement | null,
	ready: boolean,
	src: Vec2,
	tile: number,
	shade: number,
): void {
	const o = pts[0];
	const p1 = pts[1];
	const p3 = pts[3];

	ctx.save();
	ctx.beginPath();
	ctx.moveTo(pts[0][0], pts[0][1]);
	for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
	ctx.closePath();
	ctx.clip();

	if (ready && img) {
		// setTransform(a,b,c,d,e,f): (x,y) -> (a*x + c*y + e, b*x + d*y + f).
		// U axis along edge o->p1, V axis along edge o->p3.
		ctx.setTransform(
			p1[0] - o[0],
			p1[1] - o[1],
			p3[0] - o[0],
			p3[1] - o[1],
			o[0],
			o[1],
		);
		ctx.drawImage(img, src[0], src[1], tile, tile, 0, 0, 1, 1);
	} else {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = "#9a9a9a";
		ctx.fillRect(o[0] - 40, o[1] - 40, 80, 80);
	}
	ctx.restore();

	// Directional shading overlay (untransformed space). Faces brighter than
	// 1 get a white tint, darker faces a black tint, so left and right read
	// as clearly different brightnesses.
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.beginPath();
	ctx.moveTo(pts[0][0], pts[0][1]);
	for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
	ctx.closePath();
	if (shade >= 1) {
		ctx.fillStyle = `rgba(255,255,255,${(shade - 1) * 0.18})`;
	} else {
		ctx.fillStyle = `rgba(0,0,0,${(1 - shade) * 0.62})`;
	}
	ctx.fill();
	ctx.restore();
}

/** Computes the 0..1 height scale for a block from its shape definition. */
export function getShapeHeightScale(blockId: number | null): number {
	const shape = getShapeForBlockId(blockId ?? 0);
	const boxes =
		shape && shape.boxes.length > 0 ? shape.boxes : FALLBACK_CUBE.boxes;
	let maxH = 0;
	for (const b of boxes) maxH = Math.max(maxH, b.max[1] - b.min[1]);
	return Math.max(0.25, Math.min(1, maxH));
}
