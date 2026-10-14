/**
 * b102 Multiplayer Server
 *
 * Colyseus + ws-transport for shared voxel worlds, plus a small HTTP API
 * used by the client's multiplayer server list to retrieve the live MOTD,
 * player count, version, and client-measured ping without joining a room.
 *
 * Run with: npm run dev
 */

import { WebSocketTransport } from "@colyseus/ws-transport";
import { Server } from "colyseus";
import type express from "express";
import { getServerConfig, loadServerConfig } from "./config/ServerConfig.ts";
import { getOnlinePlayers, VoxelRoom } from "./rooms/VoxelRoom.ts";

const STATUS_ROUTE = "/api/status";
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const WS_MAX_PAYLOAD = 64 * 1024;

// Load server.properties once during startup.
const config = loadServerConfig();

const environmentPort = Number(process.env.PORT);
const PORT =
	Number.isInteger(environmentPort) &&
	environmentPort > 0 &&
	environmentPort <= 65_535
		? environmentPort
		: config.serverPort;

function setCors(res: express.Response): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handleStatusOptions(
	_req: express.Request,
	res: express.Response,
): void {
	setCors(res);
	res.sendStatus(204);
}

function handleStatus(_req: express.Request, res: express.Response): void {
	setCors(res);
	res.setHeader("Cache-Control", "no-store");

	const currentConfig = getServerConfig();

	res.json({
		name: currentConfig.serverName,
		motd: currentConfig.motd,
		version: currentConfig.version,
		maxPlayers: currentConfig.maxPlayers,
		players: getOnlinePlayers(),
	});
}

const gameServer = new Server({
	/*
	 * ws-transport defaults to a 4 KB incoming-frame limit. Avatar skin
	 * uploads can reach 16 KB, so use a bounded 64 KB limit.
	 *
	 * maxPayload applies only to frames received by the server. It does not
	 * constrain outgoing chunk batches.
	 */
	transport: new WebSocketTransport({
		maxPayload: WS_MAX_PAYLOAD,
	}),

	express: (app) => {
		app.options(STATUS_ROUTE, handleStatusOptions);
		app.get(STATUS_ROUTE, handleStatus);
	},
});

gameServer.define("voxel", VoxelRoom);

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
	if (isShuttingDown) return;

	isShuttingDown = true;
	console.log(`\n[b102-server] Received ${signal}. Shutting down...`);

	try {
		await gameServer.gracefullyShutdown();
		console.log("[b102-server] Shutdown complete");
		process.exitCode = 0;
	} catch (error) {
		console.error("[b102-server] Shutdown failed:", error);
		process.exitCode = 1;
	}
}

for (const signal of SHUTDOWN_SIGNALS) {
	process.once(signal, () => {
		void shutdown(signal);
	});
}

async function startServer(): Promise<void> {
	try {
		await gameServer.listen(PORT);

		const host = "localhost";
		const statusUrl = `http://${host}:${PORT}${STATUS_ROUTE}`;

		console.log(`[b102-server] Listening on ws://${host}:${PORT}`);
		console.log(`[b102-server] Status API: ${statusUrl}`);
	} catch (error) {
		console.error("[b102-server] Failed to start:", error);
		process.exitCode = 1;
	}
}

void startServer();
