// ---------------------------------------------------------------------------
// WorldContext — single source of truth for the active world name.
//
// The world name comes from the URL path (/world/<name>) and is used for:
//   - OPFS save directories  (b102/worlds/<name>/...)
//   - localStorage keys      (b102.world.<name>.*)
//   - the terrain generator seed (deterministic per world name)
//
// This module must stay worker-safe (no window/DOM access at import time).
// ---------------------------------------------------------------------------

export const WORLD_ROUTE_PREFIX = "/world/";

// biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Strip characters that are unsafe in a URL path segment or OPFS dir name. */
export function sanitizeWorldName(raw: string): string {
	return raw
		.trim()
		.replace(ILLEGAL_NAME_CHARS, "")
		.replace(/^[. ]+/, "") // no hidden/system-ish names (e.g. "..")
		.replace(/[. ]+$/g, "")
		.slice(0, 64);
}

export function isValidWorldName(name: string): boolean {
	return name.length > 0 && name !== "." && name !== "..";
}

/**
 * Parse the active world name from the URL path, e.g.
 * `/world/My%20World` → `My World`. Returns null when no world route is
 * active (i.e. the main menu).
 */
export function getWorldNameFromUrl(
	pathname: string = window.location.pathname,
): string | null {
	if (!pathname.startsWith(WORLD_ROUTE_PREFIX)) return null;
	const raw = pathname.slice(WORLD_ROUTE_PREFIX.length).split("/")[0] ?? "";
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		// Malformed percent-encoding (e.g. a literal "%") — fall back to raw.
	}
	const name = sanitizeWorldName(decoded);
	return isValidWorldName(name) ? name : null;
}

/** URL path for a world, e.g. `/world/My%20World`. */
export function worldPath(name: string): string {
	return `${WORLD_ROUTE_PREFIX}${encodeURIComponent(name)}`;
}

/**
 * Deterministic generator seed for a world name. The same name always
 * produces the same terrain.
 */
export function worldSeed(name: string): string {
	return `b102:${name}`;
}

/** Per-world localStorage key, e.g. `b102.world.My World.playerPosition.v1`. */
export function worldLocalStorageKey(name: string, baseKey: string): string {
	return `b102.world.${name}.${baseKey}`;
}
