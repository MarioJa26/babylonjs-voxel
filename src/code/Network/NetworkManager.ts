/**
 * NetworkManager â€” high-level multiplayer coordinator.
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
import { spawnRemotePrimedTnt } from "@/code/Entities/PrimedTnt";
import { resetDistantTerrain } from "@/code/Generation/DistantTerrain/DistantTerrain";
import { setTerrainSeed } from "@/code/Generation/TerrainHeightMap";
import { debugLog } from "@/code/Lib/debugLog";
import { setIsPaused } from "@/code/Lib/GameRuntimeState";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import { play, playDebris, playPlace } from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import {
	currentWorldSeed,
	runLocateCommand,
} from "@/code/Player/LocateCommand";
import type { Player } from "@/code/Player/Player";
import { Gamemodes } from "@/code/Player/PlayerStats";
import {
	deleteBlock,
	getBlockByWorldCoords,
	getLightByWorldCoords,
	setBlock,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "@/code/World/Chunk/ChunkWorkerPool";
import { FarTileManager } from "@/code/World/FarTiles/FarTileManager";
import { setSpawnPosition } from "@/code/World/SpawnPoint";
import { getWorldNameFromUrl, worldSeedFor } from "@/code/World/WorldContext";
import { WorldStorage } from "@/code/World/WorldStorage";
import { RemoteChunkProvider } from "./chunk/RemoteChunkProvider";
import { MultiplayerHUD } from "./MultiplayerHUD";
import { NetClient, type RemotePlayer } from "./NetClient";
import { BlockActionType, BlockEditRejectReason } from "./protocol/messages";
import { RemoteContainerManager } from "./RemoteContainerManager";
import { RemotePlayerRenderer } from "./RemotePlayerRenderer";
import { RemoteStationManager } from "./RemoteStationManager";

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
	"  !time        - Show the current time of day (0-1000)",
	"  !time <0-1000> - Set the time of day",
	"  !time +<amt> - Advance the time of day",
	"  !time day    - Set to day",
	"  !seed       - Show the current world's seed",
	"  !locate <name> - Find the nearest structure",
	"  !locate <name> tp - ...and teleport there (keeps current y)",
	"  !locate all  - List the nearest of every structure",
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
	/** Server-authoritative crate sync (owned here so the HUD can reach it). */
	readonly containers: RemoteContainerManager;
	readonly stations: RemoteStationManager;
	private player: Player;
	private sendAccum = 0;
	private lastSentHeldItemId = -1;
	private lastSentHeldItemBlockState = -1;
	// Last state actually sent to the server, quantized to wire values. The
	// idle-skip compares against this so identical bytes are never re-sent.
	private hasLastSentState = false;
	private lastSentX = 0;
	private lastSentY = 0;
	private lastSentZ = 0;
	private lastSentYawByte = 0;
	private lastSentPitchByte = 0;
	private _scratchVec: Vec3 = vec3Zero();
	private serverSeed: string | null = null;
	private disposed = false;
	private _canvas: HTMLCanvasElement | null = null;
	// Canvas size cache â€” reading clientWidth/clientHeight forces layout, so
	// they are sampled once per resize instead of on every frame.
	private _canvasWidth = 0;
	private _canvasHeight = 0;
	private readonly _onCanvasResize = (): void => {
		const canvas = this._canvas;
		if (!canvas) return;
		this._canvasWidth = canvas.clientWidth;
		this._canvasHeight = canvas.clientHeight;
	};

	constructor(player: Player, serverUrl?: string) {
		this.player = player;
		this.client = new NetClient(serverUrl);
		this.renderer = new RemotePlayerRenderer(Map1.engine, player.sceneRef);
		this.hud = new MultiplayerHUD(
			(msg) => this.sendChat(msg),
			(open) => this.onToggleChat(open),
		);
		this.chunkProvider = new RemoteChunkProvider(this.client);
		this.containers = new RemoteContainerManager(this.client);
		this.stations = new RemoteStationManager(this.client);
		this.initializeCanvas();
	}

	private initializeCanvas(): void {
		if (this._canvas !== null) return;

		const scene = this.player.sceneRef as unknown as {
			engine?: {
				getRenderingCanvas?: () => HTMLCanvasElement | null;
			};
		};

		const canvas = scene.engine?.getRenderingCanvas?.() ?? null;
		this._canvas = canvas;

		if (canvas === null) return;

		this._canvasWidth = canvas.clientWidth;
		this._canvasHeight = canvas.clientHeight;
		window.addEventListener("resize", this._onCanvasResize);
	}

	async connect(playerName: string, worldName: string): Promise<void> {
		this.initializeCanvas();
		this.client.setCallbacks({
			onConnected: () => {
				this.hasLastSentState = false;
				this.lastSentHeldItemId = -1;
				this.lastSentHeldItemBlockState = -1;
				this.sendHeldItemSelection();
				console.log("[NetworkManager] Connected to server");
				this.hud.setConnected(true);
				this.hud.addSystemMessage("Connected to server");
				this.refreshPlayerNames();
			},
			onDisconnected: (code, reason) => {
				console.log(`[NetworkManager] Disconnected: ${code} ${reason}`);
				this.hasLastSentState = false;
				this.sendAccum = 0;
				this.hud.setConnected(false);
				this.hud.addSystemMessage(
					`Disconnected: ${reason ?? "connection closed"}`,
				);
				this.refreshPlayerNames();
			},
			onPlayerJoin: (player) => {
				console.log(`[NetworkManager] Player joined: ${player.name}`);
				this.renderer.onPlayerJoin(player);
				this.hud.addSystemMessage(`${player.name} joined`);
				this.refreshPlayerNames();
			},
			onPlayerLeave: (sessionId, name) => {
				console.log(`[NetworkManager] Player left: ${sessionId}`);
				if (sessionId !== "") {
					this.renderer.onPlayerLeave(sessionId);
				}
				this.hud.addSystemMessage(`${name ?? "A player"} left`);
				this.refreshPlayerNames();
			},
			onPlayerSkin: (player) => {
				if (player.skinPng) {
					this.renderer.onPlayerSkin(player.sessionId, player.skinPng);
				}
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
					edit.blockState,
				);
			},
			onBlockEditRejected: (rejection) => {
				this.revertRejectedBlockEdit(rejection);
			},
			onTntIgnite: (ignite) => {
				spawnRemotePrimedTnt(
					ignite.x,
					ignite.y,
					ignite.z,
					ignite.fuse,
					ignite.radius,
				);
			},
			onChatMessage: (chat) => {
				console.log(`[${chat.name}]: ${chat.message}`);
				this.hud.addChatMessage(chat.name, chat.message);
			},
			onWorldTime: (timeOfDay) => {
				Map1.environment?.syncWithServer(timeOfDay);
			},
			onWorldConfig: (config) => {
				console.log(
					`[NetworkManager] Received server seed: ${config.seed} (day ${config.dayDurationMs}ms, cycle ${config.dayCycle})`,
				);
				this.serverSeed = config.seed;
				setTerrainSeed(config.seed);
				ChunkWorkerPool.getInstance()?.setWorldSeed(config.seed);
				Map1.environment?.setServerDaySettings(
					config.dayDurationMs,
					config.dayCycle,
				);
				FarTileManager.reset();
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

	tick(deltaMs: number): void {
		const client = this.client;

		if (!client.isConnected) {
			/*
			 * Avoid repeatedly writing the same reset values on every disconnected
			 * frame. Any non-default state means a session boundary still needs to
			 * be recorded.
			 */
			if (
				this.hasLastSentState ||
				this.lastSentHeldItemId !== -1 ||
				this.lastSentHeldItemBlockState !== -1
			) {
				this.hasLastSentState = false;
				this.lastSentHeldItemId = -1;
				this.lastSentHeldItemBlockState = -1;
				this.sendAccum = 0;
			}

			return;
		}

		const dtSec = deltaMs * 0.001;
		if (dtSec > 0) {
			client.updateRemotePlayerInterpolation(dtSec);
		}

		const camera = this.player.playerCamera.playerCamera;

		let viewportWidth = this._canvasWidth;
		let viewportHeight = this._canvasHeight;

		if (viewportWidth <= 0) {
			viewportWidth = window.innerWidth;
		}

		if (viewportHeight <= 0) {
			viewportHeight = window.innerHeight;
		}

		this.renderer.update(camera, viewportWidth, viewportHeight);

		/*
		 * Keep at most one unsent interval. Subtracting only one interval from a
		 * large accumulated value causes a state packet on several consecutive
		 * frames after a stall, even though only the newest state is useful.
		 */
		const accumulated = this.sendAccum + deltaMs;

		if (accumulated >= SEND_INTERVAL_MS) {
			this.sendAccum = accumulated % SEND_INTERVAL_MS;
			this.sendHeldItemSelection();
			this.sendPlayerState();
		} else {
			this.sendAccum = accumulated;
		}
	}

	private refreshPlayerNames(): void {
		const remotePlayers = this.client.getRemotePlayers();
		const count = remotePlayers.size;
		const names = new Array<string>(count);

		let i = 0;

		for (const player of remotePlayers.values()) {
			names[i++] = player.name;
		}

		this.hud.setPlayerNames(names);
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

	/**
	 * Call this when the selected hotbar slot, selected stack size, selected item,
	 * or selected block state changes.
	 */
	onSelectedHeldItemChanged(): void {
		if (this.client.isConnected) {
			this.sendHeldItemSelection();
		}
	}

	private sendHeldItemSelection(): void {
		const slot = this.player.playerHud.selectedHotbarSlot;
		const item = this.player.playerInventory.inventory[0]?.[slot]?.item;
		const itemId = item && item.stackSize > 0 ? item.itemId : 0;
		const blockState = itemId === 0 ? 0 : (item?.blockState ?? 0);
		if (
			itemId === this.lastSentHeldItemId &&
			blockState === this.lastSentHeldItemBlockState
		)
			return;
		if (!this.client.sendHeldItemSelection(itemId, blockState)) return;
		this.lastSentHeldItemId = itemId;
		this.lastSentHeldItemBlockState = blockState;
	}

	private sendPlayerState(): void {
		const player = this.player;
		const pos = player.position;
		const playerCamera = player.playerCamera;

		const yaw = playerCamera.cameraYaw * (180 / Math.PI);
		const pitch = -playerCamera.cameraPitch * (180 / Math.PI);

		const yawByte = NetClient.encodeYawByte(yaw);
		const pitchByte = NetClient.encodePitchByte(pitch);

		if (
			this.hasLastSentState &&
			this.lastSentYawByte === yawByte &&
			this.lastSentPitchByte === pitchByte &&
			Math.abs(pos.x - this.lastSentX) < 0.001 &&
			Math.abs(pos.y - this.lastSentY) < 0.001 &&
			Math.abs(pos.z - this.lastSentZ) < 0.001
		) {
			return;
		}

		this.lastSentX = pos.x;
		this.lastSentY = pos.y;
		this.lastSentZ = pos.z;
		this.lastSentYawByte = yawByte;
		this.lastSentPitchByte = pitchByte;
		this.hasLastSentState = true;

		this.client.sendPlayerState(pos.x, pos.y, pos.z, yaw, pitch, 0);
	}

	/**
	 * Called when the local player places a block.
	 * Sends the edit to the server for broadcast.
	 */
	onBlockPlaced = (
		x: number,
		y: number,
		z: number,
		blockId: number,
		blockState = 0,
	): void => {
		this.client.sendBlockEdit(
			x,
			y,
			z,
			blockId,
			BlockActionType.Place,
			blockState,
		);
	};

	/**
	 * Called when the local player breaks a block.
	 * Sends the edit to the server for broadcast.
	 */
	onBlockBroken = (x: number, y: number, z: number, blockId: number): void => {
		this.client.sendBlockEdit(x, y, z, blockId, BlockActionType.Break, 0);
	};

	/**
	 * Called when a local primed TNT detonates. The crater blocks were
	 * already removed locally; the server re-applies them authoritatively
	 * from a single message so far-away blocks are not rejected as TooFar.
	 */
	onExplosion = (x: number, y: number, z: number, radius: number): void => {
		this.client.sendExplosion(x, y, z, radius);
	};

	/**
	 * Called when the local player ignites TNT. Relays the ignition so other
	 * clients spawn the primed entity (the separate Break edit only removes
	 * the block for them).
	 */
	onTntIgnite = (
		x: number,
		y: number,
		z: number,
		fuse: number,
		radius: number,
	): void => {
		this.client.sendTntIgnite(x, y, z, fuse, radius);
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
		blockState = 0,
	): void {
		if (NET_DEBUG) {
			debugLog(
				`[NetworkManager] applyRemoteBlockEdit: ${
					action === BlockActionType.Place ? "PLACE" : "BREAK"
				} blockId=${blockId} blockState=${blockState} at ${x},${y},${z}`,
			);
		}

		if (action === BlockActionType.Place) {
			// Sample light BEFORE setBlock: the placed voxel is solid
			// afterwards and stores no light (same reason local placement in
			// Item.place samples first). Fall back to the brightest neighbor
			// when the target voxel itself reads dark (e.g. replacing water).
			const px = x + 0.5;
			const py = y + 0.5;
			const pz = z + 0.5;
			const packedLight = this.sampleBreakLight(px, py, pz);
			setBlock(x, y, z, blockId, blockState);
			playPlace(px, py, pz, blockId, packedLight);
			return;
		}

		if (action !== BlockActionType.Break) return;

		// The local chunk still holds the PRE-break block here â€” trust it over
		// the wire id for visuals. Relayed Break edits have been observed to
		// carry the post-edit state (air = 0), which made every remote break
		// emit particles for frame 0 (cobblestone) instead of the real block.
		const localBlockId = getBlockByWorldCoords(x, y, z);
		const visualBlockId =
			localBlockId !== 0 && localBlockId !== undefined ? localBlockId : blockId;

		const px = x + 0.5;
		const py = y + 0.5;
		const pz = z + 0.5;
		const packedLight = this.sampleBreakLight(px, py, pz);

		deleteBlock(x, y, z);

		play(setVec3(this._scratchVec, px, py, pz), visualBlockId, packedLight);
		playDebris(px, py, pz, visualBlockId, packedLight);
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
		blockState: number;
		action: number;
		reason: number;
	}): void {
		const { x, y, z, blockId, blockState, action, reason } = rejection;

		if (action === BlockActionType.Place) {
			deleteBlock(x, y, z);
			this.player.playerInventory.createAndAddItem(blockId, 1);
		} else if (action === BlockActionType.Break) {
			setBlock(x, y, z, blockId, blockState);
		}

		let reasonText = "unknown reason";
		if (reason === BlockEditRejectReason.TooFar) {
			reasonText = "too far away";
		} else if (reason === BlockEditRejectReason.InvalidEdit) {
			reasonText = "invalid edit";
		}

		this.hud.addSystemMessage(
			`Block edit rejected (${reasonText}) â€” reverted`,
		);
	}

	private sampleBreakLight(x: number, y: number, z: number): number {
		let best = getLightByWorldCoords(x, y, z);
		let bestScore = ((best >>> 4) & 0x0f) + (best & 0x0f);

		if (bestScore === 30) return best;

		for (let i = 0; i < 6; i++) {
			const light = getLightByWorldCoords(
				x + BREAK_LIGHT_OFFSET_X[i],
				y + BREAK_LIGHT_OFFSET_Y[i],
				z + BREAK_LIGHT_OFFSET_Z[i],
			);

			const score = ((light >>> 4) & 0x0f) + (light & 0x0f);

			if (score <= bestScore) continue;

			best = light;
			bestScore = score;

			if (bestScore === 30) break;
		}

		return best;
	}

	sendChat(message: string): void {
		const firstChar = message.charCodeAt(0);

		if (firstChar === 33 || firstChar === 47) {
			const raw = message.slice(1).trim();
			const cmd = raw.split(/\s+/)[0]?.toLowerCase();

			// Time commands are server-authoritative in multiplayer: forward
			// the raw text so the server updates the world clock and
			// broadcasts the new time to every client.
			if (cmd === "time") {
				this.client.sendChat(message);
				return;
			}

			this.handleCommand(raw);
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
					this.player.playerHud.updateCreativePaletteVisibility();
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

			case "time": {
				// Server-authoritative: forwarded to the server in sendChat().
				break;
			}

			case "locate":
			case "find": {
				const pos = this.player.position;

				// Read-only search, answered locally from the server's seed: the
				// world is generated by the server, so folding the client's
				// URL-derived seed would search a region grid that does not
				// exist here. Teleporting mutates the local player position,
				// the same as !tp above.
				runLocateCommand(args, {
					originX: Math.floor(pos.x),
					originZ: Math.floor(pos.z),
					seed: currentWorldSeed(this.serverSeed),
					onTeleport: (x, z) => {
						pos.x = x;
						pos.z = z;
					},
					reply: (text) => this.hud.addSystemMessage(text),
				});
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
		if (this.disposed) return;
		this.disposed = true;

		window.removeEventListener("resize", this._onCanvasResize);

		this._canvas = null;
		this._canvasWidth = 0;
		this._canvasHeight = 0;

		ChunkWorkerPool.getInstance()?.setRemoteChunkProvider(null);

		this.client.disconnect();
		this.containers.dispose();
		this.stations.dispose();
		this.renderer.dispose();
		this.hud.dispose();

		this.hasLastSentState = false;
		this.sendAccum = 0;
	}

	/** Show a transient system line in the multiplayer chat HUD. */
	notifySystemMessage(text: string): void {
		this.hud.addSystemMessage(text);
	}

	/** Expose the underlying NetClient so subsystems (e.g. RemoteMobManager)
	 * can register binary handlers without NetworkManager owning them. */
	get netClient(): NetClient {
		return this.client;
	}

	get isConnected(): boolean {
		return this.client.isConnected;
	}

	get remotePlayers(): Map<string, RemotePlayer> {
		return this.client.getRemotePlayers();
	}
}
