/**
 * VoxelRoom — Colyseus room for a shared voxel world.
 *
 * Responsibilities:
 * - Track connected players (sessionId, name, position, animation)
 * - Broadcast player movement at a fixed tick rate
 * - Relay block edits between clients with validation
 * - Generate terrain chunks (server-authoritative world gen)
 * - Manage world lifecycle (create on first join, destroy when empty)
 */
import { type Client, ClientState, CloseCode, Room } from "colyseus";
import { DEBUG_ENABLED, debugLog } from "@/code/Lib/debugLog";
import {
	BinaryDecoder,
	BinaryEncoder,
	decodePitchByte,
	decodeYawByte,
	encodeBlockEditBatch,
	encodeBlockEditRejected,
	encodeChatMessage,
	encodeChunkData,
	encodeChunkUnchanged,
	encodeMobDespawn,
	encodeMobSpawn,
	encodePitchByte,
	encodePlayerJoin,
	encodePlayerLeave,
	encodeSpawnPosition,
	encodeWorldConfig,
	encodeYawByte,
	writeMobUpdateBatch,
	writePlayerStateBatch,
} from "@/code/Network/protocol/encoder.ts";
import {
	BlockActionType,
	type BlockEditData,
	BlockEditRejectReason,
	type ChatMessageData,
	MessageType,
	type MobUpdateBatchEntry,
	type PlayerStateBatchEntry,
	type PlayerStateData,
} from "@/code/Network/protocol/messages.ts";
import {
	packChunkKeyFast,
	unpackChunkKeyFast,
} from "@/code/World/Storage/ChunkKey.ts";
import { getServerConfig } from "../config/ServerConfig.ts";
import { ChunkGenerationService } from "../world/ChunkGenerationService.ts";
import { type ServerMob, ServerMobSimulation } from "../world/MobSimulation.ts";
import type { StoredChunkData } from "../world/ServerWorldStorage.ts";
import { ServerWorldStorage } from "../world/ServerWorldStorage.ts";
import {
	createWorldSpawn,
	type WorldSpawn,
} from "../world/WorldSpawnGenerator.ts";

/**
 * Live count of connected players, shared with the HTTP status endpoint
 * (see index.ts) so the client's server list can show "👤 x/y" without
 * joining a room. Single-process server, so a module-level counter is safe.
 */
let onlinePlayers = 0;

/** Current number of connected players (for the status endpoint). */
export function getOnlinePlayers(): number {
	return onlinePlayers;
}

/**
 * Run an array of promise-returning tasks with at most `limit` of them
 * in flight at once (bounded storage concurrency for chunk flushes).
 */
async function runWithConcurrency(
	tasks: Array<() => Promise<void>>,
	limit: number,
): Promise<void> {
	if (tasks.length === 0) return;
	const cap = Math.min(limit, tasks.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= tasks.length) return;
			await tasks[i]();
		}
	};
	await Promise.all(Array.from({ length: cap }, () => worker()));
}

/** Friendly label for a 0..1 day fraction (matches the sun's sky position). */
function timeOfDayLabel(fraction: number): string {
	if (fraction < 0.25) return "morning";
	if (fraction < 0.5) return "day";
	if (fraction < 0.75) return "evening";
	return "night";
}

interface ServerPlayerState {
	sessionId: string;
	index: number;
	name: string;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	animation: number;
	/** True when the state changed since the last broadcast (dirty-tracking). */
	dirty: boolean;
	/** True when a new position arrived and is due for persistence. */
	saveDirty: boolean;
	/** Last time this player's position was persisted to storage (ms epoch). */
	lastSaveTime: number;
}

const MAX_STORED_EDITS = 200; // Keep last N edits for new joiners
const TIME_BROADCAST_INTERVAL = 5000; // Broadcast time every 5 seconds
const FULL_SNAPSHOT_INTERVAL = 2000; // Periodic full player-state broadcast (ms)
const PLAYER_SAVE_INTERVAL = 3000; // Position persistence debounce (ms)
const MOB_UPDATE_INTERVAL = 100; // Mob position broadcast cadence (10 Hz)
const MAX_CHUNK_BATCH = 255; // Cap chunks per batch request (prevents DoS)
const WORLD_BOUNDARY = 1_000_000; // Reject world coords beyond ±1M blocks
const MAX_CHUNK_COORD = WORLD_BOUNDARY >> 5; // Reject chunk coords beyond boundary
const MAX_BLOCK_ID = 255; // Block data is stored as one byte per voxel
const MAX_PROTOCOL_VIOLATIONS = 16; // Malformed packets before disconnect
const FLUSH_CONCURRENCY = 8; // Max parallel chunk storage ops per flush
const CHUNK_BATCH_BYTE_LIMIT = 256 * 1024; // Max bytes per ChunkDataBatch send
const MAX_POOLED_EDIT_ENTRIES = 8192; // Cap the pendingChunkEdits entry free list
// Spawn prewarm box (matches the client's render distances around the
// default spawn chunk (0, 2, 0) at block y=80): 7x7 columns x 13 Y-levels.
const PREWARM_HORIZONTAL_RADIUS = 3;
const PREWARM_MIN_CHUNK_Y = -5;
const PREWARM_MAX_CHUNK_Y = 7;

export class VoxelRoom extends Room {
	private players = new Map<string, ServerPlayerState>();
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	// Server-authoritative mob simulation — spawned near players, positions
	// broadcast at MOB_UPDATE_INTERVAL; clients render them without local AI.
	private mobSim!: ServerMobSimulation;
	private mobTickAccum = 0;
	// Reused across the mob broadcast: pooled entry objects + encoder, so the
	// fixed-rate mob update cycle allocates nothing per broadcast.
	private mobStatePool: MobUpdateBatchEntry[] = [];
	private mobStateScratch: MobUpdateBatchEntry[] = [];
	private mobSnapshotScratch: ServerMob[] = [];
	private mobUpdateEncoder = new BinaryEncoder(2048);
	private playerPosPool: Array<{ x: number; y: number; z: number }> = [];
	private playerPosScratch: Array<{ x: number; y: number; z: number }> = [];
	// Ring buffer of recent edits for sync on join (insertion O(1)).
	private readonly blockEdits: Array<BlockEditData | undefined> = new Array(
		MAX_STORED_EDITS,
	);
	private blockEditStart = 0;
	private blockEditCount = 0;
	private timeOfDay = 0.2; // Start at morning (0..1)
	private worldStorage!: ServerWorldStorage;
	private worldName = "default";
	private seed = "default";
	// Both keyed by packChunkKey(cx,cy,cz) — internal to this class, so the
	// packed numeric key is safe here (see ChunkKey.ts for what it must not
	// be used for).
	private dirtyChunks = new Set<number>(); // chunks pending save
	private pendingChunkEdits = new Map<
		number,
		Map<number, { x: number; y: number; z: number; blockId: number }>
	>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	// Serialized flush queue: at most one flush loop runs at a time, so
	// concurrent flushes can't reorder writes or drop retry state.
	private flushPromise: Promise<void> | null = null;
	private flushRequested = false;
	// Chunks being flushed by the in-flight flushDirtyChunksOnce() pass, plus
	// the promise that settles when that pass completes. Chunk requests whose
	// keys overlap the active flush wait for it before applying their own
	// edits, so edits for the same chunk are never applied concurrently.
	private activeFlushKeys: Set<number> | null = null;
	private activeFlushPromise: Promise<void> | null = null;
	private timeAccum = 0; // Accumulator for time broadcast
	// In-memory cache of player positions — avoids LevelDB disk read on join.
	// Keyed by player name (same as loadPlayerPosition/savePlayerPosition).
	private playerPositionCache = new Map<
		string,
		{ x: number; y: number; z: number; yaw: number; pitch: number }
	>();
	private chunkGen!: ChunkGenerationService;
	private config = getServerConfig();
	private playersReady = new Set<string>(); // received spawn position
	private protocolViolations = new Map<string, number>(); // sessionId → bad packets
	private reachRejectWarned = new Set<string>(); // sessionId → already warned TooFar
	private unknownTypeWarned = new Set<string>(); // sessionId → already warned unknown type
	private lastTickTime = 0; // Monotonic clock stamp for the tick loop

