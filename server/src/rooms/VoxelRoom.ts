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
import { getServerConfig } from "../config/ServerConfig.ts";
import {
	BinaryDecoder,
	encodeBlockEditBatch,
	encodeBlockEditBroadcast,
	encodeChatMessage,
	encodeChunkData,
	encodeChunkDataBatch,
	encodeChunkUnchanged,
	encodePlayerJoin,
	encodePlayerLeave,
	encodePlayerStateBatch,
	encodeWorldConfig,
	encodeWorldTime,
} from "../protocol/encoder.ts";
import {
	type BlockEditData,
	MessageType,
	type PlayerStateData,
} from "../protocol/messages.ts";
import { ChunkGenerationService } from "../world/ChunkGenerationService.ts";
import { ServerWorldStorage } from "../world/ServerWorldStorage.ts";

interface ServerPlayerState {
	sessionId: string;
	name: string;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	animation: number;
}

const MAX_STORED_EDITS = 1000; // Keep last N edits for new joiners
const TIME_BROADCAST_INTERVAL = 5000; // Broadcast time every 5 seconds

export class VoxelRoom extends Room {
	private players = new Map<string, ServerPlayerState>();
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private blockEdits: BlockEditData[] = []; // Edit history for sync on join
	private timeOfDay = 0.3; // Start at morning (0..1)
	private worldStorage!: ServerWorldStorage;
	private worldName = "default";
	private seed = "default";
	private dirtyChunks = new Set<string>(); // chunks pending save
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private timeAccum = 0; // Accumulator for time broadcast
	private dayCycleAccum = 0; // Accumulator for day cycle advance
	private chunkGen!: ChunkGenerationService;
	private config = getServerConfig();

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
			console.log(`[SVR-ENTRY] binary msg ${data.byteLength} bytes from ${client.sessionId}`);
			this.handleBinaryMessage(client, data);
		});

		// Register message handlers for JSON control messages (chat, etc.)
		this.onMessage("chat", (client, message: string) => {
			const player = this.players.get(client.sessionId);
			if (!player) return;
			const payload = encodeChatMessage({
				sessionId: client.sessionId,
				name: player.name,
				message,
			});
			this.broadcastBytes("binary", payload, {});
		});
	}

	onJoin(client: Client, options: { name?: string }) {
		const name = options.name ?? `Player${this.players.size + 1}`;
		console.log(`[VoxelRoom] ${name} (${client.sessionId}) joined`);

		// Initialize player state at origin (will be updated by client)
		const state: ServerPlayerState = {
			sessionId: client.sessionId,
			name,
			x: 0,
			y: 80, // Default spawn height
			z: 0,
			yaw: 0,
			pitch: 0,
			animation: 0,
		};
		this.players.set(client.sessionId, state);

		// Notify others of new player
		const joinMsg = encodePlayerJoin({ sessionId: client.sessionId, name });
		this.broadcastBytes("binary", joinMsg, { except: client });

		// Send existing players to the new client (so they can render them)
		for (const [sid, p] of this.players) {
			if (sid === client.sessionId) continue;
			const existingJoin = encodePlayerJoin({ sessionId: sid, name: p.name });
			client.sendBytes("binary", existingJoin);
		}

		// Sync block edit history so new player sees existing world changes
		if (this.blockEdits.length > 0) {
			const batch = encodeBlockEditBatch(this.blockEdits);
			client.sendBytes("binary", batch);
			console.log(
				`[VoxelRoom] Synced ${this.blockEdits.length} block edits to ${name}`,
			);
		}

		// Send authoritative world seed so the client's clip map matches server terrain
		const configMsg = encodeWorldConfig(this.seed);
		client.sendBytes("binary", configMsg);
	}

	onLeave(client: Client, code?: number) {
		const player = this.players.get(client.sessionId);
		console.log(
			`[VoxelRoom] ${player?.name ?? client.sessionId} left (code: ${code})`,
		);

		this.players.delete(client.sessionId);

		const leaveMsg = encodePlayerLeave({ sessionId: client.sessionId });
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

		const keys = Array.from(this.dirtyChunks);
		this.dirtyChunks.clear();

		for (const key of keys) {
			const [cx, cy, cz] = key.split(",").map(Number);
			const stored = await this.worldStorage.readChunk(cx, cy, cz);
			if (stored) {
				// Re-save to persist the latest state (includes block edits)
				this.worldStorage.writeChunk({
					chunkX: cx,
					chunkY: cy,
					chunkZ: cz,
					blocks: stored.blocks,
					light: stored.light,
					palette: stored.palette,
					isUniform: stored.isUniform,
					uniformBlockId: stored.uniformBlockId,
				});
			}
		}
		await this.worldStorage.flush();
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

		// Build batch of all player states
		const states: PlayerStateData[] = [];
		for (const [, p] of this.players) {
			states.push({
				sessionId: p.sessionId,
				x: p.x,
				y: p.y,
				z: p.z,
				yaw: p.yaw,
				pitch: p.pitch,
				animation: p.animation,
			});
		}

		const batch = encodePlayerStateBatch(states);
		this.broadcastBytes("binary", batch, {});
	}

	private handleBinaryMessage(client: Client, data: Uint8Array): void {
		if (data.byteLength < 1) return;

		const dec = new BinaryDecoder(data);
		const msgType = dec.readUint8(); // consume type byte
		console.log(`[SVR-RX] msgType=0x${msgType.toString(16)} from ${client.sessionId}`);

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

				// Schedule chunk save (debounced) — the chunk will be serialized
				// and written to LevelDB when the flush timer fires
				const cx = Math.floor(edit.x / 32);
				const cy = Math.floor(edit.y / 32);
				const cz = Math.floor(edit.z / 32);
				this.dirtyChunks.add(`${cx},${cy},${cz}`);
				this.scheduleChunkFlush();

				// Broadcast to all other clients
				const msg = encodeBlockEditBroadcast(storedEdit);
				this.broadcastBytes("binary", msg, { except: client });
				break;
			}

			case MessageType.ChunkRequest: {
				const { cx, cy, cz, lod, cachedHash } = dec.readChunkRequest();
				console.log(`[SVR-RX] ChunkRequest ${cx},${cy},${cz} lod=${lod} hash=${cachedHash}`);
				if (lod !== 0) break;
				void this.handleChunkRequest(client, cx, cy, cz, cachedHash);
				break;
			}

			case MessageType.ChunkRequestBatch: {
				const requests = dec.readChunkRequestBatch();
				const valid = requests.filter((r: { lod: number }) => r.lod === 0);
				console.log(`[SVR-RX] ChunkRequestBatch ${requests.length} chunks (${valid.length} valid)`);
				if (valid.length > 0) {
					void this.handleBatchChunkRequest(client, valid);
				}
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
			console.log(`[SVR] handleChunkRequest ${cx},${cy},${cz} — checking storage`);
			// Check storage first (fast path — no regeneration)
			const stored = await this.worldStorage.readChunk(cx, cy, cz);
			if (stored) {
				console.log(`[SVR] found in storage ${cx},${cy},${cz} hash=${stored.hash}`);
				if (cachedHash !== 0 && stored.hash === cachedHash) {
					const msg = encodeChunkUnchanged(cx, cy, cz, stored.hash);
					client.sendBytes("binary", msg);
					console.log(`[SVR] sent ChunkUnchanged ${cx},${cy},${cz}`);
					return;
				}
				const msg = encodeChunkData(stored);
				client.sendBytes("binary", msg);
				console.log(`[SVR] sent ChunkData ${cx},${cy},${cz}`);
				return;
			}

			console.log(`[SVR] not in storage, generating ${cx},${cy},${cz}`);
			// Not in storage — generate, which also saves to storage
			const chunkData = await this.chunkGen.generateChunk(cx, cy, cz);
			console.log(`[SVR] generation done ${cx},${cy},${cz} hash=${chunkData.hash}`);

			if (cachedHash !== 0 && chunkData.hash === cachedHash) {
				const msg = encodeChunkUnchanged(cx, cy, cz, chunkData.hash);
				client.sendBytes("binary", msg);
				console.log(`[SVR] sent ChunkUnchanged ${cx},${cy},${cz}`);
				return;
			}

			const msg = encodeChunkData(chunkData);
			client.sendBytes("binary", msg);
			console.log(`[SVR] sent ChunkData ${cx},${cy},${cz}`);
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
		console.log(`[SVR] generating batch of ${requests.length} chunks`);
		try {
			const results = await this.chunkGen.generateChunksBatch(
				requests.map((r) => ({ chunkX: r.cx, chunkY: r.cy, chunkZ: r.cz })),
			);
			console.log(`[SVR] batch done: ${results.length} chunks generated`);

			const unchanged: Array<{
				cx: number;
				cy: number;
				cz: number;
				hash: number;
			}> = [];
			const fullChunks: typeof results = [];

			for (let i = 0; i < results.length; i++) {
				const cachedHash = requests[i].cachedHash;
				if (cachedHash !== 0 && results[i].hash === cachedHash) {
					unchanged.push({
						cx: results[i].chunkX,
						cy: results[i].chunkY,
						cz: results[i].chunkZ,
						hash: results[i].hash,
					});
				} else {
					fullChunks.push(results[i]);
				}
			}

			console.log(`[SVR] sending ${fullChunks.length} full + ${unchanged.length} unchanged`);
			console.log(`[SVR] client.connected=${client.state}, sessionId=${client.sessionId}`);

			if (fullChunks.length > 0) {
				const msg = encodeChunkDataBatch(fullChunks);
				console.log(`[SVR] sendBytes ChunkDataBatch (${msg.length} bytes) to ${client.sessionId}`);
				try {
					client.sendBytes("binary", msg);
					console.log(`[SVR] sendBytes OK`);
				} catch (sendErr) {
					console.error(`[SVR] sendBytes FAILED:`, sendErr);
				}
			}

			for (const u of unchanged) {
				const msg = encodeChunkUnchanged(u.cx, u.cy, u.cz, u.hash);
				client.sendBytes("binary", msg);
			}
		} catch (err) {
			console.error(
				`[VoxelRoom] Batch chunk gen failed (${requests.length} chunks):`,
				err,
			);
		}
	}
}
