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
import {
	BinaryDecoder,
	BinaryEncoder,
	encodeBlockEditBatch,
	encodeBlockEditBroadcast,
	encodeChatMessage,
	encodeChunkData,
	encodeChunkDataBatch,
	encodeChunkUnchanged,
	encodePlayerJoin,
	encodePlayerLeave,
	encodeSpawnPosition,
	encodeWorldConfig,
	encodeWorldTime,
	writePlayerStateBatch,
} from "@/code/Network/protocol/encoder.ts";
import {
	BlockActionType,
	type BlockEditData,
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

const MAX_STORED_EDITS = 1000; // Keep last N edits for new joiners
const TIME_BROADCAST_INTERVAL = 5000; // Broadcast time every 5 seconds
const FULL_SNAPSHOT_INTERVAL = 2000; // Periodic full player-state broadcast (ms)
const PLAYER_SAVE_INTERVAL = 3000; // Position persistence debounce (ms)
const MAX_CHUNK_BATCH = 128; // Cap chunks per batch request (prevents DoS)
const WORLD_BOUNDARY = 1_000_000; // Reject world coords beyond ±1M blocks
const MAX_BLOCK_ID = 255; // Block data is stored as one byte per voxel
const MAX_PROTOCOL_VIOLATIONS = 16; // Malformed packets before disconnect
const FLUSH_CONCURRENCY = 8; // Max parallel chunk storage ops per flush
const CHUNK_BATCH_BYTE_LIMIT = 256 * 1024; // Max bytes per ChunkDataBatch send

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
	private chunkGen!: ChunkGenerationService;
	private config = getServerConfig();
	private playersReady = new Set<string>(); // received spawn position
	private protocolViolations = new Map<string, number>(); // sessionId → bad packets
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
			const saved = await this.worldStorage.loadPlayerPosition(name);

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

			// Send existing players to the new client (so they can render them)
			for (const [sid, p] of this.players) {
				if (sid === client.sessionId) continue;
				const existingJoin = encodePlayerJoin({
					index: p.index,
					sessionId: sid,
					name: p.name,
				});
				client.sendBytes("binary", existingJoin);
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
		const player = this.players.get(client.sessionId);
		console.log(
			`[VoxelRoom] ${player?.name ?? client.sessionId} left (code: ${code})`,
		);

		// Unknown player (e.g. join aborted before insertion): never broadcast
		// a leave for index 0 — that would remove an existing player on clients.
		if (!player) return;

		// Persist final position on disconnect so it's ready on next join
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
					this.worldStorage.applyBlockEdits(
						cx,
						cy,
						cz,
						Array.from(editMap.values()),
					),
				);
			}
			await runWithConcurrency(applyTasks, FLUSH_CONCURRENCY);
			await this.worldStorage.flush();
		} catch (error) {
			this.mergeFailedChunkEdits(dirty, edits);
			throw error;
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

		// Broadcast time periodically
		this.timeAccum += deltaMs;
		if (this.timeAccum >= TIME_BROADCAST_INTERVAL) {
			this.timeAccum = 0;
			const timeMsg = encodeWorldTime(this.timeOfDay);
			this.broadcastBytes("binary", timeMsg, {});
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
			this.recordProtocolViolation(client);
			console.warn(
				`[VoxelRoom] Invalid binary packet from ${client.sessionId}:`,
				error,
			);
		}
	}

	private recordProtocolViolation(client: Client): void {
		const count = (this.protocolViolations.get(client.sessionId) ?? 0) + 1;
		this.protocolViolations.set(client.sessionId, count);
		if (count >= MAX_PROTOCOL_VIOLATIONS) {
			this.protocolViolations.delete(client.sessionId);
			client.leave(CloseCode.WITH_ERROR, "Too many malformed packets");
		}
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
		let size = 12 + 4 + 1; // coords + hash + flags
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
			enc.writeUint32(c.hash);
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
				const edit = dec.readBlockEdit();
				const player = this.players.get(client.sessionId);
				if (!player) return;
				if (!this.isValidBlockEdit(edit)) return;

				// Reach check: player must be within max-reach blocks
				const dx = edit.x - player.x;
				const dy = edit.y - player.y;
				const dz = edit.z - player.z;
				const distSq = dx * dx + dy * dy + dz * dz;
				const maxReachSq = this.config.maxReach * this.config.maxReach;
				if (distSq > maxReachSq) {
					console.warn(
						`[VoxelRoom] Block edit rejected: too far (${Math.sqrt(distSq).toFixed(1)} blocks)`,
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
				// Last write wins per voxel
				editMap.set(lx + (ly << 5) + (lz << 10), {
					x: edit.x,
					y: edit.y,
					z: edit.z,
					blockId,
				});
				this.dirtyChunks.add(key);
				this.scheduleChunkFlush();

				// Broadcast to all other clients
				const msg = encodeBlockEditBroadcast(storedEdit);
				this.broadcastBytes("binary", msg, { except: client });
				break;
			}

			case MessageType.ChunkRequest: {
				const { cx, cy, cz, lod, cachedHash } = dec.readChunkRequest();
				if (lod !== 0) break;
				void this.handleChunkRequest(client, cx, cy, cz, cachedHash);
				break;
			}

			case MessageType.ChunkRequestBatch: {
				// Decode into a single array, compacting out lod !== 0 entries
				// in place (no second .filter() allocation) and bounding the
				// decode at MAX_CHUNK_BATCH so a hostile packet can't force an
				// unbounded array + decode pass.
				const count = Math.min(dec.readUint16(), MAX_CHUNK_BATCH);
				const requests = new Array<{
					cx: number;
					cy: number;
					cz: number;
					lod: number;
					cachedHash: number;
				}>(count);
				let write = 0;
				for (let i = 0; i < count; i++) {
					const cx = dec.readInt32();
					const cy = dec.readInt32();
					const cz = dec.readInt32();
					const lod = dec.readUint8();
					const cachedHash = dec.readUint32();
					if (lod !== 0) continue;
					requests[write++] = { cx, cy, cz, lod, cachedHash };
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
				console.warn(
					`[VoxelRoom] Unknown message type: 0x${msgType.toString(16)}`,
				);
		}
	}

	/**
	 * Serve a chunk to the requesting client.
	 * Checks storage first — only generates if not found in LevelDB.
	 */
	private async handleChunkRequest(
		client: Client,
		cx: number,
		cy: number,
		cz: number,
		cachedHash: number,
	): Promise<void> {
		try {
			// Check storage first (fast path — no regeneration)
			const stored = await this.worldStorage.readChunk(cx, cy, cz);
			if (stored) {
				if (cachedHash !== 0 && stored.hash === cachedHash) {
					const msg = encodeChunkUnchanged(cx, cy, cz, stored.hash);
					client.sendBytes("binary", msg);
					return;
				}
				const msg = encodeChunkData(stored);
				client.sendBytes("binary", msg);
				return;
			}

			// Not in storage — generate, which also saves to storage
			const chunkData = await this.chunkGen.generateChunk(cx, cy, cz);

			if (cachedHash !== 0 && chunkData.hash === cachedHash) {
				const msg = encodeChunkUnchanged(cx, cy, cz, chunkData.hash);
				client.sendBytes("binary", msg);
				return;
			}

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
			cachedHash: number;
		}>,
	): Promise<void> {
		try {
			const unique: typeof requests = [];
			const coords: Array<{ cx: number; cy: number; cz: number }> = [];
			const seen = new Set<number>();

			for (let i = 0; i < requests.length; i++) {
				const r = requests[i];
				const key = packChunkKeyFast(r.cx, r.cy, r.cz);
				if (seen.has(key)) continue;
				seen.add(key);
				unique.push(r);
				coords.push({ cx: r.cx, cy: r.cy, cz: r.cz });
			}

			const storedMap = await this.worldStorage.readChunks(coords);

			const missing: typeof requests = [];
			const fullChunks: StoredChunkData[] = [];
			const missingCoords: Array<{
				chunkX: number;
				chunkY: number;
				chunkZ: number;
			}> = [];

			for (let i = 0; i < unique.length; i++) {
				const r = unique[i];
				const stored = storedMap.get(packChunkKeyFast(r.cx, r.cy, r.cz));
				if (stored) {
					if (r.cachedHash !== 0 && stored.hash === r.cachedHash) {
						const msg = encodeChunkUnchanged(r.cx, r.cy, r.cz, stored.hash);
						client.sendBytes("binary", msg);
					} else {
						fullChunks.push(stored);
					}
				} else {
					missing.push(r);
					missingCoords.push({
						chunkX: r.cx,
						chunkY: r.cy,
						chunkZ: r.cz,
					});
				}
			}

			if (missing.length > 0) {
				const generated =
					await this.chunkGen.generateChunksBatch(missingCoords);

				for (let i = 0; i < generated.length; i++) {
					const cachedHash = missing[i].cachedHash;
					if (cachedHash !== 0 && generated[i].hash === cachedHash) {
						const msg = encodeChunkUnchanged(
							generated[i].chunkX,
							generated[i].chunkY,
							generated[i].chunkZ,
							generated[i].hash,
						);
						client.sendBytes("binary", msg);
					} else {
						fullChunks.push(generated[i]);
					}
				}
			}

			this.sendChunkDataBatch(client, fullChunks);
		} catch (err) {
			console.error(
				`[VoxelRoom] Batch chunk gen failed (${requests.length} chunks):`,
				err,
			);
		}
	}
}
