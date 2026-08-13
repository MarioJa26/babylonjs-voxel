/**
 * ServerConfig — loads and parses server.properties (Minecraft-style).
 *
 * All server-wide settings live in server.properties at the project root.
 * Values here are authoritative for new rooms — the seed in particular
 * overrides any seed a client sends on join.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REACH_DISTANCE } from "@/code/Player/PlayerStats";

export interface ServerConfig {
	seed: string;
	serverPort: number;
	maxPlayers: number;
	serverName: string;
	gamemode: string;
	difficulty: string;
	maxReach: number;
	tickRate: number;
	dayDuration: number;
	dayCycle: boolean;
	wasmEnabled: boolean;
	worldStoragePath: string;
	chunkCacheSize: number;
}

const DEFAULTS: ServerConfig = {
	seed: "b102:overworld",
	serverPort: 2567,
	maxPlayers: 24,
	serverName: "b102 Server",
	gamemode: "creative",
	difficulty: "normal",
	maxReach: REACH_DISTANCE,
	tickRate: 20,
	dayDuration: 120000,
	dayCycle: true,
	wasmEnabled: true,
	worldStoragePath: "server-data",
	chunkCacheSize: 1024,
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return (
		value.toLowerCase() === "true" ||
		value === "1" ||
		value.toLowerCase() === "yes"
	);
}

function parseIntSafe(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isNaN(n) ? fallback : n;
}

/**
 * Parse a server.properties file (key=value, # comments).
 */
function parseProperties(content: string): Record<string, string> {
	const props: Record<string, string> = {};
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		props[key] = value;
	}
	return props;
}

let cachedConfig: ServerConfig | null = null;

/**
 * Load server config from server.properties. Results are cached —
 * subsequent calls return the same object.
 */
export function loadServerConfig(
	configPath = resolve(process.cwd(), "server.properties"),
): ServerConfig {
	if (cachedConfig) return cachedConfig;

	const props: Record<string, string> = {};

	if (existsSync(configPath)) {
		try {
			const content = readFileSync(configPath, "utf-8");
			Object.assign(props, parseProperties(content));
			console.log(`[ServerConfig] Loaded from ${configPath}`);
		} catch (err) {
			console.warn(
				`[ServerConfig] Failed to read ${configPath}, using defaults:`,
				err,
			);
		}
	} else {
		console.warn(`[ServerConfig] ${configPath} not found, using defaults`);
	}

	cachedConfig = {
		seed: props.seed ?? DEFAULTS.seed,
		serverPort: parseIntSafe(props["server-port"], DEFAULTS.serverPort),
		maxPlayers: parseIntSafe(props["max-players"], DEFAULTS.maxPlayers),
		serverName: props["server-name"] ?? DEFAULTS.serverName,
		gamemode: props.gamemode ?? DEFAULTS.gamemode,
		difficulty: props.difficulty ?? DEFAULTS.difficulty,
		maxReach: parseIntSafe(props["max-reach"], DEFAULTS.maxReach),
		tickRate: parseIntSafe(props["tick-rate"], DEFAULTS.tickRate),
		dayDuration: parseIntSafe(props["day-duration"], DEFAULTS.dayDuration),
		dayCycle: parseBoolean(props["day-cycle"], DEFAULTS.dayCycle),
		wasmEnabled: parseBoolean(props["wasm-enabled"], DEFAULTS.wasmEnabled),
		worldStoragePath: props["world-storage-path"] ?? DEFAULTS.worldStoragePath,
		chunkCacheSize: Math.max(
			0,
			parseIntSafe(props["chunk-cache-size"], DEFAULTS.chunkCacheSize),
		),
	};

	return cachedConfig;
}

/**
 * Get the already-loaded config. Throws if loadServerConfig hasn't been called.
 */
export function getServerConfig(): ServerConfig {
	if (!cachedConfig) {
		throw new Error(
			"ServerConfig not initialized — call loadServerConfig() first",
		);
	}
	return cachedConfig;
}

/**
 * Force a config reload. Used by tests or after editing server.properties.
 */
export function reloadServerConfig(
	configPath = resolve(process.cwd(), "server.properties"),
): ServerConfig {
	cachedConfig = null;
	return loadServerConfig(configPath);
}
