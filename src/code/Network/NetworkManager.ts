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
import { setSpawnPosition } from "@/code/World/SpawnPoint";
import { getWorldNameFromUrl, worldSeedFor } from "@/code/World/WorldContext";
import { WorldStorage } from "@/code/World/WorldStorage";
import { RemoteChunkProvider } from "./chunk/RemoteChunkProvider";
import { MultiplayerHUD } from "./MultiplayerHUD";
import { NetClient, type RemotePlayer } from "./NetClient";
import { BlockActionType, BlockEditRejectReason } from "./protocol/messages";
import { RemotePlayerRenderer } from "./RemotePlayerRenderer";

const SEND_RATE = 20;
const SEND_INTERVAL_MS = 1000 / SEND_RATE;

const NET_DEBUG = false;

const BREAK_LIGHT_OFFSET_X = [0.5, -0.5, 0, 0, 0, 0];
const BREAK_LIGHT_OFFSET_Y = [0, 0, 0.5, -0.5, 0, 0];
const BREAK_LIGHT_OFFSET_Z = [0, 0, 0, 0, 0.5, -0.5];

const HELP_MESSAGES = [
	"Commands:",
	"  !g <gamemode> - Set gamemode (survival, creative, adventure, spectator)",
	"  !tp <x> <y> <z> - Teleport to coordinates (~ for current)",
	"  !tp <x> <z> - Teleport keeping current y",
	"  !seed       - Show the current world's seed",
	"  !h / !help   - Show this help",
] as const;

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

function parseRelativeCoord(input: string, current: number): number | null {
	if (input === "~") return current;

	if (input.charCodeAt(0) === 126) {
		const offset = Number.parseFloat(input.slice(1));
		return Number.isNaN(offset) ? null : current + offset;
	}

	const value = Number.parseFloat(input);
	return Number.isNaN(value) ? null : value;
}

