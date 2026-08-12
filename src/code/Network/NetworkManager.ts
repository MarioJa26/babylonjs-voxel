/**
 * NetworkManager — high-level multiplayer coordinator.
 *
 * Integrates with the existing game:
 * - Sends local player position at fixed rate
 * - Receives remote player positions and renders them
 * - Relays block edits (place/break) to other clients
 * - Handles chat
 *
 * Usage:
 *   const net = new NetworkManager(player);
 *   await net.connect("PlayerName", "worldName");
 *   // In game loop: net.tick(deltaMs);
 */

import type { Vec3 } from "@babylonjs/lite";
import { resetDistantTerrain } from "@/code/Generation/DistantTerrain/DistantTerrain";
import { setTerrainSeed } from "@/code/Generation/TerrainHeightMap";
import { debugLog } from "@/code/Lib/debugLog";
import { setIsPaused } from "@/code/Lib/GameRuntimeState";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import { play, playDebris } from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import type { Player } from "@/code/Player/Player";
import { Gamemodes } from "@/code/Player/PlayerStats";
import {
	deleteBlock,
	getLightByWorldCoords,
	setBlock,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "@/code/World/Chunk/ChunkWorkerPool";
import { getWorldNameFromUrl, worldSeedFor } from "@/code/World/WorldContext";
import { WorldStorage } from "@/code/World/WorldStorage";
import { RemoteChunkProvider } from "./chunk/RemoteChunkProvider";
import { MultiplayerHUD } from "./MultiplayerHUD";
import { NetClient, type RemotePlayer } from "./NetClient";
import { BlockActionType, BlockEditRejectReason } from "./protocol/messages";
import { RemotePlayerRenderer } from "./RemotePlayerRenderer";

const SEND_RATE = 20; // Hz — how often to send player position
const SEND_INTERVAL_MS = 1000 / SEND_RATE;

function gamemodeName(gm: Gamemodes): string {
	switch (gm) {
		case Gamemodes.Survival:
			return "Survival";
		case Gamemodes.Creative:
			return "Creative";
		case Gamemodes.Adventure:
			return "Adventure";
		case Gamemodes.Spectator:
			return "Spectator";
		default:
			return "Unknown";
	}
}

export class NetworkManager {
	private client: NetClient;
	private renderer: RemotePlayerRenderer;
	private hud: MultiplayerHUD;
	private chunkProvider: RemoteChunkProvider;
	private player: Player;
	private sendAccum = 0;
	private lastYaw = 0;
	private lastPitch = 0;
	private _scratchVec: Vec3 = vec3Zero();
	private serverSeed: string | null = null;

	constructor(player: Player, serverUrl?: string) {
		this.player = player;
		this.client = new NetClient(serverUrl);
		this.renderer = new RemotePlayerRenderer(Map1.engine, player.sceneRef);
		this.hud = new MultiplayerHUD(
			(msg) => this.sendChat(msg),
			(open) => this.onToggleChat(open),
		);
		this.chunkProvider = new RemoteChunkProvider(this.client);
	}

	async connect(playerName: string, worldName: string): Promise<void> {
		this.client.setCallbacks({
			onConnected: () => {
				console.log("[NetworkManager] Connected to server");
				this.hud.setConnected(true);
				this.hud.addSystemMessage("Connected to server");
			},
			onDisconnected: (code, reason) => {
				console.log(`[NetworkManager] Disconnected: ${code} ${reason}`);
				this.hud.setConnected(false);
				this.hud.addSystemMessage(
					`Disconnected: ${reason ?? "connection closed"}`,
				);
			},
			onPlayerJoin: (player) => {
				console.log(`[NetworkManager] Player joined: ${player.name}`);
				this.renderer.onPlayerJoin(player);
				this.hud.addSystemMessage(`${player.name} joined`);
			},
			onPlayerLeave: (sessionId, name) => {
				console.log(`[NetworkManager] Player left: ${sessionId}`);
				this.renderer.onPlayerLeave(sessionId);
				this.hud.addSystemMessage(`${name ?? "A player"} left`);
			},
			onPlayerStates: (_states) => {
				// States are applied in tick() via interpolation
			},
			onBlockEdit: (edit) => {
				this.applyRemoteBlockEdit(
					edit.x,
					edit.y,
					edit.z,
					edit.blockId,
					edit.action,
				);
			},
			onBlockEditRejected: (rejection) => {
				this.revertRejectedBlockEdit(rejection);
			},
			onChatMessage: (chat) => {
				console.log(`[${chat.name}]: ${chat.message}`);
				this.hud.addChatMessage(chat.name, chat.message);
			},
			onWorldTime: (timeOfDay) => {
				// Sync to server time — server is authoritative
				Map1.environment?.setTime(timeOfDay);
			},
			onWorldConfig: (seed) => {
				// Server sent authoritative seed — re-seed local terrain so the
				// clip map matches the server's distant terrain.
				console.log(`[NetworkManager] Received server seed: ${seed}`);
				this.serverSeed = seed;
				setTerrainSeed(seed);
				ChunkWorkerPool.getInstance(2)?.setWorldSeed(seed);
				resetDistantTerrain();
			},
			onSpawnPosition: (pos) => {
				// Teleport to server-assigned spawn (saved position)
				this.player.playerVehicle.restoreSavedPosition(pos);
				this.player.playerVehicle.updateCameraAndVisuals();
			},
			onServerError: (code, message) => {
				console.error(`[NetworkManager] Server error ${code}: ${message}`);
			},
		});

		// Clear local chunk cache so stale chunks are re-fetched from server
		await this.chunkProvider.clearCache();
		// The singleplayer store (WorldStorage) shares the same IndexedDB and
		// hydrates chunks from saved voxel data — wipe its memory cache + the
		// shared DB too, otherwise locally saved terrain can be applied to
		// chunks without ever asking the server.
		await WorldStorage.clearLocalChunkCache();

		// Multiplayer: don't send a seed — the server uses its config seed.
		// The server sends back the authoritative seed via WorldConfig on join,
		// which re-seeds our local terrain (see onWorldConfig callback).
		await this.client.connect(playerName, worldName, "");

		// Enable server-side chunk generation
		ChunkWorkerPool.getInstance(2)?.setRemoteChunkProvider(this.chunkProvider);
	}

	/**
	 * Called every frame from the game loop.
	 */
	tick(deltaMs: number): void {
		if (!this.client.isConnected) return;

		// Update remote player interpolation
		this.client.updateRemotePlayerInterpolation(deltaMs / 1000);

		// Update renderer with camera for name tag projection
		const cam = this.player.playerCamera.playerCamera;
		const canvas = (this.player.sceneRef as any).engine?.getRenderingCanvas();
		const w = canvas?.clientWidth ?? window.innerWidth;
		const h = canvas?.clientHeight ?? window.innerHeight;
		this.renderer.update(cam, w, h);

		// Update HUD player count and names
		const remotePlayers = this.client.getRemotePlayers();
		const names = Array.from(remotePlayers.values()).map((p) => p.name);
		this.hud.setPlayerNames(names);

		// Send our position at fixed rate
		this.sendAccum += deltaMs;
		if (this.sendAccum >= SEND_INTERVAL_MS) {
			this.sendAccum -= SEND_INTERVAL_MS;
			this.sendPlayerState();
		}
	}

	/**
	 * Toggle chat input (called by the 'T' key handler).
	 */
	toggleChat(): void {
		this.hud.openChat();
	}

	private onToggleChat(open: boolean): void {
		// Pause/unpause player input while typing
		setIsPaused(open);
	}

	private sendPlayerState(): void {
		const pos = this.player.position;
		const cam = this.player.playerCamera.playerCamera;

		// Extract yaw/pitch from camera
		const dx = cam.target.x - cam.position.x;
		const dy = cam.target.y - cam.position.y;
		const dz = cam.target.z - cam.position.z;
		const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
		const pitch =
			(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180) / Math.PI;

		this.client.sendPlayerState(pos.x, pos.y, pos.z, yaw, pitch, 0);
		this.lastYaw = yaw;
		this.lastPitch = pitch;
	}

	/**
	 * Called when the local player places a block.
	 * Sends the edit to the server for broadcast.
	 */
	onBlockPlaced = (x: number, y: number, z: number, blockId: number): void => {
		if (!this.client.isConnected) return;
		this.client.sendBlockEdit(x, y, z, blockId, BlockActionType.Place);
	};

	/**
	 * Called when the local player breaks a block.
	 * Sends the edit to the server for broadcast.
	 */
	onBlockBroken = (x: number, y: number, z: number, blockId: number): void => {
		if (!this.client.isConnected) return;
		this.client.sendBlockEdit(x, y, z, blockId, BlockActionType.Break);
	};

	/**
	 * Apply a block edit received from another client.
	 * Particles are emitted locally — never transmitted over the network.
	 */
	private applyRemoteBlockEdit(
		x: number,
		y: number,
		z: number,
		blockId: number,
		action: number,
	): void {
		debugLog(
			`[NetworkManager] applyRemoteBlockEdit: ${action === BlockActionType.Place ? "PLACE" : "BREAK"} blockId=${blockId} at ${x},${y},${z}`,
		);
		if (action === BlockActionType.Place) {
			setBlock(x, y, z, blockId, 0);
		} else if (action === BlockActionType.Break) {
			// Sample light BEFORE deleting — deleteBlock clears the voxel's
			// light data, which would make particles render black.
			const px = x + 0.5;
			const py = y + 0.5;
			const pz = z + 0.5;
			const packedLight = this.#sampleBreakLight(px, py, pz);

			deleteBlock(x, y, z);

			play(
				this.player.sceneRef,
				setVec3(this._scratchVec, px, py, pz),
				blockId,
				packedLight,
			);
			playDebris(this.player.sceneRef, px, py, pz, blockId, packedLight);
		}
	}

	/**
	 * The server rejected one of our own block edits — revert the optimistic
	 * local change so client and server stay in sync.
	 */
	private revertRejectedBlockEdit(rejection: {
		x: number;
		y: number;
		z: number;
		blockId: number;
		action: number;
		reason: number;
	}): void {
		if (rejection.action === BlockActionType.Place) {
			deleteBlock(rejection.x, rejection.y, rejection.z);
		} else if (rejection.action === BlockActionType.Break) {
			setBlock(rejection.x, rejection.y, rejection.z, rejection.blockId, 0);
		}
		const reason =
			rejection.reason === BlockEditRejectReason.TooFar
				? "too far away"
				: rejection.reason === BlockEditRejectReason.InvalidEdit
					? "invalid edit"
					: "unknown reason";
		this.hud.addSystemMessage(`Block edit rejected (${reason}) — reverted`);
	}

	#sampleBreakLight(x: number, y: number, z: number): number {
		let best = getLightByWorldCoords(x, y, z);
		let bestSky = (best >> 4) & 0xf;
		let bestBlock = best & 0xf;
		const offsets: [number, number, number][] = [
			[0.5, 0, 0],
			[-0.5, 0, 0],
			[0, 0.5, 0],
			[0, -0.5, 0],
			[0, 0, 0.5],
			[0, 0, -0.5],
		];
		for (const [dx, dy, dz] of offsets) {
			const l = getLightByWorldCoords(x + dx, y + dy, z + dz);
			const sky = (l >> 4) & 0xf;
			const block = l & 0xf;
			if (sky + block > bestSky + bestBlock) {
				bestSky = sky;
				bestBlock = block;
				best = l;
			}
		}
		return best;
	}

	sendChat(message: string): void {
		// Intercept commands (start with ! or /) — run locally, don't broadcast
		if (message.startsWith("!") || message.startsWith("/")) {
			this.handleCommand(message.slice(1).trim());
			return;
		}
		this.client.sendChat(message);
	}

	private handleCommand(raw: string): void {
		const parts = raw.split(/\s+/);
		const cmd = parts[0]?.toLowerCase();
		const args = parts.slice(1);

		switch (cmd) {
			case "g":
			case "gamemode": {
				const gm = this.parseGamemode(args[0]);
				if (gm !== null) {
					this.player.stats.gamemode = gm;
					this.hud.addSystemMessage(`Gamemode set to ${gamemodeName(gm)}`);
				} else {
					this.hud.addSystemMessage(
						"Usage: !g <gamemode> (survival, creative, adventure, spectator)",
					);
				}
				break;
			}
			case "tp":
			case "teleport":
				this.handleTeleport(args);
				break;
			case "seed": {
				// In multiplayer, show the server's authoritative seed
				if (this.serverSeed !== null) {
					this.hud.addSystemMessage(`Server seed: ${this.serverSeed}`);
				} else {
					const worldName = getWorldNameFromUrl() ?? "default";
					this.hud.addSystemMessage(
						`World "${worldName}" seed: ${worldSeedFor(worldName)}`,
					);
				}
				break;
			}
			case "h":
			case "help":
				this.hud.addSystemMessage("Commands:");
				this.hud.addSystemMessage(
					"  !g <gamemode> - Set gamemode (survival, creative, adventure, spectator)",
				);
				this.hud.addSystemMessage(
					"  !tp <x> <y> <z> - Teleport to coordinates (~ for current)",
				);
				this.hud.addSystemMessage("  !tp <x> <z> - Teleport keeping current y");
				this.hud.addSystemMessage(
					"  !seed       - Show the current world's seed",
				);
				this.hud.addSystemMessage("  !h / !help   - Show this help");
				break;
			default:
				this.hud.addSystemMessage(`Unknown command: ${cmd}`);
		}
	}

	private parseGamemode(input: string | undefined): Gamemodes | null {
		if (!input) return null;
		const lower = input.toLowerCase();
		if (lower === "0" || lower === "survival") return Gamemodes.Survival;
		if (lower === "1" || lower === "creative") return Gamemodes.Creative;
		if (lower === "2" || lower === "adventure") return Gamemodes.Adventure;
		if (lower === "3" || lower === "spectator") return Gamemodes.Spectator;
		return null;
	}

	private handleTeleport(args: string[]): void {
		const pos = this.player.position;
		const current = { x: pos.x, y: pos.y, z: pos.z };

		const parseCoord = (input: string, current: number): number | null => {
			if (input === "~") return current;
			if (input.startsWith("~")) {
				const offset = Number.parseFloat(input.slice(1));
				if (Number.isNaN(offset)) return null;
				return current + offset;
			}
			const val = Number.parseFloat(input);
			return Number.isNaN(val) ? null : val;
		};

		if (args.length === 2) {
			const x = parseCoord(args[0], current.x);
			const z = parseCoord(args[1], current.z);
			if (x === null || z === null) {
				this.hud.addSystemMessage("Usage: !tp <x> <z>");
				return;
			}
			pos.x = x;
			pos.z = z;
			this.hud.addSystemMessage(`Teleported to ${x} ${current.y} ${z}`);
		} else if (args.length === 3) {
			const x = parseCoord(args[0], current.x);
			const y = parseCoord(args[1], current.y);
			const z = parseCoord(args[2], current.z);
			if (x === null || y === null || z === null) {
				this.hud.addSystemMessage("Usage: !tp <x> <y> <z>");
				return;
			}
			pos.x = x;
			pos.y = y;
			pos.z = z;
			this.hud.addSystemMessage(`Teleported to ${x} ${y} ${z}`);
		} else {
			this.hud.addSystemMessage("Usage: !tp <x> <y> <z> or !tp <x> <z>");
		}
	}

	disconnect(): void {
		ChunkWorkerPool.getInstance(2)?.setRemoteChunkProvider(null);
		this.client.disconnect();
		this.renderer.dispose();
		this.hud.dispose();
	}

	get isConnected(): boolean {
		return this.client.isConnected;
	}

	get remotePlayers(): Map<string, RemotePlayer> {
		return this.client.getRemotePlayers();
	}
}
