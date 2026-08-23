/**
 * RemotePlayerRenderer — visual representation of other players.
 *
 * Creates Minecraft-style player rigs for remote players (textured with each
 * player's server-synced skin PNG) + billboard name tags (Minecraft-style).
 * Uses DynamicTexture2D + OffscreenCanvas for reliable text rendering, and
 * FacingBillboardSpriteSystem for camera-facing sprites.
 *
 * Perf notes (see individual comments below):
 *  - Per-frame billboard update no longer allocates (position/size/color arrays
 *    and the options object are created once per player and mutated in place).
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
import type {
	EngineContext,
	Mesh,
	SceneContext,
	Texture2D,
} from "@babylonjs/lite";
import {
	addBillboardSpriteIndex,
	addFacingBillboardSystem,
	addToScene,
	billboardBlendAlpha,
	clearBillboardSprites,
	createDynamicTexture,
	createFacingBillboardSystem,
	createGridSpriteAtlas,
	createTexture2DFromPixels,
	type DynamicTexture2D,
	disposeMeshGpu,
	type FacingBillboardSpriteSystem,
	rebuildSceneRenderables,
	removeFromScene,
	type SpriteAtlas,
	setShaderTexture,
	updateDynamicTexture,
} from "@babylonjs/lite";
import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
import { onGpuWorkDone } from "@/code/World/Light/liteGpuBuffer.js";
import {
	applyRigSkin,
	createPlayerRigMesh,
	createRigShaderMaterial,
	getRigFallbackTexture,
	PLAYER_LIGHT_SAMPLE_Y_OFFSET,
	packedLightToLightColor,
	setRigLightColor,
} from "../Player/PlayerModel";
import type { RemotePlayer } from "./NetClient";

// Name tag sizing
const NAME_TAG_FONT_PX = 30;
const NAME_TAG_PADDING = 12;
const NAME_TAG_HEIGHT_WORLD = 0.55;
const NAME_TAG_Y_OFFSET = 1.5;
const NAME_TAG_TEX_HEIGHT = 64; // texture pixel height

const NAME_TAG_MAX_TEX_WIDTH = 384;
const NAME_TAG_MIN_TEX_WIDTH = 32;
//const NAME_TAG_FONT = "Arial";
const NAME_TAG_FONT = "monospace";
const ELLIPSIS = "…";

const DEG_TO_RAD = Math.PI / 180;

// Billboard color never varies (name tags are always plain white), so every
// visual shares one immutable array instead of allocating its own.
const WHITE_COLOR: [number, number, number, number] = [1, 1, 1, 1];

// Light-tint refresh cadence, matching the local body in Player.ts.
const LIGHT_RESAMPLE_MS = 250;

/**
 * Decode skin PNG bytes into a 64x64 RGBA8 GPU texture.
 *
 * The bytes are scale-drawn onto an exact 64x64 canvas (nearest neighbor) so
 * HD square skins (e.g. 128x128) land correctly in the rig's /64 UV space;
 * legacy 64x32 skins stretch vertically (acceptable fallback). Sampling stays
 * nearest to preserve the pixel-art look.
 *
 * Rows are reversed BEFORE upload: createTexture2DFromPixels writes raw
 * top-row-first bytes, while loadTexture2D flips during upload
 * (invertY default true). The manual flip keeps both skin paths sampling
 * identically under the rig's v=1-at-image-top UVs.
 */
