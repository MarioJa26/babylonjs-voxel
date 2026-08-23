import type { SceneContext, Vec3 } from "@babylonjs/lite";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import { BlockType, getWaterLevel } from "../World/Texture/BlockType";

export interface EyeCamera {
	position: Vec3;
}

const OVERLAY_TRANSITION_MS = 250;
const OVERLAY_HIDE_DELAY_MS = OVERLAY_TRANSITION_MS + 10;
const UNDERWATER_CACHE_VALID_MS = 250;

const UNDERWATER_STYLE_ID = "underwater-overlay-style";
const UNDERWATER_ANIMATION_NAME = "underwaterCaustics";

let underwaterStyleReferenceCount = 0;

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

	private isUnderwater = false;
	private wasUnderwater = false;
	private overlay: HTMLDivElement | null = null;
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
		overlay.style.background =
			"radial-gradient(" +
			"ellipse at center, " +
			"rgba(20,90,140,0.18) 0%, " +
			"rgba(10,50,90,0.42) 70%, " +
			"rgba(5,30,60,0.6) 100%" +
			")";

		const shimmer = document.createElement("div");
		shimmer.style.position = "absolute";
		shimmer.style.inset = "0";
		shimmer.style.backgroundImage =
			"radial-gradient(" +
			"circle at 20% 30%, " +
			"rgba(180,230,255,0.12) 0%, " +
			"transparent 18%" +
			")," +
			"radial-gradient(" +
			"circle at 70% 60%, " +
			"rgba(180,230,255,0.10) 0%, " +
			"transparent 20%" +
			")," +
			"radial-gradient(" +
			"circle at 45% 80%, " +
			"rgba(200,240,255,0.08) 0%, " +
			"transparent 16%" +
			")";
		shimmer.style.backgroundSize = "60% 60%, 50% 50%, 70% 70%";
		shimmer.style.animation = `${UNDERWATER_ANIMATION_NAME} 6s linear infinite`;

		overlay.appendChild(shimmer);
		document.body.appendChild(overlay);

		this.overlay = overlay;

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
		return this.isUnderwater;
	}

	/**
	 * Re-evaluates underwater state from the camera eye position.
	 * Returns the current state for consumers such as fog handling.
	 */
	public updateFromCamera(): boolean {
		if (this.disposed) {
			return false;
		}

		const { x, y, z } = this.camera.position;
		const nextState = isEyeUnderwater(x, y, z);

		this.isUnderwater = nextState;

		if (nextState !== this.wasUnderwater) {
			this.wasUnderwater = nextState;
			this.#applyOverlay();
		}

		return nextState;
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

		if (this.isUnderwater) {
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

			if (!this.disposed && !this.isUnderwater && this.overlay) {
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
		this.isUnderwater = false;
		this.wasUnderwater = false;

		if (this.hideTimer !== null) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = null;
		}

		this.overlay?.remove();
		this.overlay = null;

		if (this.styleAcquired) {
			this.styleAcquired = false;
			releaseUnderwaterStyle();
		}
	}
}

// The cache primarily eliminates the duplicate call made by the overlay and
// fog systems for the same eye position. Exact coordinates are deliberately
// used because crossing a partial-water surface can happen within one voxel.
let underwaterCacheEyeX = NaN;
let underwaterCacheEyeY = NaN;
let underwaterCacheEyeZ = NaN;
let underwaterCacheResult = false;
let underwaterCacheTimestamp = 0;

/**
 * Returns true when the supplied eye position is below the local water
 * surface, including partially filled flowing-water blocks.
 */
export function isEyeUnderwater(
	eyeX: number,
	eyeY: number,
	eyeZ: number,
): boolean {
	// Compare coordinates first. This avoids calling performance.now() for the
	// common case where the camera has moved since the previous invocation.
	if (
		eyeX === underwaterCacheEyeX &&
		eyeY === underwaterCacheEyeY &&
		eyeZ === underwaterCacheEyeZ
	) {
		const now = performance.now();

		if (now - underwaterCacheTimestamp < UNDERWATER_CACHE_VALID_MS) {
			return underwaterCacheResult;
		}
	}

	const blockX = Math.floor(eyeX);
	const blockY = Math.floor(eyeY);
	const blockZ = Math.floor(eyeZ);

	const blockId = getBlockByWorldCoords(blockX, blockY, blockZ);
	let result = false;

	if (blockId === BlockType.Water) {
		const aboveId = getBlockByWorldCoords(blockX, blockY + 1, blockZ);

		let surfaceY = blockY + 1;

		// Only retrieve and decode the block state when the water voxel is not
		// covered by another water voxel. Covered water always fills the voxel.
		if (aboveId !== BlockType.Water) {
			const state = getBlockStateByWorldCoords(blockX, blockY, blockZ);
			const level = getWaterLevel(blockId, state);
			surfaceY -= level / 8;
		}

		result = eyeY < surfaceY;
	}

	underwaterCacheEyeX = eyeX;
	underwaterCacheEyeY = eyeY;
	underwaterCacheEyeZ = eyeZ;
	underwaterCacheResult = result;
	underwaterCacheTimestamp = performance.now();

	return result;
}
