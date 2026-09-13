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

// Multiplayer route: /server/<saved-server-nickname>. The nickname maps via
// the saved-servers list to a ws:// address; it carries no player name.
export const SERVER_ROUTE_PREFIX = "/server/";

const APP_PREFIX = "b102";
const WORLD_LOCAL_STORAGE_PREFIX = `${APP_PREFIX}.world.`;
const MP_CACHE_PREFIX = "__mp__cache__";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips filesystem/path-unsafe chars
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

// Matches leading/trailing dots and spaces in one pass over each edge.
const LEADING_DOTS_OR_SPACES = /^[. ]+/;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/g;

function currentPathname(): string {
	const location = globalThis?.location;
	return typeof location?.pathname === "string" ? location.pathname : "";
}

function decodePathSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		// Malformed percent-encoding, e.g. a literal "%".
		return raw;
	}
}

function firstRouteSegment(pathname: string, prefix: string): string | null {
	if (!pathname.startsWith(prefix)) return null;

	const start = prefix.length;
	const slash = pathname.indexOf("/", start);

	return slash === -1 ? pathname.slice(start) : pathname.slice(start, slash);
}

/** Strip characters that are unsafe in a URL path segment or OPFS dir name. */
export function sanitizeWorldName(raw: string): string {
	return raw
		.trim()
		.replace(ILLEGAL_NAME_CHARS, "")
		.replace(LEADING_DOTS_OR_SPACES, "")
		.replace(TRAILING_DOTS_OR_SPACES, "")
		.slice(0, 64);
}

export function isValidWorldName(name: string): boolean {
	return name.length > 0 && name !== "." && name !== "..";
}

/**
 * Parse the active world name from the URL path, e.g.
 * `/world/My%20World` -> `My World`. Returns null when no world route is
 * active, i.e. the main menu.
 */
export function getWorldNameFromUrl(
	pathname: string = currentPathname(),
): string | null {
	const raw = firstRouteSegment(pathname, WORLD_ROUTE_PREFIX);
	if (raw === null || raw.length === 0) return null;

	const name = sanitizeWorldName(decodePathSegment(raw));
	return isValidWorldName(name) ? name : null;
}

/** URL path for a world, e.g. `/world/My%20World`. */
export function worldPath(name: string): string {
	return WORLD_ROUTE_PREFIX + encodeURIComponent(name);
}

/**
 * Parse the multiplayer server nickname from the URL path, e.g.
 * `/server/localhost` -> `localhost`. Returns null when no server route is
 * active, singleplayer world, or the main menu.
 */
export function getServerNameFromUrl(
	pathname: string = currentPathname(),
): string | null {
	const raw = firstRouteSegment(pathname, SERVER_ROUTE_PREFIX);
	return raw !== null && raw.length !== 0 ? decodePathSegment(raw) : null;
}

/** URL path for a saved server, e.g. `/server/localhost`. */
export function serverPath(name: string): string {
	return SERVER_ROUTE_PREFIX + encodeURIComponent(name);
}

/**
 * Ephemeral per-page-load name for the multiplayer client chunk cache
 * (IndexedDB). A fresh name every session means the cache DB is always empty,
 * so the connect-time `clear()` is a no-op instead of grinding through a
 * store that accumulates server chunks across sessions.
 */
let _mpSessionId: string | null = null;

export function mpLocalCacheName(): string {
	let id = _mpSessionId;

	if (id === null) {
		id = Math.random().toString(36).slice(2, 10);
		_mpSessionId = id;
	}

	return MP_CACHE_PREFIX + id;
}

/**
 * Deterministic generator seed for a world name. The same name always
 * produces the same terrain.
 */
export function worldSeed(name: string): string {
	return `${APP_PREFIX}:${name}`;
}

/** Per-world localStorage key, e.g. `b102.world.My World.playerPosition.v1`. */
export function worldLocalStorageKey(name: string, baseKey: string): string {
	return WORLD_LOCAL_STORAGE_PREFIX + name + "." + baseKey;
}

/** localStorage base key for a world's explicit terrain seed. */
export const WORLD_SEED_BASE_KEY = "seed.v1";

/** The explicitly stored seed for a world, or null if it uses the default. */
export function getStoredWorldSeed(worldName: string): string | null {
	return localStorage.getItem(
		worldLocalStorageKey(worldName, WORLD_SEED_BASE_KEY),
	);
}

export function setStoredWorldSeed(worldName: string, seed: string): void {
	localStorage.setItem(
		worldLocalStorageKey(worldName, WORLD_SEED_BASE_KEY),
		seed,
	);
}

export function removeStoredWorldSeed(worldName: string): void {
	localStorage.removeItem(worldLocalStorageKey(worldName, WORLD_SEED_BASE_KEY));
}

/**
 * Effective terrain seed for a world: the explicitly stored seed if one was
 * set, otherwise the deterministic name-derived seed.
 */
export function worldSeedFor(worldName: string): string {
	return getStoredWorldSeed(worldName) ?? worldSeed(worldName);
}
