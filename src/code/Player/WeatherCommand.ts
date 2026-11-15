// ---------------------------------------------------------------------------
// `!weather` — shared by both chat front-ends.
//
// The same reasoning as LocateCommand applies: there are two independent
// command dispatchers in this game (PlayerHud's chat for singleplayer and
// NetworkManager's for multiplayer), and they used to drift. The weather
// lives in a WeatherCycle that the server owns in multiplayer, so the
// command has to behave the same on both sides — only the side that
// actually applies the change differs.
//
// This module holds no state and imports nothing, so it can be used by
// the browser client and the server alike.
// ---------------------------------------------------------------------------

/** What the command was asked to do. */
export type WeatherCommandAction = "show" | "rain" | "clear";

export type WeatherCommandDeps = {
	/** Current rain intensity, 0..1. */
	currentIntensity: () => number;

	/**
	 * Apply the change.
	 *
	 * Omit it for a read-only report. In multiplayer the change is applied
	 * by the server, so the client only ever asks for it.
	 */
	force?: (raining: boolean) => void;

	/** Where replies go: the singleplayer chat log or multiplayer HUD. */
	reply: (text: string) => void;
};

/**
 * Parse the argument list into an action.
 *
 * Returns null for anything unrecognised so the caller can show the
 * usage line.
 */
export function parseWeatherAction(
	args: string[],
): WeatherCommandAction | null {
	const arg = args[0]?.toLowerCase();

	if (arg === undefined || arg === "") return "show";
	if (arg === "rain" || arg === "raining" || arg === "on") return "rain";
	if (arg === "clear" || arg === "off" || arg === "stop") return "clear";

	return null;
}

/**
 * A human-readable name for a rain intensity.
 */
export function weatherLabel(intensity: number): string {
	if (!Number.isFinite(intensity) || intensity <= 0) return "clear";
	if (intensity < 0.34) return "light rain";
	if (intensity < 0.67) return "rain";
	if (intensity < 0.9) return "heavy rain";
	return "downpour";
}

/** Executes the shared `!weather` command. */
export function runWeatherCommand(
	args: string[],
	deps: WeatherCommandDeps,
): void {
	const action = parseWeatherAction(args);

	if (action === null) {
		deps.reply("Usage: !weather [rain | clear]");
		return;
	}

	if (action === "show") {
		const intensity = deps.currentIntensity();
		deps.reply(
			`Weather: ${weatherLabel(intensity)} (${Math.round(intensity * 100)}%)`,
		);
		return;
	}

	const raining = action === "rain";

	if (!deps.force) {
		deps.reply("Weather cannot be changed here");
		return;
	}

	deps.force(raining);
	deps.reply(`Weather set to ${raining ? "rain" : "clear"}`);
}
