/**
 * RemotePlayerRenderer — visual representation of other players.
 *
 * Creates capsule meshes for remote players + billboard name tags (Minecraft-style).
 * Uses DynamicTexture2D + OffscreenCanvas for reliable text rendering, and
 * FacingBillboardSpriteSystem for camera-facing sprites.
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
	type SpriteAtlas,
	updateDynamicTexture,
} from "@babylonjs/lite";
import type { RemotePlayer } from "./NetClient";

const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.3;

// Name tag sizing
const NAME_TAG_FONT_PX = 30;
const NAME_TAG_PADDING = 10;
const NAME_TAG_HEIGHT_WORLD = 0.55;
const NAME_TAG_Y_OFFSET = 1.5;
const NAME_TAG_TEX_HEIGHT = 64; // texture pixel height

// Color palette for different players
const PLAYER_COLORS: [number, number, number][] = [
	[0.2, 0.6, 1.0], // Blue
	[1.0, 0.4, 0.2], // Orange
	[0.2, 1.0, 0.4], // Green
	[1.0, 0.2, 0.6], // Pink
	[0.6, 0.2, 1.0], // Purple
	[1.0, 0.8, 0.2], // Yellow
	[0.2, 0.8, 1.0], // Cyan
	[0.8, 0.4, 0.1], // Brown
];

/**
 * Rasterise a player name onto an OffscreenCanvas with Minecraft-style
 * dark background + white text, then return the canvas and its measured
 * width/height in pixels.
 */
function rasteriseNameTag(name: string): {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
} {
	const canvas = new OffscreenCanvas(512, NAME_TAG_TEX_HEIGHT);
	const ctx = canvas.getContext("2d")!;

	// Measure text first to size the background
	ctx.font = `bold ${NAME_TAG_FONT_PX}px monospace`;
	const metrics = ctx.measureText(name);
	const textWidth = metrics.width;
	const bgWidth = Math.ceil(textWidth + NAME_TAG_PADDING * 2);
	const bgHeight = NAME_TAG_TEX_HEIGHT;

	// Clear to transparent
	ctx.clearRect(0, 0, canvas.width, bgHeight);

	// Draw dark background
	const bx = (canvas.width - bgWidth) / 2;
	const by = (bgHeight - NAME_TAG_FONT_PX - 4) / 2 - 2;
	ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
	ctx.fillRect(bx, by, bgWidth, NAME_TAG_FONT_PX + 8);

	// Draw white text, centred
	ctx.fillStyle = "#ffffff";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(name, canvas.width / 2, bgHeight / 2);

	return { canvas, width: canvas.width, height: bgHeight };
}

export class RemotePlayerVisual {
	readonly mesh: Mesh;
	private tex: DynamicTexture2D;
	private atlas: SpriteAtlas;
	private billboard: FacingBillboardSpriteSystem;
	private _nameTagWidthWorld: number;
	private _flushed = false;

	constructor(
		private engine: EngineContext,
		private scene: SceneContext,
		private player: RemotePlayer,
		colorIndex: number,
	) {
		// Player capsule
		this.mesh = createCapsule(engine, {
			height: PLAYER_HEIGHT,
			radius: PLAYER_RADIUS,
		});
		const color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
		const mat = createStandardMaterial();
		mat.emissiveColor = color;
		mat.disableLighting = true;
		this.mesh.material = mat;
		this.mesh.pickable = false;
		addToScene(this.scene, this.mesh);

		// Rasterise name tag to a canvas
		const { canvas, width: texW, height: texH } = rasteriseNameTag(player.name);

		// Compute world-space billboard width to preserve aspect ratio
		this._nameTagWidthWorld = NAME_TAG_HEIGHT_WORLD * (texW / texH);

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
	}

	/**
	 * Flush the deferred renderable on first update — must happen after the
	 * scene is registered. Doing it here (instead of the constructor) avoids
	 * the async-in-sync problem.
	 */
	private flushIfNeeded(): void {
		if (this._flushed) return;
		this._flushed = true;
		rebuildSceneRenderables(this.scene).catch(() => {});
	}

	update(_camera: any, _screenW: number, _screenH: number): void {
		this.flushIfNeeded();

		// Capsule position + rotation
		this.mesh.position.set(this.player.x, this.player.y, this.player.z);
		this.mesh.rotation.y = (this.player.yaw * Math.PI) / 180;

		// Name tag billboard (above head, always facing camera)
		clearBillboardSprites(this.billboard);
		addBillboardSpriteIndex(this.billboard, {
			position: [
				this.player.x,
				this.player.y + NAME_TAG_Y_OFFSET,
				this.player.z,
			],
			sizeWorld: [this._nameTagWidthWorld, NAME_TAG_HEIGHT_WORLD],
			color: [1, 1, 1, 1],
		});
	}

	dispose(): void {
		this.billboard.visible = false;
		clearBillboardSprites(this.billboard);
		disposeMeshGpu(this.mesh);
	}
}

export class RemotePlayerRenderer {
	private visuals = new Map<string, RemotePlayerVisual>();
	private scene: SceneContext;
	private engine: EngineContext;

	constructor(engine: EngineContext, scene: SceneContext) {
		this.engine = engine;
		this.scene = scene;
	}

	onPlayerJoin(player: RemotePlayer): void {
		if (this.visuals.has(player.sessionId)) return;
		const colorIndex = this.visuals.size % PLAYER_COLORS.length;
		const visual = new RemotePlayerVisual(
			this.engine,
			this.scene,
			player,
			colorIndex,
		);
		this.visuals.set(player.sessionId, visual);
	}

	onPlayerLeave(sessionId: string): void {
		const visual = this.visuals.get(sessionId);
		if (visual) {
			visual.dispose();
			this.visuals.delete(sessionId);
		}
	}

	update(camera: any, screenW: number, screenH: number): void {
		for (const visual of this.visuals.values()) {
			visual.update(camera, screenW, screenH);
		}
	}

	dispose(): void {
		for (const visual of this.visuals.values()) {
			visual.dispose();
		}
		this.visuals.clear();
	}
}
