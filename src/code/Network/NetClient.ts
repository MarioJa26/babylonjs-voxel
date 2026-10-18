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
	type BlockEditBatchView,
	createBlockEditBatchView,
	decodeBlockEditBatchInto,
	decodeBlockEditBroadcastInto,
	decodeBlockEditRejectedInto,
	decodeExplosionBroadcastInto,
	decodePlayerHeldItemInto,
	decodePlayerJoinInto,
	decodePlayerStateBatchEntriesInto,
	decodeSpawnPositionInto,
	decodeTntIgniteInto,
	decodeWorldConfigInto,
	encodeArrowShoot,
	encodeContainerClose,
	encodeContainerOpen,
	encodeContainerSetSlot,
	encodeExplosion,
	encodeHeldItemSelect,
	encodeItemDrop,
	encodeItemPickup,
	encodeMobDamage,
	encodeMobSpawnRequest,
	encodePitchByte,
	encodeSkinUpload,
	encodeStationClaimResult,
	encodeStationOpen,
	encodeStationSetSlot,
	encodeStationUpgrade,
	encodeTntIgnite,
	encodeYawByte,
	isSequenceNewer,
	type WorldConfigData,
} from "./protocol/encoder";
import {
	type BlockEditData,
	type BlockEditRejectedData,
	type ChatMessageData,
	type ExplosionData,
	MAX_SKIN_BYTES,
	MessageType,
	type PlayerHeldItemData,
	type PlayerJoinData,
	type PlayerStateBatchEntry,
	type TntIgniteData,
} from "./protocol/messages";

/**
 * Sentinel `lastSequence` meaning "no state received for this player yet".
 *
 * Must not be a real sequence value. `isSequenceNewer(0, 0)` is false, so
 * initialising to 0 would cause every player's first state batch â€” which
 * carries sequence 0 â€” to be discarded as stale.
 */
