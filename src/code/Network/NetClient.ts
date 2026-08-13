/**
 * NetClient — connection manager for b102 multiplayer.
 *
 * Wraps the Colyseus SDK to provide:
 * - Connection lifecycle (connect, disconnect, reconnect)
 * - Binary message send/receive for game data
 * - Event callbacks for player join/leave, state updates, block edits
 */
import { ColyseusSDK } from "@colyseus/sdk";
import {
	BinaryDecoder,
	BinaryEncoder,
	decodeBlockEditBatch,
	decodeBlockEditBroadcast,
	decodeBlockEditRejected,
	decodeChatMessage,
	decodePlayerJoin,
	decodePlayerLeave,
	decodePlayerStateBatchInto,
	decodeSpawnPosition,
	decodeWorldConfig,
	decodeWorldTime,
} from "./protocol/encoder";
import {
	type BlockEditData,
	type BlockEditRejectedData,
	type ChatMessageData,
	MessageType,
} from "./protocol/messages";

export interface RemotePlayer {
	sessionId: string;
	index: number;
	name: string;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	animation: number;
	// Interpolation targets (yaw stored in degrees)
	targetX: number;
	targetY: number;
	targetZ: number;
	targetYaw: number;
}

export interface NetClientCallbacks {
	onConnected?: () => void;
	onDisconnected?: (code: number, reason?: string) => void;
	onPlayerJoin?: (player: RemotePlayer) => void;
	onPlayerLeave?: (sessionId: string, name?: string) => void;
	onPlayerStates?: (states: Map<string, RemotePlayer> | RemotePlayer[]) => void;
	onBlockEdit?: (edit: BlockEditData) => void;
	onBlockEditRejected?: (rejection: BlockEditRejectedData) => void;
	onChatMessage?: (chat: ChatMessageData) => void;
	onWorldTime?: (timeOfDay: number) => void;
	onWorldConfig?: (seed: string) => void;
	onSpawnPosition?: (pos: {
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	}) => void;
	onServerError?: (code: number, message?: string) => void;
}

type BinaryHandler = (data: Uint8Array) => void;

export class NetClient {
	private client: ColyseusSDK | null = null;
	private room: any = null;
	private encoder = new BinaryEncoder(256);
	private decoder = new BinaryDecoder(new Uint8Array(0));
	private connected = false;
	private callbacks: NetClientCallbacks = {};
	private remotePlayers = new Map<string, RemotePlayer>();
	// Dense array indexed by the server-assigned room player index. The old
	// design chained a Map<number,string> (index → sessionId) into a
	// Map<string,RemotePlayer> lookup for *every player, every state batch*
	// (20Hz+). Room indices are small and bounded by max room players, so a
	// plain array collapses that into one indexed read. NOTE: this assumes
	// the server reuses freed indices rather than handing out ever-increasing
	// ones over a long session — if that's not true server-side, this should
	// go back to a Map.
	private playersByIndex: (RemotePlayer | undefined)[] = [];
	private ownIndex = -1;
	private playerName = "";
	private binaryHandlers: BinaryHandler[] = [];
	// Reusable scratch array for decodePlayerStateBatchInto — avoids per-tick
	// array + object allocation on the 20 Hz hot path.
	private batchScratch: import("./protocol/messages").PlayerStateBatchEntry[] =
		[];
	// Guards against a warn-spam perf collapse if a state batch ever
	// references an index we haven't seen a PlayerJoin for yet/anymore.
	private warnedUnknownIndices = new Set<number>();
	worldName = "default";

	constructor(private serverUrl: string = this.defaultServerUrl()) {}

	private defaultServerUrl(): string {
		if (typeof window !== "undefined") {
			const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
			return `${proto}//${window.location.hostname}:2567`;
		}
		return "ws://localhost:2567";
	}

	setCallbacks(callbacks: NetClientCallbacks): void {
		this.callbacks = callbacks;
	}

	async connect(
		playerName: string,
		worldName: string,
		seed: string,
	): Promise<void> {
		this.playerName = playerName;
		this.worldName = worldName;
		this.client = new ColyseusSDK(this.serverUrl);

		try {
			this.room = await this.client.joinOrCreate("voxel", {
				name: playerName,
				worldName,
				seed,
			});

			this.setupRoomHandlers();
			this.connected = true;
			this.callbacks.onConnected?.();
		} catch (err) {
			console.error("[NetClient] Connection failed:", err);
			throw err;
		}
	}