export class NetworkManager {
	private client: NetClient;
	private renderer: RemotePlayerRenderer;
	private hud: MultiplayerHUD;
	private chunkProvider: RemoteChunkProvider;
	private player: Player;
	private sendAccum = 0;
	private _scratchVec: Vec3 = vec3Zero();
	private serverSeed: string | null = null;
	private _lastPlayerCount = 0;
	private _canvas: HTMLCanvasElement | null = null;

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
			onPlayerStates: () => {
				// States are applied in tick() via interpolation.
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
				Map1.environment?.setTime(timeOfDay);
			},
			onWorldConfig: (seed) => {
				console.log(`[NetworkManager] Received server seed: ${seed}`);
				this.serverSeed = seed;
				setTerrainSeed(seed);
				ChunkWorkerPool.getInstance()?.setWorldSeed(seed);
				resetDistantTerrain();
			},
			onSpawnPosition: (pos) => {
				setSpawnPosition({ x: pos.x, y: pos.y, z: pos.z });
				this.player.playerVehicle.restoreSavedPosition(pos);
				this.player.playerVehicle.updateCameraAndVisuals();
			},
			onServerError: (code, message) => {
				console.error(`[NetworkManager] Server error ${code}: ${message}`);
			},
		});

		const workerPool = ChunkWorkerPool.getInstance();
		workerPool?.enableRemoteMode();

		const t0 = performance.now();
		console.log(`[MP-connect] enableRemoteMode @ ${t0.toFixed(0)}ms`);

		await Promise.all([
			this.chunkProvider.clearCache(),
			WorldStorage.clearLocalChunkCache(),
		]);

		console.log(
			`[MP-connect] after clearCache+localClear: ${(performance.now() - t0).toFixed(0)}ms`,
		);

		try {
			await this.client.connect(playerName, worldName, "");
			console.log(
				`[MP-connect] joinOrCreate resolved: ${(performance.now() - t0).toFixed(0)}ms`,
			);
		} catch (err) {
			workerPool?.disableRemoteMode();
			throw err;
		}

		workerPool?.setRemoteChunkProvider(this.chunkProvider);
	}

	/**
	 * Called every frame from the game loop.
	 */
	tick(deltaMs: number): void {
		const client = this.client;
		if (!client.isConnected) return;

		client.updateRemotePlayerInterpolation(deltaMs / 1000);

		const camera = this.player.playerCamera.playerCamera;

		let canvas = this._canvas;
		if (canvas === null) {
			canvas =
				(this.player.sceneRef as any).engine?.getRenderingCanvas() ?? null;
			this._canvas = canvas;
		}

		this.renderer.update(
			camera,
			canvas?.clientWidth ?? window.innerWidth,
			canvas?.clientHeight ?? window.innerHeight,
		);

		const remotePlayers = client.getRemotePlayers();
		const playerCount = remotePlayers.size;

		if (playerCount !== this._lastPlayerCount) {
			this._lastPlayerCount = playerCount;

			const names = new Array<string>(playerCount);
			let i = 0;
			for (const player of remotePlayers.values()) {
				names[i++] = player.name;
			}

			this.hud.setPlayerNames(names);
		}

		this.sendAccum += deltaMs;
		if (this.sendAccum >= SEND_INTERVAL_MS) {
			this.sendAccum -= SEND_INTERVAL_MS;
			this.sendPlayerState();
		}
	}

	/**
	 * Toggle chat input, called by the 'T' key handler.
	 */
	toggleChat(): void {
		this.hud.openChat();
	}

	private onToggleChat(open: boolean): void {
		setIsPaused(open);
	}

	private sendPlayerState(): void {
		const pos = this.player.position;
		const cam = this.player.playerCamera.playerCamera;

		const dx = cam.target.x - cam.position.x;
		const dy = cam.target.y - cam.position.y;
		const dz = cam.target.z - cam.position.z;

		const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
		const pitch =
			(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180) / Math.PI;

		this.client.sendPlayerState(pos.x, pos.y, pos.z, yaw, pitch, 0);
	}

	/**
	 * Called when the local player places a block.
	 * Sends the edit to the server for broadcast.
	 */
	onBlockPlaced = (x: number, y: number, z: number, blockId: number): void => {
		if (this.client.isConnected) {
			this.client.sendBlockEdit(x, y, z, blockId, BlockActionType.Place);
		}
	};

	/**
	 * Called when the local player breaks a block.
	 * Sends the edit to the server for broadcast.
	 */
	onBlockBroken = (x: number, y: number, z: number, blockId: number): void => {
		if (this.client.isConnected) {
			this.client.sendBlockEdit(x, y, z, blockId, BlockActionType.Break);
		}
	};

	/**
	 * Apply a block edit received from another client.
	 * Particles are emitted locally, never transmitted over the network.
	 */
	private applyRemoteBlockEdit(
		x: number,
		y: number,
		z: number,
		blockId: number,
		action: number,
	): void {
		if (NET_DEBUG) {
			debugLog(
				`[NetworkManager] applyRemoteBlockEdit: ${
					action === BlockActionType.Place ? "PLACE" : "BREAK"
				} blockId=${blockId} at ${x},${y},${z}`,
			);
		}

		if (action === BlockActionType.Place) {
			setBlock(x, y, z, blockId, 0);
			return;
		}

		if (action !== BlockActionType.Break) return;

		const px = x + 0.5;
		const py = y + 0.5;
		const pz = z + 0.5;
		const packedLight = this.sampleBreakLight(px, py, pz);

		deleteBlock(x, y, z);

		play(
			this.player.sceneRef,
			setVec3(this._scratchVec, px, py, pz),
			blockId,
			packedLight,
		);
		playDebris(this.player.sceneRef, px, py, pz, blockId, packedLight);
	}

	/**
	 * The server rejected one of our own block edits.
	 * Revert the optimistic local change so client and server stay in sync.
	 */
	private revertRejectedBlockEdit(rejection: {
		x: number;
		y: number;
		z: number;
		blockId: number;
		action: number;
		reason: number;
	}): void {
		const { x, y, z, blockId, action, reason } = rejection;

		if (action === BlockActionType.Place) {
			deleteBlock(x, y, z);
		} else if (action === BlockActionType.Break) {
			setBlock(x, y, z, blockId, 0);
		}

		let reasonText = "unknown reason";
		if (reason === BlockEditRejectReason.TooFar) {
			reasonText = "too far away";
		} else if (reason === BlockEditRejectReason.InvalidEdit) {
			reasonText = "invalid edit";
		}

		this.hud.addSystemMessage(`Block edit rejected (${reasonText}) — reverted`);
	}

	private sampleBreakLight(x: number, y: number, z: number): number {
		let best = getLightByWorldCoords(x, y, z);
		let bestSky = (best >> 4) & 0xf;
		let bestBlock = best & 0xf;
		let bestScore = bestSky + bestBlock;

		for (let i = 0; i < 6; i++) {
			const light = getLightByWorldCoords(
				x + BREAK_LIGHT_OFFSET_X[i],
				y + BREAK_LIGHT_OFFSET_Y[i],
				z + BREAK_LIGHT_OFFSET_Z[i],
			);

			const sky = (light >> 4) & 0xf;
			const block = light & 0xf;
			const score = sky + block;

			if (score > bestScore) {
				best = light;
				bestSky = sky;
				bestBlock = block;
				bestScore = score;
			}
		}

		return best;
	}

	sendChat(message: string): void {
		const firstChar = message.charCodeAt(0);

		if (firstChar === 33 || firstChar === 47) {
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
				const serverSeed = this.serverSeed;

				if (serverSeed !== null) {
					this.hud.addSystemMessage(`Server seed: ${serverSeed}`);
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
				for (let i = 0; i < HELP_MESSAGES.length; i++) {
					this.hud.addSystemMessage(HELP_MESSAGES[i]);
				}
				break;

			default:
				this.hud.addSystemMessage(`Unknown command: ${cmd}`);
		}
	}

	private parseGamemode(input: string | undefined): Gamemodes | null {
		if (input === undefined) return null;

		switch (input.toLowerCase()) {
			case "0":
			case "survival":
				return Gamemodes.Survival;

			case "1":
			case "creative":
				return Gamemodes.Creative;

			case "2":
			case "adventure":
				return Gamemodes.Adventure;

			case "3":
			case "spectator":
				return Gamemodes.Spectator;

			default:
				return null;
		}
	}

	private handleTeleport(args: string[]): void {
		const pos = this.player.position;
		const currentX = pos.x;
		const currentY = pos.y;
		const currentZ = pos.z;

		if (args.length === 2) {
			const x = parseRelativeCoord(args[0], currentX);
			const z = parseRelativeCoord(args[1], currentZ);

			if (x === null || z === null) {
				this.hud.addSystemMessage("Usage: !tp <x> <z>");
				return;
			}

			pos.x = x;
			pos.z = z;
			this.hud.addSystemMessage(`Teleported to ${x} ${currentY} ${z}`);
			return;
		}

		if (args.length === 3) {
			const x = parseRelativeCoord(args[0], currentX);
			const y = parseRelativeCoord(args[1], currentY);
			const z = parseRelativeCoord(args[2], currentZ);

			if (x === null || y === null || z === null) {
				this.hud.addSystemMessage("Usage: !tp <x> <y> <z>");
				return;
			}

			pos.x = x;
			pos.y = y;
			pos.z = z;
			this.hud.addSystemMessage(`Teleported to ${x} ${y} ${z}`);
			return;
		}

		this.hud.addSystemMessage("Usage: !tp <x> <y> <z> or !tp <x> <z>");
	}

	disconnect(): void {
		ChunkWorkerPool.getInstance()?.setRemoteChunkProvider(null);
		this.client.disconnect();
		this.renderer.dispose();
		this.hud.dispose();
		this._canvas = null;
	}

	get isConnected(): boolean {
		return this.client.isConnected;
	}

	get remotePlayers(): Map<string, RemotePlayer> {
		return this.client.getRemotePlayers();
	}
}
