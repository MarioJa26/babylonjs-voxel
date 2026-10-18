import type { SceneContext, Vec3 } from "@babylonjs/lite";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import {
	getLiquidDefinitionByBlockId,
	getLiquidLevel,
	type LiquidDefinition,
	WATER_LIQUID,
} from "../World/Liquid/LiquidRegistry";

export interface EyeCamera {
	position: Vec3;
}

const OVERLAY_TRANSITION_MS = 250;
const OVERLAY_HIDE_DELAY_MS = OVERLAY_TRANSITION_MS + 10;
const UNDERWATER_CACHE_VALID_MS = 250;

const UNDERWATER_STYLE_ID = "underwater-overlay-style";
const UNDERWATER_ANIMATION_NAME = "underwaterCaustics";

let underwaterStyleReferenceCount = 0;

/** Builds the three-lobe shimmer layer from a liquid's registry colors. */
function buildShimmerBackgroundImage(
	colors: readonly [string, string, string],
): string {
	return (
		"radial-gradient(" +
		`circle at 20% 30%, ${colors[0]} 0%, transparent 18%` +
		")," +
		"radial-gradient(" +
		`circle at 70% 60%, ${colors[1]} 0%, transparent 20%` +
		")," +
		"radial-gradient(" +
		`circle at 45% 80%, ${colors[2]} 0%, transparent 16%` +
		")"
	);
}

function acquireUnderwaterStyle(): void {
	underwaterStyleReferenceCount++;

	if (document.getElementById(UNDERWATER_STYLE_ID)) {
		return;
	}

	const style = document.createElement("style");
	style.id = UNDERWATER_STYLE_ID;
	style.textContent = `
        @keyframes ${UNDERWATER_ANIMATION_NAME} {
            0% {
                background-position: 0% 0%, 0% 0%, 0% 0%;
            }
            50% {
                background-position: 30% 40%, -25% 20%, 15% -30%;
            }
            100% {
                background-position: 0% 0%, 0% 0%, 0% 0%;
            }
        }
    `;

	document.head.appendChild(style);
}

function releaseUnderwaterStyle(): void {
	if (underwaterStyleReferenceCount > 0) {
		underwaterStyleReferenceCount--;
	}

	if (underwaterStyleReferenceCount !== 0) {
		return;
	}

	document.getElementById(UNDERWATER_STYLE_ID)?.remove();
}

// Babylon Lite WebGPU does not expose the traditional post-process pipeline,
// so the underwater effect is implemented as a full-screen HTML overlay.
export class UnderWaterEffect {
	public material: object | null = null;
	public postProcess: object | null = null;

	private readonly scene: SceneContext;
	private readonly camera: EyeCamera;

	private liquid: LiquidDefinition | null = null;
	private wasLiquid: LiquidDefinition | null = null;
	private overlay: HTMLDivElement | null = null;
	private shimmer: HTMLDivElement | null = null;
	private hideTimer: number | null = null;
	private styleAcquired = false;
	private disposed = false;

	constructor(scene: SceneContext, camera: EyeCamera, baseTexture: unknown) {
		this.scene = scene;
		this.camera = camera;

		// Retained for API compatibility with the previous implementation.
		void baseTexture;

		this.#buildOverlay();
	}

	#buildOverlay(): void {
		if (typeof document === "undefined") {
			return;
		}

		acquireUnderwaterStyle();
		this.styleAcquired = true;

		const overlay = document.createElement("div");
		overlay.id = "underwater-overlay";
		overlay.style.position = "fixed";
		overlay.style.inset = "0";
		overlay.style.pointerEvents = "none";
		overlay.style.zIndex = "50";
		overlay.style.display = "none";
		overlay.style.opacity = "0";
		overlay.style.transition = `opacity ${OVERLAY_TRANSITION_MS}ms ease`;
		overlay.style.background = WATER_LIQUID.overlayCss;

		const shimmer = document.createElement("div");
		shimmer.style.position = "absolute";
		shimmer.style.inset = "0";
		shimmer.style.backgroundImage = buildShimmerBackgroundImage(
			WATER_LIQUID.shimmerCss,
		);
		shimmer.style.backgroundSize = "60% 60%, 50% 50%, 70% 70%";
		shimmer.style.animation = `${UNDERWATER_ANIMATION_NAME} 6s linear infinite`;

		overlay.appendChild(shimmer);
		document.body.appendChild(overlay);

		this.overlay = overlay;
		this.shimmer = shimmer;

		const disposableScene = this.scene as unknown as {
			onDisposeObservable?: {
				addOnce?: (callback: () => void) => void;
			};
		};

