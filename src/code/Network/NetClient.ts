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
	decodeChatMessage,
	decodePlayerJoin,
	decodePlayerLeave,
	decodePlayerStateBatch,
} from "./protocol/encoder";
import {
	type BlockEditData,
	type ChatMessageData,
	MessageType,
	type PlayerJoinData,
	type PlayerLeaveData,
	type PlayerStateData,
} from "./protocol/messages";

export interface RemotePlayer {
	sessionId: string;
	name: string;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	animation: number;
	// Interpolation targets
	targetX: number;
	targetY: number;
	targetZ: number;
	targetYaw: number;
}

export interface NetClientCallbacks {
	onConnected?: () => void;
	onDisconnected?: (code: number, reason?: string) => void;
	onPlayerJoin?: (player: RemotePlayer) => void;
	onPlayerLeave?: (sessionId: string) => void;
	onPlayerStates?: (states: RemotePlayer[]) => void;
	onBlockEdit?: (edit: BlockEditData) => void;
	onChatMessage?: (chat: ChatMessageData) => void;
	onServerError?: (code: number, message?: string) => void;
}

export class NetClient {
	private client: ColyseusSDK | null = null;
	private room: any = null;
	private encoder = new BinaryEncoder(256);
	private connected = false;
	private callbacks: NetClientCallbacks = {};
	private remotePlayers = new Map<string, RemotePlayer>();
	private playerName = "";

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

	async connect(playerName: string, worldName: string): Promise<void> {
		this.playerName = playerName;
		this.client = new ColyseusSDK(this.serverUrl);

		try {
			this.room = await this.client.joinOrCreate("voxel", {
				name: playerName,
				worldName,
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

	private handleBinaryMessage(data: Uint8Array): void {
		if (data.byteLength < 1) return;

		const dec = new BinaryDecoder(data);
		const msgType = dec.readUint8(); // consume type byte

		switch (msgType) {
			case MessageType.PlayerStateBatch: {
				const states = decodePlayerStateBatch(data);
				for (const state of states) {
					if (state.sessionId === this.room.sessionId) continue;

					const existing = this.remotePlayers.get(state.sessionId);
					if (existing) {
						// Update interpolation targets
						existing.targetX = state.x;
						existing.targetY = state.y;
						existing.targetZ = state.z;
						existing.targetYaw = state.yaw;
						existing.pitch = state.pitch;
						existing.animation = state.animation;
					} else {
						// New player appeared (should have gotten PlayerJoin first, but handle anyway)
						const player: RemotePlayer = {
							sessionId: state.sessionId,
							name: state.sessionId.substring(0, 6),
							x: state.x,
							y: state.y,
							z: state.z,
							yaw: state.yaw,
							pitch: state.pitch,
							animation: state.animation,
							targetX: state.x,
							targetY: state.y,
							targetZ: state.z,
							targetYaw: state.yaw,
						};
						this.remotePlayers.set(state.sessionId, player);
					}
				}

				// Notify callback with current interpolated positions
				const players = Array.from(this.remotePlayers.values());
				this.callbacks.onPlayerStates?.(players);
				break;
			}

			case MessageType.PlayerJoin: {
				const join = decodePlayerJoin(data);
				if (join.sessionId === this.room.sessionId) break;

				const player: RemotePlayer = {
					sessionId: join.sessionId,
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
				this.callbacks.onPlayerJoin?.(player);
				break;
			}

			case MessageType.PlayerLeave: {
				const leave = decodePlayerLeave(data);
				this.remotePlayers.delete(leave.sessionId);
				this.callbacks.onPlayerLeave?.(leave.sessionId);
				break;
			}

			case MessageType.BlockEditBroadcast: {
				const edit = decodeBlockEditBroadcast(data);
				this.callbacks.onBlockEdit?.(edit);
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
		this.encoder.writePlayerState({
			sessionId: this.room.sessionId,
			x, // float32 — sub-block precision
			y,
			z,
			yaw: Math.round((yaw % 360) / 1.4) & 0xff,
			pitch: Math.round(((pitch + 90) / 180) * 255) & 0xff,
			animation: animation,
		});

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
			sessionId: this.room.sessionId,
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
		this.room.send("chat", message);
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
		for (const player of this.remotePlayers.values()) {
			player.x += (player.targetX - player.x) * lerpFactor;
			player.y += (player.targetY - player.y) * lerpFactor;
			player.z += (player.targetZ - player.z) * lerpFactor;

			// Yaw interpolation (handle wraparound)
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
	}

	get isConnected(): boolean {
		return this.connected;
	}

	get sessionId(): string {
		return this.room?.sessionId ?? "";
	}
}
