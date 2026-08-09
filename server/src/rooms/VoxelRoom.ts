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
import { type Client, Room } from "colyseus";
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
	type BlockEditData,
	type ChatMessageData,
	MessageType,
	type PlayerStateBatchEntry,
} from "@/code/Network/protocol/messages.ts";
import {
	packChunkKeyFast,
	unpackChunkKeyFast,
} from "@/code/World/Storage/ChunkKey.ts";
import { getServerConfig } from "../config/ServerConfig.ts";
import { ChunkGenerationService } from "../world/ChunkGenerationService.ts";
import { ServerWorldStorage } from "../world/ServerWorldStorage.ts";

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
	/** Last time this player's position was persisted to storage (ms epoch). */
	lastSaveTime: number;
}

const MAX_STORED_EDITS = 1000; // Keep last N edits for new joiners
const TIME_BROADCAST_INTERVAL = 5000; // Broadcast time every 5 seconds
const FULL_SNAPSHOT_INTERVAL = 2000; // Periodic full player-state broadcast (ms)
const PLAYER_SAVE_INTERVAL = 3000; // Position persistence debounce (ms)

export class VoxelRoom extends Room {
	private players = new Map<string, ServerPlayerState>();
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private blockEdits: BlockEditData[] = []; // Edit history for sync on join
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
	private timeAccum = 0; // Accumulator for time broadcast
	private dayCycleAccum = 0; // Accumulator for day cycle advance
	private chunkGen!: ChunkGenerationService;
	private config = getServerConfig();
	private playersReady = new Set<string>(); // received spawn position

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
	private nextPlayerIndex = 0;
	private freedIndices: number[] = [];
	private lastFullSnapshot = 0;

	constructor() {
		super();
		this.maxClients = getServerConfig().maxPlayers;
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
		);
		await this.worldStorage.init();
		this.chunkGen.setStorage(this.worldStorage);

		// Keep block edit history for new joiners (sent as initial edits)
		this.blockEdits = [];

		// Set up fixed-rate simulation tick
		this.tickInterval = setInterval(
			() => this.tick(),
			1000 / this.config.tickRate,
		);

