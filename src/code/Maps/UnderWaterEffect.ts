import type { SceneContext, Vec3 } from "@babylonjs/lite";
import {
	getBlockByWorldCoords,
	getBlockStateByWorldCoords,
} from "../World/Chunk/ChunkLoadingSystem";
import { BlockType, getWaterLevel } from "../World/Texture/BlockType";

export interface EyeCamera {
	position: Vec3;
}

// Babylon Lite (WebGPU) has no PostProcess / DepthRenderer / GLSL ShaderMaterial
// pipeline, so the underwater effect is a full-screen HTML overlay (blue tint +
// animated caustic shimmer) toggled whenever the player's eyes are submerged.
export class UnderWaterEffect {
	public material: object | null;
	public postProcess: object | null;

	private scene: SceneContext;
	private camera: EyeCamera;
	private isUnderwater = false;
	private wasUnderwater = false;

	private overlay: HTMLDivElement | null = null;

	constructor(scene: SceneContext, camera: EyeCamera, baseTexture: unknown) {
		this.scene = scene;
		this.camera = camera;
		this.material = null;
		this.postProcess = null;
		void baseTexture;

		this.#buildOverlay();
	}

	#buildOverlay(): void {
		// Try to attach to the engine canvas so the overlay tracks the game view.
		const engine = (
			this.scene as unknown as {
				engine?: { getInputElement?: () => HTMLCanvasElement | null };
			}
		).engine;
		const canvas = engine?.getInputElement?.() ?? null;

		void canvas;

		const overlay = document.createElement("div");
		overlay.id = "underwater-overlay";
		overlay.style.position = "fixed";
		overlay.style.inset = "0";
		overlay.style.pointerEvents = "none";
		overlay.style.zIndex = "50";
		overlay.style.display = "none";
		overlay.style.background =
			"radial-gradient(ellipse at center, rgba(20,90,140,0.18) 0%, rgba(10,50,90,0.42) 70%, rgba(5,30,60,0.6) 100%)";
		overlay.style.transition = "opacity 250ms ease";
		overlay.style.opacity = "0";

		const shimmer = document.createElement("div");
		shimmer.style.position = "absolute";
		shimmer.style.inset = "0";
		shimmer.style.backgroundImage =
			"radial-gradient(circle at 20% 30%, rgba(180,230,255,0.12) 0%, transparent 18%)," +
			"radial-gradient(circle at 70% 60%, rgba(180,230,255,0.10) 0%, transparent 20%)," +
			"radial-gradient(circle at 45% 80%, rgba(200,240,255,0.08) 0%, transparent 16%)";
		shimmer.style.backgroundSize = "60% 60%, 50% 50%, 70% 70%";
		shimmer.style.animation = "underwaterCaustics 6s linear infinite";
		overlay.appendChild(shimmer);

		const style = document.createElement("style");
		style.textContent = `
			@keyframes underwaterCaustics {
				0%   { background-position: 0% 0%, 0% 0%, 0% 0%; }
				50%  { background-position: 30% 40%, -25% 20%, 15% -30%; }
				100% { background-position: 0% 0%, 0% 0%, 0% 0%; }
			}
		`;
		document.head.appendChild(style);

		document.body.appendChild(overlay);
		this.overlay = overlay;

		const disposable = this.scene as unknown as {
			onDisposeObservable?: { addOnce?: (cb: () => void) => void };
		};
		disposable.onDisposeObservable?.addOnce?.(() => {
			overlay.remove();
			style.remove();
		});
	}

	/** True when the player's eyes are currently below the water surface. */
	public get isUnderwaterState(): boolean {
		return this.isUnderwater;
	}

	/**
	 * Re-evaluate underwater state from the camera's eye position. Returns the
	 * new underwater flag so callers (fog, etc.) can react to transitions.
	 */
	public updateFromCamera(): boolean {
		const pos = this.camera.position;
		this.isUnderwater = isEyeUnderwater(pos.x, pos.y, pos.z);

		if (this.isUnderwater !== this.wasUnderwater) {
			this.wasUnderwater = this.isUnderwater;
			this.#applyOverlay();
		}
		return this.isUnderwater;
	}

	#applyOverlay(): void {
		if (!this.overlay) return;
		if (this.isUnderwater) {
			this.overlay.style.display = "block";
			// Force reflow so the opacity transition runs.
			void this.overlay.offsetWidth;
			this.overlay.style.opacity = "1";
		} else {
			this.overlay.style.opacity = "0";
			window.setTimeout(() => {
				if (this.overlay && !this.isUnderwater) {
					this.overlay.style.display = "none";
				}
			}, 260);
		}
	}

	public dispose(): void {
		this.material = null;
		this.postProcess = null;
		this.isUnderwater = false;
		this.wasUnderwater = false;
		if (this.overlay) {
			this.overlay.remove();
			this.overlay = null;
		}
	}
}

/**
 * Shared underwater test: true when the block at the given eye/world position
 * is a water source. Used by both the visual overlay and the fog system so
 * they stay in sync (lakes count, not just sea-level Y).
 */
export function isEyeUnderwater(
	eyeX: number,
	eyeY: number,
	eyeZ: number,
): boolean {
	const x = Math.floor(eyeX);
	const y = Math.floor(eyeY);
	const z = Math.floor(eyeZ);
	const blockId = getBlockByWorldCoords(x, y, z);
	if (blockId !== BlockType.Water) return false;

	// Compute the actual water surface height. A water block fully covered
	// by water above (or a source block, level 0) fills the whole voxel;
	// a lower-level (flowing) block has a surface dropped by level/8.
	const state = getBlockStateByWorldCoords(x, y, z);
	const level = getWaterLevel(blockId, state);
	const aboveId = getBlockByWorldCoords(x, y + 1, z);
	const surfaceY = aboveId === BlockType.Water ? y + 1 : y + 1 - level / 8;

	// The eye is underwater when it sits below the water surface within
	// this voxel (any water voxel counts, source or non-source).
	return eyeY < surfaceY;
}
