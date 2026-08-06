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
import { isUiOpen, setIsPaused } from "@/code/Lib/GameRuntimeState";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import { play, playDebris } from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import type { Player } from "@/code/Player/Player";
import {
	deleteBlock,
	getLightByWorldCoords,
	setBlock,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { MultiplayerHUD } from "./MultiplayerHUD";
import { NetClient, type RemotePlayer } from "./NetClient";
import { BlockActionType } from "./protocol/messages";
import { RemotePlayerRenderer } from "./RemotePlayerRenderer";

const SEND_RATE = 20; // Hz — how often to send player position
const SEND_INTERVAL_MS = 1000 / SEND_RATE;

export class NetworkManager {
	private client: NetClient;
	private renderer: RemotePlayerRenderer;
	private hud: MultiplayerHUD;
	private player: Player;
	private sendAccum = 0;
	private lastYaw = 0;
	private lastPitch = 0;
	private _scratchVec: Vec3 = vec3Zero();

	constructor(player: Player, serverUrl?: string) {
		this.player = player;
		this.client = new NetClient(serverUrl);
		this.renderer = new RemotePlayerRenderer(Map1.engine, player.sceneRef);
		this.hud = new MultiplayerHUD(
			(msg) => this.sendChat(msg),
			(open) => this.onToggleChat(open),
		);
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
			onPlayerLeave: (sessionId) => {
				console.log(`[NetworkManager] Player left: ${sessionId}`);
				this.renderer.onPlayerLeave(sessionId);
				// Try to get the name from remotePlayers before it's removed
				const rp = this.client.getRemotePlayer(sessionId);
				this.hud.addSystemMessage(`${rp?.name ?? "A player"} left`);
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
			onChatMessage: (chat) => {
				console.log(`[${chat.name}]: ${chat.message}`);
				this.hud.addChatMessage(chat.name, chat.message);
			},
			onServerError: (code, message) => {
				console.error(`[NetworkManager] Server error ${code}: ${message}`);
			},
		});

		await this.client.connect(playerName, worldName);
	}

	/**
	 * Called every frame from the game loop.
	 */
	tick(deltaMs: number): void {
		if (!this.client.isConnected) return;

		// Update remote player interpolation
		this.client.updateRemotePlayerInterpolation(deltaMs / 1000);
		this.renderer.update();

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
		if (action === BlockActionType.Place) {
			setBlock(x, y, z, blockId, 0);
		} else if (action === BlockActionType.Break) {
			deleteBlock(x, y, z);

			// Emit break particles locally (not transmitted over network)
			const px = x + 0.5;
			const py = y + 0.5;
			const pz = z + 0.5;
			const packedLight = getLightByWorldCoords(px, py, pz);

			play(
				this.player.sceneRef,
				setVec3(this._scratchVec, px, py, pz),
				blockId,
				packedLight,
			);
			playDebris(this.player.sceneRef, px, py, pz, blockId, packedLight);
		}
	}

	sendChat(message: string): void {
		this.client.sendChat(message);
	}

	disconnect(): void {
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
