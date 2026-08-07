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
		this.chunkGen.setSeed(this.seed);
		console.log(`[VoxelRoom] terrain seed: ${this.seed} (from server.properties)`);

		// Initialize world storage (persistence) and load existing edits
		this.worldStorage = new ServerWorldStorage(this.worldName);
		await this.worldStorage.init();

		// Restore in-memory edit history from storage
		this.blockEdits = this.worldStorage
			.getEdits()
			.map((e) => ({ sessionId: "stored", ...e }));

		console.log(
			`[VoxelRoom] loaded ${this.blockEdits.length} stored edits for ${this.worldName}`,
		);

		// Set up fixed-rate simulation tick
		this.tickInterval = setInterval(
			() => this.tick(),
			1000 / this.config.tickRate,
		);

		// Register message handlers for binary protocol (raw bytes)
		this.onMessageBytes("binary", (client, data: Uint8Array) => {
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

		// Terminate worker threads
		await this.chunkGen.terminate();

		// Persist world edits to disk
		if (this.worldStorage) {
			await this.worldStorage.save();
			console.log(
				`[VoxelRoom] saved ${this.worldStorage.editCount} edits for ${this.worldName}`,
			);
		}
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

				// Persist to server storage
				this.worldStorage.addEdit({
					x: edit.x,
					y: edit.y,
					z: edit.z,
					blockId: edit.blockId,
					action: edit.action,
					timestamp: Date.now(),
				});

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

			default:
				console.warn(
					`[VoxelRoom] Unknown message type: 0x${msgType.toString(16)}`,
				);
		}
	}

	/**
	 * Generate a chunk and send it to the requesting client.
	 * Runs generation off the main handler to avoid blocking other messages.
	 */
	private async handleChunkRequest(
		client: Client,
		cx: number,
		cy: number,
		cz: number,
		cachedHash: number,
	): Promise<void> {
		try {
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
			const results = await this.chunkGen.generateChunksBatch(
				requests.map((r) => ({ chunkX: r.cx, chunkY: r.cy, chunkZ: r.cz })),
			);

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

			if (fullChunks.length > 0) {
				const msg = encodeChunkDataBatch(fullChunks);
				client.sendBytes("binary", msg);
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
