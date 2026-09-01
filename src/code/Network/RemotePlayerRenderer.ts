/**
 * RemotePlayerRenderer: visual representation of other players.
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
import {
	makeSprintEmitterState,
	playSprint,
	SPRINT_FEET_OFFSET,
	SPRINT_MIN_SPEED_SQ,
	type SprintEmitterState,
} from "@/code/Maps/BlockBreakParticles";
import { getLightByWorldCoords } from "@/code/World/Chunk/ChunkLoadingSystem";
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

// Flush billboard deferred builders that `addFacingBillboardSystem` registers.
// Lite only drains `_deferredBuilders` in `buildScene` (at `registerScene`);
// any system added after that (remote players) must be flushed manually —
// `rebuildSceneRenderables` does NOT handle them, which is why a new player
// stayed invisible until another system (e.g. a mob's `ensureInstancedGroupBuild`)
// forced a shader-group rebuild that also drained the queue.
async function flushDeferredBillboards(scene: SceneContext): Promise<void> {
	const ctx = scene as unknown as {
		_deferredBuilders?: Array<() => Promise<void>>;
		_renderables?: Array<{ order: number }>;
		_renderableVersion?: number;
		_materialEpoch?: number;
		_frameGraph?: { build(): void };
		_built?: boolean;
	};
	// Only needed after the scene is built; before that `registerScene` will drain.
	if (
		!ctx._built ||
		!ctx._deferredBuilders ||
		ctx._deferredBuilders.length === 0
	)
		return;
	const builders = ctx._deferredBuilders.splice(0);
	await Promise.all(builders.map((b) => b()));
	ctx._renderables?.sort((a, b) => a.order - b.order);
	if (ctx._renderableVersion !== undefined) ctx._renderableVersion++;
	if (ctx._materialEpoch !== undefined) ctx._materialEpoch++;
	ctx._frameGraph?.build();
}

const NAME_TAG_FONT_PX = 30;
const NAME_TAG_PADDING = 12;
export const NAME_TAG_HEIGHT_WORLD = 0.55;
export const NAME_TAG_Y_OFFSET = 1.5;
const NAME_TAG_TEX_HEIGHT = 64;
const NAME_TAG_MAX_TEX_WIDTH = 384;
const NAME_TAG_MIN_TEX_WIDTH = 32;
const NAME_TAG_FONT = "monospace";
const ELLIPSIS = "…";

const DEG_TO_RAD = Math.PI / 180;
const PITCH_BYTE_TO_RAD = (180 / 255) * DEG_TO_RAD;
const HALF_PI = Math.PI * 0.5;

const WHITE_COLOR: [number, number, number, number] = [1, 1, 1, 1];

const LIGHT_RESAMPLE_MS = 250;
const WALK_SAMPLE_MS = 40;

const WALK_SPEED_ZERO_EPS = 0.01;
const WALK_AMP_SNAP_EPS = 0.002;
const HEAD_PITCH_SNAP_EPS = 0.001;

const REMOTE_CULL_ENTER_DIST_SQ = 96 * 96;
const REMOTE_CULL_EXIT_DIST_SQ = 88 * 88;

const SKIN_SIZE = 64;
const SKIN_ROW_BYTES = SKIN_SIZE * 4;

let skinDecodeCtx: OffscreenCanvasRenderingContext2D | null = null;
const skinRowScratch = new Uint8Array(SKIN_ROW_BYTES);

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;

function getSkinDecodeContext(): OffscreenCanvasRenderingContext2D {
	let ctx = skinDecodeCtx;

	if (ctx !== null) {
		return ctx;
	}

	ctx = new OffscreenCanvas(SKIN_SIZE, SKIN_SIZE).getContext("2d");

	if (ctx === null) {
		throw new Error("Unable to create skin decoding canvas context");
	}

	ctx.imageSmoothingEnabled = false;
	skinDecodeCtx = ctx;
	return ctx;
}

function getMeasureCtx(): OffscreenCanvasRenderingContext2D {
	let ctx = measureCtx;

	if (ctx !== null) {
		return ctx;
	}

	ctx = new OffscreenCanvas(1, 1).getContext("2d");

	if (ctx === null) {
		throw new Error("Unable to create name-tag measurement context");
	}

	measureCtx = ctx;
	return ctx;
}

/**
 * Blob accepts ArrayBuffer-backed views directly.
 *
 * SharedArrayBuffer-backed views are copied because Blob implementations and
 * TypeScript's BlobPart declarations do not consistently accept them.
 */
