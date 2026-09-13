/**
 * Shared crosshair customization helpers used by the main-menu Options screen
 * and the in-game pause Settings panel. Kept free of menu-framework imports
 * so both menus (and GameSettings) can share constants and validation.
 */

export interface CrosshairVisualOptions {
	/** Zero-padded texture id, "001".."200". */
	crosshairId: string;
	/** Rendered size in px. */
	crosshairSize: number;
	/** Tint color as #rrggbb. */
	crosshairColor: string;
	/** Whether the crosshair image is shown at all. */
	crosshairVisible: boolean;
	/** Whether bow/arrow hits flash the hit marker. */
	hitmarkerEnabled: boolean;
}

export const CROSSHAIR_COUNT = 200;
export const CROSSHAIR_MIN_SIZE = 16;
export const CROSSHAIR_MAX_SIZE = 96;

export const DEFAULT_CROSSHAIR_OPTIONS: CrosshairVisualOptions = {
	crosshairId: "179",
	crosshairSize: 48,
	crosshairColor: "#ffffff",
	crosshairVisible: true,
	hitmarkerEnabled: true,
};

const CROSSHAIR_TEXTURE_BASE =
	"/texture/gui/kenney_crosshair-pack/PNG/Outline Retina/crosshair";
const CROSSHAIR_TEXTURE_EXT = ".png";

/** Normalize a raw id ("7", 7, "007") to a zero-padded "001".."200" id. */
export function normalizeCrosshairId(value: unknown): string {
	const fallback = DEFAULT_CROSSHAIR_OPTIONS.crosshairId;
	const num =
		typeof value === "number"
			? Math.floor(value)
			: typeof value === "string" && /^\d{1,3}$/.test(value.trim())
				? Number.parseInt(value.trim(), 10)
				: Number.NaN;
	if (!Number.isFinite(num)) return fallback;
	const clamped = Math.min(CROSSHAIR_COUNT, Math.max(1, num));
	return String(clamped).padStart(3, "0");
}

/** All valid ids, "001".."200", for building the thumbnail grid. */
export function allCrosshairIds(): string[] {
	const ids = new Array<string>(CROSSHAIR_COUNT);
	for (let i = 1; i <= CROSSHAIR_COUNT; i++) {
		ids[i - 1] = String(i).padStart(3, "0");
	}
	return ids;
}

export function crosshairTexturePath(id: string): string {
	return `${CROSSHAIR_TEXTURE_BASE}${normalizeCrosshairId(id)}${CROSSHAIR_TEXTURE_EXT}`;
}

export function normalizeCrosshairSize(value: unknown): number {
	const fallback = DEFAULT_CROSSHAIR_OPTIONS.crosshairSize;
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(
		CROSSHAIR_MAX_SIZE,
		Math.max(CROSSHAIR_MIN_SIZE, Math.round(value)),
	);
}

export function normalizeCrosshairColor(value: unknown): string {
	if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
		return value.trim().toLowerCase();
	}
	return DEFAULT_CROSSHAIR_OPTIONS.crosshairColor;
}

/**
 * CSS filter that tints the white-with-black-outline Kenney textures toward
 * the given hex color. `sepia(1)` turns white into a warm cream while leaving
 * black untouched, so `saturate + hue-rotate` recolors the crosshair body
 * while the dark outline survives. Grayscale targets use a plain
 * saturate/brightness chain instead.
 */