	private setupRoomHandlers(): void {
		// Handle binary messages (game data)
		this.room.onMessage("binary", (data: Uint8Array) => {
			this.handleBinaryMessage(data);
		});

		// Handle connection lifecycle
		this.room.onLeave((code: number, reason?: string) => {
			this.connected = false;
			this.callbacks.onDisconnected?.(code, reason);
		});

		this.room.onError((code: number, message?: string) => {
			this.callbacks.onServerError?.(code, message);
		});
	}

	addBinaryHandler(handler: BinaryHandler): void {
		this.binaryHandlers.push(handler);
	}

	private handleBinaryMessage(data: Uint8Array): void {
		// Notify external handlers first (e.g. RemoteChunkProvider). Indexed
		// loop instead of for-of — this runs for every message, including
		// the 20Hz+ player state batch, so we skip the iterator allocation.
		const handlers = this.binaryHandlers;
		for (let i = 0; i < handlers.length; i++) {
			handlers[i](data);
		}

		if (data.byteLength < 1) return;

		// Reuse the decoder — setBuffer is cheaper than allocating a new
		// BinaryDecoder + DataView per message (20+ Hz).
		const dec = this.decoder;
		dec.setBuffer(data);
		const msgType = dec.readUint8(); // consume type byte

		switch (msgType) {
			case MessageType.PlayerStateBatch: {
				decodePlayerStateBatchInto(data, this.batchScratch);
				const players = this.playersByIndex;
				for (let i = 0; i < this.batchScratch.length; i++) {
					const state = this.batchScratch[i];
					if (state.index === this.ownIndex) continue;

					// Direct indexed lookup — replaces the old
					// index→sessionId→player double Map hop.
					const existing = players[state.index];
					if (existing === undefined) {
						if (!this.warnedUnknownIndices.has(state.index)) {
							this.warnedUnknownIndices.add(state.index);
							console.warn(
								`[NetClient] State for unknown player index ${state.index}, skipping`,
							);
						}
						continue;
					}

					// Update interpolation targets (yaw byte → degrees)
					existing.targetX = state.x;
					existing.targetY = state.y;
					existing.targetZ = state.z;
					existing.targetYaw = (state.yaw / 255) * 360;
					existing.pitch = state.pitch;
					existing.animation = state.animation;
				}

				// Notify callback — pass the Map directly instead of
				// Array.from() which allocates a new array every tick.
				this.callbacks.onPlayerStates?.(this.remotePlayers);
				break;
			}

			case MessageType.PlayerJoin: {
				const join = decodePlayerJoin(data);
				if (join.sessionId === this.room.sessionId) {
					// This is our own join message — record our room index
					this.ownIndex = join.index;
					break;
				}

				const player: RemotePlayer = {
					sessionId: join.sessionId,
					index: join.index,
					name: join.name,
					x: 0,
					y: 80,
					z: 0,
					yaw: 0,
					pitch: 0,
					animation: 0,
					targetX: 0,
					targetY: 80,
					targetZ: 0,
					targetYaw: 0,
				};
				this.remotePlayers.set(join.sessionId, player);
				this.playersByIndex[join.index] = player;
				this.warnedUnknownIndices.delete(join.index);
				this.callbacks.onPlayerJoin?.(player);
				break;
			}

			case MessageType.PlayerLeave: {
				const index = decodePlayerLeave(data);
				const existing = this.playersByIndex[index];
				const sessionId = existing?.sessionId ?? "";
				const name = existing?.name;
				if (sessionId) this.remotePlayers.delete(sessionId);
				this.playersByIndex[index] = undefined;
				this.callbacks.onPlayerLeave?.(sessionId, name);
				break;
			}

			case MessageType.BlockEditBroadcast: {
				const edit = decodeBlockEditBroadcast(data);
				this.callbacks.onBlockEdit?.(edit);
				break;
			}

			case MessageType.BlockEditRejected: {
				const rejection = decodeBlockEditRejected(data);
				this.callbacks.onBlockEditRejected?.(rejection);
				break;
			}

			case MessageType.ChatMessage: {
				const chat = decodeChatMessage(data);
				this.callbacks.onChatMessage?.(chat);
				break;
			}

			case MessageType.BlockEditBatch: {
				// Received on join: sync all existing world edits
				const edits = decodeBlockEditBatch(data);
				for (const edit of edits) {
					this.callbacks.onBlockEdit?.(edit);
				}
				break;
			}

			case MessageType.WorldTime: {
				const timeOfDay = decodeWorldTime(data);
				this.callbacks.onWorldTime?.(timeOfDay);
				break;
			}

			case MessageType.WorldConfig: {
				const seed = decodeWorldConfig(data);
				this.callbacks.onWorldConfig?.(seed);
				break;
			}

			case MessageType.SpawnPosition: {
				const pos = decodeSpawnPosition(data);
				this.callbacks.onSpawnPosition?.(pos);
				break;
			}

			case MessageType.ChunkData:
				// Handled by RemoteChunkProvider via addBinaryHandler — no-op here
				break;

			case MessageType.ChunkDataBatch:
				// Handled by RemoteChunkProvider via addBinaryHandler — no-op here
				break;

			default:
				console.warn(
					`[NetClient] Unknown message type: 0x${msgType.toString(16)}`,
				);
		}
	}

