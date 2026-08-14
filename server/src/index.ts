/**
 * b102 Multiplayer Server
 *
 * Colyseus + ws-transport for shared voxel worlds, plus a small HTTP API
 * (express) used by the client's multiplayer server list to show a live
 * MOTD, player count, and client-measured ping without joining a room.
 *
 * Run with: npm run dev (tsx watch)
 */

import { WebSocketTransport } from "@colyseus/ws-transport";
import { Server } from "colyseus";
import type express from "express";
import { getServerConfig, loadServerConfig } from "./config/ServerConfig.ts";
import { getOnlinePlayers, VoxelRoom } from "./rooms/VoxelRoom.ts";

const STATUS_ROUTE = "/api/status";
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

// Load server.properties once at startup.
const config = loadServerConfig();
const PORT = Number(process.env.PORT) || config.serverPort;

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

	const cfg = getServerConfig();

	res.json({
		name: cfg.serverName,
		motd: cfg.motd,
		version: cfg.version,
		maxPlayers: cfg.maxPlayers,
		players: getOnlinePlayers(),
	});
}

const gameServer = new Server({
	transport: new WebSocketTransport(),
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
		process.exit(0);
	} catch (err) {
		console.error("[b102-server] Shutdown failed:", err);
		process.exit(1);
	}
}

for (const signal of SHUTDOWN_SIGNALS) {
	process.once(signal, () => {
		void shutdown(signal);
	});
}

gameServer
	.listen(PORT)
	.then(() => {
		const statusUrl = `http://localhost:${PORT}${STATUS_ROUTE}`;

		console.log(`[b102-server] Listening on ws://localhost:${PORT}`);
		console.log(`[b102-server] Status API: ${statusUrl}`);
	})
	.catch((err) => {
		console.error("[b102-server] Failed to start:", err);
		process.exit(1);
	});
