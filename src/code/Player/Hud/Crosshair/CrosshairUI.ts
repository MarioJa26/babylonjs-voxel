import { type Engine, type Scene } from "@babylonjs/core";
import * as GUI from "@babylonjs/gui";

const CROSSHAIR_TEXTURE_PATH = (id: string) =>
	`/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair${id}.png`;

const HIT_MARKER_DURATION_S = 0.33;

export class CrosshairUI {
	readonly #engine: Engine;
	readonly #scene: Scene;
	readonly #ui: GUI.AdvancedDynamicTexture;

	#crosshair: GUI.Image;
	#hitMarker: GUI.Image;

	constructor(engine: Engine, scene: Scene, initialCrosshairId = "179") {
		this.#engine = engine;
		this.#scene  = scene;
		this.#ui     = GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");

		this.#crosshair  = this.#addImage("crossHair", CROSSHAIR_TEXTURE_PATH(initialCrosshairId), "48px", 1);
		this.#hitMarker  = this.#addImage("hitMarker",  "/texture/gui/hitmarker01.png",             "28px", 0);
	}

	setCrosshair(id: string): void {
		this.#crosshair.source = CROSSHAIR_TEXTURE_PATH(id);
	}

	showHitMarker(): void {
		let elapsed = 0;

		const onRender = (): void => {
			elapsed += this.#engine.getDeltaTime() / 1000;
			this.#hitMarker.alpha = Math.max(0, 1 - elapsed / HIT_MARKER_DURATION_S);

			if (elapsed >= HIT_MARKER_DURATION_S) {
				this.#scene.onBeforeRenderObservable.removeCallback(onRender);
				this.#hitMarker.alpha = 0;
			}
		};

		this.#scene.onBeforeRenderObservable.add(onRender);
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	#addImage(name: string, source: string, size: string, alpha: number): GUI.Image {
		const img    = new GUI.Image(name, source);
		img.width    = size;
		img.height   = size;
		img.alpha    = alpha;
		this.#ui.addControl(img);
		return img;
	}
}