export function filterForCrosshairColor(hex: string): string {
	const color = normalizeCrosshairColor(hex);
	const r = Number.parseInt(color.slice(1, 3), 16);
	const g = Number.parseInt(color.slice(3, 5), 16);
	const b = Number.parseInt(color.slice(5, 7), 16);

	if (r >= 250 && g >= 250 && b >= 250) return "none";
	if (r <= 8 && g <= 8 && b <= 8) return "brightness(0)";

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

	if (max - min < 14) {
		// Gray: white body scales with brightness, black outline stays black.
		return `saturate(0) brightness(${lum.toFixed(2)})`;
	}

	// RGB -> HSL hue (0..360).
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const maxN = Math.max(rn, gn, bn);
	const minN = Math.min(rn, gn, bn);
	const delta = maxN - minN;
	let hue = 0;
	if (delta !== 0) {
		if (maxN === rn) hue = 60 * (((gn - bn) / delta) % 6);
		else if (maxN === gn) hue = 60 * ((bn - rn) / delta + 2);
		else hue = 60 * ((rn - gn) / delta + 4);
	}
	if (hue < 0) hue += 360;

	// sepia(1) on white lands near hue ~45deg; rotate from there to target.
	const rotation = Math.round(hue - 45);
	const parts = [`sepia(1) saturate(5) hue-rotate(${rotation}deg)`];
	if (lum < 0.35) {
		// Dark targets: the white source stays too bright without help.
		parts.push(`brightness(${(0.55 + lum).toFixed(2)})`);
	}
	return parts.join(" ");
}

export interface CrosshairColorPreset {
	readonly name: string;
	readonly hex: string;
}

export const CROSSHAIR_COLOR_PRESETS: readonly CrosshairColorPreset[] = [
	{ name: "White", hex: "#ffffff" },
	{ name: "Black", hex: "#1a1a1a" },
	{ name: "Red", hex: "#ff3838" },
	{ name: "Orange", hex: "#ff9f1a" },
	{ name: "Yellow", hex: "#ffe14d" },
	{ name: "Green", hex: "#39d353" },
	{ name: "Cyan", hex: "#35d0ff" },
	{ name: "Blue", hex: "#4d7cff" },
	{ name: "Pink", hex: "#ff5fa2" },
];

const SHARED_STYLE_ID = "crosshair-options-shared-style";

/**
 * Inject the shared grid / swatch / preview / collapsible styles once.
 * Both menus call this; the second call is a no-op. This is only a fallback:
 * the same rules ship in src/style/crosshair-options.css (via main.ts), which
 * additionally carries the #pauseMenuContainer overrides that beat hud.css
 * button theming at ID specificity.
 */