async function decodeSkinToTexture(
	engine: EngineContext,
	png: Uint8Array,
): Promise<Texture2D> {
	// Copy into a plain ArrayBuffer-backed view (Blob rejects SAB-backed views).
	const bytes = new Uint8Array(png.byteLength);
	bytes.set(png);
	const blob = new Blob([bytes], { type: "image/png" });
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = new OffscreenCanvas(64, 64);
		const ctx = canvas.getContext("2d")!;
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(bitmap, 0, 0, 64, 64);
		const src = ctx.getImageData(0, 0, 64, 64).data;
		const rowBytes = 64 * 4;
		const flipped = new Uint8Array(src.length);
		for (let y = 0; y < 64; y++) {
			flipped.set(
				src.subarray((63 - y) * rowBytes, (64 - y) * rowBytes),
				y * rowBytes,
			);
		}
		return createTexture2DFromPixels(engine, flipped, 64, 64);
	} finally {
		bitmap.close();
	}
}

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

	private mat: ReturnType<typeof createRigShaderMaterial>;
	private tex: DynamicTexture2D;
	private atlas: SpriteAtlas;
	private billboard: FacingBillboardSpriteSystem;

	// Skin delivery: the loader handed to applyRigSkin resolves either
	// immediately (PNG already synced) or when onSkinPng() receives it.
	private skinPromise: Promise<Texture2D> | null = null;
	private skinArrived: ((tex: Texture2D) => void) | null = null;
	private skinBound = false;
	private alive = true;

	private lastX = Number.NaN;
	private lastY = Number.NaN;
	private lastZ = Number.NaN;
	private lastYaw = Number.NaN;
	private lastTargetX = Number.NaN;
	private lastTargetY = Number.NaN;
	private lastTargetZ = Number.NaN;
	private lastTargetYaw = Number.NaN;

	// Voxel-light tint bookkeeping (same cadence as the local body).
	private lastLightX = Number.NaN;
	private lastLightY = Number.NaN;
	private lastLightZ = Number.NaN;
	private lastLightSampleMs = -Infinity;

	// Scratch state reused every frame.
	private readonly _pos: [number, number, number] = [0, 0, 0];

	// Throttle visual (mesh + billboard) GPU writes to ~60Hz. The interpolation
	// targets only change at the server's send rate (20Hz), so flushing faster
	// than the display refresh would just re-upload identical world matrices.
	private lastFlushMs = -1;
	private static readonly VISUAL_REFRESH_MS = 16;

	private readonly _billboardOpts: {
		position: [number, number, number];
		sizeWorld: [number, number];
		color: [number, number, number, number];
	};

	constructor(
		private engine: EngineContext,
		private scene: SceneContext,
		private player: RemotePlayer,
	) {
		this.mesh = createPlayerRigMesh(
			engine,
			`remoteRig_${player.sessionId.slice(0, 8)}`,
			"center",
		);

		this.mat = createRigShaderMaterial("remoteRigMat");
		this.mesh.material = this.mat;
		this.mesh.pickable = false;
		// Hidden until the skin texture binds (unbound sampler = invalid pass),
		// mirroring the local third-person body in Player.ts.
		this.mesh.visible = false;

		addToScene(this.scene, this.mesh);

		applyRigSkin(
			engine,
			this.mat,
			() => {
				this.skinBound = true;
			},
			() => this.alive,
			(eng) => this.getSkinTexture(eng),
		);

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

	/**
	 * Loader override for applyRigSkin: resolves from the already-synced PNG
	 * when present, otherwise parks until onSkinPng delivers the bytes.
	 */
	private getSkinTexture(engine: EngineContext): Promise<Texture2D> {
		if (!this.skinPromise) {
			const existing = this.player.skinPng;
			if (existing) {
				this.skinPromise = decodeSkinToTexture(engine, existing);
			} else {
				this.skinPromise = new Promise<Texture2D>((resolve) => {
					this.skinArrived = resolve;
				});
			}
		}
		return this.skinPromise;
	}

	/** Called when the server delivers this player's skin PNG. */
	onSkinPng(png: Uint8Array): void {
		const resolve = this.skinArrived;
		if (resolve) {
			this.skinArrived = null;
			void decodeSkinToTexture(this.engine, png).then(resolve, () =>
				resolve(getRigFallbackTexture(this.engine)),
			);
			return;
		}
		// Safety net for a re-delivered/updated skin: decode and rebind.
		void decodeSkinToTexture(this.engine, png).then(
			(tex) => {
				if (!this.alive) return;
				setShaderTexture(this.mat, "diffuseTexture", tex);
				this.skinBound = true;
			},
			() => {},
		);
	}

	/** Voxel-light tint at the remote player's position (chest height). */
	private syncLight(): void {
		const p = this.player;
		const lx = Math.floor(p.x);
		const ly = Math.floor(p.y + PLAYER_LIGHT_SAMPLE_Y_OFFSET);
		const lz = Math.floor(p.z);
		const now = performance.now();
		if (
			lx === this.lastLightX &&
			ly === this.lastLightY &&
			lz === this.lastLightZ &&
			now - this.lastLightSampleMs < LIGHT_RESAMPLE_MS
		) {
			return;
		}
		this.lastLightX = lx;
		this.lastLightY = ly;
		this.lastLightZ = lz;
		this.lastLightSampleMs = now;
		setRigLightColor(
			this.mat,
			packedLightToLightColor(
				getLightByWorldCoords(p.x, p.y + PLAYER_LIGHT_SAMPLE_Y_OFFSET, p.z),
			),
		);
	}

	update(): void {
		this.syncLight();
		this.mesh.visible = this.skinBound;

		const x = this.player.x;
		const y = this.player.y;
		const z = this.player.z;
		const yaw = this.player.yaw;
		const tx = this.player.targetX;
		const ty = this.player.targetY;
		const tz = this.player.targetZ;
		const tyaw = this.player.targetYaw;

		const targetChanged =
			tx !== this.lastTargetX ||
			ty !== this.lastTargetY ||
			tz !== this.lastTargetZ ||
			tyaw !== this.lastTargetYaw;

		const now = performance.now();
		// Full early-out: identical current state and identical interpolation
		// targets → nothing to do this frame (idle remote player).
		if (
			!targetChanged &&
			x === this.lastX &&
			y === this.lastY &&
			z === this.lastZ &&
			yaw === this.lastYaw
		) {
			return;
		}

		// Throttle: skip the flush unless the target moved (new server data) or
		// the refresh interval elapsed. Interpolation keeps the state current in
		// between; the visual resamples at ~60Hz, matching the display.
		if (
			!targetChanged &&
			now - this.lastFlushMs < RemotePlayerVisual.VISUAL_REFRESH_MS
		) {
			return;
		}
		this.lastFlushMs = now;

		this.lastX = x;
		this.lastY = y;
		this.lastZ = z;
		this.lastYaw = yaw;
		this.lastTargetX = tx;
		this.lastTargetY = ty;
		this.lastTargetZ = tz;
		this.lastTargetYaw = tyaw;

		this.mesh.position.set(x, y, z);
		this.mesh.rotation.y = yaw * DEG_TO_RAD;

		this._pos[0] = x;
		this._pos[1] = y + NAME_TAG_Y_OFFSET;
		this._pos[2] = z;

		clearBillboardSprites(this.billboard);
		addBillboardSpriteIndex(this.billboard, this._billboardOpts);
	}

	dispose(): void {
		this.alive = false;
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
	}
}

export class RemotePlayerRenderer {
	private list: RemotePlayerVisual[] = [];
	private ids: string[] = [];
	private indexById = new Map<string, number>();

	private pendingFlush = false;
	private rebuildInFlight = false;

	private scene: SceneContext;
	private engine: EngineContext;

	constructor(engine: EngineContext, scene: SceneContext) {
		this.engine = engine;
		this.scene = scene;
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

		const visual = new RemotePlayerVisual(this.engine, this.scene, player);

		const index = this.list.length;

		this.indexById.set(sessionId, index);
		this.list.push(visual);
		this.ids.push(sessionId);

		this.requestSceneRenderableFlush();
	}

	/** Deliver a server-synced skin PNG to the matching player's visual. */
	onPlayerSkin(sessionId: string, png: Uint8Array): void {
		const index = this.indexById.get(sessionId);
		if (index === undefined) return;
		this.list[index].onSkinPng(png);
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
	}
}