function pngToBlobPart(png: Uint8Array): BlobPart {
	if (png.buffer instanceof ArrayBuffer) {
		return png as Uint8Array<ArrayBuffer>;
	}

	const bytes = new Uint8Array(png.byteLength);
	bytes.set(png);
	return bytes;
}

async function decodeSkinToTexture(
	engine: EngineContext,
	png: Uint8Array,
): Promise<Texture2D> {
	const blob = new Blob([pngToBlobPart(png)], { type: "image/png" });
	const bitmap = await createImageBitmap(blob);

	try {
		const ctx = getSkinDecodeContext();
		ctx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
		ctx.drawImage(bitmap, 0, 0, SKIN_SIZE, SKIN_SIZE);

		const imageData = ctx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE).data;

		const pixels = new Uint8Array(
			imageData.buffer,
			imageData.byteOffset,
			imageData.byteLength,
		);

		let topOffset = 0;
		let bottomOffset = (SKIN_SIZE - 1) * SKIN_ROW_BYTES;

		while (topOffset < bottomOffset) {
			skinRowScratch.set(
				pixels.subarray(topOffset, topOffset + SKIN_ROW_BYTES),
			);

			pixels.copyWithin(topOffset, bottomOffset, bottomOffset + SKIN_ROW_BYTES);

			pixels.set(skinRowScratch, bottomOffset);

			topOffset += SKIN_ROW_BYTES;
			bottomOffset -= SKIN_ROW_BYTES;
		}

		return createTexture2DFromPixels(engine, pixels, SKIN_SIZE, SKIN_SIZE);
	} finally {
		bitmap.close();
	}
}

function clampInt(value: number, min: number, max: number): number {
	const integer = Math.trunc(value);

	if (integer < min) {
		return min;
	}

	return integer > max ? max : integer;
}

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Adjust a UTF-16 index so substring(0, index) cannot end between the two
 * code units of a surrogate pair.
 */
function adjustCodePointBoundary(text: string, index: number): number {
	if (
		index > 0 &&
		index < text.length &&
		isHighSurrogate(text.charCodeAt(index - 1)) &&
		isLowSurrogate(text.charCodeAt(index))
	) {
		return index - 1;
	}

	return index;
}

