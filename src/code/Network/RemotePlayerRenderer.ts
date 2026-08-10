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
//const NAME_TAG_FONT = "Arial";
const NAME_TAG_FONT = "monospace";

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
	const measureCtx = getMeasureCtx();
	measureCtx.font = `bold ${NAME_TAG_FONT_PX}px ${NAME_TAG_FONT}`;
	const textWidth = measureCtx.measureText(name).width;
	const bgWidth = Math.ceil(textWidth + NAME_TAG_PADDING * 2);
	const bgHeight = NAME_TAG_TEX_HEIGHT;

	const canvas = new OffscreenCanvas(bgWidth, bgHeight);
	const ctx = canvas.getContext("2d")!;
	ctx.font = measureCtx.font;

	// Freshly created canvases are already fully transparent — no clearRect needed.

	// Draw dark background band (same vertical band as before, now full-width
	// since the canvas is already trimmed to the content width).
	const by = (bgHeight - NAME_TAG_FONT_PX - 4) / 2 - 4;
	ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
	ctx.fillRect(0, by, bgWidth, NAME_TAG_FONT_PX + 10);

	// Draw white text, centred
	ctx.fillStyle = "#ffffffff";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(name, bgWidth / 2, bgHeight / 2);

	return { canvas, width: bgWidth, height: bgHeight };
}

export class RemotePlayerVisual {
	readonly mesh: Mesh;
	private tex: DynamicTexture2D;
	private atlas: SpriteAtlas;
	private billboard: FacingBillboardSpriteSystem;

	// Scratch state reused every frame — zero allocations in update().
	private readonly _pos: [number, number, number] = [0, 0, 0];
	private readonly _billboardOpts: {
		position: [number, number, number];
		sizeWorld: [number, number];
		color: [number, number, number, number];
	};

	constructor(
		engine: EngineContext,
		private scene: SceneContext,
		private player: RemotePlayer,
		material: PlayerMaterial,
	) {
		// Player capsule
		this.mesh = createCapsule(engine, {
			height: PLAYER_HEIGHT,
			radius: PLAYER_RADIUS,
		});
		this.mesh.material = material;
		this.mesh.pickable = false;
		addToScene(this.scene, this.mesh);

		// Rasterise name tag to a canvas
		const { canvas, width: texW, height: texH } = rasteriseNameTag(player.name);

		// Compute world-space billboard width to preserve aspect ratio
		const nameTagWidthWorld = NAME_TAG_HEIGHT_WORLD * (texW / texH);

		// Create GPU texture and upload the canvas pixels
		this.tex = createDynamicTexture(engine, texW, texH, {
			magFilter: "linear",
			minFilter: "linear",
			srgb: true,
		});
		updateDynamicTexture(engine, this.tex, canvas, { invertY: false });

		// 1-frame sprite atlas (the whole texture is one frame)
		this.atlas = createGridSpriteAtlas(this.tex, {
			cellWidthPx: texW,
			cellHeightPx: texH,
		});

		// Billboard system — one sprite capacity per player
		this.billboard = createFacingBillboardSystem(this.atlas, {
			capacity: 1,
			blendMode: billboardBlendAlpha,
		});
		addFacingBillboardSystem(this.scene, this.billboard);

		// Built once; `position` aliases `_pos` so mutating `_pos` each frame
		// is automatically reflected here without re-allocating the object.
		this._billboardOpts = {
			position: this._pos,
			sizeWorld: [nameTagWidthWorld, NAME_TAG_HEIGHT_WORLD],
			color: WHITE_COLOR,
		};
	}

	update(): void {
		// Capsule position + rotation
		this.mesh.position.set(this.player.x, this.player.y, this.player.z);
		this.mesh.rotation.y = this.player.yaw * DEG_TO_RAD;

		// Name tag billboard (above head, always facing camera) — mutate the
		// scratch position in place instead of allocating a new options object
		// and new arrays every frame.
		this._pos[0] = this.player.x;
		this._pos[1] = this.player.y + NAME_TAG_Y_OFFSET;
		this._pos[2] = this.player.z;

		clearBillboardSprites(this.billboard);
		addBillboardSpriteIndex(this.billboard, this._billboardOpts);
	}