	// ─── Outgoing messages ─────────────────────────────────────────────

	sendPlayerState(
		x: number,
		y: number,
		z: number,
		yaw: number,
		pitch: number,
		animation: number,
	): void {
		if (!this.connected || !this.room) return;

		this.encoder.reset();
		// Write directly from raw values — avoids allocating an intermediate
		// PlayerStateData object on the 20 Hz hot path.
		this.encoder.writePlayerStateRaw(
			x,
			y,
			z,
			// yaw: 0-255 maps the full 360° circle
			Math.round(((((yaw % 360) + 360) % 360) / 360) * 255) & 0xff,
			Math.round(((pitch + 90) / 180) * 255) & 0xff,
			animation,
		);

		this.room.sendBytes("binary", this.encoder.getBytes());
	}

	sendBlockEdit(
		x: number,
		y: number,
		z: number,
		blockId: number,
		action: number,
	): void {
		if (!this.connected || !this.room) return;

		this.encoder.reset();
		this.encoder.writeBlockEdit({
			sessionId: "",
			x,
			y,
			z,
			blockId,
			action,
		});

		this.room.sendBytes("binary", this.encoder.getBytes());
	}

	sendChat(message: string): void {
		if (!this.connected || !this.room) return;

		this.encoder.reset();
		const chat: ChatMessageData = {
			sessionId: this.room.sessionId,
			name: this.playerName,
			message,
		};
		this.encoder.writeChatMessage(chat);
		this.room.sendBytes("binary", this.encoder.getBytes());

		// Local echo — the server relays to everyone except the sender, so
		// echo here to avoid a full round-trip delay on our own message.
		this.callbacks.onChatMessage?.(chat);
	}

	sendChunkRequest(
		cx: number,
		cy: number,
		cz: number,
		lod: number,
		cachedVersion = 0,
	): void {
		if (!this.connected || !this.room) {
			console.warn(
				`[NetClient] sendChunkRequest skipped (not connected): ${cx},${cy},${cz}`,
			);
			return;
		}
		this.encoder.reset();
		this.encoder.writeChunkRequest(cx, cy, cz, lod, cachedVersion);
		this.room.sendBytes("binary", this.encoder.getBytes());
	}

	sendChunkRequestBatch(
		requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>,
	): void {
		if (!this.connected || !this.room || requests.length === 0) return;
		this.encoder.reset();
		this.encoder.writeChunkRequestBatch(requests);
		this.room.sendBytes("binary", this.encoder.getBytes());
	}

	// ─── Remote player access ──────────────────────────────────────────

	getRemotePlayers(): Map<string, RemotePlayer> {
		return this.remotePlayers;
	}

	getRemotePlayer(sessionId: string): RemotePlayer | undefined {
		return this.remotePlayers.get(sessionId);
	}

	updateRemotePlayerInterpolation(dt: number): void {
		const lerpFactor = 1 - Math.exp(-10 * dt); // Smooth interpolation
		// Iterate the dense index array directly rather than Map.values() —
		// skips the Map iterator allocation on this per-frame path.
		const players = this.playersByIndex;
		for (let i = 0; i < players.length; i++) {
			const player = players[i];
			if (player === undefined) continue;

			player.x += (player.targetX - player.x) * lerpFactor;
			player.y += (player.targetY - player.y) * lerpFactor;
			player.z += (player.targetZ - player.z) * lerpFactor;

			// Yaw interpolation (handle wraparound — yaw is stored in degrees)
			let yawDiff = player.targetYaw - player.yaw;
			if (yawDiff > 180) yawDiff -= 360;
			if (yawDiff < -180) yawDiff += 360;
			player.yaw += yawDiff * lerpFactor;
		}
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────

	disconnect(): void {
		if (this.room) {
			this.room.leave();
			this.room = null;
		}
		this.connected = false;
		this.remotePlayers.clear();
		this.playersByIndex.length = 0;
		this.warnedUnknownIndices.clear();
		this.ownIndex = -1;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	get sessionId(): string {
		return this.room?.sessionId ?? "";
	}
}