/**
 * Finds the longest prefix fitting the available width.
 *
 * Unlike Array.from(text), this does not allocate an array containing every
 * code point. Each binary-search iteration allocates only the candidate string
 * required by CanvasRenderingContext2D.measureText.
 */
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

	let low = 0;
	let high = text.length;
	let bestEnd = 0;

	while (low <= high) {
		let middle = (low + high) >>> 1;
		middle = adjustCodePointBoundary(text, middle);

		const candidate = text.substring(0, middle) + ELLIPSIS;

		if (ctx.measureText(candidate).width <= maxTextWidthPx) {
			bestEnd = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	bestEnd = adjustCodePointBoundary(text, bestEnd);
	return text.substring(0, bestEnd) + ELLIPSIS;
}

export function rasteriseNameTag(
	name: string,
	scale = 0.575,
): {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
} {
	const safeName = name.length === 0 ? "Player" : name;
	const measurementContext = getMeasureCtx();

	const fontPx = NAME_TAG_FONT_PX * scale;
	const padding = NAME_TAG_PADDING * scale;
	const height = NAME_TAG_TEX_HEIGHT * scale;
	const maxWidth = NAME_TAG_MAX_TEX_WIDTH * scale;
	const minWidth = Math.max(1, NAME_TAG_MIN_TEX_WIDTH * scale);

	const font = `bold ${fontPx}px ${NAME_TAG_FONT}`;
	measurementContext.font = font;

	const displayName = fitTextWithEllipsis(
		measurementContext,
		safeName,
		maxWidth - padding * 2,
	);

	const width = clampInt(
		Math.ceil(measurementContext.measureText(displayName).width + padding * 2),
		minWidth,
		maxWidth,
	);

	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");

	if (ctx === null) {
		throw new Error("Unable to create name-tag rendering context");
	}

	ctx.font = font;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";

	const bandHeight = fontPx + 10 * scale;
	const bandY = Math.trunc((height - bandHeight) * 0.5);

	ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
	ctx.fillRect(0, bandY, width, bandHeight);

	ctx.fillStyle = "#ffffff";
	ctx.fillText(displayName, width * 0.5, height * 0.5);

	return { canvas, width, height };
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

	private lastLightX = Number.NaN;
	private lastLightY = Number.NaN;
	private lastLightZ = Number.NaN;
	private lastLightSampleMs = -Infinity;

	private walkPhase = 0;
	private walkAmp = 0;
	private smoothedSpeed = 0;
	private walkSampleX = Number.NaN;
	private walkSampleZ = Number.NaN;
	private walkSampleMs = Number.NaN;
	private sentWalkPhase = Number.NaN;
	private sentWalkAmp = Number.NaN;

	private headPitch = 0;
	private headPitchTarget = 0;
	private lastPitchByte = -1;

	private readonly billboardPosition: [number, number, number] = [0, 0, 0];

	private readonly sprintEmitter: SprintEmitterState = makeSprintEmitterState();

	private sprintPrevX = Number.NaN;
	private sprintPrevZ = Number.NaN;
	private sprintPrevMs = Number.NaN;

	private lastFlushMs = -Infinity;

	// Notification-driven refresh: skin / join events force a visual sync
	// without waiting for movement polling.
	private needsForcedRefresh = true;
	private needsBillboardSync = true;

	private readonly requestFlush: () => void;

	private readonly billboardOptions: {
		position: [number, number, number];
		sizeWorld: [number, number];
		color: [number, number, number, number];
	};

	private static readonly VISUAL_REFRESH_MS = 16;

	constructor(
		private readonly engine: EngineContext,
		private readonly scene: SceneContext,
		private readonly player: RemotePlayer,
		requestFlush?: () => void,
	) {
		this.requestFlush = requestFlush ?? (() => {});
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
		// Shader meshes added after `registerScene` are normally built via
		// `processMaterialSwaps` next frame, but if a `rebuildSceneRenderables`
		// is already in flight (`_runtimeBuilds.w`) that queue stalls. Force a
		// direct shader-group build like `MobInstancePool.ensureInstancedGroupBuild`
		// so the rig appears without needing a mob spawn to kick the group.
		{
			const bg = (
				this.mat as unknown as {
					_buildGroup?: (scene: unknown, meshes: unknown[]) => Promise<unknown>;
				}
			)._buildGroup;
			if (typeof bg === "function") {
				void bg(scene, [this.mesh]).catch(() => {});
			}
		}

		applyRigSkin(
			engine,
			this.mat,
			this.handleInitialSkinBound,
			this.isAlive,
			this.getSkinTexture,
		);

		const nameTag = rasteriseNameTag(player.name);
		const widthWorld = NAME_TAG_HEIGHT_WORLD * (nameTag.width / nameTag.height);

		this.tex = createDynamicTexture(engine, nameTag.width, nameTag.height, {
			magFilter: "nearest",
			minFilter: "nearest",
			srgb: true,
		});

		updateDynamicTexture(engine, this.tex, nameTag.canvas, {
			invertY: false,
		});

		this.atlas = createGridSpriteAtlas(this.tex, {
			cellWidthPx: nameTag.width,
			cellHeightPx: nameTag.height,
		});

		this.billboard = createFacingBillboardSystem(this.atlas, {
			capacity: 1,
			blendMode: billboardBlendAlpha,
		});

		addFacingBillboardSystem(scene, this.billboard);
		// Billboard systems are deferred builders, not shader groups.
		// `rebuildSceneRenderables` does not drain them — flush explicitly
		// like `BlockBreakParticles` does, otherwise the name tag stays
		// invisible until an unrelated `buildScene` (e.g. mob spawn) drains it.
		void flushDeferredBillboards(scene);

		this.billboardOptions = {
			position: this.billboardPosition,
			sizeWorld: [widthWorld, NAME_TAG_HEIGHT_WORLD],
			color: WHITE_COLOR,
		};
	}

	private readonly handleInitialSkinBound = (): void => {
		if (!this.alive) return;
		this.skinBound = true;
		// Notification: skin is ready — make mesh visible and force a billboard/
		// transform flush without waiting for position polling.
		if (!this.culled) {
			this.mesh.visible = true;
		}
		this.needsForcedRefresh = true;
		this.needsBillboardSync = true;
		this.requestFlush();
		this.syncBillboardIfNeeded(this.player.x, this.player.y, this.player.z);
	};

	private syncBillboardIfNeeded(x: number, y: number, z: number): void {
		if (!this.alive || this.culled || this.billboardActive) return;
		// If billboard not yet active (first join), create it immediately
		// so late joiners see the name tag without movement.
		const position = this.billboardPosition;
		position[0] = x;
		position[1] = y + NAME_TAG_Y_OFFSET;
		position[2] = z;
		clearBillboardSprites(this.billboard);
		addBillboardSpriteIndex(this.billboard, this.billboardOptions);
		this.billboardActive = true;
		this.needsBillboardSync = false;
	}

	private readonly isAlive = (): boolean => this.alive;

	private readonly getSkinTexture = (
		engine: EngineContext,
	): Promise<Texture2D> => {
		let promise = this.skinPromise;

		if (promise !== null) {
			return promise;
		}

		const png = this.player.skinPng;

		if (png !== undefined && png !== null) {
			promise = decodeSkinToTexture(engine, png);
		} else {
			promise = new Promise<Texture2D>((resolve) => {
				this.skinArrived = resolve;
			});
		}

		this.skinPromise = promise;
		return promise;
	};

	onSkinPng(png: Uint8Array): void {
		if (!this.alive) {
			return;
		}

		const pendingResolve = this.skinArrived;

		if (pendingResolve !== null) {
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
				if (!this.alive) return;
				setShaderTexture(this.mat, "diffuseTexture", texture);
				this.skinBound = true;
				// Notification: skin updated — force visibility/billboard sync
				if (!this.culled) {
					this.mesh.visible = true;
				}
				this.needsForcedRefresh = true;
				this.needsBillboardSync = true;
				this.requestFlush();
				this.syncBillboardIfNeeded(this.player.x, this.player.y, this.player.z);
			},
			() => {
				// Keep the currently bound texture when an update fails.
			},
		);
	}

	/** Notification hook — called when a player state batch changes position/yaw. */
	notifyStateChanged(): void {
		if (!this.alive) return;
		this.needsForcedRefresh = true;
	}

	private syncLight(now: number): void {
		const player = this.player;
		const sampleY = player.y + PLAYER_LIGHT_SAMPLE_Y_OFFSET;

		const lightX = Math.floor(player.x);
		const lightY = Math.floor(sampleY);
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

		const packedLight = getLightByWorldCoords(player.x, sampleY, player.z);

		setRigLightColor(this.mat, packedLightToLightColor(packedLight));
	}

	private syncWalk(now: number): void {
		const player = this.player;

		if (!Number.isFinite(this.walkSampleMs)) {
			this.walkSampleX = player.x;
			this.walkSampleZ = player.z;
			this.walkSampleMs = now;
			return;
		}

		const elapsedMs = now - this.walkSampleMs;

		if (elapsedMs < WALK_SAMPLE_MS) {
			return;
		}

		const dt = Math.min(elapsedMs * 0.001, 0.25);
		const dx = player.x - this.walkSampleX;
		const dz = player.z - this.walkSampleZ;
		const instantaneousSpeed = Math.sqrt(dx * dx + dz * dz) / dt;

		this.smoothedSpeed +=
			(instantaneousSpeed - this.smoothedSpeed) * Math.min(1, dt * 6);

		if (instantaneousSpeed === 0 && this.smoothedSpeed < WALK_SPEED_ZERO_EPS) {
			this.smoothedSpeed = 0;
		}

		this.walkSampleX = player.x;
		this.walkSampleZ = player.z;
		this.walkSampleMs = now;

		this.walkPhase += this.smoothedSpeed * dt * WALK_STRIDE_FACTOR;

		const targetAmp = Math.min(1, this.smoothedSpeed / WALK_REF_SPEED);

		this.walkAmp += (targetAmp - this.walkAmp) * Math.min(1, dt * 10);

		if (Math.abs(targetAmp - this.walkAmp) < WALK_AMP_SNAP_EPS) {
			this.walkAmp = targetAmp;
		}

		if (
			this.walkPhase === this.sentWalkPhase &&
			this.walkAmp === this.sentWalkAmp
		) {
			return;
		}

		this.sentWalkPhase = this.walkPhase;
		this.sentWalkAmp = this.walkAmp;
		setRigWalk(this.mat, this.walkPhase, this.walkAmp);
	}

	private syncHeadPitch(): void {
		const pitchByte = this.player.pitch;
		let target = this.headPitchTarget;

		if (pitchByte !== this.lastPitchByte) {
			this.lastPitchByte = pitchByte;
			target = HALF_PI - pitchByte * PITCH_BYTE_TO_RAD;
			this.headPitchTarget = target;
		}

		if (this.headPitch === target) {
			return;
		}

		const difference = target - this.headPitch;

		this.headPitch =
			Math.abs(difference) < HEAD_PITCH_SNAP_EPS
				? target
				: this.headPitch + difference * 0.2;

		setRigHeadPitch(this.mat, this.headPitch);
	}

	update(camX: number, camY: number, camZ: number, now: number): void {
		const player = this.player;
		const x = player.x;
		const y = player.y;
		const z = player.z;

		const cameraDx = x - camX;
		const cameraDy = y - camY;
		const cameraDz = z - camZ;

		const distanceSquared =
			cameraDx * cameraDx + cameraDy * cameraDy + cameraDz * cameraDz;

		let forceVisualRefresh = false;

		if (this.culled) {
			if (distanceSquared >= REMOTE_CULL_EXIT_DIST_SQ) {
				return;
			}

			this.culled = false;
			forceVisualRefresh = true;
			this.needsForcedRefresh = true;
			this.needsBillboardSync = true;
			if (this.skinBound) {
				this.mesh.visible = true;
			}
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

		if (Number.isFinite(this.sprintPrevMs)) {
			const dt = (now - this.sprintPrevMs) * 0.001;

			if (dt > 0) {
				const velocityX = (x - this.sprintPrevX) / dt;
				const velocityZ = (z - this.sprintPrevZ) / dt;

				if (
					velocityX * velocityX + velocityZ * velocityZ >=
					SPRINT_MIN_SPEED_SQ
				) {
					playSprint(
						this.sprintEmitter,
						x,
						y - SPRINT_FEET_OFFSET,
						z,
						velocityX,
						velocityZ,
					);
				}
			}
		}

		this.sprintPrevX = x;
		this.sprintPrevZ = z;
		this.sprintPrevMs = now;

		if (this.skinBound) {
			this.syncLight(now);
		}

		this.syncWalk(now);
		this.syncHeadPitch();

		// Visibility: primary path is notification-driven (handleInitialSkinBound /
		// onSkinPng) but keep a lightweight per-frame fallback so a missed
		// notification (e.g. skin bound while culled) still recovers without
		// requiring camera movement. This is not the "poll every frame for skin"
		// anti-pattern — it's a single boolean compare.
		{
			const desiredVisible = this.skinBound && !this.culled;
			if (this.mesh.visible !== desiredVisible) {
				this.mesh.visible = desiredVisible;
				if (desiredVisible) {
					this.needsForcedRefresh = true;
					this.needsBillboardSync = true;
				}
			}
		}

		const yaw = player.yaw;
		const positionChanged =
			x !== this.lastX || y !== this.lastY || z !== this.lastZ;
		const yawChanged = yaw !== this.lastYaw;

		const needsForced = this.needsForcedRefresh;
		const needsBillboard = this.needsBillboardSync;

		// If nothing changed and no notification forced a refresh, skip.
		if (
			!forceVisualRefresh &&
			!needsForced &&
			!needsBillboard &&
			!positionChanged &&
			!yawChanged
		) {
			return;
		}

		// Throttle transform flushes, but never throttle a notification-forced
		// billboard/visibility sync — those must appear immediately on join/skin.
		if (
			!forceVisualRefresh &&
			!needsForced &&
			!needsBillboard &&
			now - this.lastFlushMs < RemotePlayerVisual.VISUAL_REFRESH_MS
		) {
			return;
		}

		this.lastFlushMs = now;

		// Consume the forced flag — it bypasses position/yaw gating once.
		if (needsForced) {
			this.needsForcedRefresh = false;
		}

		if (forceVisualRefresh || needsForced || positionChanged) {
			this.lastX = x;
			this.lastY = y;
			this.lastZ = z;
			this.mesh.position.set(x, y, z);
		}

		if (forceVisualRefresh || needsForced || yawChanged) {
			this.lastYaw = yaw;
			this.mesh.rotation.y = yaw * DEG_TO_RAD;
		}

		if (
			forceVisualRefresh ||
			needsForced ||
			needsBillboard ||
			positionChanged ||
			!this.billboardActive
		) {
			const position = this.billboardPosition;
			position[0] = x;
			position[1] = y + NAME_TAG_Y_OFFSET;
			position[2] = z;

			clearBillboardSprites(this.billboard);
			addBillboardSpriteIndex(this.billboard, this.billboardOptions);
			this.billboardActive = true;
			this.needsBillboardSync = false;
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
		const disposeMesh = (): void => {
			disposeMeshGpu(mesh);
		};

		void onGpuWorkDone(this.engine).then(disposeMesh, disposeMesh);
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

	private readonly finishRenderableRebuild = (): void => {
		this.rebuildInFlight = false;
	};

	private flushSceneRenderablesIfNeeded(): void {
		if (this.disposed || !this.pendingFlush || this.rebuildInFlight) {
			return;
		}

		this.pendingFlush = false;
		this.rebuildInFlight = true;

		void rebuildSceneRenderables(this.scene).then(
			this.finishRenderableRebuild,
			this.finishRenderableRebuild,
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

		this.list.push(
			new RemotePlayerVisual(this.engine, this.scene, player, () =>
				this.requestSceneRenderableFlush(),
			),
		);
		this.ids.push(sessionId);
		this.indexById.set(sessionId, index);

		this.requestSceneRenderableFlush();
	}

	/** Notification hook — called when a PlayerStateBatch updates targets. */
	notifyPlayerStatesChanged(): void {
		if (this.disposed) return;
		for (let i = 0; i < this.list.length; i++) {
			this.list[i].notifyStateChanged();
		}
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

		const position = camera.position;
		const camX = position?.x ?? 0;
		const camY = position?.y ?? 0;
		const camZ = position?.z ?? 0;
		const now = performance.now();
		const list = this.list;

		for (let index = 0; index < list.length; index++) {
			list[index].update(camX, camY, camZ, now);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;

		const list = this.list;

		for (let index = 0; index < list.length; index++) {
			list[index].dispose();
		}

		list.length = 0;
		this.ids.length = 0;
		this.indexById.clear();
		this.pendingFlush = false;
	}
}
