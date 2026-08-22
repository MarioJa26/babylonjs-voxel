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
}

const STORAGE_KEY = "b102.settings.v1";

const DEFAULTS: GameSettings = {
	renderDistance: SETTING_PARAMS.RENDER_DISTANCE,
	verticalRenderDistance: SETTING_PARAMS.VERTICAL_RENDER_DISTANCE,
	fov: SETTING_PARAMS.CAMERA_FOV,
	mouseSensitivity: 0.003,
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
	return settings;
}
