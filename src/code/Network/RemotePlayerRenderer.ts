/**
 * RemotePlayerRenderer — visual representation of other players.
 *
 * Creates Minecraft-style player rigs for remote players with server-synced
 * skin PNGs and camera-facing Minecraft-style name tags.
 */
import type {
	EngineContext,
	FreeCamera,
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
import {
	makeSprintEmitterState,
	playSprint,
	type SprintEmitterState,
	SPRINT_FEET_OFFSET,
	SPRINT_MIN_SPEED_SQ,
} from "@/code/Maps/BlockBreakParticles";
import { onGpuWorkDone } from "@/code/World/Light/liteGpuBuffer.js";
import {
	applyRigSkin,
	createPlayerRigMesh,
	createRigShaderMaterial,
	getRigFallbackTexture,
	PLAYER_LIGHT_SAMPLE_Y_OFFSET,
	packedLightToLightColor,
	setRigHeadPitch,
	setRigLightColor,
	setRigWalk,
	WALK_REF_SPEED,
	WALK_STRIDE_FACTOR,
} from "../Player/PlayerModel";
import type { RemotePlayer } from "./NetClient";

const NAME_TAG_FONT_PX = 30;
const NAME_TAG_PADDING = 12;
const NAME_TAG_HEIGHT_WORLD = 0.55;
const NAME_TAG_Y_OFFSET = 1.5;
const NAME_TAG_TEX_HEIGHT = 64;
const NAME_TAG_MAX_TEX_WIDTH = 384;
const NAME_TAG_MIN_TEX_WIDTH = 32;
const NAME_TAG_FONT = "monospace";
const ELLIPSIS = "…";

const DEG_TO_RAD = Math.PI / 180;

const WHITE_COLOR: [number, number, number, number] = [1, 1, 1, 1];

const LIGHT_RESAMPLE_MS = 250;

// Walk-speed sampling window for inferred remote animation.
const WALK_SAMPLE_MS = 40;

const REMOTE_CULL_ENTER_DIST_SQ = 96 * 96;
const REMOTE_CULL_EXIT_DIST_SQ = 88 * 88;

async function decodeSkinToTexture(
	engine: EngineContext,
	png: Uint8Array,
): Promise<Texture2D> {
	// Blob does not reliably accept SharedArrayBuffer-backed typed arrays.
	const bytes = new Uint8Array(png.byteLength);
	bytes.set(png);

	const blob = new Blob([bytes], { type: "image/png" });
	const bitmap = await createImageBitmap(blob);

	try {
		const canvas = new OffscreenCanvas(64, 64);
		const ctx = canvas.getContext("2d");

		if (!ctx) {
			throw new Error("Unable to create skin decoding canvas context");
		}

		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(bitmap, 0, 0, 64, 64);

		const src = ctx.getImageData(0, 0, 64, 64).data;
		const rowBytes = 64 * 4;
		const flipped = new Uint8Array(src.length);

		for (let dstY = 0, srcY = 63; dstY < 64; dstY++, srcY--) {
			const srcOffset = srcY * rowBytes;
			flipped.set(
				src.subarray(srcOffset, srcOffset + rowBytes),
				dstY * rowBytes,
			);
		}

		return createTexture2DFromPixels(engine, flipped, 64, 64);
	} finally {
		bitmap.close();
	}
}

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

function getMeasureCtx(): OffscreenCanvasRenderingContext2D {
	if (measureCtx) {
		return measureCtx;
	}

	const ctx = new OffscreenCanvas(1, 1).getContext("2d");

	if (!ctx) {
		throw new Error("Unable to create name-tag measurement context");
	}

	measureCtx = ctx;
	return ctx;
}

function clampInt(value: number, min: number, max: number): number {
	const intValue = Math.trunc(value);

	if (intValue < min) {
		return min;
	}

	if (intValue > max) {
		return max;
	}

	return intValue;
}

function fitTextWithEllipsis(
	ctx: OffscreenCanvasRenderingContext2D,
	text: string,
	maxTextWidthPx: number,
): string {
	if (ctx.measureText(text).width <= maxTextWidthPx) {
		return text;
	}

	if (ctx.measureText(ELLIPSIS).width >= maxTextWidthPx) {
		return ELLIPSIS;
	}

	/*
	 * Array.from splits by Unicode code points instead of UTF-16 code units.
	 * This avoids cutting a surrogate pair in half for names containing emoji
	 * or supplementary-plane characters.
	 *
	 * This allocation occurs only when an oversized name tag is created.
	 */
	const codePoints = Array.from(text);

	let low = 0;
	let high = codePoints.length;
	let best = ELLIPSIS;

	while (low <= high) {
		const middle = (low + high) >>> 1;
		const candidate = codePoints.slice(0, middle).join("") + ELLIPSIS;

		if (ctx.measureText(candidate).width <= maxTextWidthPx) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return best;
}

function rasteriseNameTag(name: string): {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
} {
	const safeName = name.length > 0 ? name : "Player";
	const measurementContext = getMeasureCtx();

	measurementContext.font = `bold ${NAME_TAG_FONT_PX}px ${NAME_TAG_FONT}`;

	const maxTextWidth = NAME_TAG_MAX_TEX_WIDTH - NAME_TAG_PADDING * 2;

	const displayName = fitTextWithEllipsis(
		measurementContext,
		safeName,
		maxTextWidth,
	);

	const textWidth = measurementContext.measureText(displayName).width;

	const width = clampInt(
		Math.ceil(textWidth + NAME_TAG_PADDING * 2),
		NAME_TAG_MIN_TEX_WIDTH,
		NAME_TAG_MAX_TEX_WIDTH,
	);

	const height = NAME_TAG_TEX_HEIGHT;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");

	if (!ctx) {
		throw new Error("Unable to create name-tag rendering context");
	}

	ctx.font = measurementContext.font;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";

	const bandHeight = NAME_TAG_FONT_PX + 10;
	const bandY = Math.trunc((height - bandHeight) * 0.5);

	ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
	ctx.fillRect(0, bandY, width, bandHeight);

	ctx.fillStyle = "#ffffff";
	ctx.fillText(displayName, width * 0.5, height * 0.5);

	return {
		canvas,
		width,
		height,
	};
}

export class RemotePlayerVisual {
	readonly mesh: Mesh;

	private readonly mat: ReturnType<typeof createRigShaderMaterial>;
	private readonly tex: DynamicTexture2D;
	private readonly atlas: SpriteAtlas;
	private readonly billboard: FacingBillboardSpriteSystem;

	private skinPromise: Promise<Texture2D> | null = null;
	private skinArrived: ((texture: Texture2D) => void) | null = null;
	private skinBound = false;
	private alive = true;

	private culled = false;
	private billboardActive = false;

	private lastX = Number.NaN;
	private lastY = Number.NaN;
	private lastZ = Number.NaN;
	private lastYaw = Number.NaN;

	private lastTargetX = Number.NaN;
	private lastTargetY = Number.NaN;
	private lastTargetZ = Number.NaN;
	private lastTargetYaw = Number.NaN;

	private lastLightX = Number.NaN;
	private lastLightY = Number.NaN;
	private lastLightZ = Number.NaN;
	private lastLightSampleMs = -Infinity;

	// Walk-swing state, driven by speed inferred from interpolated positions.
	private walkPhase = 0;
	private walkAmp = 0;
	private smoothedSpeed = 0;
	private walkSampleX = Number.NaN;
	private walkSampleZ = Number.NaN;
	private walkSampleMs = Number.NaN;
	// Head pitch eased toward the server's pitch byte each frame.
	private headPitch = 0;

	private readonly positionScratch: [number, number, number] = [0, 0, 0];

	// Sprint-dust emission, derived entirely from locally-interpolated motion
	// (no server sprint flag is transmitted). Each remote player keeps its own
	// throttle state and a per-frame position sample to estimate velocity.
	private readonly sprintEmitter: SprintEmitterState = makeSprintEmitterState();
	private sprintPrevX = Number.NaN;
	private sprintPrevZ = Number.NaN;
	private sprintPrevMs = Number.NaN;

	private lastFlushMs = -Infinity;

	private static readonly VISUAL_REFRESH_MS = 16;

	private readonly billboardOptions: {
		position: [number, number, number];
		sizeWorld: [number, number];
		color: [number, number, number, number];
	};

	constructor(
		private readonly engine: EngineContext,
		private readonly scene: SceneContext,
		private readonly player: RemotePlayer,
	) {
		this.mesh = createPlayerRigMesh(
			engine,
			`remoteRig_${player.sessionId.slice(0, 8)}`,
			"center",
		);

		this.mat = createRigShaderMaterial("remoteRigMat");
		this.mesh.material = this.mat;
		this.mesh.pickable = false;
		this.mesh.visible = false;

		addToScene(scene, this.mesh);

		applyRigSkin(
			engine,
			this.mat,
			() => {
				if (this.alive) {
					this.skinBound = true;
				}
			},
			() => this.alive,
			(currentEngine) => this.getSkinTexture(currentEngine),
		);

		const {
			canvas,
			width: textureWidth,
			height: textureHeight,
		} = rasteriseNameTag(player.name);

		const nameTagWidthWorld =
			NAME_TAG_HEIGHT_WORLD * (textureWidth / textureHeight);

		this.tex = createDynamicTexture(engine, textureWidth, textureHeight, {
			magFilter: "linear",
			minFilter: "linear",
			srgb: true,
		});

		updateDynamicTexture(engine, this.tex, canvas, {
			invertY: false,
		});

		this.atlas = createGridSpriteAtlas(this.tex, {
			cellWidthPx: textureWidth,
			cellHeightPx: textureHeight,
		});

		this.billboard = createFacingBillboardSystem(this.atlas, {
			capacity: 1,
			blendMode: billboardBlendAlpha,
		});

		addFacingBillboardSystem(scene, this.billboard);

		this.billboardOptions = {
			position: this.positionScratch,
			sizeWorld: [nameTagWidthWorld, NAME_TAG_HEIGHT_WORLD],
			color: WHITE_COLOR,
		};
	}

	private getSkinTexture(engine: EngineContext): Promise<Texture2D> {
		if (this.skinPromise) {
			return this.skinPromise;
		}

		const existingPng = this.player.skinPng;

		if (existingPng) {
			this.skinPromise = decodeSkinToTexture(engine, existingPng);
		} else {
			this.skinPromise = new Promise<Texture2D>((resolve) => {
				this.skinArrived = resolve;
			});
		}

		return this.skinPromise;
	}

	/** Called when the server delivers this player's skin PNG. */
	onSkinPng(png: Uint8Array): void {
		if (!this.alive) {
			return;
		}

		const pendingResolve = this.skinArrived;

		if (pendingResolve) {
			this.skinArrived = null;

			void decodeSkinToTexture(this.engine, png).then(
				(texture) => {
					if (this.alive) {
						pendingResolve(texture);
					}
				},
				() => {
					if (this.alive) {
						pendingResolve(getRigFallbackTexture(this.engine));
					}
				},
			);

			return;
		}

		void decodeSkinToTexture(this.engine, png).then(
			(texture) => {
				if (!this.alive) {
					return;
				}

				setShaderTexture(this.mat, "diffuseTexture", texture);
				this.skinBound = true;
			},
			() => {
				// Preserve the currently bound texture on update failure.
			},
		);
	}

	private syncLight(now: number): void {
		const player = this.player;

		const lightX = Math.floor(player.x);
		const lightY = Math.floor(player.y + PLAYER_LIGHT_SAMPLE_Y_OFFSET);
		const lightZ = Math.floor(player.z);

		if (
			lightX === this.lastLightX &&
			lightY === this.lastLightY &&
			lightZ === this.lastLightZ &&
			now - this.lastLightSampleMs < LIGHT_RESAMPLE_MS
		) {
			return;
		}

		this.lastLightX = lightX;
		this.lastLightY = lightY;
		this.lastLightZ = lightZ;
		this.lastLightSampleMs = now;

		const packedLight = getLightByWorldCoords(
			player.x,
			player.y + PLAYER_LIGHT_SAMPLE_Y_OFFSET,
			player.z,
		);

		setRigLightColor(this.mat, packedLightToLightColor(packedLight));
	}

	/**
	 * Advance the walk swing from speed inferred from interpolated positions.
	 * Sampled on a short window so per-frame jitter doesn't feed the easing.
	 */
	private syncWalk(now: number): void {
		const p = this.player;

		// First sample after spawn/cull: record the baseline — there is no
		// previous position to measure speed against yet.
		if (!Number.isFinite(this.walkSampleMs)) {
			this.walkSampleX = p.x;
			this.walkSampleZ = p.z;
			this.walkSampleMs = now;
			return;
		}

		const dtMs = now - this.walkSampleMs;
		if (dtMs < WALK_SAMPLE_MS) return;

		const dt = Math.min(dtMs / 1000, 0.25); // clamp: tab-switch / cull gaps
		const instSpeed =
			Math.hypot(p.x - this.walkSampleX, p.z - this.walkSampleZ) / dt;
		this.smoothedSpeed +=
			(instSpeed - this.smoothedSpeed) * Math.min(1, dt * 6);

		this.walkSampleX = p.x;
		this.walkSampleZ = p.z;
		this.walkSampleMs = now;

		this.walkPhase += this.smoothedSpeed * dt * WALK_STRIDE_FACTOR;
		const targetAmp = Math.min(1, this.smoothedSpeed / WALK_REF_SPEED);
		this.walkAmp += (targetAmp - this.walkAmp) * Math.min(1, dt * 10);
		setRigWalk(this.mat, this.walkPhase, this.walkAmp);
	}

	/** Ease the head toward the server pitch byte (0-255 → -90°..+90°). */
	private syncHeadPitch(): void {
		// Network convention is negative-looks-down; the rig shader expects
		// the camera convention (positive = down), so invert the decode.
		const target = -(this.player.pitch * (180 / 255) - 90) * DEG_TO_RAD;
		this.headPitch += (target - this.headPitch) * 0.2;
		setRigHeadPitch(this.mat, this.headPitch);
	}

	update(camX: number, camY: number, camZ: number, now: number): void {
		const player = this.player;

		const x = player.x;
		const y = player.y;
		const z = player.z;

		const dx = x - camX;
		const dy = y - camY;
		const dz = z - camZ;
		const distanceSquared = dx * dx + dy * dy + dz * dz;

		let forceVisualRefresh = false;

		if (this.culled) {
			if (distanceSquared >= REMOTE_CULL_EXIT_DIST_SQ) {
				return;
			}

			this.culled = false;
			forceVisualRefresh = true;

			/*
			 * Establish a fresh walk baseline after unculling. Without this reset,
			 * movement that occurred while culled could create a one-frame spike.
			 */
			this.walkSampleMs = Number.NaN;
			this.sprintPrevMs = Number.NaN;
		} else if (distanceSquared >= REMOTE_CULL_ENTER_DIST_SQ) {
			this.culled = true;
			this.mesh.visible = false;
			this.walkSampleMs = Number.NaN;
			this.sprintPrevMs = Number.NaN;

			if (this.billboardActive) {
				clearBillboardSprites(this.billboard);
				this.billboardActive = false;
			}

			return;
		}

		/*
		 * These systems must continue updating for stationary visible players:
		 *
		 * - light can change without the player moving;
		 * - walk amplitude needs to ease back to zero;
		 * - head pitch can change independently of position and yaw.
		 */

		// Sprint dust is inferred purely from interpolated motion: when the
		// player's horizontal speed clears the sprint gate, kick up ground dust
		// behind them. No sprint flag is transmitted — we have the position
		// stream and that is everything we need.
		if (Number.isFinite(this.sprintPrevMs)) {
			const dt = (now - this.sprintPrevMs) / 1000;
			if (dt > 0) {
				const velX = (x - this.sprintPrevX) / dt;
				const velZ = (z - this.sprintPrevZ) / dt;
				if (velX * velX + velZ * velZ >= SPRINT_MIN_SPEED_SQ) {
					playSprint(
						this.sprintEmitter,
						x,
						y - SPRINT_FEET_OFFSET,
						z,
						velX,
						velZ,
					);
				}
			}
		}
		this.sprintPrevX = x;
		this.sprintPrevZ = z;
		this.sprintPrevMs = now;

		this.syncLight(now);
		this.syncWalk(now);
		this.syncHeadPitch();

		this.mesh.visible = this.skinBound;

		const yaw = player.yaw;

		const positionChanged =
			x !== this.lastX || y !== this.lastY || z !== this.lastZ;

		const yawChanged = yaw !== this.lastYaw;

		/*
		 * Target changes do not directly alter either renderable. However, retain
		 * their cached values so existing interpolation/debug assumptions remain
		 * observable and no stale comparison state accumulates.
		 */
		const targetX = player.targetX;
		const targetY = player.targetY;
		const targetZ = player.targetZ;
		const targetYaw = player.targetYaw;

		const targetChanged =
			targetX !== this.lastTargetX ||
			targetY !== this.lastTargetY ||
			targetZ !== this.lastTargetZ ||
			targetYaw !== this.lastTargetYaw;

		if (targetChanged) {
			this.lastTargetX = targetX;
			this.lastTargetY = targetY;
			this.lastTargetZ = targetZ;
			this.lastTargetYaw = targetYaw;
		}

		if (!forceVisualRefresh && !positionChanged && !yawChanged) {
			return;
		}

		/*
		 * Preserve the original refresh throttle for ordinary interpolated
		 * movement. An uncull bypasses it because both renderables must be
		 * restored immediately.
		 */
		if (
			!forceVisualRefresh &&
			now - this.lastFlushMs < RemotePlayerVisual.VISUAL_REFRESH_MS
		) {
			return;
		}

		this.lastFlushMs = now;

		/*
		 * Update only the mesh properties that actually changed. Babylon-style
		 * observable vectors can mark transforms dirty on every setter call, so
		 * avoiding unchanged writes reduces downstream matrix work.
		 */
		if (forceVisualRefresh || positionChanged) {
			this.lastX = x;
			this.lastY = y;
			this.lastZ = z;
			this.mesh.position.set(x, y, z);
		}

		if (forceVisualRefresh || yawChanged) {
			this.lastYaw = yaw;
			this.mesh.rotation.y = yaw * DEG_TO_RAD;
		}

		/*
		 * The name tag depends only on position. Do not clear and recreate it for
		 * yaw-only or interpolation-target-only updates.
		 */
		if (forceVisualRefresh || positionChanged || !this.billboardActive) {
			const billboardPosition = this.positionScratch;
			billboardPosition[0] = x;
			billboardPosition[1] = y + NAME_TAG_Y_OFFSET;
			billboardPosition[2] = z;

			clearBillboardSprites(this.billboard);
			addBillboardSpriteIndex(this.billboard, this.billboardOptions);
			this.billboardActive = true;
		}
	}

	dispose(): void {
		if (!this.alive) {
			return;
		}

		this.alive = false;
		this.skinArrived = null;

		this.mesh.visible = false;
		this.billboard.visible = false;

		if (this.billboardActive) {
			clearBillboardSprites(this.billboard);
			this.billboardActive = false;
		}

		removeFromScene(this.scene, this.mesh);

		const mesh = this.mesh;

		void onGpuWorkDone(this.engine).then(
			() => {
				disposeMeshGpu(mesh);
			},
			() => {
				disposeMeshGpu(mesh);
			},
		);

		/*
		 * Explicit billboard, atlas, dynamic-texture, material, and decoded-skin
		 * cleanup should be added here if @babylonjs/lite exposes matching
		 * disposal APIs.
		 */
	}
}

export class RemotePlayerRenderer {
	private readonly list: RemotePlayerVisual[] = [];
	private readonly ids: string[] = [];
	private readonly indexById = new Map<string, number>();

	private pendingFlush = false;
	private rebuildInFlight = false;
	private disposed = false;

	constructor(
		private readonly engine: EngineContext,
		private readonly scene: SceneContext,
	) {}

	private requestSceneRenderableFlush(): void {
		if (!this.disposed) {
			this.pendingFlush = true;
		}
	}

	private flushSceneRenderablesIfNeeded(): void {
		if (this.disposed || !this.pendingFlush || this.rebuildInFlight) {
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
		if (this.disposed) {
			return;
		}

		const sessionId = player.sessionId;

		if (this.indexById.has(sessionId)) {
			return;
		}

		const index = this.list.length;
		const visual = new RemotePlayerVisual(this.engine, this.scene, player);

		this.list.push(visual);
		this.ids.push(sessionId);
		this.indexById.set(sessionId, index);

		this.requestSceneRenderableFlush();
	}

	onPlayerSkin(sessionId: string, png: Uint8Array): void {
		if (this.disposed) {
			return;
		}

		const index = this.indexById.get(sessionId);

		if (index !== undefined) {
			this.list[index].onSkinPng(png);
		}
	}

	onPlayerLeave(sessionId: string): void {
		if (this.disposed) {
			return;
		}

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

	update(camera: FreeCamera, _screenW: number, _screenH: number): void {
		if (this.disposed) {
			return;
		}

		this.flushSceneRenderablesIfNeeded();

		const cameraPosition = camera?.position;
		const camX = cameraPosition?.x ?? 0;
		const camY = cameraPosition?.y ?? 0;
		const camZ = cameraPosition?.z ?? 0;

		/*
		 * Read performance.now once for the whole renderer rather than once or
		 * twice per remote player.
		 */
		const now = performance.now();
		const list = this.list;

		for (let index = 0, count = list.length; index < count; index++) {
			list[index].update(camX, camY, camZ, now);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;

		const list = this.list;

		for (let index = 0, count = list.length; index < count; index++) {
			list[index].dispose();
		}

		list.length = 0;
		this.ids.length = 0;
		this.indexById.clear();

		this.pendingFlush = false;
	}
}