export function ensureCrosshairOptionStyles(): void {
	if (document.getElementById(SHARED_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = SHARED_STYLE_ID;
	style.innerHTML = `
		.crosshair-collapsible {
			width: 100%;
			max-width: min(480px, 90vw);
			border: 1px solid var(--hud-frame-dim, #3a3a3a);
			border-radius: 4px;
			background: rgba(0, 0, 0, 0.25);
			box-sizing: border-box;
		}
		.crosshair-collapsible-header {
			width: 100%;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 10px 12px;
			background: none;
			border: none;
			color: inherit;
			font: inherit;
			cursor: pointer;
			box-sizing: border-box;
		}
		.crosshair-collapsible-header:hover {
			color: #fff;
		}
		.crosshair-collapsible-body {
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 12px;
			padding: 4px 12px 14px;
			box-sizing: border-box;
		}
		.crosshair-preview-wrap {
			display: flex;
			align-items: center;
			gap: 12px;
		}
		.crosshair-preview-box {
			flex: 0 0 auto;
			width: 64px;
			height: 64px;
			display: flex;
			align-items: center;
			justify-content: center;
			background:
				repeating-conic-gradient(rgba(255,255,255,0.09) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px,
				rgba(0, 0, 0, 0.55);
			border: 1px solid var(--hud-frame-dim, #3a3a3a);
			border-radius: 4px;
			overflow: hidden;
		}
		.crosshair-preview-box img {
			width: 64px;
			height: 64px;
			pointer-events: none;
			user-select: none;
		}
		.crosshair-preview-label {
			font-size: 0.85em;
			color: var(--hud-text-muted, #9aa4ad);
		}
		.crosshair-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(36px, 1fr));
			gap: 4px;
			max-height: 240px;
			overflow-y: auto;
			padding: 4px;
			background: rgba(0, 0, 0, 0.35);
			border: 1px solid var(--hud-frame-dim, #3a3a3a);
			border-radius: 1px;
			scrollbar-width: thin;
		}
		.crosshair-thumb {
			aspect-ratio: 1;
			display: flex;
			align-items: center;
			justify-content: center;
			width: 100%;
			min-width: 0;
			min-height: 0;
			margin: 0;
			overflow: hidden;
			padding: 1px;
			background: rgba(255, 255, 255, 0.04);
			border: 1px solid transparent;
			border-radius: 4px;
			cursor: pointer;
			box-sizing: border-box;
			appearance: none;
			font: inherit;
			line-height: 0;
		}
		.crosshair-thumb:hover {
			background: rgba(255, 255, 255, 0.1);
		}
		.crosshair-thumb.selected {
			border-color: var(--hud-accent, #00bbff);
			background: rgba(0, 187, 255, 0.12);
		}
		.crosshair-thumb img {
			display: block;
			width: 100%;
			height: 100%;
			max-width: 100%;
			max-height: 100%;
			min-width: 0;
			min-height: 0;
			object-fit: contain;
			pointer-events: none;
			user-select: none;
		}
		.crosshair-swatches {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: center;
		}
		.crosshair-swatch {
			width: 28px;
			height: 28px;
			border-radius: 50%;
			border: 2px solid rgba(255, 255, 255, 0.25);
			cursor: pointer;
			padding: 0;
			box-sizing: border-box;
		}
		.crosshair-swatch:hover {
			transform: scale(1.1);
		}
		.crosshair-swatch.selected {
			border-color: #fff;
			box-shadow: 0 0 0 2px var(--hud-accent, #00bbff);
		}
		.crosshair-color-row {
			display: flex;
			align-items: center;
			gap: 8px;
			font-size: 0.85em;
			color: var(--hud-text-muted, #9aa4ad);
		}
		.crosshair-color-row input[type="color"] {
			width: 40px;
			height: 28px;
			padding: 0;
			border: 1px solid var(--hud-frame-dim, #3a3a3a);
			background: none;
			cursor: pointer;
		}
		#pauseMenuContainer .crosshair-collapsible-header,
		#pauseMenuContainer .crosshair-thumb,
		#pauseMenuContainer .crosshair-swatch {
			min-width: 0;
			font-size: 1em;
		}
		#pauseMenuContainer .crosshair-collapsible-header {
			padding: 10px 12px;
			background: none;
			border: none;
		}
		#pauseMenuContainer .crosshair-thumb {
			padding: 1px;
			border: 1px solid transparent;
			background: rgba(255, 255, 255, 0.04);
			line-height: 0;
		}
		#pauseMenuContainer .crosshair-thumb:hover {
			border-color: var(--hud-accent, #00bbff);
			background: rgba(255, 255, 255, 0.1);
		}
		#pauseMenuContainer .crosshair-thumb.selected {
			border-color: var(--hud-accent, #00bbff);
			background: rgba(0, 187, 255, 0.12);
		}
		#pauseMenuContainer .crosshair-swatch {
			width: 28px;
			height: 28px;
			padding: 0;
			border: 2px solid rgba(255, 255, 255, 0.25);
			border-radius: 50%;
		}
		#pauseMenuContainer .crosshair-swatch.selected {
			border-color: #fff;
		}
	`;
	document.head.appendChild(style);
}

export interface CrosshairGrid {
	readonly element: HTMLElement;
	/** Highlight the given id (scrolls it into view when requested). */
	setSelected: (id: string, scroll?: boolean) => void;
}

/**
 * Build the scrollable 200-thumbnail picker grid. Images lazy-load so
 * opening the section stays cheap.
 */
export function createCrosshairGrid(
	initialId: string,
	onPick: (id: string) => void,
): CrosshairGrid {
	let selected = normalizeCrosshairId(initialId);
	const grid = document.createElement("div");
	grid.className = "crosshair-grid";
	grid.setAttribute("role", "listbox");
	grid.setAttribute("aria-label", "Crosshair style");

	const buttons = new Map<string, HTMLButtonElement>();
	for (const id of allCrosshairIds()) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "crosshair-thumb";
		btn.setAttribute("role", "option");
		btn.title = `Crosshair ${id}`;
		btn.setAttribute("aria-label", `Crosshair ${id}`);
		if (id === selected) {
			btn.classList.add("selected");
			btn.setAttribute("aria-selected", "true");
		}
		const img = document.createElement("img");
		img.src = crosshairTexturePath(id);
		img.alt = "";
		img.loading = "lazy";
		img.draggable = false;
		btn.appendChild(img);
		btn.addEventListener("click", () => onPick(id));
		buttons.set(id, btn);
		grid.appendChild(btn);
	}

	return {
		element: grid,
		setSelected: (id: string, scroll = false): void => {
			const next = normalizeCrosshairId(id);
			if (next === selected) return;
			buttons.get(selected)?.classList.remove("selected");
			buttons.get(selected)?.removeAttribute("aria-selected");
			selected = next;
			const btn = buttons.get(next);
			btn?.classList.add("selected");
			btn?.setAttribute("aria-selected", "true");
			if (scroll) btn?.scrollIntoView({ block: "nearest" });
		},
	};
}

export interface CrosshairPreview {
	readonly element: HTMLElement;
	update: (options: {
		id: string;
		size: number;
		color: string;
		visible: boolean;
	}) => void;
}

/** Large live preview box showing exactly what the HUD will render. */
export function createCrosshairPreview(initial: {
	id: string;
	size: number;
	color: string;
	visible: boolean;
}): CrosshairPreview {
	const wrap = document.createElement("div");
	wrap.className = "crosshair-preview-wrap";

	const box = document.createElement("div");
	box.className = "crosshair-preview-box";
	const img = document.createElement("img");
	img.alt = "Crosshair preview";
	img.draggable = false;
	box.appendChild(img);

	const label = document.createElement("div");
	label.className = "crosshair-preview-label";

	wrap.append(box, label);

	const update: CrosshairPreview["update"] = (options): void => {
		const id = normalizeCrosshairId(options.id);
		const size = normalizeCrosshairSize(options.size);
		const color = normalizeCrosshairColor(options.color);
		img.src = crosshairTexturePath(id);
		const previewSize = Math.min(56, Math.max(20, Math.round(size * 0.6)));
		img.style.width = `${previewSize}px`;
		img.style.height = `${previewSize}px`;
		img.style.filter = filterForCrosshairColor(color);
		img.style.opacity = options.visible ? "1" : "0.25";
		label.textContent = options.visible
			? `Style ${id} · ${size}px`
			: `Style ${id} · ${size}px · hidden`;
	};
	update(initial);

	return { element: wrap, update };
}

export interface CrosshairSwatches {
	readonly element: HTMLElement;
	setSelected: (hex: string) => void;
}

/** Preset color swatches + a native custom-color input. */
export function createCrosshairSwatches(
	initialHex: string,
	onPick: (hex: string) => void,
): CrosshairSwatches {
	let selected = normalizeCrosshairColor(initialHex);
	const wrap = document.createElement("div");
	wrap.className = "crosshair-swatches";

	const swatchButtons = new Map<string, HTMLButtonElement>();
	for (const preset of CROSSHAIR_COLOR_PRESETS) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "crosshair-swatch";
		btn.title = preset.name;
		btn.setAttribute("aria-label", `Crosshair color ${preset.name}`);
		btn.style.backgroundColor = preset.hex;
		if (preset.hex === selected) btn.classList.add("selected");
		btn.addEventListener("click", () => onPick(preset.hex));
		swatchButtons.set(preset.hex, btn);
		wrap.appendChild(btn);
	}

	const row = document.createElement("label");
	row.className = "crosshair-color-row";
	row.textContent = "Custom";
	const input = document.createElement("input");
	input.type = "color";
	input.value = selected;
	input.setAttribute("aria-label", "Custom crosshair color");
	input.addEventListener("input", () => onPick(input.value));
	row.appendChild(input);
	wrap.appendChild(row);

	return {
		element: wrap,
		setSelected: (hex: string): void => {
			const next = normalizeCrosshairColor(hex);
			selected = next;
			for (const [presetHex, btn] of swatchButtons) {
				btn.classList.toggle("selected", presetHex === next);
			}
			if (input.value.toLowerCase() !== next) input.value = next;
		},
	};
}
