/**
 * NetClient - connection manager for b102 multiplayer.
 *
 * Wraps the Colyseus SDK to provide:
 * - Connection lifecycle: connect, disconnect, reconnect
 * - Binary message send and receive for game data
 * - Event callbacks for player join/leave, state updates, block edits
 */

import { ColyseusSDK } from "@colyseus/sdk";
import {
	BinaryDecoder,
	BinaryEncoder,
	decodeBlockEditBatch,
	decodeBlockEditBroadcastFrom,
	decodeBlockEditRejectedFrom,
	decodePlayerJoinFrom,
	decodePlayerStateBatchEntriesInto,
	decodeWorldConfig,
	type WorldConfigData,
} from "./protocol/encoder";
import {
	type BlockEditData,
	type BlockEditRejectedData,
	type ChatMessageData,
	MessageType,
	type PlayerStateBatchEntry,
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
	// Interpolation targets, yaw stored in degrees.
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
	onWorldConfig?: (config: WorldConfigData) => void;
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

type ChunkRequest = {
	cx: number;
	cy: number;
	cz: number;
	lod: number;
	cachedVersion: number;
};

export class NetClient {
	private client: ColyseusSDK | null = null;
	private room: any = null;

	private readonly encoder = new BinaryEncoder(256);
	private readonly decoder = new BinaryDecoder(new Uint8Array(0));

	private connected = false;
	private callbacks: NetClientCallbacks = {};

	private readonly remotePlayers = new Map<string, RemotePlayer>();

	// Dense array indexed by server-assigned room player index. This avoids the
	// old index -> sessionId -> player double lookup on the 20 Hz state path.
	private playersByIndex: (RemotePlayer | undefined)[] = [];

	private ownIndex = -1;
	private playerName = "";

	private readonly binaryHandlers: BinaryHandler[] = [];

	// Reusable decode scratch for the hot player-state path.
	private readonly batchScratch: PlayerStateBatchEntry[] = [];

	// Prevent warn spam if a state batch references an index we do not know.
	private readonly warnedUnknownIndices = new Set<number>();

	// Monotonic connection generation. Room handlers capture this value so
	// packets/events from older rooms are ignored after reconnects.
	private roomGeneration = 0;

	worldName = "default";

	constructor(private serverUrl: string = NetClient.defaultServerUrl()) {}

	private static defaultServerUrl(): string {
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
		// Make reconnect explicit and safe. Old room events are ignored by the
		// generation guard in setupRoomHandlers.
		this.detachCurrentRoom();

		this.playerName = playerName;
		this.worldName = worldName;
		this.client = new ColyseusSDK(this.serverUrl);

		const generation = ++this.roomGeneration;

		try {
			const room = await this.client.joinOrCreate("voxel", {
				name: playerName,
				worldName,
				seed,
			});

			// A newer connect/disconnect happened while this join was in flight.
			if (generation !== this.roomGeneration) {
				void room.leave();
				throw new Error("Connection superseded");
			}

			this.room = room;
			this.setupRoomHandlers(room, generation);
			this.connected = true;
			this.callbacks.onConnected?.();
		} catch (err) {
			if (generation === this.roomGeneration) {
				this.connected = false;
				this.room = null;
				this.client = null;
				this.resetRemoteState();
			}

			console.error("[NetClient] Connection failed:", err);
			throw err;
		}
	}

	private setupRoomHandlers(room: any, generation: number): void {
		room.onMessage("binary", (data: Uint8Array) => {
			// Drop packets from stale rooms after reconnect.
			if (!this.isCurrentRoom(room, generation)) return;
			this.handleBinaryMessage(data);
		});

		room.onLeave((code: number, reason?: string) => {
			if (!this.isCurrentRoom(room, generation)) return;

			this.connected = false;
			this.room = null;
			this.resetRemoteState();
			this.callbacks.onDisconnected?.(code, reason);
		});

		room.onError((code: number, message?: string) => {
			if (!this.isCurrentRoom(room, generation)) return;
			this.callbacks.onServerError?.(code, message);
		});
	}

	addBinaryHandler(handler: BinaryHandler): void {
		this.binaryHandlers.push(handler);
	}

	removeBinaryHandler(handler: BinaryHandler): void {
		const index = this.binaryHandlers.indexOf(handler);
		if (index >= 0) {
			this.binaryHandlers.splice(index, 1);
		}
	}

	private handleBinaryMessage(data: Uint8Array): void {
		const handlers = this.binaryHandlers;

		// External handlers first, preserving existing behavior. Individual
		// handler failures are isolated so one consumer cannot break NetClient.
		for (let i = 0; i < handlers.length; i++) {
			try {
				handlers[i](data);
			} catch (err) {
				console.error("[NetClient] Binary handler failed:", err);
			}
		}

		if (data.byteLength < 1) return;

		const dec = this.decoder;
		dec.setBuffer(data);

		try {
			const msgType = dec.readUint8();

			switch (msgType) {
				case MessageType.PlayerStateBatch:
					this.handlePlayerStateBatch(dec);
					break;

				case MessageType.PlayerJoin:
					this.handlePlayerJoin(dec);
					break;

				case MessageType.PlayerLeave:
					this.handlePlayerLeave(dec);
					break;

				case MessageType.BlockEditBroadcast: {
					const edit = decodeBlockEditBroadcastFrom(dec);
					this.callbacks.onBlockEdit?.(edit);
					break;
				}

				case MessageType.BlockEditRejected: {
					const rejection = decodeBlockEditRejectedFrom(dec);
					this.callbacks.onBlockEditRejected?.(rejection);
					break;
				}

				case MessageType.ChatMessage: {
					const chat = dec.readChatMessage();
					this.callbacks.onChatMessage?.(chat);
					break;
				}

				case MessageType.BlockEditBatch: {
					const edits = decodeBlockEditBatch(data);
					for (let i = 0; i < edits.length; i++) {
						this.callbacks.onBlockEdit?.(edits[i]);
					}
					break;
				}

				case MessageType.WorldTime: {
					const timeOfDay = dec.readFloat32();
					this.callbacks.onWorldTime?.(timeOfDay);
					break;
				}

				case MessageType.WorldConfig: {
					const config = decodeWorldConfig(data);
					this.callbacks.onWorldConfig?.(config);
					break;
				}

				case MessageType.SpawnPosition:
					this.callbacks.onSpawnPosition?.({
						x: dec.readFloat32(),
						y: dec.readFloat32(),
						z: dec.readFloat32(),
						yaw: dec.readFloat32(),
						pitch: dec.readFloat32(),
					});
					break;

				case MessageType.ChunkData:
				case MessageType.ChunkDataBatch:
				case MessageType.ChunkUnchanged:
				case MessageType.ChunkUnchangedBatch:
					// Handled by RemoteChunkProvider via addBinaryHandler.
					break;

				case MessageType.MobSpawn:
				case MessageType.MobUpdateBatch:
				case MessageType.MobDespawn:
					// Handled by RemoteMobManager via addBinaryHandler.
					break;

				case MessageType.ItemSpawn:
				case MessageType.ItemUpdateBatch:
				case MessageType.ItemDespawn:
					// Handled by RemoteItemManager via addBinaryHandler.
					break;

				default:
					console.warn(
						`[NetClient] Unknown message type: 0x${msgType.toString(16)}`,
					);
					break;
			}
		} catch (err) {
			console.error("[NetClient] Failed to handle binary message:", err);
		}
	}

	private handlePlayerStateBatch(dec: BinaryDecoder): void {
		decodePlayerStateBatchEntriesInto(dec, this.batchScratch);

		const scratch = this.batchScratch;
		const players = this.playersByIndex;

		for (let i = 0; i < scratch.length; i++) {
			const state = scratch[i];

			if (state.index === this.ownIndex) continue;

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

			existing.targetX = state.x;
			existing.targetY = state.y;
			existing.targetZ = state.z;
			existing.targetYaw = (state.yaw / 255) * 360;
			existing.pitch = state.pitch;
			existing.animation = state.animation;
		}

		this.callbacks.onPlayerStates?.(this.remotePlayers);
	}

	private handlePlayerJoin(dec: BinaryDecoder): void {
		const join = decodePlayerJoinFrom(dec);

		if (join.sessionId === this.room?.sessionId) {
			this.ownIndex = join.index;
			return;
		}

		let player = this.remotePlayers.get(join.sessionId);

		if (player) {
			// Same session joined again, likely after an index reassignment.
			this.playersByIndex[player.index] = undefined;

			player.index = join.index;
			player.name = join.name;
			player.x = 0;
			player.y = 80;
			player.z = 0;
			player.yaw = 0;
			player.pitch = 0;
			player.animation = 0;
			player.targetX = 0;
			player.targetY = 80;
			player.targetZ = 0;
			player.targetYaw = 0;
		} else {
			player = {
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
		}

		this.playersByIndex[join.index] = player;
		this.warnedUnknownIndices.delete(join.index);
		this.callbacks.onPlayerJoin?.(player);
	}

	private handlePlayerLeave(dec: BinaryDecoder): void {
		const index = dec.readUint8();
		const existing = this.playersByIndex[index];

		if (existing === undefined) {
			this.warnedUnknownIndices.delete(index);
			this.callbacks.onPlayerLeave?.("", undefined);
			return;
		}

		this.remotePlayers.delete(existing.sessionId);
		this.playersByIndex[index] = undefined;
		this.warnedUnknownIndices.delete(index);
		this.callbacks.onPlayerLeave?.(existing.sessionId, existing.name);
	}

	// Outgoing messages

	sendPlayerState(
		x: number,
		y: number,
		z: number,
		yaw: number,
		pitch: number,
		animation: number,
	): void {
		const room = this.getConnectedRoom();
		if (!room) return;

		const yawByte = NetClient.encodeYawByte(yaw);
		const pitchByte = NetClient.encodePitchByte(pitch);

		this.encoder.reset();
		this.encoder.writePlayerStateRaw(x, y, z, yawByte, pitchByte, animation);

		room.sendBytes("binary", this.encoder.getBytes());
	}

	sendBlockEdit(
		x: number,
		y: number,
		z: number,
		blockId: number,
		action: number,
	): void {
		const room = this.getConnectedRoom();
		if (!room) return;

		this.encoder.reset();
		this.encoder.writeBlockEdit({
			sessionId: "",
			x,
			y,
			z,
			blockId,
			action,
		});

		room.sendBytes("binary", this.encoder.getBytes());
	}

	sendChat(message: string): void {
		const room = this.getConnectedRoom();
		if (!room) return;

		this.encoder.reset();

		const chat: ChatMessageData = {
			sessionId: room.sessionId,
			name: this.playerName,
			message,
		};

		this.encoder.writeChatMessage(chat);
		room.sendBytes("binary", this.encoder.getBytes());

		// Local echo. The server relays to everyone except the sender.
		this.callbacks.onChatMessage?.(chat);
	}

	sendChunkRequest(
		cx: number,
		cy: number,
		cz: number,
		lod: number,
		cachedVersion = 0,
	): void {
		const room = this.getConnectedRoom();

		if (!room) {
			console.warn(
				`[NetClient] sendChunkRequest skipped (not connected): ${cx},${cy},${cz}`,
			);
			return;
		}

		this.encoder.reset();
		this.encoder.writeChunkRequest(cx, cy, cz, lod, cachedVersion);
		room.sendBytes("binary", this.encoder.getBytes());
	}

	sendChunkRequestBatch(requests: ChunkRequest[]): void {
		if (requests.length === 0) return;

		const room = this.getConnectedRoom();

		if (!room) {
			console.warn(
				`[NetClient] sendChunkRequestBatch skipped (connected=${this.connected}): ${requests.length} chunks`,
			);
			return;
		}

		this.encoder.reset();
		this.encoder.writeChunkRequestBatch(requests);
		room.sendBytes("binary", this.encoder.getBytes());
	}

	/** C→S: a player dropped an item into the world (server-authoritative). */
	sendItemDrop(
		itemId: number,
		stackSize: number,
		x: number,
		y: number,
		z: number,
		vx: number,
		vy: number,
		vz: number,
	): void {
		const room = this.getConnectedRoom();
		if (!room) return;

		this.encoder.reset();
		this.encoder.writeUint8(MessageType.ItemDrop);
		this.encoder.writeUint16(itemId);
		this.encoder.writeUint16(stackSize);
		this.encoder.writeFloat32(x);
		this.encoder.writeFloat32(y);
		this.encoder.writeFloat32(z);
		this.encoder.writeFloat32(vx);
		this.encoder.writeFloat32(vy);
		this.encoder.writeFloat32(vz);
		room.sendBytes("binary", this.encoder.getBytes());
	}

	/** C→S: a player picked up a server item, referenced by its instance id. */
	sendItemPickup(instanceId: number): void {
		const room = this.getConnectedRoom();
		if (!room) return;

		this.encoder.reset();
		this.encoder.writeUint8(MessageType.ItemPickup);
		this.encoder.writeUint32(instanceId);
		room.sendBytes("binary", this.encoder.getBytes());
	}

	// Remote player access

	getRemotePlayers(): Map<string, RemotePlayer> {
		return this.remotePlayers;
	}

	getRemotePlayer(sessionId: string): RemotePlayer | undefined {
		return this.remotePlayers.get(sessionId);
	}

	updateRemotePlayerInterpolation(dt: number): void {
		const lerpFactor = 1 - Math.exp(-10 * dt);
		const players = this.playersByIndex;

		for (let i = 0; i < players.length; i++) {
			const player = players[i];
			if (player === undefined) continue;

			player.x += (player.targetX - player.x) * lerpFactor;
			player.y += (player.targetY - player.y) * lerpFactor;
			player.z += (player.targetZ - player.z) * lerpFactor;

			let yawDiff = player.targetYaw - player.yaw;
			if (yawDiff > 180) yawDiff -= 360;
			else if (yawDiff < -180) yawDiff += 360;

			player.yaw += yawDiff * lerpFactor;

			// Keep yaw bounded over long sessions to avoid unbounded drift.
			if (player.yaw >= 360) player.yaw -= 360;
			else if (player.yaw < 0) player.yaw += 360;
		}
	}

	// Lifecycle

	disconnect(): void {
		this.detachCurrentRoom();
		this.resetRemoteState();
	}

	get isConnected(): boolean {
		return this.connected;
	}

	get sessionId(): string {
		return this.room?.sessionId ?? "";
	}

	private detachCurrentRoom(): void {
		const room = this.room;

		// Invalidate existing handlers before calling leave so late events from
		// this room cannot affect the next connection.
		this.roomGeneration++;
		this.connected = false;
		this.room = null;

		if (room) {
			void room.leave();
		}
	}

	private resetRemoteState(): void {
		this.remotePlayers.clear();
		this.playersByIndex.length = 0;
		this.warnedUnknownIndices.clear();
		this.batchScratch.length = 0;
		this.ownIndex = -1;
	}

	private isCurrentRoom(room: any, generation: number): boolean {
		return this.room === room && this.roomGeneration === generation;
	}

	private getConnectedRoom(): any | null {
		return this.connected ? this.room : null;
	}

	public static encodeYawByte(yaw: number): number {
		const normalized = ((yaw % 360) + 360) % 360;
		return Math.round((normalized / 360) * 255) & 0xff;
	}

	public static encodePitchByte(pitch: number): number {
		// Valid pitch range is expected to be -90..90. Clamp instead of wrapping
		// so bad input does not turn into a seemingly valid opposite angle.
		const clamped = pitch < -90 ? -90 : pitch > 90 ? 90 : pitch;
		return Math.round(((clamped + 90) / 180) * 255) & 0xff;
	}
}
