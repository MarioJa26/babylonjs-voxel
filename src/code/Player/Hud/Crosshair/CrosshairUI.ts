import {
	type CrosshairVisualOptions,
	crosshairTexturePath,
	DEFAULT_CROSSHAIR_OPTIONS,
	filterForCrosshairColor,
	normalizeCrosshairColor,
	normalizeCrosshairId,
	normalizeCrosshairSize,
} from "./CrosshairOptions";

const CROSSHAIR_CLASS_NAME = "crosshair";
const HIT_MARKER_CLASS_NAME = "hit-marker";
const HITMARKER_TEXTURE_PATH = "/texture/gui/hitmarker01.png";

const HIT_MARKER_DURATION_MS = 330;

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
	#hitmarkerEnabled: boolean;

	constructor(options?: Partial<CrosshairVisualOptions>) {
		const initial: CrosshairVisualOptions = {
			...DEFAULT_CROSSHAIR_OPTIONS,
			...options,
		};

		this.#crosshairId = normalizeCrosshairId(initial.crosshairId);
		this.#hitmarkerEnabled = initial.hitmarkerEnabled;

		this.#crosshair = createImage(
			crosshairTexturePath(this.#crosshairId),
			CROSSHAIR_CLASS_NAME,
		);
		this.applyVisualOptions(initial);

		this.#hitMarker = createImage(
			HITMARKER_TEXTURE_PATH,
			HIT_MARKER_CLASS_NAME,
		);
	}

	setCrosshair(id: string): void {
		const next = normalizeCrosshairId(id);
		if (next === this.#crosshairId) return;

		this.#crosshairId = next;
		this.#crosshair.src = crosshairTexturePath(next);
	}

	getCrosshairId(): string {
		return this.#crosshairId;
	}

	setSize(sizePx: number): void {
		const size = normalizeCrosshairSize(sizePx);
		this.#crosshair.style.width = `${size}px`;
		this.#crosshair.style.height = `${size}px`;
	}

	setColor(hex: string): void {
		const color = normalizeCrosshairColor(hex);
		this.#crosshair.style.filter = filterForCrosshairColor(color);
	}

	setVisible(visible: boolean): void {
		this.#crosshair.style.display = visible ? "" : "none";
	}

	setHitmarkerEnabled(enabled: boolean): void {
		this.#hitmarkerEnabled = enabled;
		if (!enabled && this.#hitMarkerTimeout !== undefined) {
			clearTimeout(this.#hitMarkerTimeout);
			this.#hitMarkerTimeout = undefined;
			this.#hitMarker.style.opacity = "0";
		}
	}

	isHitmarkerEnabled(): boolean {
		return this.#hitmarkerEnabled;
	}

	/** Apply a full visual option set (used at boot and by settings menus). */
	applyVisualOptions(options: Partial<CrosshairVisualOptions>): void {
		if (options.crosshairId !== undefined) {
			this.setCrosshair(options.crosshairId);
		}
		if (options.crosshairSize !== undefined) {
			this.setSize(options.crosshairSize);
		}
		if (options.crosshairColor !== undefined) {
			this.setColor(options.crosshairColor);
		}
		if (options.crosshairVisible !== undefined) {
			this.setVisible(options.crosshairVisible);
		}
		if (options.hitmarkerEnabled !== undefined) {
			this.setHitmarkerEnabled(options.hitmarkerEnabled);
		}
	}

	showHitMarker(): void {
		if (!this.#hitmarkerEnabled) return;

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
