// ---------------------------------------------------------------------------
// serverList — persistence helpers for the multiplayer server list and the
// local player name. Extracted from MainMenu so non-UI code (e.g. TestScene)
// can read them without pulling in the whole menu.
//
// This module uses localStorage (main-thread only).
// ---------------------------------------------------------------------------

export interface SavedServer {
	name: string;
	url: string;
}

const PLAYER_NAME_KEY = "b102.playerName";
const SERVER_LIST_KEY = "b102.mpServers";

export function getPlayerName(): string {
	return localStorage.getItem(PLAYER_NAME_KEY) ?? "";
}

export function setPlayerName(name: string): void {
	localStorage.setItem(PLAYER_NAME_KEY, name);
}

export function getSavedServers(): SavedServer[] {
	try {
		return JSON.parse(localStorage.getItem(SERVER_LIST_KEY) ?? "[]");
	} catch {
		return [];
	}
}

export function saveServer(server: SavedServer): void {
	const servers = getSavedServers();
	const idx = servers.findIndex((s) => s.url === server.url);
	if (idx >= 0) {
		servers[idx] = server;
	} else {
		servers.push(server);
	}
	localStorage.setItem(SERVER_LIST_KEY, JSON.stringify(servers));
}

export function removeServer(url: string): void {
	const servers = getSavedServers().filter((s) => s.url !== url);
	localStorage.setItem(SERVER_LIST_KEY, JSON.stringify(servers));
}

/** Find a saved server by its display name (the /server/<name> token). */
export function findSavedServerByName(name: string): SavedServer | undefined {
	return getSavedServers().find((s) => s.name === name);
}
