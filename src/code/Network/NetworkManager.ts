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
import { playExplosionSound } from "@/code/Audio/TntAudio";
import { spawnRemotePrimedTnt } from "@/code/Entities/PrimedTnt";
import { resetDistantTerrain } from "@/code/Generation/DistantTerrain/DistantTerrain";
import { setTerrainSeed } from "@/code/Generation/TerrainHeightMap";
import { debugLog } from "@/code/Lib/debugLog";
import { setIsPaused } from "@/code/Lib/GameRuntimeState";
import { setVec3, vec3Zero } from "@/code/Lib/Math";
import {
	chooseBlockEditParticleQuality,
	getAliveParticleCount,
	ParticleQuality,
	play,
	playDebris,
	playDebrisScaled,
	playExplosion,
	playPlace,
	playPlaceScaled,
	playScaled,
} from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import {
	currentWorldSeed,
	runLocateCommand,
} from "@/code/Player/LocateCommand";
import type { Player } from "@/code/Player/Player";
import type { CameraFrameState } from "@/code/Player/PlayerCamera";
import { Gamemodes } from "@/code/Player/PlayerStats";
import { Chunk } from "@/code/World/Chunk/Chunk";
import {
	deleteBlock,
	getBlockByWorldCoords,
	getLightByWorldCoords,
	setBlock,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { ChunkWorkerPool } from "@/code/World/Chunk/ChunkWorkerPool";
import { resetChunkResidency } from "@/code/World/Chunk/Loading/ChunkResidency";
import type { BlockMutationResult } from "@/code/World/Chunk/Runtime/ChunkEditBatching";
import {
	claimExplosionEvent,
	ExplosionVisualTier,
	explosionVisualTier,
	resetExplosionDedup,
} from "@/code/World/ExplosionEvents";
import { FarTileManager } from "@/code/World/FarTiles/FarTileManager";
import { setSpawnPosition } from "@/code/World/SpawnPoint";
import { getWorldNameFromUrl, worldSeedFor } from "@/code/World/WorldContext";
import { WorldStorage } from "@/code/World/WorldStorage";
import { RemoteChunkProvider } from "./chunk/RemoteChunkProvider";
import { MultiplayerHUD } from "./MultiplayerHUD";
import { NetClient, type RemotePlayer } from "./NetClient";
import type { BlockEditBatchView } from "./protocol/encoder";
import {
	BlockActionType,
	BlockEditRejectReason,
	type ExplosionData,
} from "./protocol/messages";
import { RemoteContainerManager } from "./RemoteContainerManager";
import { RemotePlayerRenderer } from "./RemotePlayerRenderer";
import { RemoteStationManager } from "./RemoteStationManager";

const SEND_RATE = 20;
const SEND_INTERVAL_MS = 1000 / SEND_RATE;

const NET_DEBUG = false;

/**
 * Loudness for a remote explosion, from distance.
 *
 * Falls off to a floor rather than to silence: an explosion the player cannot
 * see is still a world event, and cutting it off entirely makes distant fights
 * feel like they are not happening.
 */
function audioIntensity(distanceSq: number): number {
	const distance = Math.sqrt(distanceSq);
	return Math.max(0.25, 1 - distance / 256);
}

/**
 * Most particle bursts one batched edit may emit, regardless of how many edits
 * it contains.
 *
 * A break burst is ~198 particles, so this caps a batch at roughly 5k particles
 * against an 8192-slot pool — the rest of the pool stays available for ambient
 * effects. Bursts are spread across the batch rather than taken from its
 * prefix, so the visual still covers the whole edited region.
 */
const MAX_PARTICLE_BURSTS_PER_BATCH = 24;

/** Upper bound on light samples held per batch. Matches the wire count cap. */
const MAX_BLOCK_EDIT_BATCH_LIGHTS = 4096;

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

	/**
	 * Reused light samples for one block edit batch, indexed by edit.
	 *
	 * Sized for the worst case the server can legally send (a uint16 count).
	 * Allocated once per NetworkManager, not once per batch.
	 */
	private readonly _batchLightScratch = new Uint8Array(
		MAX_BLOCK_EDIT_BATCH_LIGHTS,
	);

	/** Emission position for one batched burst. Kept separate from the camera scratch. */
	private readonly _batchVecScratch: Vec3 = vec3Zero();
	/**
	 * Visual block IDs for particle effects, captured before mutations.
	 *
	 * Break messages may contain air or another post-edit value, so break effects
	 * prefer the locally resident pre-edit block. Uint16Array assumes protocol
	 * block IDs are unsigned 16-bit values.
	 */
	private readonly _batchVisualBlockScratch = new Uint16Array(
		MAX_BLOCK_EDIT_BATCH_LIGHTS,
	);
	/**
	 * Dirty footprint of the most recent remote block edit batch.
	 *
	 * Retained rather than consumed because the batch handler and the particle
	 * pass are separate concerns, and because retaining it lets the HUD and any
	 * future ranged-upload scheduler observe the same result without having to
	 * wrap the whole handler in a scope.
	 */
	private lastBatchMutation: BlockMutationResult | null = null;

	/**
	 * Dirty footprint of the most recent remote block edit batch, or null if no
	 * batch has arrived. For diagnostics: a 2048-edit join snapshot reports how
	 * many DISTINCT chunks it actually dirtied, which is the number that decides
	 * whether the batch path is paying for itself.
	 */
	getBatchMutationResult(): BlockMutationResult | null {
		return this.lastBatchMutation;
	}

	/** Camera snapshot for distance classification of batched effects. */
	private readonly _batchCamScratch: CameraFrameState = {
		x: 0,
		y: 0,
		z: 0,
		yaw: 0,
		pitch: 0,
		forwardX: 0,
		forwardY: 0,
		forwardZ: 0,
	};
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
				/*
				 * Positions themselves are applied by the renderer, from its own
				 * timestamped sample buffer. This notification exists only to tell
				 * it that NEW samples arrived, which is when it must push them
				 * into that buffer — without it the buffer stays empty and every
				 * remote player renders at its last-known coordinates.
				 */
				this.renderer.notifyPlayerStatesChanged();
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
			onBlockEditBatch: (view) => {
				this.applyRemoteBlockEdits(view);
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
			onExplosion: (explosion) => {
				this.onRemoteExplosion(explosion);
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

		// The batch handler's dedup history belongs to the old room's ids.
		resetExplosionDedup();
		resetChunkResidency();

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

		/*
		 * Remote player smoothing deliberately does NOT happen here.
		 *
		 * It used to: `updateRemotePlayerInterpolation(dt)` chased each player
		 * toward its latest packet target with a coefficient derived from the
		 * RENDER frame delta. That made transport state advance at the render
		 * rate — a dropped frame moved remote players further — and it gave the
		 * renderer nothing but an already-chased value to draw.
		 *
		 * The renderer now owns a timestamped two-sample buffer per player and
		 * resolves its own snapshot from the shared frame clock, which is
		 * frame-rate independent and interpolates along real velocity instead of
		 * toward a discarded target. See Network/RemotePlayerInterpolation.ts.
		 *
		 * `updateRemotePlayerInterpolation` is retained on NetClient only for
		 * callers that have not migrated, and is NOT called on this path.
		 */

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
	 * Apply a batch of remote block edits within one lighting/remesh transaction.
	 *
	 * All mutation-sensitive visual data is captured before the first edit:
	 * - light samples must observe the pre-edit world;
	 * - break particle IDs must observe the block before it is deleted.
	 *
	 * The mutation and block-edit scopes are closed independently so an exception
	 * in one cleanup operation cannot leave the other global scope active.
	 */
	private applyRemoteBlockEdits(view: BlockEditBatchView): void {
		const count = view.count;

		if (count <= 0) {
			return;
		}

		const lights = this._batchLightScratch;
		const visualBlockIds = this._batchVisualBlockScratch;

		/*
		 * Guard against malformed or future protocol batches exceeding the
		 * preallocated scratch capacity. Silently writing past a TypedArray does
		 * not extend it, which would otherwise produce missing lights and block IDs.
		 */
		if (count > lights.length || count > visualBlockIds.length) {
			console.error(
				`[NetworkManager] Ignoring oversized block-edit batch: ` +
					`${count} edits, capacity ${lights.length}`,
			);
			return;
		}

		if (NET_DEBUG) {
			console.log(`[NetworkManager] Applying block edit batch of ${count}`);
		}

		const xs = view.x;
		const ys = view.y;
		const zs = view.z;
		const blockIds = view.blockId;
		const blockStates = view.blockState;
		const actions = view.action;

		/*
		 * Capture everything that depends on the pre-mutation world in one pass.
		 *
		 * This also removes getBlockByWorldCoords from the particle-emission pass,
		 * where it previously ran after deletions and therefore usually observed
		 * air rather than the broken block.
		 */
		for (let i = 0; i < count; i++) {
			const x = xs[i];
			const y = ys[i];
			const z = zs[i];

			lights[i] = this.sampleBreakLight(x + 0.5, y + 0.5, z + 0.5);

			let visualBlockId = blockIds[i];

			if (actions[i] === BlockActionType.Break) {
				const localBlockId = getBlockByWorldCoords(x, y, z);

				if (localBlockId !== undefined && localBlockId !== 0) {
					visualBlockId = localBlockId;
				}
			}

			visualBlockIds[i] = visualBlockId;
		}

		let mutation: BlockMutationResult | null = null;

		Chunk.beginBlockEditBatch();
		Chunk.beginMutationScope();

		try {
			for (let i = 0; i < count; i++) {
				const action = actions[i];

				if (action === BlockActionType.Place) {
					setBlock(xs[i], ys[i], zs[i], blockIds[i], blockStates[i]);
				} else if (action === BlockActionType.Break) {
					deleteBlock(xs[i], ys[i], zs[i]);
				}
			}
		} finally {
			/*
			 * Close both global scopes even if mutation finalization throws.
			 * Leaving either scope open would cause later unrelated edits to be
			 * accumulated into this batch indefinitely.
			 */
			try {
				mutation = Chunk.endMutationScope();
			} finally {
				Chunk.endBlockEditBatch();
			}
		}

		this.lastBatchMutation = mutation;

		if (NET_DEBUG && mutation !== null) {
			console.log(
				`[NetworkManager] batch dirtied ` +
					`${mutation.affectedChunks.length} chunk(s), ` +
					`lighting=${mutation.lightingChanged} ` +
					`connectivity=${mutation.connectivityChanged}`,
			);
		}

		this.emitBlockEditParticles(view, lights, visualBlockIds);
	}

	/**
	 * Emit representative break/place effects for a batch under a fixed budget.
	 *
	 * Light and visual block IDs were captured before mutation, so this pass does
	 * not query the chunk system and is independent of the resulting world state.
	 */
	private emitBlockEditParticles(
		view: BlockEditBatchView,
		lights: Uint8Array,
		visualBlockIds: Uint16Array,
	): void {
		const count = view.count;

		if (count <= 0) {
			return;
		}

		const budget = Math.min(count, MAX_PARTICLE_BURSTS_PER_BATCH);

		/*
		 * Equivalent to floor(burst * count / budget), but expressed directly to
		 * avoid maintaining a floating-point stride and the redundant upper clamp.
		 * For burst < budget, the result is always below count.
		 */
		const playerCamera = this.player.playerCamera;
		const camera = this._batchCamScratch;

		playerCamera.writeFrameState(camera);

		const cameraX = camera.x;
		const cameraY = camera.y;
		const cameraZ = camera.z;

		const xs = view.x;
		const ys = view.y;
		const zs = view.z;
		const actions = view.action;

		const burstPosition = this._batchVecScratch;
		const activeParticleCount = getAliveParticleCount();

		for (let burst = 0; burst < budget; burst++) {
			const index = Math.floor((burst * count) / budget);

			const px = xs[index] + 0.5;
			const py = ys[index] + 0.5;
			const pz = zs[index] + 0.5;

			const dx = px - cameraX;
			const dy = py - cameraY;
			const dz = pz - cameraZ;
			const distanceSq = dx * dx + dy * dy + dz * dz;

			const quality = chooseBlockEditParticleQuality(
				distanceSq,
				activeParticleCount,
				count,
			);

			if (quality === ParticleQuality.None) {
				continue;
			}

			const visualBlockId = visualBlockIds[index];
			const packedLight = lights[index];
			const action = actions[index];

			if (action === BlockActionType.Place) {
				playPlaceScaled(px, py, pz, visualBlockId, packedLight, quality);
				continue;
			}

			if (action !== BlockActionType.Break) {
				continue;
			}

			playScaled(
				setVec3(burstPosition, px, py, pz),
				visualBlockId,
				packedLight,
				quality,
			);

			playDebrisScaled(px, py, pz, visualBlockId, packedLight, quality);
		}
	}

	/**
	 * Handle the server's authoritative explosion record.
	 *
	 * The crater's block edits arrive SEPARATELY as a `BlockEditBatch`, and are
	 * applied by the normal path. This handler is responsible only for the
	 * effects that are not implied by the block state: sound, screen flash, and
	 * the seeded particle burst.
	 *
	 * Deduplicated by `eventId`, so a redelivered explosion costs one comparison
	 * rather than a full replay of every effect.
	 */
	private onRemoteExplosion(explosion: ExplosionData): void {
		if (!claimExplosionEvent(explosion.eventId ?? 0)) {
			if (NET_DEBUG) {
				console.log(
					"[NetworkManager] dropped duplicate explosion",
					explosion.eventId,
				);
			}
			return;
		}

		const camera = this._batchCamScratch;
		this.player.playerCamera.writeFrameState(camera);

		const px = explosion.x;
		const py = explosion.y;
		const pz = explosion.z;

		const dx = px - camera.x;
		const dy = py - camera.y;
		const dz = pz - camera.z;
		const distanceSq = dx * dx + dy * dy + dz * dz;

		const tier = explosionVisualTier(distanceSq);

		// Out of visual range but still audible — a distant explosion that is
		// completely silent reads as a bug rather than as distance.
		if (tier === ExplosionVisualTier.Offscreen) {
			playExplosionSound(audioIntensity(distanceSq));
			return;
		}

		// Light is sampled at the blast, but the crater's block edits may have
		// already landed and removed the blocks that carried it. Message order
		// is not guaranteed, so this deliberately does not depend on it — an
		// explosion is emissive anyway, so a dark sample only dims the tint.
		const packedLight = getLightByWorldCoords(px, py, pz);

		if (tier === ExplosionVisualTier.Near) {
			playExplosion(px, py, pz, explosion.radius, packedLight);
		} else {
			// Distant: the same explosion at reduced fidelity. Recognisably the
			// same event, at a fraction of the ~350 particles.
			playExplosion(px, py, pz, explosion.radius, packedLight, 0.35);
		}

		playExplosionSound(audioIntensity(distanceSq));
	}

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