	dispose(): void {
		this.billboard.visible = false;
		clearBillboardSprites(this.billboard);
		removeFromScene(this.scene, this.mesh);
		const engine = (this.scene as any).surface?.engine;
		if (engine) {
			void onGpuWorkDone(engine).then(() => {
				disposeMeshGpu(this.mesh);
			});
		} else {
			disposeMeshGpu(this.mesh);
		}
		// Material is pooled/owned by RemotePlayerRenderer — not disposed here.
	}
}

export class RemotePlayerRenderer {
	// Flat, swap-remove array instead of a Map: iteration in `update()` is the
	// hot path (every frame, every remote player), while join/leave are rare —
	// so pay the O(1) index-lookup cost there and keep the frame loop a plain
	// array walk with no iterator allocation.
	private list: RemotePlayerVisual[] = [];
	private ids: string[] = [];
	private indexById = new Map<string, number>();

	// Up to 8 shared materials (one per palette color) instead of one per
	// player — color is purely a function of colorIndex, so players sharing
	// an index already rendered identically; this just stops re-creating
	// equivalent materials.
	private materialPool: (PlayerMaterial | null)[] = new Array(
		PLAYER_COLORS.length,
	).fill(null);

	// rebuildSceneRenderables is scene-wide, not per-mesh — batch it so N
	// players joining in one frame trigger one rebuild instead of N.
	private pendingFlush = false;

	private scene: SceneContext;
	private engine: EngineContext;

	constructor(engine: EngineContext, scene: SceneContext) {
		this.engine = engine;
		this.scene = scene;
	}

	private getMaterial(colorIndex: number): PlayerMaterial {
		let mat = this.materialPool[colorIndex];
		if (!mat) {
			mat = createStandardMaterial();
			mat.emissiveColor = PLAYER_COLORS[colorIndex];
			mat.disableLighting = true;
			this.materialPool[colorIndex] = mat;
		}
		return mat;
	}

	onPlayerJoin(player: RemotePlayer): void {
		if (this.indexById.has(player.sessionId)) return;

		const colorIndex = this.list.length % PLAYER_COLORS.length;
		const material = this.getMaterial(colorIndex);
		const visual = new RemotePlayerVisual(
			this.engine,
			this.scene,
			player,
			material,
		);

		this.indexById.set(player.sessionId, this.list.length);
		this.list.push(visual);
		this.ids.push(player.sessionId);
		this.pendingFlush = true;
	}

	onPlayerLeave(sessionId: string): void {
		const index = this.indexById.get(sessionId);
		if (index === undefined) return;

		this.list[index].dispose();

		// Swap-remove: move the last element into the freed slot.
		const lastIndex = this.list.length - 1;
		if (index !== lastIndex) {
			const movedVisual = this.list[lastIndex];
			const movedId = this.ids[lastIndex];
			this.list[index] = movedVisual;
			this.ids[index] = movedId;
			this.indexById.set(movedId, index);
		}
		this.list.pop();
		this.ids.pop();
		this.indexById.delete(sessionId);
		this.pendingFlush = true;
	}

	update(_camera: any, _screenW: number, _screenH: number): void {
		if (this.pendingFlush) {
			rebuildSceneRenderables(this.scene).catch(() => {});
			this.pendingFlush = false;
		}
		for (let i = 0; i < this.list.length; i++) {
			this.list[i].update();
		}
	}

	dispose(): void {
		for (let i = 0; i < this.list.length; i++) {
			this.list[i].dispose();
		}
		this.list.length = 0;
		this.ids.length = 0;
		this.indexById.clear();
		// Pooled materials outlive individual visuals; if @babylonjs/lite
		// exposes a material-disposal free function, call it per pool entry
		// here before clearing.
		this.materialPool.fill(null);
	}
}
