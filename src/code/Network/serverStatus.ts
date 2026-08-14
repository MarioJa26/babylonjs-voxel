// ---------------------------------------------------------------------------
// serverStatus — query a b102 server's public status (MOTD, player count,
// version) without joining a room.
//
// The server exposes `GET /api/status` (see server/src/index.ts) returning
// `{ name, motd, version, maxPlayers, players }`. We measure the round-trip
// time as an approximate ping. Uses fetch (browser) with a timeout so an
// unreachable server degrades gracefully instead of hanging the menu.
// ---------------------------------------------------------------------------

export interface ServerStatus {
	online: boolean;
	name: string;
	motd: string;
	version: string;
	maxPlayers: number;
	players: number;
	/** Round-trip time in ms (-1 if unreachable / timed out). */
	pingMs: number;
	error?: string;
}

/**
 * Normalize a saved server URL (ws:// / wss:// / raw host:port) into the
 * http(s) URL of its status endpoint.
 */
export function statusUrlFor(serverUrl: string): string {
	const url = serverUrl.trim();
	if (!url) return "";

	// Already an http(s) URL (rare) — just hit /api/status.
	if (url.startsWith("http://") || url.startsWith("https://")) {
		return url.replace(/\/+$/, "") + "/api/status";
	}

	// Convert ws/wss → http/https.
	let scheme = "http:";
	let rest = url;
	if (url.startsWith("wss://")) {
		scheme = "https:";
		rest = url.slice("wss://".length);
	} else if (url.startsWith("ws://")) {
		rest = url.slice("ws://".length);
	}
	rest = rest.replace(/\/+$/, "");
	return `${scheme}//${rest}/api/status`;
}

/**
 * Fetch one server's status. Never throws — on any failure returns an
 * `online: false` result with a user-facing message.
 */
export async function fetchServerStatus(
	serverUrl: string,
	timeoutMs = 3000,
): Promise<ServerStatus> {
	const url = statusUrlFor(serverUrl);
	if (!url) {
		return {
			online: false,
			name: "",
			motd: "Invalid server address",
			version: "",
			maxPlayers: 0,
			players: 0,
			pingMs: -1,
			error: "invalid-url",
		};
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const t0 = performance.now();
	try {
		const res = await fetch(url, { signal: controller.signal });
		const pingMs = Math.round(performance.now() - t0);
		if (!res.ok) {
			return {
				online: false,
				name: "",
				motd: `Server responded with ${res.status}`,
				version: "",
				maxPlayers: 0,
				players: 0,
				pingMs: -1,
				error: `http-${res.status}`,
			};
		}
		const data = (await res.json()) as Partial<ServerStatus>;
		return {
			online: true,
			name: data.name ?? "",
			motd: data.motd ?? "",
			version: data.version ?? "",
			maxPlayers: data.maxPlayers ?? 0,
			players: data.players ?? 0,
			pingMs,
		};
	} catch (err) {
		const pingMs = Math.round(performance.now() - t0);
		const aborted = err instanceof Error && err.name === "AbortError";
		return {
			online: false,
			name: "",
			motd: aborted ? "Server timed out" : "Can't reach server",
			version: "",
			maxPlayers: 0,
			players: 0,
			pingMs: -1,
			error: aborted ? "timeout" : "unreachable",
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fetch statuses for many servers concurrently. Failures are isolated so one
 * dead server doesn't block the others.
 */
export async function fetchAllStatuses(
	servers: ReadonlyArray<{ url: string }>,
): Promise<ServerStatus[]> {
	return Promise.all(servers.map((s) => fetchServerStatus(s.url)));
}
