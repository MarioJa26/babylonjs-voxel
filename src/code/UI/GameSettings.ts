import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";

/**
 * Locally persisted game options (localStorage). The main-menu Options screen
 * writes them; the engine applies them once at boot.
 */

export interface GameSettings {
	renderDistance: number;
	verticalRenderDistance: number;
	fov: number;
	mouseSensitivity: number;
	/** Multiplier on window.devicePixelRatio for the render canvas. */
	renderScale: number;
	/** 4x MSAA on the main surface (costly; see SETTING_PARAMS.ENABLE_MSAA). */
	msaaEnabled: boolean;
	/** Frame-rate cap in Hz; 0 = uncapped. */
	fpsCap: number;
	/** Master audio volume 0..1 (see AudioManager). */
	masterVolume: number;
	/** Mute all game audio. */
	muted: boolean;
}

const STORAGE_KEY = "b102.settings.v1";

const DEFAULTS: GameSettings = {
	renderDistance: SETTING_PARAMS.RENDER_DISTANCE,
	verticalRenderDistance: SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
	fov: SETTING_PARAMS.CAMERA_FOV,
	mouseSensitivity: 0.003,
	renderScale: SETTING_PARAMS.RENDER_SCALE,
	msaaEnabled: SETTING_PARAMS.ENABLE_MSAA,
	fpsCap: SETTING_PARAMS.FPS_CAP,
	masterVolume: 0.8,
	muted: false,
};

function clamp(v: number, min: number, fallback: number, max: number): number {
	if (!Number.isFinite(v)) return fallback;
	return Math.min(max, Math.max(min, v));
}

export function loadGameSettings(): GameSettings {
	const defaults = { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return defaults;
		const parsed = JSON.parse(raw) as Partial<GameSettings>;
		return {
			renderDistance: clamp(
				parsed.renderDistance ?? defaults.renderDistance,
				1,
				defaults.renderDistance,
				32,
			),
			verticalRenderDistance: clamp(
				parsed.verticalRenderDistance ?? defaults.verticalRenderDistance,
				1,
				defaults.verticalRenderDistance,
				20,
			),
			fov: clamp(parsed.fov ?? defaults.fov, 50, defaults.fov, 140),
			mouseSensitivity: clamp(
				parsed.mouseSensitivity ?? defaults.mouseSensitivity,
				0.001,
				defaults.mouseSensitivity,
				0.02,
			),
			renderScale: clamp(
				parsed.renderScale ?? defaults.renderScale,
				defaults.renderScale * 0.5,
				defaults.renderScale,
				2,
			),
			msaaEnabled:
				typeof parsed.msaaEnabled === "boolean"
					? parsed.msaaEnabled
					: defaults.msaaEnabled,
			fpsCap: [0, 30, 60, 120].includes(parsed.fpsCap ?? defaults.fpsCap)
				? (parsed.fpsCap ?? defaults.fpsCap)
				: defaults.fpsCap,
			masterVolume: clamp(
				parsed.masterVolume ?? defaults.masterVolume,
				0,
				defaults.masterVolume,
				1,
			),
			muted: typeof parsed.muted === "boolean" ? parsed.muted : defaults.muted,
		};
	} catch {
		return defaults;
	}
}

export function saveGameSettings(settings: GameSettings): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Push persisted settings into the shared runtime params (pre-boot). */
export function applyGameSettingsToEngine(
	settings: GameSettings,
): GameSettings {
	SETTING_PARAMS.RENDER_DISTANCE = Math.round(settings.renderDistance);
	SETTING_PARAMS.VERTICAL_RENDER_DISTANCE = Math.round(
		settings.verticalRenderDistance,
	);
	SETTING_PARAMS.CAMERA_FOV = Math.round(settings.fov);
	SETTING_PARAMS.RENDER_SCALE = settings.renderScale;
	SETTING_PARAMS.ENABLE_MSAA = settings.msaaEnabled;
	SETTING_PARAMS.FPS_CAP = settings.fpsCap;
	return settings;
}
