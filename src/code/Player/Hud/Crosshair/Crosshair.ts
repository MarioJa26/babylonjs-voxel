import { BlockHighlight } from "../BlockHighlight/BlockHighlight";
import type { BlockRaycastHit } from "../BlockHighlight/BlockRaycaster";
import type { CrosshairVisualOptions } from "./CrosshairOptions";
import { CrosshairUI } from "./CrosshairUI";

export class Crosshair {
	readonly #ui: CrosshairUI;
	readonly #highlight: BlockHighlight;

	constructor(options?: Partial<CrosshairVisualOptions>) {
		this.#ui = new CrosshairUI(options);
		this.#highlight = new BlockHighlight();

		// Pointer lock requires a user gesture; at startup it will reject — ignore.
		document
			.querySelector("canvas")
			?.requestPointerLock?.()
			?.catch?.(() => {});
	}

	/** Set the pre-computed pick target hit from PlayerLoopController. */
	public setTargetHit(hit: BlockRaycastHit | null): void {
		this.#highlight.setHit(hit);
	}

	// ─── UI delegation ───────────────────────────────────────────────────────

	setCrosshair(id: string): void {
		this.#ui.setCrosshair(id);
	}

	setCrosshairSize(sizePx: number): void {
		this.#ui.setSize(sizePx);
	}

	setCrosshairColor(hex: string): void {
		this.#ui.setColor(hex);
	}

	setCrosshairVisible(visible: boolean): void {
		this.#ui.setVisible(visible);
	}

	setHitmarkerEnabled(enabled: boolean): void {
		this.#ui.setHitmarkerEnabled(enabled);
	}

	showHitMarker(): void {
		this.#ui.showHitMarker();
	}
}