		disposableScene.onDisposeObservable?.addOnce?.(() => {
			this.dispose();
		});
	}

	/** True when the player's eyes are currently below the water surface. */
	public get isUnderwaterState(): boolean {
		return this.liquid === WATER_LIQUID;
	}

	/**
	 * Re-evaluates the eye's liquid state from the camera eye position.
	 * Returns true while the eye is inside any liquid, for consumers such as
	 * fog handling.
	 */
	public updateFromCamera(): boolean {
		if (this.disposed) {
			return false;
		}

		const { x, y, z } = this.camera.position;
		const nextLiquid = getEyeLiquid(x, y, z);

		this.liquid = nextLiquid;

		if (nextLiquid !== this.wasLiquid) {
			this.wasLiquid = nextLiquid;
			this.#applyOverlay();
		}

		return nextLiquid !== null;
	}

	#applyOverlay(): void {
		const overlay = this.overlay;
		if (!overlay) {
			return;
		}

		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}

		const liquid = this.liquid;

		if (liquid !== null) {
			overlay.style.background = liquid.overlayCss;

			if (this.shimmer) {
				this.shimmer.style.backgroundImage = buildShimmerBackgroundImage(
					liquid.shimmerCss,
				);
			}

			overlay.style.display = "block";

			// Reading offsetWidth makes the browser commit display:block before
			// changing opacity, ensuring the fade-in transition starts.
			void overlay.offsetWidth;
			overlay.style.opacity = "1";
			return;
		}

		overlay.style.opacity = "0";

		this.hideTimer = window.setTimeout(() => {
			this.hideTimer = null;

			if (!this.disposed && this.liquid === null && this.overlay) {
				this.overlay.style.display = "none";
			}
		}, OVERLAY_HIDE_DELAY_MS);
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.material = null;
		this.postProcess = null;
		this.liquid = null;
		this.wasLiquid = null;

		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}

		this.overlay?.remove();
		this.overlay = null;
		this.shimmer = null;

		if (this.styleAcquired) {
			this.styleAcquired = false;
			releaseUnderwaterStyle();
		}
	}
}

// The cache primarily eliminates the duplicate calls made by the overlay and
// fog systems for the same eye position. Exact coordinates are deliberately
// used because crossing a partial-liquid surface can happen within one voxel.
let underwaterCacheEyeX = NaN;
let underwaterCacheEyeY = NaN;
let underwaterCacheEyeZ = NaN;
let underwaterCacheLiquid: LiquidDefinition | null = null;
let underwaterCacheTimestamp = 0;

/**
 * Liquid definition the supplied eye position is inside (below the local
 * surface, including partially filled flowing blocks), or null when the eye
 * is in air.
 */
export function getEyeLiquid(
	eyeX: number,
	eyeY: number,
	eyeZ: number,
): LiquidDefinition | null {
	// Compare coordinates first. This avoids calling performance.now() for the
	// common case where the camera has moved since the previous invocation.
	if (
		eyeX === underwaterCacheEyeX &&
		eyeY === underwaterCacheEyeY &&
		eyeZ === underwaterCacheEyeZ
	) {
		const now = performance.now();

		if (now - underwaterCacheTimestamp < UNDERWATER_CACHE_VALID_MS) {
			return underwaterCacheLiquid;
		}
	}

	const blockX = Math.floor(eyeX);
	const blockY = Math.floor(eyeY);
	const blockZ = Math.floor(eyeZ);

	const blockId = getBlockByWorldCoords(blockX, blockY, blockZ);
	const definition = getLiquidDefinitionByBlockId(blockId);
	let result: LiquidDefinition | null = null;

	if (definition !== null) {
		const aboveId = getBlockByWorldCoords(blockX, blockY + 1, blockZ);

		let surfaceY = blockY + 1;

		// The surface only dips below the voxel top when the same liquid is not
		// stacked above; covered liquid always fills the whole voxel.
		if (getLiquidDefinitionByBlockId(aboveId) !== definition) {
			const state = getBlockStateByWorldCoords(blockX, blockY, blockZ);
			const level = getLiquidLevel(blockId, state);
			surfaceY -= level / 8;
		}

		if (eyeY < surfaceY) {
			result = definition;
		}
	}

	underwaterCacheEyeX = eyeX;
	underwaterCacheEyeY = eyeY;
	underwaterCacheEyeZ = eyeZ;
	underwaterCacheLiquid = result;
	underwaterCacheTimestamp = performance.now();

	return result;
}

/**
 * Returns true when the supplied eye position is below the local water
 * surface, including partially filled flowing-water blocks.
 */
export function isEyeUnderwater(
	eyeX: number,
	eyeY: number,
	eyeZ: number,
): boolean {
	return getEyeLiquid(eyeX, eyeY, eyeZ) === WATER_LIQUID;
}
