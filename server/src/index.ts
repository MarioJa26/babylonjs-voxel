/**
 * b102 Multiplayer Server
 *
 * Colyseus + ws-transport for shared voxel worlds.
 * Run with: npm run dev (tsx watch)
 */

import { WebSocketTransport } from "@colyseus/ws-transport";
import { Server } from "colyseus";
import { VoxelRoom } from "./rooms/VoxelRoom.ts";

const PORT = Number(process.env.PORT) || 2567;

// Colyseus game server with WebSocket transport
const gameServer = new Server({
	transport: new WebSocketTransport(),
});

// Register room handlers
gameServer.define("voxel", VoxelRoom);

// Start listening
gameServer
	.listen(PORT)
	.then(() => {
		console.log(`[b102-server] Listening on ws://localhost:${PORT}`);
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