		// Register message handlers for binary protocol (raw bytes)
		this.onMessageBytes("binary", (client, data: Uint8Array) => {
			this.handleBinaryMessage(client, data);
		});
	}

	async onJoin(client: Client, options: { name?: string }) {
		const name = options.name ?? `Player${this.players.size + 1}`;
		console.log(`[VoxelRoom] ${name} (${client.sessionId}) joined`);

		// Restore saved position or use default spawn (keyed by player name, not sessionId)
		const saved = await this.worldStorage.loadPlayerPosition(name);
		const index = this.allocateIndex();
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

		// Force a full dirty pass so the joiner gets current positions on the
		// next tick even if nobody is moving.
		for (const p of this.players.values()) {
			p.dirty = true;
		}

		// Sync block edit history so new player sees existing world changes
		if (this.blockEdits.length > 0) {
			const batch = encodeBlockEditBatch(this.blockEdits);
			client.sendBytes("binary", batch);
		}

		// Send authoritative world seed so the client's clip map matches server terrain
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
	}

	onLeave(client: Client, code?: number) {
		const player = this.players.get(client.sessionId);
		console.log(
			`[VoxelRoom] ${player?.name ?? client.sessionId} left (code: ${code})`,
		);

		// Persist final position on disconnect so it's ready on next join
		if (player) {
			void this.worldStorage.savePlayerPosition(
				player.name,
				player.x,
				player.y,
				player.z,
				player.yaw,
				player.pitch,
			);
		}

		this.players.delete(client.sessionId);
		this.playersReady.delete(client.sessionId);
		if (player) this.freeIndex(player.index);

		const leaveMsg = encodePlayerLeave({ index: player?.index ?? 0 });
		this.broadcastBytes("binary", leaveMsg, {});
	}

	async onDispose() {
		console.log("[VoxelRoom] disposed");
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
		this.players.clear();

		// Flush any pending chunk saves
		this.clearChunkFlush();
		await this.flushDirtyChunks();
		this.pendingChunkEdits.clear();

		// Terminate worker threads
		await this.chunkGen.terminate();

		// Close storage
		if (this.worldStorage) {
			await this.worldStorage.dispose();
		}
	}

	private scheduleChunkFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			void this.flushDirtyChunks();
		}, 500);
	}

	private clearChunkFlush(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	private async flushDirtyChunks(): Promise<void> {
		this.clearChunkFlush();
		if (this.dirtyChunks.size === 0) return;

		// Swap in a fresh set instead of Array.from(this.dirtyChunks) +
		// clear(): any new edits that land while the applyBlockEdits calls
		// below are in flight get tracked on the new set and picked up by
		// the next flush (same behavior as before), without allocating an
		// extra array on every flush.
		const dirty = this.dirtyChunks;
		this.dirtyChunks = new Set();

		// Apply pending block edits to the stored chunks (parallel I/O).
		const applyTasks: Promise<void>[] = [];
		for (const key of dirty) {
			const editMap = this.pendingChunkEdits.get(key);
			this.pendingChunkEdits.delete(key);
			if (editMap && editMap.size > 0) {
				const [cx, cy, cz] = unpackChunkKeyFast(key);
				applyTasks.push(
					this.worldStorage.applyBlockEdits(
						cx,
						cy,
						cz,
						Array.from(editMap.values()),
					),
				);
			}
		}
		await Promise.all(applyTasks);
		await this.worldStorage.flush();
	}

	/** Assign the lowest free room player index (0-255). */
	private allocateIndex(): number {
		const idx = this.freedIndices.pop() ?? this.nextPlayerIndex++;
		if (idx > 255) return 255; // safety cap — far above maxClients
		return idx;
	}

	private freeIndex(index: number): void {
		this.freedIndices.push(index);
	}

	private tick(deltaMs = 50): void {
		if (this.players.size === 0) return;

		// Advance day/night cycle (only if enabled in config)
		if (this.config.dayCycle) {
			this.dayCycleAccum += deltaMs;
			this.timeOfDay =
				(this.dayCycleAccum % this.config.dayDuration) /
				this.config.dayDuration;
		}

		// Broadcast time periodically
		this.timeAccum += deltaMs;
		if (this.timeAccum >= TIME_BROADCAST_INTERVAL) {
			this.timeAccum = 0;
			const timeMsg = encodeWorldTime(this.timeOfDay);
			this.broadcastBytes("binary", timeMsg, {});
		}

		// Dirty-tracking broadcast: only players whose state changed since the
		// last tick are included, plus a periodic full snapshot so clients can
		// resync interpolation (and late joiners get current positions).
		const now = Date.now();
		const fullSnapshotDue =
			now - this.lastFullSnapshot >= FULL_SNAPSHOT_INTERVAL;
		if (fullSnapshotDue) this.lastFullSnapshot = now;

		this.statesScratch.length = 0;
		let idx = 0;
		for (const p of this.players.values()) {
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

		const dec = new BinaryDecoder(data);
		const msgType = dec.readUint8(); // consume type byte

		switch (msgType) {
			case MessageType.PlayerState: {
				const state = dec.readPlayerState();
				const player = this.players.get(client.sessionId);
				if (player) {
					player.x = state.x;
					player.y = state.y;
					player.z = state.z;
					player.yaw = state.yaw;
					player.pitch = state.pitch;
					player.animation = state.animation;
					player.dirty = true;
					// Persist debounced (at most every PLAYER_SAVE_INTERVAL ms) —
					// the per-tick save was hammering LevelDB at 20 writes/sec/player.
					// Only persist after the client has received its spawn position
					// (prevents race condition where default 0,80,0 overwrites saved pos).
					// Keyed by player name so position survives reconnects (sessionId changes each time).
					if (this.playersReady.has(client.sessionId)) {
						const now = Date.now();
						if (now - player.lastSaveTime >= PLAYER_SAVE_INTERVAL) {
							player.lastSaveTime = now;
							void this.worldStorage.savePlayerPosition(
								player.name,
								state.x,
								state.y,
								state.z,
								state.yaw,
								state.pitch,
							);
						}
					}
				}
				break;
			}

			case MessageType.BlockEdit: {
				const edit = dec.readBlockEdit();
				const player = this.players.get(client.sessionId);
				if (!player) return;

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

				// Store edit for future joiners (cap at max)
				const storedEdit: BlockEditData = {
					sessionId: client.sessionId,
					x: edit.x,
					y: edit.y,
					z: edit.z,
					blockId: edit.blockId,
					action: edit.action,
				};
				this.blockEdits.push(storedEdit);
				if (this.blockEdits.length > MAX_STORED_EDITS) {
					this.blockEdits.shift();
				}

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
					blockId: edit.blockId,
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
				const requests = dec.readChunkRequestBatch();
				const valid = requests.filter((r: { lod: number }) => r.lod === 0);
				if (valid.length > 0) {
					void this.handleBatchChunkRequest(client, valid);
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
			// Deduplicate coords — one response per unique chunk.
			const seen = new Map<number, (typeof requests)[0]>();
			for (const r of requests) {
				const key = packChunkKeyFast(r.cx, r.cy, r.cz);
				if (!seen.has(key)) seen.set(key, r);
			}
			const unique = Array.from(seen.values());

			// Bulk read from storage in parallel — only generate what's missing.
			const storedMap = await this.worldStorage.readChunks(
				unique.map((r) => ({ cx: r.cx, cy: r.cy, cz: r.cz })),
			);

			const missing: typeof requests = [];
			for (const r of unique) {
				const stored = storedMap.get(packChunkKeyFast(r.cx, r.cy, r.cz));
				if (stored) {
					if (r.cachedHash !== 0 && stored.hash === r.cachedHash) {
						const msg = encodeChunkUnchanged(r.cx, r.cy, r.cz, stored.hash);
						client.sendBytes("binary", msg);
					} else {
						const msg = encodeChunkData(stored);
						client.sendBytes("binary", msg);
					}
				} else {
					missing.push(r);
				}
			}

			if (missing.length > 0) {
				const generated = await this.chunkGen.generateChunksBatch(
					missing.map((r) => ({ chunkX: r.cx, chunkY: r.cy, chunkZ: r.cz })),
				);

				const fullChunks: Array<{
					cx: number;
					cy: number;
					cz: number;
					data: (typeof generated)[0];
				}> = [];
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
						fullChunks.push({ ...missing[i], data: generated[i] });
					}
				}

				if (fullChunks.length > 0) {
					const msg = encodeChunkDataBatch(fullChunks.map((c) => c.data));
					client.sendBytes("binary", msg);
				}
			}
		} catch (err) {
			console.error(
				`[VoxelRoom] Batch chunk gen failed (${requests.length} chunks):`,
				err,
			);
		}
	}
}
