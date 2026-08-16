const CROSSHAIR_TEXTURE_BASE =
	"/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair";
const CROSSHAIR_TEXTURE_EXT = ".png";
const HIT_MARKER_TEXTURE_PATH = "/texture/gui/hitmarker01.png";

const CROSSHAIR_CLASS_NAME = "crosshair";
const HIT_MARKER_CLASS_NAME = "hit-marker";

const HIT_MARKER_DURATION_MS = 330;

const crosshairTexturePath = (id: string): string =>
	`${CROSSHAIR_TEXTURE_BASE}${id}${CROSSHAIR_TEXTURE_EXT}`;

const createImage = (src: string, className: string): HTMLImageElement => {
	const image = document.createElement("img");
	image.src = src;
	image.className = className;
	document.body.appendChild(image);
	return image;
};

export class CrosshairUI {
	#crosshair: HTMLImageElement;
	#hitMarker: HTMLImageElement;
	#hitMarkerTimeout?: ReturnType<typeof setTimeout>;
	#crosshairId: string;

	constructor(initialCrosshairId = "179") {
		this.#crosshairId = initialCrosshairId;

		this.#crosshair = createImage(
			crosshairTexturePath(initialCrosshairId),
			CROSSHAIR_CLASS_NAME,
		);

		this.#hitMarker = createImage(
			HIT_MARKER_TEXTURE_PATH,
			HIT_MARKER_CLASS_NAME,
		);
	}

	setCrosshair(id: string): void {
		if (id === this.#crosshairId) return;

		this.#crosshairId = id;
		this.#crosshair.src = crosshairTexturePath(id);
	}

	showHitMarker(): void {
		const timeout = this.#hitMarkerTimeout;
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}

		this.#hitMarker.style.opacity = "1";

		this.#hitMarkerTimeout = setTimeout(() => {
			this.#hitMarker.style.opacity = "0";
			this.#hitMarkerTimeout = undefined;
		}, HIT_MARKER_DURATION_MS);
	}
}
