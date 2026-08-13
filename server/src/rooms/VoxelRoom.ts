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
	encodeBlockEditBatch,
	encodeBlockEditRejected,
	encodeChatMessage,
	encodeChunkData,
	encodeChunkUnchanged,
	encodePlayerJoin,
	encodePlayerLeave,
	encodeSpawnPosition,
	encodeWorldConfig,
	hashChunk,
	writePlayerStateBatch,
} from "@/code/Network/protocol/encoder.ts";
import {
	BlockActionType,
	type BlockEditData,
	BlockEditRejectReason,
	type ChatMessageData,
	MessageType,
	type PlayerStateBatchEntry,
	type PlayerStateData,
} from "@/code/Network/protocol/messages.ts";
import {
	packChunkKeyFast,
	unpackChunkKeyFast,
} from "@/code/World/Storage/ChunkKey.ts";
import { getServerConfig } from "../config/ServerConfig.ts";
import { ChunkGenerationService } from "../world/ChunkGenerationService.ts";
import type { StoredChunkData } from "../world/ServerWorldStorage.ts";
import { ServerWorldStorage } from "../world/ServerWorldStorage.ts";

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
const MAX_CHUNK_BATCH = 128; // Cap chunks per batch request (prevents DoS)
const WORLD_BOUNDARY = 1_000_000; // Reject world coords beyond ±1M blocks
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
	// Ring buffer of recent edits for sync on join (insertion O(1)).
	private readonly blockEdits: Array<BlockEditData | undefined> = new Array(
		MAX_STORED_EDITS,
	);
	private blockEditStart = 0;
	private blockEditCount = 0;
	private timeOfDay = 0.3; // Start at morning (0..1)
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

		// Kick off spawn-area generation in the background so the first join
		// serves from storage instead of stalling behind ~637 cold chunks.
		this.prewarmSpawnArea();

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

			const state: ServerPlayerState = {
				sessionId: client.sessionId,
				index,
				name,
				x: saved?.x ?? 0,
				y: saved?.y ?? 80,
				z: saved?.z ?? 0,
				yaw: saved?.yaw ?? 0,
				pitch: saved?.pitch ?? 0,
				animation: 0,
				dirty: true,
				saveDirty: false,
				lastSaveTime: 0,
			};
			// Cache the position so next join skips LevelDB (even for first-timers).
			if (!cached) {
				this.playerPositionCache.set(name, {
					x: state.x,
					y: state.y,
					z: state.z,
					yaw: state.yaw,
					pitch: state.pitch,
				});
			}
			this.players.set(client.sessionId, state);

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

			// Force a full dirty pass so the joiner gets current positions on
			// the next tick even if nobody is moving.
			for (const p of this.players.values()) {
				p.dirty = true;
			}

			// Sync block edit history so new player sees existing world changes
			if (this.blockEditCount > 0) {
				const batch = encodeBlockEditBatch(this.getBlockEditHistory());
				client.sendBytes("binary", batch);
			}

			// Send authoritative world seed so the client's clip map matches
			// server terrain
			const configMsg = encodeWorldConfig(this.seed);
			client.sendBytes("binary", configMsg);

			// Tell client where to spawn (saved position or default)
			const spawnMsg = encodeSpawnPosition(
				state.x,
				state.y,
				state.z,
				state.yaw,
				state.pitch,
			);
			client.sendBytes("binary", spawnMsg);

			// Now safe to save positions (client has been told where to spawn)
			this.playersReady.add(client.sessionId);
		} catch (error) {
			// Storage failure must not leak an allocated index or a partially
			// initialized player.
			this.players.delete(client.sessionId);
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
		this.playersReady.delete(client.sessionId);
		this.freeIndex(player.index);

		this.broadcastBytes(
			"binary",
			encodePlayerLeave({ index: player.index }),
			{},
		);
	}

	async onDispose() {
		console.log("[VoxelRoom] disposed");
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
		this.players.clear();

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
		if (recycled !== undefined) return recycled;

		if (this.nextPlayerIndex > 255) {
			// Never silently hand out duplicate indices — identity collisions
			// on clients corrupt their player map.
			throw new Error("Player index space exhausted");
		}

		return this.nextPlayerIndex++;
	}

	private freeIndex(index: number): void {
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
	 * Background pre-generation of the spawn area. The first join requests
	 * ~637 chunks (7x7 columns x 13 Y-levels around the default spawn chunk
	 * (0,2,0)); generating them all on-demand stalls the join, especially
	 * while the worker pool is still loading WASM. Running it here means
	 * join batches mostly hit storage. Runs concurrently with the normal
	 * generation path — ChunkGenerationService dedupes shared coordinates,
	 * so a player request overlapping the prewarm waits on the same work
	 * instead of duplicating it.
	 */
	private prewarmSpawnArea(): void {
		this.reportAsync("Spawn area prewarm failed", this.prewarmSpawnAreaImpl());
	}

	private async prewarmSpawnAreaImpl(): Promise<void> {
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
				for (
					let cy = PREWARM_MIN_CHUNK_Y;
					cy <= PREWARM_MAX_CHUNK_Y;
					cy++
				) {
					coords.push({ cx: dx, cy, cz: dz });
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
		let size = 12 + 4 + 4 + 1; // coords + hash + version + flags
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
			enc.writeUint32(hashChunk(c.blocks, c.light, c.palette));
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
				if (req.lod !== 0) break;
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
					if (lod !== 0) continue;
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
				const msg = encodeChunkData({
					...stored,
					hash: hashChunk(stored.blocks, stored.light, stored.palette),
				});
				client.sendBytes("binary", msg);
				return;
			}

			const chunkData = await this.chunkGen.generateChunk(cx, cy, cz);

			const msg = encodeChunkData({
				...chunkData,
				hash: hashChunk(chunkData.blocks, chunkData.light, chunkData.palette),
			});
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
