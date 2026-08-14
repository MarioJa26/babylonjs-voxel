/**
 * RemotePlayerRenderer — visual representation of other players.
 *
 * Creates capsule meshes for remote players + billboard name tags (Minecraft-style).
 * Uses DynamicTexture2D + OffscreenCanvas for reliable text rendering, and
 * FacingBillboardSpriteSystem for camera-facing sprites.
 *
 * Perf notes (see individual comments below):
 *  - Per-frame billboard update no longer allocates (position/size/color arrays
 *    and the options object are created once per player and mutated in place).
 *  - Materials are pooled by color index (max 8 live materials, not one per
 *    player) since color is purely a function of `colorIndex % PLAYER_COLORS.length`.
 *  - Name-tag textures are sized to the actual rasterised text instead of a
 *    fixed 512px canvas, cutting texture memory/upload bandwidth for typical
 *    names without changing the rendered on-screen scale (the texel→world
 *    ratio is fixed by NAME_TAG_HEIGHT_WORLD / NAME_TAG_TEX_HEIGHT, both
 *    constants, so trimming canvas width is scale-neutral).
 *  - `rebuildSceneRenderables` is deferred to the renderer and batched: it's a
 *    scene-wide call, so N players joining in the same frame now trigger it
 *    once instead of N times.
 *  - Remote players are iterated over a flat array (swap-remove on leave)
 *    instead of `Map.values()` for a tighter, allocation-free hot loop.
 */
import type { EngineContext, Mesh, SceneContext } from "@babylonjs/lite";
import {
	addBillboardSpriteIndex,
	addFacingBillboardSystem,
	addToScene,
	billboardBlendAlpha,
	clearBillboardSprites,
	createCapsule,
	createDynamicTexture,
	createFacingBillboardSystem,
	createGridSpriteAtlas,
	createStandardMaterial,
	type DynamicTexture2D,
	disposeMeshGpu,
	type FacingBillboardSpriteSystem,
	rebuildSceneRenderables,
	removeFromScene,
	type SpriteAtlas,
	updateDynamicTexture,
} from "@babylonjs/lite";
import { onGpuWorkDone } from "@/code/World/Light/liteGpuBuffer.js";
import type { RemotePlayer } from "./NetClient";

type PlayerMaterial = ReturnType<typeof createStandardMaterial>;

const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.3;

// Name tag sizing
const NAME_TAG_FONT_PX = 30;
const NAME_TAG_PADDING = 12;
const NAME_TAG_HEIGHT_WORLD = 0.55;
const NAME_TAG_Y_OFFSET = 1.5;
const NAME_TAG_TEX_HEIGHT = 64; // texture pixel height

const NAME_TAG_MAX_TEX_WIDTH = 384;
2;
const NAME_TAG_MIN_TEX_WIDTH = 32;
//const NAME_TAG_FONT = "Arial";
const NAME_TAG_FONT = "monospace";
const ELLIPSIS = "…";

const DEG_TO_RAD = Math.PI / 180;

// Billboard color never varies (name tags are always plain white), so every
// visual shares one immutable array instead of allocating its own.
const WHITE_COLOR: [number, number, number, number] = [1, 1, 1, 1];

// Color palette for different players
const PLAYER_COLORS: readonly [number, number, number][] = [
	[0.2, 0.6, 1.0], // Blue
	[1.0, 0.4, 0.2], // Orange
	[0.2, 1.0, 0.4], // Green
	[1.0, 0.2, 0.6], // Pink
	[0.6, 0.2, 1.0], // Purple
	[1.0, 0.8, 0.2], // Yellow
	[0.2, 0.8, 1.0], // Cyan
	[0.8, 0.4, 0.1], // Brown
];

// Shared scratch canvas used only for `measureText` calls, so rasterising a
// name tag doesn't need a throwaway full-size canvas just to size itself.
let _measureCtx: OffscreenCanvasRenderingContext2D | null = null;
function getMeasureCtx(): OffscreenCanvasRenderingContext2D {
	if (!_measureCtx) {
		_measureCtx = new OffscreenCanvas(1, 1).getContext("2d")!;
	}
	return _measureCtx;
}

function clampInt(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value | 0;
}

/**
 * Fast deterministic hash for stable player colors.
 * This avoids color changes caused by join/leave order.
 */
