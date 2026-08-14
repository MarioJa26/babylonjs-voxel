/**
 * b102 Multiplayer Server
 *
 * Colyseus + ws-transport for shared voxel worlds, plus a small HTTP API
 * (express) used by the client's multiplayer server list to show a live
 * MOTD, player count, and (client-measured) ping without joining a room.
 *
 * Run with: npm run dev (tsx watch)
 */

import { WebSocketTransport } from "@colyseus/ws-transport";
import { Server } from "colyseus";
import type express from "express";
import { getServerConfig, loadServerConfig } from "./config/ServerConfig.ts";
import { getOnlinePlayers, VoxelRoom } from "./rooms/VoxelRoom.ts";

// Load server.properties (seed, port, max-players, etc.)
const config = loadServerConfig();
const PORT = Number(process.env.PORT) || config.serverPort;

// ─── HTTP API (express) ──────────────────────────────────────────────
// Served on the same port as Colyseus via the `express` Server option.
// The browser dev origin differs from the server origin, so CORS must be
// explicitly allowed.
function setCors(res: express.Response): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── Colyseus game server ────────────────────────────────────────────
const gameServer = new Server({
	transport: new WebSocketTransport(),
	express: (app) => {
		app.options("/api/status", (_req, res) => {
			setCors(res);
			res.sendStatus(204);
		});
		app.get("/api/status", (_req, res) => {
			setCors(res);
			const cfg = getServerConfig();
			res.json({
				name: cfg.serverName,
				motd: cfg.motd,
				version: cfg.version,
				maxPlayers: cfg.maxPlayers,
				players: getOnlinePlayers(),
			});
		});
	},
});

// Register room handlers
gameServer.define("voxel", VoxelRoom);

// Start listening
gameServer
	.listen(PORT)
	.then(() => {
		console.log(`[b102-server] Listening on ws://localhost:${PORT}`);
		console.log(
			`[b102-server] Status API: http://localhost:${PORT}/api/status`,
		);
	})
	.catch((err) => {
		console.error("[b102-server] Failed to start:", err);
		process.exit(1);
	});

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\n[b102-server] Shutting down...");
	gameServer.gracefullyShutdown().then(() => {
		console.log("[b102-server] Shutdown complete");
		process.exit(0);
	});
});
