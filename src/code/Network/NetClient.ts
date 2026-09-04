/**
 * NetClient - connection manager for b102 multiplayer.
 *
 * Wraps the Colyseus SDK to provide:
 * - Connection lifecycle: connect, disconnect, reconnect
 * - Binary message send and receive for game data
 * - Event callbacks for player join/leave, state updates, block edits
 */

import { ColyseusSDK } from "@colyseus/sdk";
import { PLAYER_SKIN_PATH } from "../Player/PlayerModel";
import {
	BinaryDecoder,
	BinaryEncoder,
	decodeBlockEditBroadcastInto,
	decodeBlockEditRejectedInto,
	decodePlayerJoinInto,
	decodePlayerStateBatchEntriesInto,
	decodeSpawnPositionInto,
	decodeTntIgniteInto,
	decodeWorldConfigInto,
	encodeSkinUpload,
	type WorldConfigData,
} from "./protocol/encoder";
import {
	type BlockEditData,
	type BlockEditRejectedData,
	type ChatMessageData,
	MAX_SKIN_BYTES,
	MessageType,
	type PlayerJoinData,
	type PlayerStateBatchEntry,
	type TntIgniteData,
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
	/** Server-synced avatar skin PNG (null until received). */
	skinPng: Uint8Array | null;
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
	/** Fired when a remote player's skin PNG arrives (or is re-sent). */
	onPlayerSkin?: (player: RemotePlayer, png: Uint8Array) => void;
	onPlayerStates?: (states: Map<string, RemotePlayer> | RemotePlayer[]) => void;
	onBlockEdit?: (edit: BlockEditData) => void;
	onBlockEditRejected?: (rejection: BlockEditRejectedData) => void;
	/** Fired when another client ignites TNT (spawn a remote primed entity). */
	onTntIgnite?: (ignite: TntIgniteData) => void;
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
	private playersByIndex: (RemotePlayer | undefined)[] = [];

	private ownIndex = -1;
	private playerName = "";

	private readonly binaryHandlers: BinaryHandler[] = [];
	private readonly disconnectListeners: (() => void)[] = [];

	private readonly batchScratch: PlayerStateBatchEntry[] = [];
	private readonly warnedUnknownIndices = new Set<number>();
	private readonly playerJoinScratch: PlayerJoinData = {
		index: 0,
		sessionId: "",
		name: "",
	};
	private readonly blockEditBroadcastScratch: BlockEditData = {
		sessionId: "",
		x: 0,
		y: 0,
		z: 0,
		blockId: 0,
		blockState: 0,
		action: 0,
	};
	private readonly blockEditRejectedScratch: BlockEditRejectedData = {
		x: 0,
		y: 0,
		z: 0,
		blockId: 0,
		blockState: 0,
		action: 0,
		reason: 0,
	};
	private readonly tntIgniteScratch: TntIgniteData = {
		x: 0,
		y: 0,
		z: 0,
		fuse: 0,
		radius: 0,
	};
	private readonly chatMessageScratch: ChatMessageData = {
		sessionId: "",
		name: "",
		message: "",
	};
	private readonly worldConfigScratch: WorldConfigData = {
		seed: "",
		dayDurationMs: 0,
		dayCycle: false,
	};
	private readonly spawnPositionScratch = {
		x: 0,
		y: 0,
		z: 0,
		yaw: 0,
		pitch: 0,
	};

	/*
	 * writeBlockEdit currently accepts an object. Reusing this object avoids
	 * allocating one object for every block edit.
	 *
	 * This is safe as long as BinaryEncoder.writeBlockEdit consumes the fields
	 * synchronously and does not retain the object reference.
	 */
	private readonly blockEditScratch: BlockEditData = {
		sessionId: "",
		x: 0,
		y: 0,
		z: 0,
		blockId: 0,
		blockState: 0,
		action: 0,
	};

	private roomGeneration = 0;

	worldName = "default";

	constructor(private serverUrl: string = NetClient.defaultServerUrl()) {}

	private static defaultServerUrl(): string {
		if (typeof window === "undefined") {
			return "ws://localhost:2567";
		}
		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		return `${proto}//${window.location.hostname}:2567`;
	}

	setCallbacks(callbacks: NetClientCallbacks): void {
		this.callbacks = callbacks;
	}

	async connect(
		playerName: string,
		worldName: string,
		seed: string,
	): Promise<void> {
		this.detachCurrentRoom();

		this.playerName = playerName;
		this.worldName = worldName;

		const client = new ColyseusSDK(this.serverUrl);
		this.client = client;

		const generation = ++this.roomGeneration;

		try {
			const room = await client.joinOrCreate("voxel", {
				name: playerName,
				worldName,
				seed,
			});

			if (generation !== this.roomGeneration) {
				void room.leave();
				throw new Error("Connection superseded");
			}

			this.room = room;
			this.setupRoomHandlers(room, generation);
			this.connected = true;

			this.callbacks.onConnected?.();

			void this.uploadOwnSkin();
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
		/*
		 * These three closures are allocated once per connection. They capture
		 * the room generation, which is necessary to reject stale events.
		 */
		room.onMessage("binary", (data: Uint8Array) => {
			if (!this.isCurrentRoom(room, generation)) return;
			this.handleBinaryMessage(data);
		});

		room.onLeave((code: number, reason?: string) => {
			if (!this.isCurrentRoom(room, generation)) return;

			this.connected = false;
			this.room = null;
			this.client = null;

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

		if (index !== -1) {
			this.binaryHandlers.splice(index, 1);
		}
	}

	addDisconnectListener(listener: () => void): void {
		this.disconnectListeners.push(listener);
	}

	removeDisconnectListener(listener: () => void): void {
		const index = this.disconnectListeners.indexOf(listener);

		if (index !== -1) {
			this.disconnectListeners.splice(index, 1);
		}
	}

	private handleBinaryMessage(data: Uint8Array): void {
		const handlers = this.binaryHandlers;

		/*
		 * Capture the original length so a handler added during dispatch does
		 * not unexpectedly receive the packet currently being dispatched.
		 *
		 * This matches normal array-loop behavior more predictably while still
		 * avoiding copies such as handlers.slice().
		 */
		const handlerCount = handlers.length;

		for (let i = 0; i < handlerCount; i++) {
			const handler = handlers[i];

			/*
			 * A preceding handler can remove entries. Preserve the old
			 * defensive behavior without allocating a snapshot array.
			 */
			if (handler === undefined) break;

			try {
				handler(data);
			} catch (err) {
				console.error("[NetClient] Binary handler failed:", err);
			}
		}

		if (data.byteLength === 0) return;

		const dec = this.decoder;
		dec.setBuffer(data);

		try {
			const callbacks = this.callbacks;

			// Loop to handle concatenated messages (e.g. server merges multiple
			// PlayerJoin frames into one binary payload for late joiners).
			// This is notification-driven: each join/skin is an event, not a poll.
			while (dec.remaining > 0) {
				const msgType = dec.readUint8();

				switch (msgType) {
					case MessageType.PlayerStateBatch:
						this.handlePlayerStateBatch(dec);
						break;

					case MessageType.PlayerJoin:
						this.handlePlayerJoin(dec);
						break;

					case MessageType.PlayerSkin: {
						const index = dec.readUint8();
						const len = dec.readUint16();
						if (len === 0 || len > MAX_SKIN_BYTES) {
							throw new Error(`skin payload out of range: ${len}`);
						}
						const png = dec.readBytes(len);
						const player = this.playersByIndex[index];

						if (player === undefined) {
							console.warn(
								`[NetClient] Skin for unknown player index ${index}, skipping`,
							);
							break;
						}

						player.skinPng = png;
						callbacks.onPlayerSkin?.(player, png);
						break;
					}

					case MessageType.PlayerLeave:
						this.handlePlayerLeave(dec);
						break;

					case MessageType.BlockEditBroadcast: {
						// Reused scratch — safe: NetworkManager.applyRemoteBlockEdit copies fields synchronously (no retain). See NetworkManager:165.
						const edit = decodeBlockEditBroadcastInto(
							dec,
							this.blockEditBroadcastScratch,
						);
						callbacks.onBlockEdit?.(edit);
						break;
					}

					case MessageType.BlockEditRejected: {
						const rej = decodeBlockEditRejectedInto(
							dec,
							this.blockEditRejectedScratch,
						);
						callbacks.onBlockEditRejected?.(rej);
						break;
					}

					case MessageType.ChatMessage: {
						// Reused scratch — safe: NetworkManager.onChatMessage copies name/message strings synchronously. Caller must not retain object.
						const chat = dec.readChatMessageInto(this.chatMessageScratch);
						callbacks.onChatMessage?.(chat);
						break;
					}

					case MessageType.BlockEditBatch: {
						const count = dec.readUint16();
						const callback = callbacks.onBlockEdit;
						if (callback !== undefined) {
							// Reused single scratch per iteration — safe: callback copies fields synchronously (NetworkManager.applyRemoteBlockEdit). No retain.
							const scratch = this.blockEditBroadcastScratch;
							for (let i = 0; i < count; i++) {
								scratch.sessionId = "";
								scratch.x = dec.readInt32();
								scratch.y = dec.readInt32();
								scratch.z = dec.readInt32();
								scratch.blockId = dec.readUint16();
								scratch.blockState = dec.readUint8();
								scratch.action = dec.readUint8();
								callback(scratch);
							}
						} else {
							for (let i = 0; i < count; i++) {
								dec.readInt32();
								dec.readInt32();
								dec.readInt32();
								dec.readUint16();
								dec.readUint8();
								dec.readUint8();
							}
						}
						break;
					}

					case MessageType.WorldTime:
						callbacks.onWorldTime?.(dec.readFloat32());
						break;

					case MessageType.WorldConfig: {
						// Reused scratch — safe: NetworkManager.onWorldConfig copies seed string synchronously (NetworkManager:186). Caller must copy if retaining.
						const cfg = decodeWorldConfigInto(dec, this.worldConfigScratch);
						callbacks.onWorldConfig?.(cfg);
						break;
					}

					case MessageType.SpawnPosition: {
						// Reused scratch — safe: NetworkManager.onSpawnPosition copies via setSpawnPosition/restoreSavedPosition (no retain). See NetClient:398.
						const pos = decodeSpawnPositionInto(dec, this.spawnPositionScratch);
						callbacks.onSpawnPosition?.(pos);
						break;
					}

					case MessageType.ChunkData:
					case MessageType.ChunkDataBatch:
					case MessageType.ChunkDataDeflated:
					case MessageType.ChunkDataDeflatedBatch:
					case MessageType.ChunkUnchanged:
					case MessageType.ChunkUnchangedBatch:
						// Handled by RemoteChunkProvider via addBinaryHandler.
						// Payload is variable-length; we cannot skip it without
						// decoding, so stop the loop and let the delegated handler
						// own the buffer.
						return;

					case MessageType.MobSpawn:
					case MessageType.MobUpdateBatch:
					case MessageType.MobDespawn:
						// Handled by RemoteMobManager via addBinaryHandler.
						return;

					case MessageType.MobDamage:
						// Handled by RemoteMobManager via addBinaryHandler. Consume the
						// fixed-size payload so relayed hit effects do not log as unknown.
						dec.readUint16();
						dec.readFloat32();
						break;

					case MessageType.MobImpact:
						// Handled by RemoteMobManager via addBinaryHandler.
						dec.readUint16();
						dec.readFloat32();
						dec.readFloat32();
						dec.readFloat32();
						dec.readFloat32();
						break;

					case MessageType.ItemSpawn:
					case MessageType.ItemUpdateBatch:
					case MessageType.ItemDespawn:
						// Handled by RemoteItemManager via addBinaryHandler.
						return;

					case MessageType.ArrowSpawn:
						// Handled by Arrow.ensureNetworkHandler via addBinaryHandler.
						return;

					case MessageType.TntIgnite: {
						// Reused scratch — safe: the callback consumes fields
						// synchronously (NetworkManager spawns the entity).
						const ignite = decodeTntIgniteInto(dec, this.tntIgniteScratch);
						callbacks.onTntIgnite?.(ignite);
						break;
					}

					default:
						console.warn(
							`[NetClient] Unknown message type: 0x${msgType.toString(16)}`,
						);
						// Unknown payload length — stop to avoid desync.
						return;
				}
			}
		} catch (err) {
			console.error("[NetClient] Failed to handle binary message:", err);
		}
	}

	private handlePlayerStateBatch(dec: BinaryDecoder): void {
		decodePlayerStateBatchEntriesInto(dec, this.batchScratch);

		const scratch = this.batchScratch;
		const players = this.playersByIndex;
		const ownIndex = this.ownIndex;

		for (let i = 0; i < scratch.length; i++) {
			const state = scratch[i];

			if (state.index === ownIndex) continue;

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
			existing.targetYaw = state.yaw * (360 / 255);
			existing.pitch = state.pitch;
			existing.animation = state.animation;
		}

		this.callbacks.onPlayerStates?.(this.remotePlayers);
	}

	private handlePlayerJoin(dec: BinaryDecoder): void {
		const join = decodePlayerJoinInto(dec, this.playerJoinScratch);

		if (join.sessionId === this.room?.sessionId) {
			this.ownIndex = join.index;
			return;
		}

		let player = this.remotePlayers.get(join.sessionId);

		if (player !== undefined) {
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
				skinPng: null,
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

	sendPlayerState(
		x: number,
		y: number,
		z: number,
		yaw: number,
		pitch: number,
		animation: number,
	): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		this.encoder.reset();
		this.encoder.writePlayerStateRaw(
			x,
			y,
			z,
			NetClient.encodeYawByte(yaw),
			NetClient.encodePitchByte(pitch),
			animation,
		);

		room.sendBytes("binary", this.encoder.getBytes());
	}

	sendBlockEdit(
		x: number,
		y: number,
		z: number,
		blockId: number,
		action: number,
		blockState = 0,
	): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		const edit = this.blockEditScratch;
		edit.x = x;
		edit.y = y;
		edit.z = z;
		edit.blockId = blockId;
		edit.blockState = blockState;
		edit.action = action;

		this.encoder.reset();
		this.encoder.writeBlockEdit(edit);

		room.sendBytes("binary", this.encoder.getBytes());
	}

	sendChat(message: string): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		/*
		 * This object must not be reused because it is passed to a consumer
		 * through onChatMessage, and that consumer may retain the reference.
		 */
		const chat: ChatMessageData = {
			sessionId: room.sessionId,
			name: this.playerName,
			message,
		};

		this.encoder.reset();
		this.encoder.writeChatMessage(chat);
		room.sendBytes("binary", this.encoder.getBytes());

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

		if (room === null) {
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

		if (room === null) {
			console.warn(
				`[NetClient] sendChunkRequestBatch skipped (connected=${this.connected}): ${requests.length} chunks`,
			);
			return;
		}

		this.encoder.reset();
		this.encoder.writeChunkRequestBatch(requests);

		room.sendBytes("binary", this.encoder.getBytes());
	}

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
		if (room === null) return;

		const encoder = this.encoder;
		encoder.reset();
		encoder.writeUint8(MessageType.ItemDrop);
		encoder.writeUint16(itemId);
		encoder.writeUint16(stackSize);
		encoder.writeFloat32(x);
		encoder.writeFloat32(y);
		encoder.writeFloat32(z);
		encoder.writeFloat32(vx);
		encoder.writeFloat32(vy);
		encoder.writeFloat32(vz);

		room.sendBytes("binary", encoder.getBytes());
	}

	sendItemPickup(instanceId: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		this.encoder.reset();
		this.encoder.writeUint8(MessageType.ItemPickup);
		this.encoder.writeUint32(instanceId);

		room.sendBytes("binary", this.encoder.getBytes());
	}

	sendMobSpawnRequest(typeId: number, x: number, y: number, z: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		const encoder = this.encoder;
		encoder.reset();
		encoder.writeUint8(MessageType.MobSpawnRequest);
		encoder.writeUint8(typeId);
		encoder.writeFloat32(x);
		encoder.writeFloat32(y);
		encoder.writeFloat32(z);

		room.sendBytes("binary", encoder.getBytes());
	}

	sendMobDamage(mobId: number, damage: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		this.encoder.reset();
		this.encoder.writeUint8(MessageType.MobDamage);
		this.encoder.writeUint16(mobId);
		this.encoder.writeFloat32(damage);

		room.sendBytes("binary", this.encoder.getBytes());
	}

	sendArrowShoot(
		x: number,
		y: number,
		z: number,
		vx: number,
		vy: number,
		vz: number,
		arrowType: number,
	): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		const encoder = this.encoder;
		encoder.reset();
		encoder.writeUint8(MessageType.ArrowShoot);
		encoder.writeFloat32(x);
		encoder.writeFloat32(y);
		encoder.writeFloat32(z);
		encoder.writeFloat32(vx);
		encoder.writeFloat32(vy);
		encoder.writeFloat32(vz);
		encoder.writeUint8(arrowType);

		room.sendBytes("binary", encoder.getBytes());
	}

	sendExplosion(x: number, y: number, z: number, radius: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		const encoder = this.encoder;
		encoder.reset();
		encoder.writeUint8(MessageType.Explosion);
		encoder.writeFloat32(x);
		encoder.writeFloat32(y);
		encoder.writeFloat32(z);
		encoder.writeFloat32(radius);

		room.sendBytes("binary", encoder.getBytes());
	}

	sendTntIgnite(
		x: number,
		y: number,
		z: number,
		fuse: number,
		radius: number,
	): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		const encoder = this.encoder;
		encoder.reset();
		encoder.writeUint8(MessageType.TntIgnite);
		encoder.writeFloat32(x);
		encoder.writeFloat32(y);
		encoder.writeFloat32(z);
		encoder.writeFloat32(fuse);
		encoder.writeFloat32(radius);

		room.sendBytes("binary", encoder.getBytes());
	}

	uploadSkin(png: Uint8Array): void {
		const room = this.getConnectedRoom();

		if (
			room === null ||
			png.byteLength === 0 ||
			png.byteLength > MAX_SKIN_BYTES
		) {
			return;
		}

		room.sendBytes("binary", encodeSkinUpload(png));
	}

	private async uploadOwnSkin(): Promise<void> {
		try {
			const response = await fetch(PLAYER_SKIN_PATH);
			if (!response.ok) return;

			const buffer = await response.arrayBuffer();

			/*
			 * Uint8Array(ArrayBuffer) creates a view over the buffer. It does
			 * not copy the PNG bytes.
			 */
			this.uploadSkin(new Uint8Array(buffer));
		} catch {
			// Skin sharing is best-effort.
		}
	}

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

			if (yawDiff > 180) {
				yawDiff -= 360;
			} else if (yawDiff < -180) {
				yawDiff += 360;
			}

			player.yaw += yawDiff * lerpFactor;

			if (player.yaw >= 360) {
				player.yaw -= 360;
			} else if (player.yaw < 0) {
				player.yaw += 360;
			}
		}
	}

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

		this.roomGeneration++;
		this.connected = false;
		this.room = null;

		/*
		 * Release the SDK object immediately. The local room variable remains
		 * alive only long enough to call leave().
		 */
		this.client = null;

		if (room !== null) {
			void room.leave();
		}
	}

	private resetRemoteState(): void {
		const listeners = this.disconnectListeners;

		/*
		 * An indexed loop avoids creating an array iterator in this cleanup
		 * path and preserves the original no-copy dispatch behavior.
		 */
		for (let i = 0; i < listeners.length; i++) {
			try {
				listeners[i]();
			} catch (err) {
				console.error("[NetClient] Disconnect listener failed:", err);
			}
		}

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

	static encodeYawByte(yaw: number): number {
		const normalized = ((yaw % 360) + 360) % 360;
		return Math.round(normalized * (255 / 360)) & 0xff;
	}

	static encodePitchByte(pitch: number): number {
		const clamped = pitch < -90 ? -90 : pitch > 90 ? 90 : pitch;

		return Math.round((clamped + 90) * (255 / 180)) & 0xff;
	}
}