const NO_STATE_SEQUENCE = 0xffff;

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
	heldItemId: number;
	heldItemBlockState: number;
	// Interpolation targets, yaw stored in degrees.
	targetX: number;
	targetY: number;
	targetZ: number;
	targetYaw: number;
	/**
	 * Highest `PlayerStateBatch` sequence already applied for this player.
	 *
	 * Per-player rather than global, because a player omitted from some batches
	 * must not be blocked by a batch that carried none of its state.
	 */
	lastSequence: number;
	/**
	 * Wall-clock arrival time of the most recent accepted state batch, ms.
	 *
	 * This runs in a Colyseus message task, OUTSIDE the frame loop, so it uses
	 * `performance.now()` directly. The shared FrameClock is not valid here â€”
	 * its sample belongs to the last completed frame, which for a message task
	 * may be arbitrarily stale.
	 */
	receivedAtMs: number;
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
	/**
	 * Batched counterpart to `onBlockEdit`.
	 *
	 * When present it takes priority for `BlockEditBatch` messages and
	 * `onBlockEdit` is NOT called for them. This is strongly preferred: a join
	 * snapshot carries up to 2048 edits and an explosion crater carries its
	 * whole sphere, and applying those one at a time means one lighting pass,
	 * one neighbour walk and one remesh scheduling per edit instead of per
	 * affected chunk.
	 *
	 * The view is a REUSED scratch buffer: read it synchronously and copy out
	 * anything you need to keep.
	 */
	onBlockEditBatch?: (view: BlockEditBatchView) => void;
	onBlockEditRejected?: (rejection: BlockEditRejectedData) => void;
	/**
	 * The server's authoritative record of an explosion: center, radius, a
	 * dedup id, and a seed for deriving identical particles locally.
	 *
	 * Preferred over reacting to the craters' `BlockEditBatch`, because the
	 * batch carries neither: it tells a client which blocks vanished but not
	 * that they were one explosion, so a redelivery replays every effect.
	 */
	onExplosion?: (explosion: ExplosionData) => void;
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
	private readonly activeRemotePlayers: RemotePlayer[] = [];

	private ownIndex = -1;
	private playerName = "";

	private readonly binaryHandlers: BinaryHandler[] = [];
	private readonly disconnectListeners: (() => void)[] = [];

	private readonly batchScratch: PlayerStateBatchEntry[] = [];
	private readonly stateScratch = { sequence: 0 };
	private readonly blockEditBatchView = createBlockEditBatchView();
	private readonly explosionScratch: ExplosionData = {
		x: 0,
		y: 0,
		z: 0,
		radius: 0,
		eventId: 0,
		seed: 0,
	};
	private readonly warnedUnknownIndices = new Set<number>();
	private readonly playerHeldItemScratch: PlayerHeldItemData = {
		index: 0,
		itemId: 0,
		blockState: 0,
	};
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

	/**
	 * Monotonic identity of the current room/connection.
	 *
	 * PERF/RATIONALE: async work started against one room can outlive it â€” an
	 * inflate, a cache write, a skin decode, a deferred GPU replacement. All of
	 * those must answer "which room produced this operation?" before applying
	 * their result, or a late completion from a room you already left will
	 * corrupt the new one.
	 *
	 * Two independent guards exist and they answer different questions:
	 *
	 * - `connectionGeneration` answers WHICH ROOM. Capture it before an await;
	 *   if it changed, the result belongs to a superseded room and must be
	 *   dropped regardless of what it contains.
	 * - Request object identity answers IS THIS STILL THE EXACT REQUEST. Two
	 *   requests for the same chunk coordinates can be live at once, so
	 *   coordinates alone are ambiguous.
	 *
	 * Keep the pending-object checks too â€” generation alone would let a stale
	 * response for a re-requested coordinate resolve the new request.
	 */
	get connectionGeneration(): number {
		return this.roomGeneration;
	}

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

					case MessageType.PlayerHeldItem: {
						const selection = decodePlayerHeldItemInto(
							dec,
							this.playerHeldItemScratch,
						);
						const player = this.playersByIndex[selection.index];
						if (player !== undefined) {
							player.heldItemId = selection.itemId;
							player.heldItemBlockState = selection.blockState;
						}
						break;
					}

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
						// Reused scratch â€” safe: NetworkManager.applyRemoteBlockEdit copies fields synchronously (no retain). See NetworkManager:165.
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
						// Reused scratch â€” safe: NetworkManager.onChatMessage copies name/message strings synchronously. Caller must not retain object.
						const chat = dec.readChatMessageInto(this.chatMessageScratch);
						callbacks.onChatMessage?.(chat);
						break;
					}

					case MessageType.BlockEditBatch: {
						const batch = callbacks.onBlockEditBatch;

						if (batch !== undefined) {
							// Batch path: the consumer applies every edit inside one
							// edit batch so lighting and remesh scheduling are
							// deduplicated. See NetworkManager.applyRemoteBlockEdits.
							const count = decodeBlockEditBatchInto(
								dec,
								this.blockEditBatchView,
							);
							if (count > 0) {
								this.blockEditBatchView.count = count;
								batch(this.blockEditBatchView);
							}
							break;
						}

						// Legacy path: one callback per edit, for callers that have not
						// migrated yet. Decoded as a view rather than per-edit objects
						// so even this path stops allocating.
						const count = decodeBlockEditBatchInto(
							dec,
							this.blockEditBatchView,
						);
						const view = this.blockEditBatchView;
						const scratch = this.blockEditBroadcastScratch;
						const single = callbacks.onBlockEdit;

						for (let i = 0; i < count; i++) {
							scratch.sessionId = "";
							scratch.x = view.x[i];
							scratch.y = view.y[i];
							scratch.z = view.z[i];
							scratch.blockId = view.blockId[i];
							scratch.blockState = view.blockState[i];
							scratch.action = view.action[i];
							single?.(scratch);
						}
						break;
					}

					case MessageType.WorldTime:
						callbacks.onWorldTime?.(dec.readFloat32());
						break;

					case MessageType.WorldConfig: {
						// Reused scratch â€” safe: NetworkManager.onWorldConfig copies seed string synchronously (NetworkManager:186). Caller must copy if retaining.
						const cfg = decodeWorldConfigInto(dec, this.worldConfigScratch);
						callbacks.onWorldConfig?.(cfg);
						break;
					}

					case MessageType.SpawnPosition: {
						// Reused scratch â€” safe: NetworkManager.onSpawnPosition copies via setSpawnPosition/restoreSavedPosition (no retain). See NetClient:398.
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

					case MessageType.ContainerState:
					case MessageType.ContainerSlotUpdate:
					case MessageType.ContainerRejected:
						// Handled by RemoteContainerManager via addBinaryHandler.
						return;

					case MessageType.ArrowSpawn:
						// Handled by Arrow.ensureNetworkHandler via addBinaryHandler.
						return;

					case MessageType.TntIgnite: {
						// Reused scratch - safe: the callback consumes fields
						// synchronously (NetworkManager spawns the entity).
						const ignite = decodeTntIgniteInto(dec, this.tntIgniteScratch);
						callbacks.onTntIgnite?.(ignite);
						break;
					}

					case MessageType.ExplosionBroadcast: {
						// Reused scratch - safe: the callback copies what it needs
						// synchronously (NetworkManager dedups and derives).
						const explosion = decodeExplosionBroadcastInto(
							dec,
							this.explosionScratch,
						);
						callbacks.onExplosion?.(explosion);
						break;
					}

					default:
						console.warn(
							`[NetClient] Unknown message type: 0x${msgType.toString(16)}`,
						);
						// Unknown payload length â€” stop to avoid desync.
						return;
				}
			}
		} catch (err) {
			console.error("[NetClient] Failed to handle binary message:", err);
		}
	}

	private handlePlayerStateBatch(dec: BinaryDecoder): void {
		const states = this.batchScratch;

		const sequence = decodePlayerStateBatchEntriesInto(
			dec,
			states,
			this.stateScratch,
		);

		const stateCount = states.length;

		if (stateCount === 0) {
			return;
		}

		const players = this.playersByIndex;
		const ownIndex = this.ownIndex;
		const warnedUnknownIndices = this.warnedUnknownIndices;

		/*
		 * Every entry in this packet has the same arrival time. Sampling once also
		 * prevents players later in a large batch from receiving slightly newer
		 * timestamps solely because of their position in the packet.
		 */
		const receivedAtMs = performance.now();
		const yawScale = 360 / 255;

		let acceptedCount = 0;

		for (let i = 0; i < stateCount; i++) {
			const state = states[i];
			const index = state.index;

			if (index === ownIndex) {
				continue;
			}

			const player = players[index];

			if (player === undefined) {
				if (!warnedUnknownIndices.has(index)) {
					warnedUnknownIndices.add(index);

					console.warn(
						`[NetClient] State for unknown player index ${index}, skipping`,
					);
				}

				continue;
			}

			if (!isSequenceNewer(sequence, player.lastSequence)) {
				continue;
			}

			player.lastSequence = sequence;
			player.receivedAtMs = receivedAtMs;

			player.targetX = state.x;
			player.targetY = state.y;
			player.targetZ = state.z;
			player.targetYaw = state.yaw * yawScale;

			player.pitch = state.pitch;
			player.animation = state.animation;

			acceptedCount++;
		}

		/*
		 * Notify presentation code only when at least one remote player changed.
		 * Unknown, local-only, and entirely stale batches need no renderer work.
		 */
		if (acceptedCount !== 0) {
			this.callbacks.onPlayerStates?.(this.remotePlayers);
		}
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

			// A rejoin must not retain the previous connection's skin or item.
			player.skinPng = null;
			player.heldItemId = 0;
			player.heldItemBlockState = 0;

			player.targetX = 0;
			player.targetY = 80;
			player.targetZ = 0;
			player.targetYaw = 0;

			// A rejoin starts a fresh server-side sequence stream, so the old
			// high-water mark would reject the new room's first batches as stale.
			player.lastSequence = NO_STATE_SEQUENCE;
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
				heldItemId: 0,
				heldItemBlockState: 0,
				targetX: 0,
				targetY: 80,
				targetZ: 0,
				targetYaw: 0,
				// "Nothing received yet", not a real sequence. The server's first
				// batch carries sequence 0, and isSequenceNewer(0, 0) is false â€”
				// initialising to 0 would silently drop every player's first
				// state. 0xffff makes 0 compare as newer instead.
				lastSequence: NO_STATE_SEQUENCE,
				receivedAtMs: 0,
			};

			this.remotePlayers.set(join.sessionId, player);
			this.activeRemotePlayers.push(player);
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

		const activePlayers = this.activeRemotePlayers;
		const activeIndex = activePlayers.indexOf(existing);

		if (activeIndex !== -1) {
			// Removal order is not observable, so swap-removal avoids shifting
			// every following player.
			const lastIndex = activePlayers.length - 1;
			activePlayers[activeIndex] = activePlayers[lastIndex];
			activePlayers.pop();
		}

		this.callbacks.onPlayerLeave?.(existing.sessionId, existing.name);
	}

	sendHeldItemSelection(itemId: number, blockState = 0): boolean {
		const room = this.getConnectedRoom();
		if (room === null) return false;
		if (
			!Number.isInteger(itemId) ||
			itemId < 0 ||
			itemId > 65535 ||
			!Number.isInteger(blockState) ||
			blockState < 0 ||
			blockState > 63 ||
			(itemId === 0 && blockState !== 0)
		)
			return false;
		room.sendBytes("binary", encodeHeldItemSelect({ itemId, blockState }));
		return true;
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
			encodeYawByte(yaw),
			encodePitchByte(pitch),
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

		room.sendBytes(
			"binary",
			encodeItemDrop({ itemId, stackSize, x, y, z, vx, vy, vz }),
		);
	}

	sendItemPickup(instanceId: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		room.sendBytes("binary", encodeItemPickup({ itemId: instanceId }));
	}

	/**
	 * Crate sync (server-authoritative): open a crate for viewing, push one
	 * slot delta, or stop viewing. Slot deltas are last-write-wins per slot;
	 * the server relays every accepted write to all viewers.
	 */
	sendContainerOpen(x: number, y: number, z: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;
		room.sendBytes("binary", encodeContainerOpen({ x, y, z }));
	}

	sendContainerSetSlot(
		x: number,
		y: number,
		z: number,
		row: number,
		col: number,
		itemId: number,
		stackSize: number,
	): void {
		const room = this.getConnectedRoom();
		if (room === null) return;
		room.sendBytes(
			"binary",
			encodeContainerSetSlot({ x, y, z, row, col, itemId, stackSize }),
		);
	}

	sendContainerClose(x: number, y: number, z: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;
		room.sendBytes("binary", encodeContainerClose({ x, y, z }));
	}

	// â”€â”€â”€ Stations â”€â”€â”€
	// No Close message: a station is a fixed block position, so the server needs
	// no per-client view registration the way crates need one. Reaching it again
	// just re-opens.

	sendStationOpen(x: number, y: number, z: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;
		room.sendBytes("binary", encodeStationOpen({ x, y, z }));
	}

	sendStationSetSlot(
		x: number,
		y: number,
		z: number,
		slot: number,
		itemId: number,
		stackSize: number,
	): void {
		const room = this.getConnectedRoom();
		if (room === null) return;
		room.sendBytes(
			"binary",
			encodeStationSetSlot({ x, y, z, slot, itemId, stackSize }),
		);
	}

	sendStationUpgrade(x: number, y: number, z: number, capTier: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;
		room.sendBytes("binary", encodeStationUpgrade({ x, y, z, capTier }));
	}

	sendStationClaimResult(x: number, y: number, z: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;
		room.sendBytes("binary", encodeStationClaimResult({ x, y, z }));
	}

	sendMobSpawnRequest(typeId: number, x: number, y: number, z: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		room.sendBytes("binary", encodeMobSpawnRequest({ typeId, x, y, z }));
	}

	sendMobDamage(mobId: number, damage: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		room.sendBytes("binary", encodeMobDamage({ mobId, damage }));
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

		room.sendBytes(
			"binary",
			encodeArrowShoot({ x, y, z, vx, vy, vz, arrowType }),
		);
	}

	sendExplosion(x: number, y: number, z: number, radius: number): void {
		const room = this.getConnectedRoom();
		if (room === null) return;

		room.sendBytes("binary", encodeExplosion({ x, y, z, radius }));
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

		room.sendBytes("binary", encodeTntIgnite({ x, y, z, fuse, radius }));
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

	/**
	 * Advance remote players toward their latest authoritative sample.
	 *
	 * @deprecated Presentation smoothing belongs to the renderer, not to the
	 *   transport. This now only primes `player.x/y/z/yaw` so that a caller
	 *   which has not yet adopted `RemotePlayerInterpolationBuffer` still sees a
	 *   moving position. New code should read render snapshots instead â€” see
	 *   Network/RemotePlayerInterpolation.ts for why the old in-place chase was
	 *   both frame-rate dependent and jitter-prone.
	 */

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
		this.activeRemotePlayers.length = 0;
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
}
