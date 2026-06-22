const CROSSHAIR_TEXTURE_PATH = (id: string) =>
	`/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair${id}.png`;

const HIT_MARKER_DURATION_MS = 330;

export class CrosshairUI {
	#crosshair: HTMLImageElement;
	#hitMarker: HTMLImageElement;
	#hitMarkerTimeout?: ReturnType<typeof setTimeout>;

	constructor(initialCrosshairId = "179") {
		this.#crosshair = document.createElement("img");
		this.#crosshair.src = CROSSHAIR_TEXTURE_PATH(initialCrosshairId);
		this.#crosshair.className = "crosshair";
		document.body.appendChild(this.#crosshair);

		this.#hitMarker = document.createElement("img");
		this.#hitMarker.src = "/texture/gui/hitmarker01.png";
		this.#hitMarker.className = "hit-marker";
		document.body.appendChild(this.#hitMarker);
	}

	setCrosshair(id: string): void {
		this.#crosshair.src = CROSSHAIR_TEXTURE_PATH(id);
	}

	showHitMarker(): void {
		if (this.#hitMarkerTimeout) clearTimeout(this.#hitMarkerTimeout);

		this.#hitMarker.style.opacity = "1";

		this.#hitMarkerTimeout = setTimeout(() => {
			this.#hitMarker.style.opacity = "0";
		}, HIT_MARKER_DURATION_MS);
	}
}
