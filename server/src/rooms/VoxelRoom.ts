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
	encodeBlockEditBatch,
	encodeBlockEditBroadcast,
	encodeChatMessage,
	encodeChunkData,
	encodePlayerJoin,
	encodePlayerLeave,
	encodePlayerStateBatch,
	encodeWorldTime,
} from "../protocol/encoder.ts";
import {
	type BlockEditData,
	MessageType,
	type PlayerStateData,
} from "../protocol/messages.ts";
import { ChunkGenerationService } from "../world/ChunkGenerationService.ts";

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

const TICK_RATE = 20; // Hz
const MAX_PLAYERS = 24;
const MAX_STORED_EDITS = 1000; // Keep last N edits for new joiners
const DAY_DURATION_MS = 120000; // 2 minutes per day cycle
const TIME_BROADCAST_INTERVAL = 5000; // Broadcast time every 5 seconds

export class VoxelRoom extends Room {
	private players = new Map<string, ServerPlayerState>();
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private blockEdits: BlockEditData[] = []; // Edit history for sync on join
	private timeOfDay = 0.3; // Start at morning (0..1)
	private timeAccum = 0; // Accumulator for time broadcast
	private dayCycleAccum = 0; // Accumulator for day cycle advance
	private chunkGen!: ChunkGenerationService;

	maxClients = MAX_PLAYERS;

	onCreate(options: { worldName?: string; seed?: string }) {
		console.log(
			`[VoxelRoom] created for world: ${options.worldName ?? "default"}`,
		);

		// Initialize chunk generation service with seed
		this.chunkGen = new ChunkGenerationService();
		const seed = options.seed ?? options.worldName ?? "default";
		this.chunkGen.setSeed(String(seed));
		console.log(`[VoxelRoom] terrain seed: ${seed}`);

		// Set up fixed-rate simulation tick
		this.tickInterval = setInterval(() => this.tick(), 1000 / TICK_RATE);

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

	onDispose() {
		console.log("[VoxelRoom] disposed");
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
		this.players.clear();
	}

	private tick(deltaMs = 50): void {
		if (this.players.size === 0) return;

		// Advance day/night cycle
		this.dayCycleAccum += deltaMs;
		this.timeOfDay = (this.dayCycleAccum % DAY_DURATION_MS) / DAY_DURATION_MS;

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

				// Simple reach check: player must be within reasonable distance
				const dx = edit.x - player.x;
				const dy = edit.y - player.y;
				const dz = edit.z - player.z;
				const distSq = dx * dx + dy * dy + dz * dz;
				const MAX_REACH_SQ = 8 * 8; // 64 blocks²
				if (distSq > MAX_REACH_SQ) {
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

				// Broadcast to all other clients
				const msg = encodeBlockEditBroadcast(storedEdit);
				this.broadcastBytes("binary", msg, { except: client });
				break;
			}

			case MessageType.ChunkRequest: {
				const { cx, cy, cz, lod } = dec.readChunkRequest();
				// Only support LOD0 for now
				if (lod !== 0) break;

				// Generate chunk asynchronously (don't block other messages)
				void this.handleChunkRequest(client, cx, cy, cz);
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
	): Promise<void> {
		try {
			console.log(`[VoxelRoom] chunk request ${cx},${cy},${cz}`);
			const chunkData = await this.chunkGen.generateChunk(cx, cy, cz);
			const msg = encodeChunkData(chunkData);
			client.sendBytes("binary", msg);
			console.log(
				`[VoxelRoom] sent chunk ${cx},${cy},${cz} blocks=${chunkData.blocks.byteLength} uniform=${chunkData.isUniform} palette=${chunkData.palette ? chunkData.palette.length : "none"}`,
			);
		} catch (err) {
			console.error(
				`[VoxelRoom] Chunk gen failed for ${cx},${cy},${cz}:`,
				err,
			);
		}
	}
}