	// Pooled PlayerStateBatchEntry objects + reused output array for the
	// per-tick broadcast, so the fixed-rate tick doesn't allocate N objects
	// + 1 array every cycle regardless of whether anything actually moved.
	// The pool grows lazily up to the peak concurrent player count (bounded
	// by maxClients) and is reused for the lifetime of the room after that.
	// The batch buffer itself is also reused (tickEncoder) — no per-tick
	// allocation on the broadcast path.
	private statePool: PlayerStateBatchEntry[] = [];
	private statesScratch: PlayerStateBatchEntry[] = [];
	private tickEncoder = new BinaryEncoder(2048);
	private chunkBatchEncoder = new BinaryEncoder(65536);
	// Reused for infrequent broadcasts (time every 5s, block edits).
	// Avoids a fresh BinaryEncoder + Uint8Array allocation per broadcast.
	private timeEncoder = new BinaryEncoder(16);
	private editBroadcastEncoder = new BinaryEncoder(64);
	// Reused across incoming messages: no per-message decoder/DataView or
	// per-message PlayerState object allocation on the receive path.
	private decoder = new BinaryDecoder(new Uint8Array(0));
	private readonly stateScratch: PlayerStateData = {
		x: 0,
		y: 0,
		z: 0,
		yaw: 0,
		pitch: 0,
		animation: 0,
	};
	private readonly editScratch: BlockEditData = {
		sessionId: "",
		x: 0,
		y: 0,
		z: 0,
		blockId: 0,
		action: 0,
	};
	private readonly chunkRequestScratch = {
		cx: 0,
		cy: 0,
		cz: 0,
		lod: 0,
		cachedVersion: 0,
	};
	// Free list for pendingChunkEdits entries ({x,y,z,blockId} per voxel).
	// Entries live at most one flush cycle (≤500ms debounce), so they're
	// pooled instead of allocated per edit; released back after a successful
	// flush. Entries requeued on flush failure are never pooled.
	private editEntryPool: Array<{
		x: number;
		y: number;
		z: number;
		blockId: number;
	}> = [];
	private nextPlayerIndex = 0;
	private freedIndices: number[] = [];
	// Membership set mirroring freedIndices, so a double free (e.g. join
	// failure racing onLeave) can never push the same index twice.
	private freedIndexSet = new Set<number>();
	private lastFullSnapshot = 0;