function hashString32(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function getColorIndexForSession(sessionId: string): number {
	return hashString32(sessionId) % PLAYER_COLORS.length;
}

/**
 * Restricts text to fit inside maxTextWidthPx.
 * This only runs when a name tag is created, not per frame.
 */
function fitTextWithEllipsis(
	ctx: OffscreenCanvasRenderingContext2D,
	text: string,
	maxTextWidthPx: number,
): string {
	if (ctx.measureText(text).width <= maxTextWidthPx) {
		return text;
	}

	const ellipsisWidth = ctx.measureText(ELLIPSIS).width;
	if (ellipsisWidth >= maxTextWidthPx) {
		return ELLIPSIS;
	}

	let lo = 0;
	let hi = text.length;
	let best = ELLIPSIS;

	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const candidate = text.slice(0, mid) + ELLIPSIS;

		if (ctx.measureText(candidate).width <= maxTextWidthPx) {
			best = candidate;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}

	return best;
}
/**
 * Rasterise a player name onto an OffscreenCanvas with Minecraft-style
 * dark background + white text, then return the canvas and its measured
 * width/height in pixels. The canvas is sized to fit the text exactly
 * (rather than a fixed wide canvas) to minimise GPU texture memory and
 * upload bandwidth; this does not change the rendered scale because the
 * texel→world ratio is derived from the fixed NAME_TAG_TEX_HEIGHT.
 */
function rasteriseNameTag(name: string): {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
} {
	const safeName = name && name.length > 0 ? name : "Player";

	const measureCtx = getMeasureCtx();
	measureCtx.font = `bold ${NAME_TAG_FONT_PX}px ${NAME_TAG_FONT}`;

	const maxTextWidth = NAME_TAG_MAX_TEX_WIDTH - NAME_TAG_PADDING * 2;
	const displayName = fitTextWithEllipsis(measureCtx, safeName, maxTextWidth);
	const textWidth = measureCtx.measureText(displayName).width;

	const bgWidth = clampInt(
		Math.ceil(textWidth + NAME_TAG_PADDING * 2),
		NAME_TAG_MIN_TEX_WIDTH,
		NAME_TAG_MAX_TEX_WIDTH,
	);

	const bgHeight = NAME_TAG_TEX_HEIGHT;

	const canvas = new OffscreenCanvas(bgWidth, bgHeight);
	const ctx = canvas.getContext("2d")!;

	ctx.font = measureCtx.font;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";

	const bandHeight = NAME_TAG_FONT_PX + 10;
	const bandY = ((bgHeight - bandHeight) * 0.5) | 0;

	ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
	ctx.fillRect(0, bandY, bgWidth, bandHeight);

	ctx.fillStyle = "#ffffffff";
	ctx.fillText(displayName, bgWidth * 0.5, bgHeight * 0.5);

	return {
		canvas,
		width: bgWidth,
		height: bgHeight,
	};
}

export class RemotePlayerVisual {
	readonly mesh: Mesh;

	private tex: DynamicTexture2D;
	private atlas: SpriteAtlas;
	private billboard: FacingBillboardSpriteSystem;

	private lastX = Number.NaN;
	private lastY = Number.NaN;
	private lastZ = Number.NaN;
	private lastYaw = Number.NaN;

	// Scratch state reused every frame.
	private readonly _pos: [number, number, number] = [0, 0, 0];

	private readonly _billboardOpts: {
		position: [number, number, number];
		sizeWorld: [number, number];
		color: [number, number, number, number];
	};

	constructor(
		private engine: EngineContext,
		private scene: SceneContext,
		private player: RemotePlayer,
		material: PlayerMaterial,
	) {
		this.mesh = createCapsule(engine, {
			height: PLAYER_HEIGHT,
			radius: PLAYER_RADIUS,
		});

		this.mesh.material = material;
		this.mesh.pickable = false;

		addToScene(this.scene, this.mesh);

		const { canvas, width: texW, height: texH } = rasteriseNameTag(player.name);
		const nameTagWidthWorld = NAME_TAG_HEIGHT_WORLD * (texW / texH);

		this.tex = createDynamicTexture(engine, texW, texH, {
			magFilter: "linear",
			minFilter: "linear",
			srgb: true,
		});

		updateDynamicTexture(engine, this.tex, canvas, { invertY: false });

		this.atlas = createGridSpriteAtlas(this.tex, {
			cellWidthPx: texW,
			cellHeightPx: texH,
		});

		this.billboard = createFacingBillboardSystem(this.atlas, {
			capacity: 1,
			blendMode: billboardBlendAlpha,
		});

		addFacingBillboardSystem(this.scene, this.billboard);

		this._billboardOpts = {
			position: this._pos,
			sizeWorld: [nameTagWidthWorld, NAME_TAG_HEIGHT_WORLD],
			color: WHITE_COLOR,
		};

		// Force initial placement on first update.
		this.update();
	}

	update(): void {
		const x = this.player.x;
		const y = this.player.y;
		const z = this.player.z;
		const yaw = this.player.yaw;

		if (
			x === this.lastX &&
			y === this.lastY &&
			z === this.lastZ &&
			yaw === this.lastYaw
		) {
			return;
		}

		this.lastX = x;
		this.lastY = y;
		this.lastZ = z;
		this.lastYaw = yaw;

		this.mesh.position.set(x, y, z);
		this.mesh.rotation.y = yaw * DEG_TO_RAD;

		this._pos[0] = x;
		this._pos[1] = y + NAME_TAG_Y_OFFSET;
		this._pos[2] = z;

		clearBillboardSprites(this.billboard);
		addBillboardSpriteIndex(this.billboard, this._billboardOpts);
	}

	dispose(): void {
		this.billboard.visible = false;
		clearBillboardSprites(this.billboard);

		removeFromScene(this.scene, this.mesh);

		const mesh = this.mesh;
		const engine = this.engine;

		void onGpuWorkDone(engine).then(
			() => {
				disposeMeshGpu(mesh);
			},
			() => {
				disposeMeshGpu(mesh);
			},
		);

		// If @babylonjs/lite exposes explicit disposal functions for
		// FacingBillboardSpriteSystem, SpriteAtlas, or DynamicTexture2D,
		// call them here as well. The current imports only expose disposeMeshGpu.
		//
		// Material is pooled and owned by RemotePlayerRenderer.
	}
}

export class RemotePlayerRenderer {
	private list: RemotePlayerVisual[] = [];
	private ids: string[] = [];
	private indexById = new Map<string, number>();

	private materialPool: (PlayerMaterial | null)[] = new Array(
		PLAYER_COLORS.length,
	).fill(null);

	private pendingFlush = false;
	private rebuildInFlight = false;

	private scene: SceneContext;
	private engine: EngineContext;

	constructor(engine: EngineContext, scene: SceneContext) {
		this.engine = engine;
		this.scene = scene;
	}

	private getMaterial(colorIndex: number): PlayerMaterial {
		let mat = this.materialPool[colorIndex];

		if (mat === null) {
			mat = createStandardMaterial();
			mat.emissiveColor = PLAYER_COLORS[colorIndex];
			mat.disableLighting = true;
			this.materialPool[colorIndex] = mat;
		}

		return mat;
	}

	private requestSceneRenderableFlush(): void {
		this.pendingFlush = true;
	}

	private flushSceneRenderablesIfNeeded(): void {
		if (!this.pendingFlush || this.rebuildInFlight) {
			return;
		}

		this.pendingFlush = false;
		this.rebuildInFlight = true;

		void rebuildSceneRenderables(this.scene).then(
			() => {
				this.rebuildInFlight = false;
			},
			() => {
				this.rebuildInFlight = false;
			},
		);
	}

	onPlayerJoin(player: RemotePlayer): void {
		const sessionId = player.sessionId;

		if (this.indexById.has(sessionId)) {
			return;
		}

		const colorIndex = getColorIndexForSession(sessionId);
		const material = this.getMaterial(colorIndex);

		const visual = new RemotePlayerVisual(
			this.engine,
			this.scene,
			player,
			material,
		);

		const index = this.list.length;

		this.indexById.set(sessionId, index);
		this.list.push(visual);
		this.ids.push(sessionId);

		this.requestSceneRenderableFlush();
	}

	onPlayerLeave(sessionId: string): void {
		const index = this.indexById.get(sessionId);

		if (index === undefined) {
			return;
		}

		const list = this.list;
		const ids = this.ids;
		const lastIndex = list.length - 1;

		list[index].dispose();

		if (index !== lastIndex) {
			const movedVisual = list[lastIndex];
			const movedId = ids[lastIndex];

			list[index] = movedVisual;
			ids[index] = movedId;

			this.indexById.set(movedId, index);
		}

		list.pop();
		ids.pop();
		this.indexById.delete(sessionId);

		this.requestSceneRenderableFlush();
	}

	update(_camera: any, _screenW: number, _screenH: number): void {
		this.flushSceneRenderablesIfNeeded();

		const list = this.list;
		const count = list.length;

		for (let i = 0; i < count; i++) {
			list[i].update();
		}
	}

	dispose(): void {
		const list = this.list;

		for (let i = 0; i < list.length; i++) {
			list[i].dispose();
		}

		list.length = 0;
		this.ids.length = 0;
		this.indexById.clear();

		this.pendingFlush = false;

		// Pooled materials outlive individual visuals. If @babylonjs/lite exposes
		// a material-disposal function, call it per non-null entry here.
		this.materialPool.fill(null);
	}
}