	constructor() {
		super();
		// maxClients is authoritative for the player index space (0-255):
		// validate once here instead of silently capping with duplicates.
		const maxPlayers = this.config.maxPlayers;
		if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 256) {
			throw new Error("maxPlayers must be an integer from 1 to 256");
		}
		if (!Number.isFinite(this.config.tickRate) || this.config.tickRate <= 0) {
			throw new Error("tickRate must be a positive number");
		}
		this.maxClients = maxPlayers;
	}

	async onCreate(options: { worldName?: string; seed?: string }) {
		this.worldName = options.worldName ?? "default";
		console.log(`[VoxelRoom] created for world: ${this.worldName}`);

		// Initialize chunk generation service with seed from server config.
		// The config seed is authoritative — clients do not provide their own.
		this.chunkGen = new ChunkGenerationService();
		this.seed = this.config.seed;
		this.chunkGen.setSeed(this.seed, this.config.wasmEnabled);
		console.log(
			`[VoxelRoom] terrain seed: ${this.seed} (from server.properties), wasm: ${this.config.wasmEnabled}`,
		);

		// Initialize world storage (LevelDB) — terrain persists across restarts
		this.worldStorage = new ServerWorldStorage(
			this.worldName,
			this.seed,
			this.config.worldStoragePath,
			this.config.chunkCacheSize,
		);
		await this.worldStorage.init();
		this.chunkGen.setStorage(this.worldStorage);
		this.worldStorage.setWorldGenerator(this.chunkGen);

		// Server-authoritative mobs read the LRU chunk cache synchronously on
		// the room tick — no LevelDB on the sim path.
		this.mobSim = new ServerMobSimulation(this.worldStorage);

		// Generate (once) the world spawn point on world creation, and prewarm
		// the spawn-area chunks around the *actual* spawn (one-time cost, which
		// is fine at world creation). Memoized via ensureWorldSpawn().
		void this.ensureWorldSpawn();

		// Set up fixed-rate simulation tick (real elapsed time per tick)
		this.startTickLoop();

		// Register message handlers for binary protocol (raw bytes)
		this.onMessageBytes("binary", (client, data: Uint8Array) => {
			this.handleBinaryMessage(client, data);
		});
	}

	async onJoin(client: Client, options: { name?: string }) {
		// Allocate before any await so a mid-join disconnect can't leave a
		// ghost player behind (onLeave may already have run by then).
		const index = this.allocateIndex();
		const name = this.sanitizeName(options?.name, index);
		console.log(`[VoxelRoom] ${name} (${client.sessionId}) joined`);

		try {
			// Restore saved position or use default spawn (keyed by player
			// name, not sessionId — sessionIds change on every reconnect).
			// In-memory cache avoids LevelDB disk read for returning players.
			const cached = this.playerPositionCache.get(name);
			const saved =
				cached ?? (await this.worldStorage.loadPlayerPosition(name));

			// The client may have disconnected while the storage read was in
			// flight — bail out instead of inserting a ghost player.
			if (
				client.state === ClientState.LEAVING ||
				client.state === ClientState.CLOSED
			) {
				this.freeIndex(index);
				return;
			}

			// Generate (once) and use the server-authoritative world spawn as
			// the default location for players without a saved position.
			const worldSpawn = await this.ensureWorldSpawn();

			const state: ServerPlayerState = {
				sessionId: client.sessionId,
				index,
				name,
				x: saved?.x ?? worldSpawn.x,
				y: saved?.y ?? worldSpawn.y,
				z: saved?.z ?? worldSpawn.z,
				yaw: saved?.yaw ?? worldSpawn.yaw,
				pitch: saved?.pitch ?? worldSpawn.pitch,
				animation: 0,
				dirty: true,
				saveDirty: false,
				lastSaveTime: 0,
			};
			// Cache the position so next join skips LevelDB (even for first-timers).
			// First-timer cache entries come from the worldSpawn (degrees), but
			// returning-player entries are the 0-255 rotation bytes the client
			// sends — normalize to bytes so the cache has one unit system.
			if (!cached) {
				this.playerPositionCache.set(name, {
					x: state.x,
					y: state.y,
					z: state.z,
					yaw: encodeYawByte(state.yaw),
					pitch: encodePitchByte(state.pitch),
				});
			}
			this.players.set(client.sessionId, state);
			onlinePlayers++;

			// Notify others of new player
			const joinMsg = encodePlayerJoin({
				index,
				sessionId: client.sessionId,
				name,
			});
			this.broadcastBytes("binary", joinMsg, { except: client });

			// Tell the joiner its own room index (no join event fires for self).
			// The client needs this to skip its own entry in PlayerStateBatch.
			client.sendBytes("binary", joinMsg);

			// Send existing players to the new client (so they can render them).
			// Concatenate all PlayerJoin messages into one buffer to avoid
			// N individual WebSocket frames (each with frame header overhead).
			if (this.players.size > 1) {
				// Pre-size: each join ≈ 32 bytes (type + index + sessionId str + name str)
				const parts: Uint8Array[] = [];
				let totalLen = 0;
				for (const [sid, p] of this.players) {
					if (sid === client.sessionId) continue;
					const msg = encodePlayerJoin({
						index: p.index,
						sessionId: sid,
						name: p.name,
					});
					parts.push(msg);
					totalLen += msg.length;
				}
				if (parts.length > 0) {
					const merged = new Uint8Array(totalLen);
					let offset = 0;
					for (const part of parts) {
						merged.set(part, offset);
						offset += part.length;
					}
					client.sendBytes("binary", merged);
				}
			}

			// Send the current player-state batch directly to the joiner so it
			// sees every existing player position immediately — without a
			// global dirty pass / full broadcast to everyone else.
			this.sendFullPlayerSnapshot(client);

			// Sync block edit history so new player sees existing world changes
			if (this.blockEditCount > 0) {
				const batch = encodeBlockEditBatch(this.getBlockEditHistory());
				client.sendBytes("binary", batch);
			}

			// Sync current server mobs so the joiner sees the same animals as
			// everyone else. Concatenated into one frame, like the player
			// join sync above.
			if (this.mobSim.size > 0) {
				const mobs = this.mobSim.snapshotInto(this.mobSnapshotScratch);
				const parts: Uint8Array[] = [];
				let totalLen = 0;
				for (const mob of mobs) {
					const msg = encodeMobSpawn(
						mob.id,
						mob.typeId,
						mob.x,
						mob.y,
						mob.z,
						mob.yaw,
					);
					parts.push(msg);
					totalLen += msg.length;
				}
				if (parts.length > 0) {
					const merged = new Uint8Array(totalLen);
					let offset = 0;
					for (const part of parts) {
						merged.set(part, offset);
						offset += part.length;
					}
					client.sendBytes("binary", merged);
				}
			}

			// Send authoritative world seed so the client's clip map matches
			// server terrain, plus day/night settings so the client sun
			// interpolates at the server's rate
			const configMsg = encodeWorldConfig(
				this.seed,
				this.config.dayDuration,
				this.config.dayCycle,
			);
			client.sendBytes("binary", configMsg);

			// Send the current day/night time immediately so the client's sun
			// snaps to the authoritative time instead of waiting for the first
			// periodic WorldTime broadcast (up to TIME_BROADCAST_INTERVAL ms).
			const timeMsg = new BinaryEncoder(5);
			timeMsg.writeUint8(MessageType.WorldTime);
			timeMsg.writeFloat32(this.timeOfDay);
			client.sendBytes("binary", timeMsg.getBytes());

			// Tell client where to spawn (saved position or default). Saved angles
			// are 0-255 rotation bytes; the worldSpawn defaults are already
			// degrees. The SpawnPosition message carries degrees.
			const spawnMsg = encodeSpawnPosition(
				state.x,
				state.y,
				state.z,
				saved ? decodeYawByte(state.yaw) : state.yaw,
				saved ? decodePitchByte(state.pitch) : state.pitch,
			);
			client.sendBytes("binary", spawnMsg);

			// Now safe to save positions (client has been told where to spawn)
			this.playersReady.add(client.sessionId);
		} catch (error) {
			// Storage failure must not leak an allocated index or a partially
			// initialized player.
			const wasPresent = this.players.delete(client.sessionId);
			if (wasPresent) onlinePlayers--;
			this.playersReady.delete(client.sessionId);
			this.freeIndex(index);
			console.error(
				`[VoxelRoom] Join failed for ${name} (${client.sessionId}):`,
				error,
			);
			throw error;
		}
	}

	onLeave(client: Client, code?: number) {
		this.protocolViolations.delete(client.sessionId);
		this.reachRejectWarned.delete(client.sessionId);
		this.unknownTypeWarned.delete(client.sessionId);
		const player = this.players.get(client.sessionId);
		console.log(
			`[VoxelRoom] ${player?.name ?? client.sessionId} left (code: ${code})`,
		);

		// Unknown player (e.g. join aborted before insertion): never broadcast
		// a leave for index 0 — that would remove an existing player on clients.
		if (!player) return;

		// Persist final position on disconnect so it's ready on next join.
		// Update in-memory cache immediately so a quick rejoin skips the
		// LevelDB read even if the disk write is still in flight.
		this.playerPositionCache.set(player.name, {
			x: player.x,
			y: player.y,
			z: player.z,
			yaw: player.yaw,
			pitch: player.pitch,
		});
		this.reportAsync(
			`Failed to save position for ${player.name} on disconnect`,
			this.worldStorage.savePlayerPosition(
				player.name,
				player.x,
				player.y,
				player.z,
				player.yaw,
				player.pitch,
			),
		);

		this.players.delete(client.sessionId);
		onlinePlayers--;
		this.playersReady.delete(client.sessionId);
		this.freeIndex(player.index);

		this.broadcastBytes(
			"binary",
			encodePlayerLeave({ index: player.index }),
			{},
		);
	}

	/**
	 * Handle server-authoritative chat commands ('!' or '/' prefix).
	 * Returns true when the message was consumed as a command and must not
	 * be relayed to other players as chat.
	 */
	private handleChatCommand(client: Client, raw: string): boolean {
		const parts = raw.split(/\s+/);
		const cmd = parts[0]?.toLowerCase();
		if (cmd !== "time") return false;

		const args = parts.slice(1);

		const reply = (text: string): void => {
			client.sendBytes(
				"binary",
				encodeChatMessage({
					sessionId: client.sessionId,
					name: "Server",
					message: text,
				}),
			);
		};

		if (args.length === 0) {
			reply(
				`Time: ${Math.round(this.timeOfDay * 1000)} (${timeOfDayLabel(this.timeOfDay)})`,
			);
			return true;
		}

		let fraction: number | null = null;
		const arg = args[0].toLowerCase();

		if (arg === "day") {
			fraction = 0.25;
		} else {
			const isRelative = arg.startsWith("+") || arg.startsWith("-");
			const numeric = Number.parseFloat(arg);

			if (Number.isFinite(numeric)) {
				if (isRelative) {
					fraction = (this.timeOfDay + numeric / 1000) % 1;
					if (fraction < 0) fraction += 1;
				} else {
					fraction = Math.max(0, Math.min(1000, numeric)) / 1000;
				}
			}
		}

		if (fraction === null) {
			reply("Usage: !time [<0-1000> | +<amount> | day]");
			return true;
		}

		this.timeOfDay = fraction;

		// Broadcast the new authoritative time immediately so every client's
		// sun snaps to it instead of waiting for the next periodic WorldTime
		// broadcast. Fresh encoder: the tick loop reuses its own.
		const timeMsg = new BinaryEncoder(5);
		timeMsg.writeUint8(MessageType.WorldTime);
		timeMsg.writeFloat32(this.timeOfDay);
		this.broadcastBytes("binary", timeMsg.getBytes(), {});

		reply(
			`Time set to ${Math.round(fraction * 1000)} (${timeOfDayLabel(fraction)})`,
		);
		return true;
	}

	async onDispose() {
		console.log("[VoxelRoom] disposed");
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
		// Keep the shared onlinePlayers counter consistent with the player map
		// (the HTTP status endpoint reads it without joining the room).
		const remainingPlayers = this.players.size;
		onlinePlayers = Math.max(0, onlinePlayers - remainingPlayers);
		this.players.clear();
		// Per-session tracking must not leak across room instances.
		this.playersReady.clear();
		this.protocolViolations.clear();
		this.reachRejectWarned.clear();
		this.unknownTypeWarned.clear();

		// Persist any still-active mobs to their chunk columns before the
		// storage closes, so they survive a server restart.
		await this.mobSim.persistAll();

		// Flush any pending chunk saves through the serialized queue
		this.clearChunkFlush();
		await this.requestChunkFlush();
		this.pendingChunkEdits.clear();

		// Terminate worker threads
		await this.chunkGen.terminate();

		// Close storage
		if (this.worldStorage) {
			await this.worldStorage.dispose();
		}
	}

	private scheduleChunkFlush(): void {
		if (this.flushTimer || this.flushRequested) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.requestChunkFlush();
		}, 500);
	}

	private clearChunkFlush(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	/**
	 * Request a flush through the serialized queue. At most one flush loop
	 * runs at a time, so concurrent flushDirtyChunksOnce() calls can never
	 * reorder writes for the same chunk or drop retry state.
	 */
	private requestChunkFlush(): Promise<void> {
		this.flushRequested = true;

		if (!this.flushPromise) {
			this.flushPromise = this.runChunkFlushLoop().finally(() => {
				this.flushPromise = null;
				if (this.dirtyChunks.size > 0) {
					this.requestChunkFlush();
				}
			});
		}

		return this.flushPromise;
	}

	private async runChunkFlushLoop(): Promise<void> {
		while (this.flushRequested || this.dirtyChunks.size > 0) {
			this.flushRequested = false;
			try {
				await this.flushDirtyChunksOnce();
			} catch (error) {
				// Edits were requeued by flushDirtyChunksOnce — retry later via
				// the debounce timer instead of hot-looping on a failing store.
				console.error(
					"[VoxelRoom] Chunk flush failed (edits requeued):",
					error,
				);
				this.scheduleChunkFlush();
				return;
			}
		}
	}

	private async flushDirtyChunksOnce(): Promise<void> {
		if (this.dirtyChunks.size === 0) return;

		// Swap in fresh containers: any new edits that land while the
		// applyBlockEdits calls below are in flight get tracked on the new
		// set and picked up by the next loop iteration.
		const dirty = this.dirtyChunks;
		const edits = this.pendingChunkEdits;
		this.dirtyChunks = new Set();
		this.pendingChunkEdits = new Map();

		// Publish the in-flight flush *before* the first await so a concurrent
		// chunk request can wait on it instead of applying edits for the same
		// chunks in parallel (see waitForOverlappingFlush).
		this.activeFlushKeys = new Set(dirty);
		this.activeFlushPromise = this.applyFlushedEdits(dirty, edits).finally(
			() => {
				this.activeFlushKeys = null;
				this.activeFlushPromise = null;
			},
		);
		await this.activeFlushPromise;
	}

	/**
	 * Apply + persist one swapped-out batch of chunk edits. Split out of
	 * flushDirtyChunksOnce() so the active-flush tracking can be published
	 * synchronously before the first await.
	 */
	private async applyFlushedEdits(
		dirty: Set<number>,
		edits: Map<
			number,
			Map<number, { x: number; y: number; z: number; blockId: number }>
		>,
	): Promise<void> {
		try {
			// Apply pending block edits to the stored chunks with bounded
			// concurrency (avoid unbounded Promise.all fan-out on huge batches).
			const applyTasks: Array<() => Promise<void>> = [];
			for (const key of dirty) {
				const editMap = edits.get(key);
				if (!editMap || editMap.size === 0) continue;
				const [cx, cy, cz] = unpackChunkKeyFast(key);
				applyTasks.push(() =>
					this.worldStorage.applyBlockEdits(cx, cy, cz, editMap.values()),
				);
			}
			await runWithConcurrency(applyTasks, FLUSH_CONCURRENCY);
			await this.worldStorage.flush();
			// Every entry in the swapped-out map is fully persisted now —
			// return them to the free list for reuse.
			this.releaseEditEntries(edits);
		} catch (error) {
			this.mergeFailedChunkEdits(dirty, edits);
			throw error;
		}
	}

	/**
	 * Wait for the in-flight flush pass to settle when any of `keys` overlaps
	 * the chunks it is writing. Guarantees a chunk request never applies
	 * edits for the same chunk concurrently with the flush loop.
	 */
	private async waitForOverlappingFlush(
		keys: readonly number[],
	): Promise<void> {
		const activeKeys = this.activeFlushKeys;
		const activePromise = this.activeFlushPromise;
		if (!activeKeys || !activePromise) return;
		for (let i = 0; i < keys.length; i++) {
			if (activeKeys.has(keys[i])) {
				try {
					await activePromise;
				} catch {
					// The flush failed and requeued its edits — proceed; the
					// requeued (older) edits are picked up below.
				}
				return;
			}
		}
	}

	/** Take an edit entry from the free list, or allocate a fresh one. */
	private acquireEditEntry(): {
		x: number;
		y: number;
		z: number;
		blockId: number;
	} {
		return this.editEntryPool.pop() ?? { x: 0, y: 0, z: 0, blockId: 0 };
	}

	private releaseEditEntry(entry: {
		x: number;
		y: number;
		z: number;
		blockId: number;
	}): void {
		if (this.editEntryPool.length < MAX_POOLED_EDIT_ENTRIES) {
			this.editEntryPool.push(entry);
		}
	}

	private releaseEditEntries(
		edits: Map<
			number,
			Map<number, { x: number; y: number; z: number; blockId: number }>
		>,
	): void {
		for (const editMap of edits.values()) {
			for (const entry of editMap.values()) {
				this.releaseEditEntry(entry);
			}
		}
	}

	/** Requeue edits whose apply failed — current (newer) edits keep priority. */
	private mergeFailedChunkEdits(
		dirty: Set<number>,
		failed: Map<
			number,
			Map<number, { x: number; y: number; z: number; blockId: number }>
		>,
	): void {
		for (const key of dirty) {
			const failedMap = failed.get(key);
			if (!failedMap) continue;
			let currentMap = this.pendingChunkEdits.get(key);
			if (!currentMap) {
				currentMap = new Map();
				this.pendingChunkEdits.set(key, currentMap);
			}
			// Current edits are newer, so they must win.
			for (const [voxel, edit] of failedMap) {
				if (!currentMap.has(voxel)) currentMap.set(voxel, edit);
			}
			this.dirtyChunks.add(key);
		}
	}

	/** Assign the lowest free room player index (0-255). */
	private allocateIndex(): number {
		const recycled = this.freedIndices.pop();
		if (recycled !== undefined) {
			this.freedIndexSet.delete(recycled);
			return recycled;
		}

		if (this.nextPlayerIndex > 255) {
			// Never silently hand out duplicate indices — identity collisions
			// on clients corrupt their player map.
			throw new Error("Player index space exhausted");
		}

		return this.nextPlayerIndex++;
	}

	private freeIndex(index: number): void {
		// Ignore invalid frees (non-integer or out of the 0-255 index space)
		// and duplicate frees, so a double-free can never put the same index
		// into the free list twice. All O(1).
		if (!Number.isInteger(index) || index < 0 || index > 255) return;
		if (this.freedIndexSet.has(index)) return;
		this.freedIndexSet.add(index);
		this.freedIndices.push(index);
	}

	/** Clamp/trim a join name to something safe to display and store. */
	private sanitizeName(raw: string | undefined, index: number): string {
		const cleaned = (raw ?? "")
			.trim()
			// biome-ignore lint/suspicious/noControlCharactersInRegex: <ingore regex>
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
		return cleaned.slice(0, 32) || `Player${index + 1}`;
	}

	/** Log a fire-and-forget failure instead of letting it become unhandled. */
	private reportAsync(label: string, promise: Promise<unknown>): void {
		void promise.catch((error) => {
			console.error(`[VoxelRoom] ${label}:`, error);
		});
	}

	/**
	 * Compute (and persist) the world's default spawn point exactly once, on
	 * first world creation. Spiral outward from the origin for a flat column of
	 * solid ground *above sea level*, build a 3x3 stone platform there, and
	 * return {x,y,z,yaw,pitch}. Subsequent calls read the stored value, so the
	 * search never runs again.
	 *
	 * The client must NOT search locally — it receives this spawn via the
	 * SpawnPosition (0x1b) message on join.
	 */
	private worldSpawnPromise: Promise<{
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	}> | null = null;

	/** Memoized: generates the spawn once and caches the in-flight promise. */
	private ensureWorldSpawn(): Promise<{
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	}> {
		if (this.worldSpawnPromise) return this.worldSpawnPromise;
		this.worldSpawnPromise = this.computeWorldSpawn().catch((err) => {
			this.worldSpawnPromise = null; // allow a later retry
			throw err;
		});
		return this.worldSpawnPromise;
	}

	private async computeWorldSpawn(): Promise<WorldSpawn> {
		return createWorldSpawn({
			seed: this.seed,
			chunkGen: this.chunkGen,
			worldStorage: this.worldStorage,
			prewarmSpawnArea: (chunkX, chunkZ) =>
				this.prewarmSpawnArea(chunkX, chunkZ),
		});
	}

	/**
	 * Background pre-generation of the spawn area. The first join requests
	 * ~637 chunks (7x7 columns x 13 Y-levels around the default spawn chunk
	 * (0,2,0)); generating them all on-demand stalls the join, especially
	 * while the worker pool is still loading WASM. Running it here means
	 * join batches mostly hit storage. Runs concurrently with the normal
	 * generation path — ChunkGenerationService dedupes shared coordinates,
	 * so a player request overlapping the prewarm waits on the same work
	 * instead of duplicating it.
	 */
	private prewarmSpawnArea(centerCx = 0, centerCz = 0): void {
		this.reportAsync(
			"Spawn area prewarm failed",
			this.prewarmSpawnAreaImpl(centerCx, centerCz),
		);
	}

	private async prewarmSpawnAreaImpl(
		centerCx: number,
		centerCz: number,
	): Promise<void> {
		const coords: Array<{ cx: number; cy: number; cz: number }> = [];
		for (
			let dx = -PREWARM_HORIZONTAL_RADIUS;
			dx <= PREWARM_HORIZONTAL_RADIUS;
			dx++
		) {
			for (
				let dz = -PREWARM_HORIZONTAL_RADIUS;
				dz <= PREWARM_HORIZONTAL_RADIUS;
				dz++
			) {
				for (let cy = PREWARM_MIN_CHUNK_Y; cy <= PREWARM_MAX_CHUNK_Y; cy++) {
					coords.push({ cx: centerCx + dx, cy, cz: centerCz + dz });
				}
			}
		}

		const storedMap = await this.worldStorage.readChunks(coords);
		const missing: Array<{ chunkX: number; chunkY: number; chunkZ: number }> =
			[];
		for (const c of coords) {
			if (!storedMap.has(packChunkKeyFast(c.cx, c.cy, c.cz))) {
				missing.push({ chunkX: c.cx, chunkY: c.cy, chunkZ: c.cz });
			}
		}

		if (missing.length === 0) {
			console.log(
				"[VoxelRoom] Spawn area already generated — skipping prewarm",
			);
			return;
		}

		console.log(
			`[VoxelRoom] Prewarming spawn area: ${missing.length}/${coords.length} chunks missing — generating...`,
		);
		await this.chunkGen.generateChunksBatch(missing);
		console.log(
			`[VoxelRoom] Spawn area prewarm complete (${missing.length} chunks)`,
		);
	}

	private startTickLoop(): void {
		this.lastTickTime = performance.now();
		this.tickInterval = setInterval(() => {
			const now = performance.now();
			// Real elapsed time (event-loop delay included), clamped so a
			// temporary stall can't jump the day cycle by a huge amount.
			const deltaMs = Math.min(now - this.lastTickTime, 250);
			this.lastTickTime = now;
			this.tick(deltaMs);
		}, 1000 / this.config.tickRate);
	}

	private tick(deltaMs: number): void {
		if (this.players.size === 0) return;

		// Advance day/night cycle (only if enabled in config)
		if (this.config.dayCycle && this.config.dayDuration > 0) {
			this.timeOfDay = (this.timeOfDay + deltaMs / this.config.dayDuration) % 1;
		}

		// Broadcast time periodically — reuse encoder to avoid per-broadcast alloc.
		this.timeAccum += deltaMs;
		if (this.timeAccum >= TIME_BROADCAST_INTERVAL) {
			this.timeAccum = 0;
			this.timeEncoder.reset();
			this.timeEncoder.writeUint8(MessageType.WorldTime);
			this.timeEncoder.writeFloat32(this.timeOfDay);
			this.broadcastBytes("binary", this.timeEncoder.getBytes(), {});
		}

		// Debounced position persistence: moved off the message hot path and
		// into the tick, which coalesces updates naturally. One Date.now()
		// per tick instead of one per incoming PlayerState message.
		const now = Date.now();
		const fullSnapshotDue =
			now - this.lastFullSnapshot >= FULL_SNAPSHOT_INTERVAL;
		if (fullSnapshotDue) this.lastFullSnapshot = now;

		// Server-authoritative mobs: simulate continuously, broadcast spawns
		// and despawns immediately and positions at a lower rate than the
		// player-state tick.
		this.collectPlayerPositions();
		const mobEvents = this.mobSim.tick(deltaMs, this.playerPosScratch);
		for (let i = 0; i < mobEvents.length; i++) {
			const event = mobEvents[i];
			if (event.kind === "spawn") {
				this.broadcastBytes(
					"binary",
					encodeMobSpawn(
						event.mob.id,
						event.mob.typeId,
						event.mob.x,
						event.mob.y,
						event.mob.z,
						event.mob.yaw,
					),
					{},
				);
			} else {
				this.broadcastBytes("binary", encodeMobDespawn(event.mob.id), {});
			}
		}
		this.mobTickAccum += deltaMs;
		if (this.mobTickAccum >= MOB_UPDATE_INTERVAL) {
			this.mobTickAccum = 0;
			this.writeMobUpdateBatch();
		}

		this.statesScratch.length = 0;
		let idx = 0;
		for (const p of this.players.values()) {
			if (
				p.saveDirty &&
				this.playersReady.has(p.sessionId) &&
				now - p.lastSaveTime >= PLAYER_SAVE_INTERVAL
			) {
				p.lastSaveTime = now;
				p.saveDirty = false;
				// Update in-memory cache immediately so a quick rejoin
				// avoids the LevelDB read even if the disk write is in flight.
				this.playerPositionCache.set(p.name, {
					x: p.x,
					y: p.y,
					z: p.z,
					yaw: p.yaw,
					pitch: p.pitch,
				});
				void this.worldStorage
					.savePlayerPosition(p.name, p.x, p.y, p.z, p.yaw, p.pitch)
					.catch((error) => {
						// Retry on the next interval — the last write wins.
						p.saveDirty = true;
						console.error(
							`[VoxelRoom] Position save failed for ${p.name}:`,
							error,
						);
					});
			}

			if (!p.dirty && !fullSnapshotDue) continue;
			let slot = this.statePool[idx];
			if (!slot) {
				slot = {
					index: 0,
					x: 0,
					y: 0,
					z: 0,
					yaw: 0,
					pitch: 0,
					animation: 0,
				};
				this.statePool[idx] = slot;
			}
			slot.index = p.index;
			slot.x = p.x;
			slot.y = p.y;
			slot.z = p.z;
			slot.yaw = p.yaw;
			slot.pitch = p.pitch;
			slot.animation = p.animation;
			this.statesScratch.push(slot);
			idx++;
			p.dirty = false;
		}

		if (this.statesScratch.length === 0) return;

		// Reuse the persistent encoder — no per-tick allocation.
		this.tickEncoder.reset();
		writePlayerStateBatch(this.tickEncoder, this.statesScratch);
		this.broadcastBytes("binary", this.tickEncoder.getBytes(), {});
	}

	/** Fill the pooled scratch array with the players' positions (no alloc). */
	private collectPlayerPositions(): void {
		const scratch = this.playerPosScratch;
		scratch.length = 0;
		let idx = 0;
		for (const p of this.players.values()) {
			let slot = this.playerPosPool[idx];
			if (!slot) {
				slot = { x: 0, y: 0, z: 0 };
				this.playerPosPool[idx] = slot;
			}
			slot.x = p.x;
			slot.y = p.y;
			slot.z = p.z;
			scratch.push(slot);
			idx++;
		}

		// Keep the chunk-cache eviction pinned to the area around players so
		// the mob sim always finds the surface chunks it samples.
		this.worldStorage.setPlayerPositions(scratch);
	}

	/**
	 * Send the current player-state batch directly to a joining client so it
	 * sees every existing player position immediately — no global dirty pass,
	 * no broadcast to other players. Uses the pooled entry objects + the
	 * reused tick encoder, so a join allocates nothing.
	 */
	private sendFullPlayerSnapshot(client: Client): void {
		const scratch = this.statesScratch;
		scratch.length = 0;
		let idx = 0;
		for (const p of this.players.values()) {
			if (p.sessionId === client.sessionId) continue;
			let slot = this.statePool[idx];
			if (!slot) {
				slot = {
					index: 0,
					x: 0,
					y: 0,
					z: 0,
					yaw: 0,
					pitch: 0,
					animation: 0,
				};
				this.statePool[idx] = slot;
			}
			slot.index = p.index;
			slot.x = p.x;
			slot.y = p.y;
			slot.z = p.z;
			slot.yaw = p.yaw;
			slot.pitch = p.pitch;
			slot.animation = p.animation;
			scratch.push(slot);
			idx++;
		}

		if (scratch.length === 0) return;

		this.tickEncoder.reset();
		writePlayerStateBatch(this.tickEncoder, scratch);
		client.sendBytes("binary", this.tickEncoder.getBytes());
	}

	/** Broadcast all mob positions at MOB_UPDATE_INTERVAL (pooled, no alloc). */
	private writeMobUpdateBatch(): void {
		const mobs = this.mobSim.snapshotInto(this.mobSnapshotScratch);
		if (mobs.length === 0) return;

		const scratch = this.mobStateScratch;
		scratch.length = 0;
		let idx = 0;
		for (const mob of mobs) {
			let slot = this.mobStatePool[idx];
			if (!slot) {
				slot = { mobId: 0, x: 0, y: 0, z: 0, yaw: 0 };
				this.mobStatePool[idx] = slot;
			}
			slot.mobId = mob.id;
			slot.x = mob.x;
			slot.y = mob.y;
			slot.z = mob.z;
			slot.yaw = mob.yaw;
			scratch.push(slot);
			idx++;
		}

		this.mobUpdateEncoder.reset();
		writeMobUpdateBatch(this.mobUpdateEncoder, scratch);
		this.broadcastBytes("binary", this.mobUpdateEncoder.getBytes(), {});
	}

	private handleBinaryMessage(client: Client, data: Uint8Array): void {
		if (data.byteLength < 1) return;

		try {
			this.decodeAndHandleBinaryMessage(client, data);
		} catch (error) {
			// Truncated/malformed packets must never escape into the room's
			// message pipeline. Track violations and disconnect repeat
			// offenders instead of logging every bad packet forever.
			// Only the first violation per session is logged — the template
			// literal would otherwise allocate a string on every bad packet.
			if (this.recordProtocolViolation(client) === 1) {
				console.warn(
					`[VoxelRoom] Invalid binary packet from ${client.sessionId}:`,
					error,
				);
			}
		}
	}

	/** @returns the new violation count for this session (1 on first offense). */
	private recordProtocolViolation(client: Client): number {
		const count = (this.protocolViolations.get(client.sessionId) ?? 0) + 1;
		this.protocolViolations.set(client.sessionId, count);
		if (count >= MAX_PROTOCOL_VIOLATIONS) {
			this.protocolViolations.delete(client.sessionId);
			client.leave(CloseCode.WITH_ERROR, "Too many malformed packets");
		}
		return count;
	}

	/**
	 * Strict validation before mutating authoritative state. Without it a
	 * NaN/Infinity coordinate silently defeats the reach check (NaN
	 * comparisons are false) and corrupts the world position.
	 */
	private isValidPlayerState(state: {
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
		animation: number;
	}): boolean {
		return (
			Number.isFinite(state.x) &&
			Number.isFinite(state.y) &&
			Number.isFinite(state.z) &&
			Number.isInteger(state.yaw) &&
			state.yaw >= 0 &&
			state.yaw <= 255 &&
			Number.isInteger(state.pitch) &&
			state.pitch >= 0 &&
			state.pitch <= 255 &&
			Number.isInteger(state.animation) &&
			state.animation >= 0 &&
			state.animation <= 255 &&
			Math.abs(state.x) <= WORLD_BOUNDARY &&
			Math.abs(state.y) <= WORLD_BOUNDARY &&
			Math.abs(state.z) <= WORLD_BOUNDARY
		);
	}

	/**
	 * Block edits must be integers inside the world boundary and carry a
	 * known block ID + action. Bitwise packing silently truncates fractional
	 * or huge values to int32, which would move the edit into a different
	 * chunk than the one validated.
	 */
	private isValidBlockEdit(edit: {
		x: number;
		y: number;
		z: number;
		blockId: number;
		action: number;
	}): boolean {
		return (
			Number.isSafeInteger(edit.x) &&
			Number.isSafeInteger(edit.y) &&
			Number.isSafeInteger(edit.z) &&
			Math.abs(edit.x) <= WORLD_BOUNDARY &&
			Math.abs(edit.y) <= WORLD_BOUNDARY &&
			Math.abs(edit.z) <= WORLD_BOUNDARY &&
			Number.isInteger(edit.blockId) &&
			edit.blockId >= 0 &&
			edit.blockId <= MAX_BLOCK_ID &&
			(edit.action === BlockActionType.Place ||
				edit.action === BlockActionType.Break)
		);
	}

	/**
	 * Chunk requests must reference a real chunk: safe integer coordinates
	 * inside the world boundary, LOD 0 (no LOD support), and a cachedVersion
	 * that fits the wire's uint32. Invalid requests are silently ignored.
	 */
	private isValidChunkRequest(
		cx: number,
		cy: number,
		cz: number,
		lod: number,
		cachedVersion: number,
	): boolean {
		return (
			Number.isSafeInteger(cx) &&
			Number.isSafeInteger(cy) &&
			Number.isSafeInteger(cz) &&
			Math.abs(cx) <= MAX_CHUNK_COORD &&
			Math.abs(cy) <= MAX_CHUNK_COORD &&
			Math.abs(cz) <= MAX_CHUNK_COORD &&
			lod === 0 &&
			Number.isInteger(cachedVersion) &&
			cachedVersion >= 0 &&
			cachedVersion <= 0xffffffff
		);
	}

	/**
	 * Notify the originating client that its block edit was rejected so it
	 * can revert the optimistic local change.
	 */
	private sendBlockEditRejected(
		client: Client,
		edit: { x: number; y: number; z: number; blockId: number; action: number },
		reason: number,
	): void {
		const msg = encodeBlockEditRejected({
			x: edit.x,
			y: edit.y,
			z: edit.z,
			blockId: edit.blockId,
			action: edit.action,
			reason,
		});
		client.sendBytes("binary", msg);
	}

	/** Append an edit to the ring buffer (O(1) insertion, no shift()). */
	private recordBlockEdit(edit: BlockEditData): void {
		const index =
			(this.blockEditStart + this.blockEditCount) % MAX_STORED_EDITS;
		if (this.blockEditCount < MAX_STORED_EDITS) {
			this.blockEdits[index] = edit;
			this.blockEditCount++;
		} else {
			this.blockEdits[this.blockEditStart] = edit;
			this.blockEditStart = (this.blockEditStart + 1) % MAX_STORED_EDITS;
		}
	}

	private getBlockEditHistory(): BlockEditData[] {
		const history = new Array<BlockEditData>(this.blockEditCount);
		for (let i = 0; i < this.blockEditCount; i++) {
			history[i] =
				this.blockEdits[(this.blockEditStart + i) % MAX_STORED_EDITS]!;
		}
		return history;
	}

	/** Estimated encoded size of one chunk inside a ChunkDataBatch. */
	private estimateChunkBytes(c: StoredChunkData): number {
		let size = 12 + 4 + 1; // coords + version + flags
		if (c.isUniform) {
			size += 2;
		} else if (c.palette) {
			size += 2 + c.palette.length * 2 + c.blocks.length;
		} else {
			size += c.blocks.length;
		}
		return size + 4 + c.light.length;
	}

	private sendChunkDataBatch(client: Client, chunks: StoredChunkData[]): void {
		if (chunks.length === 0) return;
		let groupStart = 0;
		let size = 0;
		for (let i = 0; i < chunks.length; i++) {
			const cSize = this.estimateChunkBytes(chunks[i]);
			if (groupStart < i && size + cSize > CHUNK_BATCH_BYTE_LIMIT) {
				client.sendBytes(
					"binary",
					this.encodeChunkBatch(chunks, groupStart, i),
				);
				groupStart = i;
				size = 0;
			}
			size += cSize;
		}
		if (groupStart < chunks.length) {
			client.sendBytes(
				"binary",
				this.encodeChunkBatch(chunks, groupStart, chunks.length),
			);
		}
	}

	private encodeChunkBatch(
		chunks: StoredChunkData[],
		start: number,
		end: number,
	): Uint8Array {
		const enc = this.chunkBatchEncoder;
		enc.reset();
		enc.writeUint8(MessageType.ChunkDataBatch);
		enc.writeUint16(Math.min(end - start, 65535));
		for (let i = start; i < end; i++) {
			const c = chunks[i];
			enc.writeInt32(c.chunkX);
			enc.writeInt32(c.chunkY);
			enc.writeInt32(c.chunkZ);
			enc.writeUint32(c.version);
			let flags = 0;
			if (c.isUniform) flags |= 1;
			if (c.palette) flags |= 2;
			enc.writeUint8(flags);
			if (c.isUniform) {
				enc.writeUint16(c.uniformBlockId);
			} else if (c.palette) {
				enc.writeUint16(c.palette.length);
				for (let j = 0; j < c.palette.length; j++) {
					enc.writeUint16(c.palette[j]);
				}
				enc.writeBytes(c.blocks);
			} else {
				enc.writeBytes(c.blocks);
			}
			enc.writeUint32(c.light.length);
			enc.writeBytes(c.light);
		}
		return enc.getBytes();
	}

	private decodeAndHandleBinaryMessage(client: Client, data: Uint8Array): void {
		const dec = this.decoder;
		dec.setBuffer(data);
		const msgType = dec.readUint8(); // consume type byte

		switch (msgType) {
			case MessageType.PlayerState: {
				// Decode into the reused scratch object — the values are read
				// out synchronously, so sharing it across messages is safe.
				const state = dec.readPlayerStateInto(this.stateScratch);
				const player = this.players.get(client.sessionId);
				if (player && this.isValidPlayerState(state)) {
					player.x = state.x;
					player.y = state.y;
					player.z = state.z;
					player.yaw = state.yaw;
					player.pitch = state.pitch;
					player.animation = state.animation;
					player.dirty = true;
					// Persistence happens debounced in the tick; just flag it
					// here (PLAYER_SAVE_INTERVAL, retry on failure).
					player.saveDirty = true;
				}
				break;
			}

			case MessageType.BlockEdit: {
				// Decode into the reused scratch object — every read below is
				// synchronous, so sharing it across messages is safe.
				const edit = dec.readBlockEditInto(this.editScratch);
				const player = this.players.get(client.sessionId);
				if (!player) {
					this.sendBlockEditRejected(
						client,
						edit,
						BlockEditRejectReason.NotAPlayer,
					);
					return;
				}
				if (!this.isValidBlockEdit(edit)) {
					this.sendBlockEditRejected(
						client,
						edit,
						BlockEditRejectReason.InvalidEdit,
					);
					return;
				}

				// Reach check: player must be within max-reach blocks
				const dx = edit.x - player.x;
				const dy = edit.y - player.y;
				const dz = edit.z - player.z;
				const distSq = dx * dx + dy * dy + dz * dz;
				const maxReachSq = this.config.maxReach * this.config.maxReach;
				if (distSq > maxReachSq) {
					// Log only the first rejection per session — computing the
					// distance string on every rejection lets a client spam
					// out-of-reach edits into per-packet string allocations.
					if (!this.reachRejectWarned.has(client.sessionId)) {
						this.reachRejectWarned.add(client.sessionId);
						console.warn(
							`[VoxelRoom] Block edit rejected: too far (${Math.sqrt(distSq).toFixed(1)} blocks)`,
						);
					}
					this.sendBlockEditRejected(
						client,
						edit,
						BlockEditRejectReason.TooFar,
					);
					return;
				}

				// Derive the stored block ID from the action server-side so a
				// client can't send contradictory semantics (e.g. "break" with
				// a non-air blockId).
				const blockId =
					edit.action === BlockActionType.Break ? 0 : edit.blockId;

				// Store edit for future joiners (ring buffer, cap at max)
				const storedEdit: BlockEditData = {
					sessionId: client.sessionId,
					x: edit.x,
					y: edit.y,
					z: edit.z,
					blockId,
					action: edit.action,
				};
				this.recordBlockEdit(storedEdit);

				// Schedule chunk save (debounced) — the edit is applied to the
				// stored chunk when the flush timer fires, so it persists.
				// >>5 === floor(x/32) for any 32-bit int (including negatives),
				// same result as the original Math.floor(x/32) but no
				// floating-point division.
				const cx = edit.x >> 5;
				const cy = edit.y >> 5;
				const cz = edit.z >> 5;
				const key = packChunkKeyFast(cx, cy, cz);
				let editMap = this.pendingChunkEdits.get(key);
				if (!editMap) {
					editMap = new Map();
					this.pendingChunkEdits.set(key, editMap);
				}
				// &31 gives the same non-negative local coordinate as
				// ((x % 32) + 32) % 32 since 32 is a power of two — one op
				// instead of two mods and an add.
				const lx = edit.x & 31;
				const ly = edit.y & 31;
				const lz = edit.z & 31;
				const voxelIndex = lx + (ly << 5) + (lz << 10);
				// Last write wins per voxel. If the voxel already has a
				// pending entry, hand the old one back to the pool — it can
				// only be referenced by this map, which is never applied
				// while it is still current (the flush swaps maps atomically).
				const prev = editMap.get(voxelIndex);
				if (prev) this.releaseEditEntry(prev);
				const entry = this.acquireEditEntry();
				entry.x = edit.x;
				entry.y = edit.y;
				entry.z = edit.z;
				entry.blockId = blockId;
				editMap.set(voxelIndex, entry);
				this.dirtyChunks.add(key);
				this.scheduleChunkFlush();

				// Broadcast to all other clients — reuse encoder to avoid alloc.
				this.editBroadcastEncoder.reset();
				this.editBroadcastEncoder.writeUint8(MessageType.BlockEditBroadcast);
				this.editBroadcastEncoder.writeString(storedEdit.sessionId);
				this.editBroadcastEncoder.writeInt32(storedEdit.x);
				this.editBroadcastEncoder.writeInt32(storedEdit.y);
				this.editBroadcastEncoder.writeInt32(storedEdit.z);
				this.editBroadcastEncoder.writeUint16(storedEdit.blockId);
				this.editBroadcastEncoder.writeUint8(storedEdit.action);
				this.broadcastBytes("binary", this.editBroadcastEncoder.getBytes(), {
					except: client,
				});
				break;
			}

			case MessageType.ChunkRequest: {
				const req = dec.readChunkRequestInto(this.chunkRequestScratch);
				if (
					!this.isValidChunkRequest(
						req.cx,
						req.cy,
						req.cz,
						req.lod,
						req.cachedVersion,
					)
				) {
					break;
				}
				void this.handleChunkRequest(
					client,
					req.cx,
					req.cy,
					req.cz,
					req.cachedVersion,
				);
				break;
			}

			case MessageType.ChunkRequestBatch: {
				const count = Math.min(dec.readUint16(), MAX_CHUNK_BATCH);
				const requests = new Array<{
					cx: number;
					cy: number;
					cz: number;
					lod: number;
					cachedVersion: number;
				}>(count);
				let write = 0;
				for (let i = 0; i < count; i++) {
					const cx = dec.readInt32();
					const cy = dec.readInt32();
					const cz = dec.readInt32();
					const lod = dec.readUint8();
					const cachedVersion = dec.readUint32();
					if (!this.isValidChunkRequest(cx, cy, cz, lod, cachedVersion)) {
						continue;
					}
					requests[write++] = { cx, cy, cz, lod, cachedVersion };
				}
				requests.length = write;
				if (write > 0) {
					void this.handleBatchChunkRequest(client, requests);
				}
				break;
			}

			case MessageType.ChatMessage: {
				const chat: ChatMessageData = dec.readChatMessage();
				const player = this.players.get(client.sessionId);
				if (!player) return;

				const trimmed = chat.message.trim();
				if (trimmed.length === 0) return; // ignore empty messages
				const firstChar = trimmed.charCodeAt(0);

				// Server-authoritative commands are prefixed with '!' or '/'
				// and consumed here instead of being relayed as chat.
				if (firstChar === 33 || firstChar === 47) {
					if (this.handleChatCommand(client, trimmed.slice(1).trim())) {
						break;
					}
				}

				// Relay to everyone except the sender — the sender already
				// echoed locally.
				const payload = encodeChatMessage({
					sessionId: client.sessionId,
					name: player.name,
					message: chat.message,
				});
				this.broadcastBytes("binary", payload, { except: client });
				break;
			}

			default:
				// First unknown type per session only — repeat offenders are
				// silently dropped instead of allocating a log string each.
				if (!this.unknownTypeWarned.has(client.sessionId)) {
					this.unknownTypeWarned.add(client.sessionId);
					console.warn(
						`[VoxelRoom] Unknown message type: 0x${msgType.toString(16)}`,
					);
				}
		}
	}

	/**
	 * Serve a chunk to the requesting client.
	 * Checks storage first — only generates if not found in LevelDB.
	 */
	/**
	 * Apply the pending block edits for exactly the chunks being requested
	 * before serving a chunk request, so the returned data reflects every
	 * edit players have already made. Unlike flushing the whole world's edit
	 * queue, this never stalls a chunk request behind unrelated chunks.
	 * No-op when nothing is pending for the requested chunks.
	 */
	private async ensureEditsApplied(keys: readonly number[]): Promise<void> {
		if (keys.length === 0) return;

		// Never apply edits for a chunk an in-flight flush is still writing:
		// waiting keeps per-chunk apply order and prevents a chunk request
		// from racing the flush loop for the same chunk.
		await this.waitForOverlappingFlush(keys);

		// Move the requested chunks' pending edits out synchronously so a
		// concurrent flush-loop swap can't double-own the same entries.
		const mine = new Map<
			number,
			Map<number, { x: number; y: number; z: number; blockId: number }>
		>();
		for (const key of keys) {
			const editMap = this.pendingChunkEdits.get(key);
			if (!editMap || editMap.size === 0) continue;
			this.pendingChunkEdits.delete(key);
			mine.set(key, editMap);
		}
		if (mine.size === 0) return;

		const applyTasks: Array<() => Promise<void>> = [];
		for (const key of mine.keys()) {
			const editMap = mine.get(key)!;
			const [cx, cy, cz] = unpackChunkKeyFast(key);
			applyTasks.push(() =>
				this.worldStorage.applyBlockEdits(cx, cy, cz, editMap.values()),
			);
		}

		try {
			await runWithConcurrency(applyTasks, FLUSH_CONCURRENCY);
			await this.worldStorage.flush();
			// Every moved entry is fully applied now — return to the pool.
			this.releaseEditEntries(mine);
		} catch (error) {
			// Requeue so the normal flush loop retries; the request itself
			// is served with the currently stored data.
			this.mergeFailedChunkEdits(new Set(mine.keys()), mine);
			throw error;
		}
	}

	private async handleChunkRequest(
		client: Client,
		cx: number,
		cy: number,
		cz: number,
		cachedVersion: number,
	): Promise<void> {
		try {
			await this.ensureEditsApplied([packChunkKeyFast(cx, cy, cz)]);
			// Version-based reconciliation: the client sends the version of
			// the data it already has (local cache or save). If it matches
			// the authoritative version, confirm with a short "unchanged"
			// stamp so the client applies its local copy; otherwise send the
			// full authoritative data. ensureEditsApplied() above guarantees
			// pending edits are applied before the version is compared, so a
			// confirmation can never be based on an un-applied edit.
			const stored = await this.worldStorage.readChunk(cx, cy, cz);
			if (stored) {
				if (stored.version === cachedVersion) {
					// Gate so the template literal isn't built per chunk
					// request when debug output is disabled.
					if (DEBUG_ENABLED) {
						debugLog(
							`[VoxelRoom] handleChunkRequest ${cx},${cy},${cz} cachedVersion=${cachedVersion} serverVersion=${stored.version} unchanged`,
						);
					}
					const msg = encodeChunkUnchanged(cx, cy, cz, stored.version);
					client.sendBytes("binary", msg);
					return;
				}
				if (DEBUG_ENABLED) {
					debugLog(
						`[VoxelRoom] handleChunkRequest ${cx},${cy},${cz} cachedVersion=${cachedVersion} serverVersion=${stored.version} sendingFullData`,
					);
				}
				const msg = encodeChunkData(stored);
				client.sendBytes("binary", msg);
				return;
			}

			const chunkData = await this.chunkGen.generateChunk(cx, cy, cz);

			const msg = encodeChunkData(chunkData);
			client.sendBytes("binary", msg);
		} catch (err) {
			console.error(`[VoxelRoom] Chunk gen failed for ${cx},${cy},${cz}:`, err);
		}
	}

	private async handleBatchChunkRequest(
		client: Client,
		requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>,
	): Promise<void> {
		try {
			const unique: typeof requests = [];
			const coords: Array<{ cx: number; cy: number; cz: number }> = [];
			const keys: number[] = [];
			const seen = new Set<number>();

			for (let i = 0; i < requests.length; i++) {
				const r = requests[i];
				const key = packChunkKeyFast(r.cx, r.cy, r.cz);
				if (seen.has(key)) continue;
				seen.add(key);
				unique.push(r);
				keys.push(key);
				coords.push({ cx: r.cx, cy: r.cy, cz: r.cz });
			}

			// Apply only this batch's pending edits — not the whole world's.
			await this.ensureEditsApplied(keys);

			const storedMap = await this.worldStorage.readChunks(coords);

			const missingCoords: Array<{
				chunkX: number;
				chunkY: number;
				chunkZ: number;
			}> = [];
			const fullChunks: StoredChunkData[] = [];
			const unchangedChunks: Array<{
				cx: number;
				cy: number;
				cz: number;
				version: number;
			}> = [];

			for (let i = 0; i < unique.length; i++) {
				const r = unique[i];
				const stored = storedMap.get(keys[i]);
				if (stored) {
					if (stored.version === r.cachedVersion) {
						// Client's copy matches the authoritative version —
						// confirm it so the client applies its local chunk.
						unchangedChunks.push({
							cx: r.cx,
							cy: r.cy,
							cz: r.cz,
							version: stored.version,
						});
					} else {
						fullChunks.push(stored);
					}
				} else {
					missingCoords.push({
						chunkX: r.cx,
						chunkY: r.cy,
						chunkZ: r.cz,
					});
				}
			}

			// Send storage hits immediately so the client doesn't wait for
			// generation of missing chunks to get cached data.
			if (fullChunks.length > 0) {
				this.sendChunkDataBatch(client, fullChunks);
			}
			if (unchangedChunks.length > 0) {
				this.sendUnchangedBatch(client, unchangedChunks);
			}

			// Generate missing chunks. Wrap in try-catch so a failure in one
			// chunk doesn't prevent the batch from completing.
			if (missingCoords.length > 0) {
				try {
					const generated =
						await this.chunkGen.generateChunksBatch(missingCoords);
					this.sendChunkDataBatch(client, generated);
				} catch (genErr) {
					// Send individual requests as fallback so at least some chunks
					// succeed even if the batch dispatch failed.
					for (const coord of missingCoords) {
						try {
							const data = await this.chunkGen.generateChunk(
								coord.chunkX,
								coord.chunkY,
								coord.chunkZ,
							);
							this.sendChunkDataBatch(client, [data]);
						} catch (singleErr) {
							console.error(
								`[VoxelRoom] Single chunk gen failed: ${coord.chunkX},${coord.chunkY},${coord.chunkZ}`,
								singleErr,
							);
						}
					}
				}
			}
		} catch (err) {
			console.error(
				`[VoxelRoom] Batch chunk request FAILED (${requests.length} chunks):`,
				err,
			);
		}
	}

	private sendUnchangedBatch(
		client: Client,
		unchangedChunks: Array<{
			cx: number;
			cy: number;
			cz: number;
			version: number;
		}>,
	): void {
		if (unchangedChunks.length === 0) return;
		const enc = this.chunkBatchEncoder;
		enc.reset();
		enc.writeUint8(MessageType.ChunkUnchangedBatch);
		enc.writeUint16(unchangedChunks.length);
		for (let i = 0; i < unchangedChunks.length; i++) {
			const u = unchangedChunks[i];
			enc.writeInt32(u.cx);
			enc.writeInt32(u.cy);
			enc.writeInt32(u.cz);
			enc.writeUint32(u.version);
		}
		client.sendBytes("binary", enc.getBytes());
	}
}
