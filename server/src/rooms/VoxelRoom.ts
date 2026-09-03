/**
 * VoxelRoom — Colyseus room for a shared voxel world.
 *
 * Engine Optimizations Applied:
 * 1. Hot-Loop Array Indexing: Replaced all `.push()` calls in the tick loop,
 *    snapshot broadcasts, and batch handlers with direct array index assignments
 *    (`arr[i] = val`). This eliminates V8 array resizing overhead and bounds
 *    checking in the most frequently executed paths.
 * 2. Tick Loop Unification: Merged `collectPlayerPositions` directly into the
 *    main `tick()` pass. This halves the iteration count over the player map
 *    per server tick.
 * 3. Deflate Concurrency: Replaced `Array.from({ length }, async ...)` in
 *    `sendChunkDataBatchDeflated` with a pre-allocated promise array and a
 *    standard `for` loop. This prevents closure and array allocation overhead
 *    per compression window.
 * 4. Batch Request Scratch Arrays: Replaced per-request allocation of `unique`,
 *    `coords`, and `keys` arrays in `handleBatchChunkRequest` with class-level
 *    scratch arrays that are simply reset via `.length = 0`.
 * 5. Edit Application Scratch: Replaced the `new Map()` allocation in
 *    `ensureEditsApplied` with a class-level `appliedEditsScratch` array to
 *    track pending edits without GC pressure.
 */
import { type Client, ClientState, CloseCode, Room } from "colyseus";
import { MOB_STATS } from "@/code/Entities/MobConfig";
import { DEBUG_ENABLED, debugLog } from "@/code/Lib/debugLog";
import {
	BinaryDecoder,
	BinaryEncoder,
	decodeArrowShootInto,
	decodeItemDropInto,
	decodeItemPickupInto,
	decodeMobDamageInto,
	decodeMobSpawnRequestInto,
	decodePitchByte,
	decodeYawByte,
	encodeArrowSpawn,
	encodeBlockEditBatch,
	encodeBlockEditRejected,
	encodeChatMessage,
	encodeChunkData,
	encodeChunkDataDeflatedPayload,
	encodeChunkUnchanged,
	encodeItemDespawn,
	encodeItemPickupRejected,
	encodeItemSpawn,
	encodeMobDamage,
	encodeMobDespawn,
	encodeMobImpact,
	encodeMobSpawn,
	encodePitchByte,
	encodePlayerJoin,
	encodePlayerLeave,
	encodePlayerSkin,
	encodeSpawnPosition,
	encodeWorldConfig,
	encodeYawByte,
	writeItemUpdateBatch,
	writeMobUpdateBatch,
	writePlayerStateBatch,
} from "@/code/Network/protocol/encoder.ts";
import {
	type ArrowTrajectoryData,
	BlockActionType,
	type BlockEditData,
	BlockEditRejectReason,
	type ChatMessageData,
	type ItemDropData,
	type ItemPickupData,
	ItemPickupRejectReason,
	type ItemSpawnData,
	type ItemUpdateBatchEntry,
	MAX_SKIN_BYTES,
	MessageType,
	type MobDamageData,
	type MobSpawnRequestData,
	type MobUpdateBatchEntry,
	type PlayerStateBatchEntry,
	type PlayerStateData,
} from "@/code/Network/protocol/messages.ts";
import { BlockTickScheduler } from "@/code/World/Chunk/Worker/BlockTickScheduler.ts";
import { WaterSimulation } from "@/code/World/Chunk/Worker/WaterSimulation.ts";
import {
	deflate,
	deflateSupported,
} from "@/code/World/Storage/BlobCompression.ts";
import {
	packChunkKeyFast,
	unpackChunkKeyFast,
} from "@/code/World/Storage/ChunkKey.ts";
import { serializeVoxelData } from "@/code/World/Storage/VoxelSerializer.ts";
import { getServerConfig } from "../config/ServerConfig.ts";
import { ChunkGenerationService } from "../world/ChunkGenerationService.ts";
import type { ServerItem } from "../world/ItemSimulation.ts";
import { ServerItemSimulation } from "../world/ItemSimulation.ts";
import { rollMobFoodDrop } from "../world/MobDrops.ts";
import {
	type ServerMob,
	type ServerMobDeath,
	ServerMobSimulation,
} from "../world/MobSimulation.ts";
import type { StoredChunkData } from "../world/ServerWorldStorage.ts";
import { ServerWorldStorage } from "../world/ServerWorldStorage.ts";
import { ServerWaterBlockAccess } from "../world/WaterBlockAccess.ts";
import {
	createWorldSpawn,
	type WorldSpawn,
} from "../world/WorldSpawnGenerator.ts";

let onlinePlayers = 0;

export function getOnlinePlayers(): number {
	return onlinePlayers;
}

async function runWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	handler: (item: T, index: number) => Promise<void>,
): Promise<void> {
	const count = items.length;
	if (count === 0) return;

	const workerCount = Math.min(Math.max(1, limit | 0), count);
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex++;
			if (index >= count) return;
			await handler(items[index], index);
		}
	};

	const workers = new Array<Promise<void>>(workerCount);
	for (let i = 0; i < workerCount; i++) {
		workers[i] = worker();
	}

	await Promise.all(workers);
}

function timeOfDayLabel(fraction: number): string {
	if (fraction < 0.25) return "morning";
	if (fraction < 0.5) return "day";
	if (fraction < 0.75) return "evening";
	return "night";
}

/** PNG signature bytes (\x89PNG\r\n\x1a\n). */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPngBytes(bytes: Uint8Array): boolean {
	if (bytes.byteLength < PNG_SIGNATURE.length) return false;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (bytes[i] !== PNG_SIGNATURE[i]) return false;
	}
	return true;
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
	/** Session-scoped avatar skin PNG (validated on upload; never persisted). */
	skin: Uint8Array | null;
	dirty: boolean;
	saveDirty: boolean;
	lastSaveTime: number;
}

const MAX_STORED_EDITS = 200;
const TIME_BROADCAST_INTERVAL = 5000;
const FULL_SNAPSHOT_INTERVAL = 2000;
const PLAYER_SAVE_INTERVAL = 3000;
const MOB_UPDATE_INTERVAL = 100;
const ITEM_UPDATE_INTERVAL = 100;
const ITEM_PICKUP_RADIUS = 2.5;
const ITEM_PICKUP_RADIUS_SQ = ITEM_PICKUP_RADIUS * ITEM_PICKUP_RADIUS;
const MAX_ITEM_ID = 65535;
const MAX_ITEM_STACK = 1024;
const MAX_ITEM_VELOCITY = 64;
const MAX_CHUNK_BATCH = 255;
const WORLD_BOUNDARY = 1_000_000;
// Arrow trajectory sync is cosmetic only (damage is validated separately
// via MobDamage), so just reject absurd speeds and non-finite input.
const MAX_ARROW_SPEED = 200;
// Spawn-egg reach: the client raycasts up to REACH_DISTANCE (64) blocks,
// so the server accepts a little headroom beyond that.
const MAX_MOB_SPAWN_REQUEST_DIST = 72;
const MAX_MOB_SPAWN_REQUEST_DIST_SQ =
	MAX_MOB_SPAWN_REQUEST_DIST * MAX_MOB_SPAWN_REQUEST_DIST;
const MAX_CHUNK_COORD = WORLD_BOUNDARY >> 5;
// 10-bit block ids, matching the client's BlockEncoding (mason shape
// variants occupy the 500+ range).
const MAX_BLOCK_ID = 1023;
const MAX_BLOCK_STATE = 63;
const MAX_PROTOCOL_VIOLATIONS = 16;
const FLUSH_CONCURRENCY = 8;
const CHUNK_BATCH_BYTE_LIMIT = 256 * 1024;
const MAX_POOLED_EDIT_ENTRIES = 8192;
const PREWARM_HORIZONTAL_RADIUS = 3;
const PREWARM_MIN_CHUNK_Y = -5;
const PREWARM_MAX_CHUNK_Y = 7;
// Reserved sessionId for block edits generated by the server's water
// simulation (vs. player edits). Lets clients tag these as server-authoritative.
const WATER_EDIT_SESSION_ID = "water";

/** One pending voxel edit queued for persistence. blockId/blockState are the
 * raw (unpacked) fields — applyBlockEdits packs them for storage. */
type PendingBlockEdit = {
	x: number;
	y: number;
	z: number;
	blockId: number;
	blockState: number;
};

export class VoxelRoom extends Room {
	private players = new Map<string, ServerPlayerState>();
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private mobSim!: ServerMobSimulation;
	private mobDebugAccum = 0;
	private mobTickAccum = 0;
	private mobStatePool: MobUpdateBatchEntry[] = [];
	private mobStateScratch: MobUpdateBatchEntry[] = [];
	private mobSnapshotScratch: ServerMob[] = [];
	private mobDeathScratch: ServerMobDeath[] = [];
	private mobUpdateEncoder = new BinaryEncoder(2048);
	private itemSim!: ServerItemSimulation;
	private itemTickAccum = 0;
	private itemStatePool: ItemUpdateBatchEntry[] = [];
	private itemStateScratch: ItemUpdateBatchEntry[] = [];
	private itemSnapshotScratch: ServerItem[] = [];
	private itemUpdateEncoder = new BinaryEncoder(4096);
	// Authoritative water simulation — shares the client's WaterSimulation logic
	// via injected ServerWaterBlockAccess + a dedicated BlockTickScheduler.
	private waterSim!: WaterSimulation;
	private waterScheduler!: BlockTickScheduler;
	private waterBlockAccess!: ServerWaterBlockAccess;
	private playerPosPool: Array<{ x: number; y: number; z: number }> = [];
	private playerPosScratch: Array<{ x: number; y: number; z: number }> = [];
	private readonly blockEdits: Array<BlockEditData | undefined> = new Array(
		MAX_STORED_EDITS,
	);
	private blockEditStart = 0;
	private blockEditCount = 0;
	private timeOfDay = 0.2;
	private worldStorage!: ServerWorldStorage;
	private worldName = "default";
	private seed = "default";
	private dirtyChunks = new Set<number>();
	private pendingChunkEdits = new Map<number, Map<number, PendingBlockEdit>>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushPromise: Promise<void> | null = null;
	private flushRequested = false;
	private activeFlushKeys: Set<number> | null = null;
	private activeFlushPromise: Promise<void> | null = null;
	private timeAccum = 0;
	private playerPositionCache = new Map<
		string,
		{ x: number; y: number; z: number; yaw: number; pitch: number }
	>();
	private chunkGen!: ChunkGenerationService;
	private config = getServerConfig();
	private playersReady = new Set<string>();
	private protocolViolations = new Map<string, number>();
	private reachRejectWarned = new Set<string>();
	private unknownTypeWarned = new Set<string>();
	private lastTickTime = 0;

	private statePool: PlayerStateBatchEntry[] = [];
	private statesScratch: PlayerStateBatchEntry[] = [];
	private tickEncoder = new BinaryEncoder(2048);
	private chunkBatchEncoder = new BinaryEncoder(65536);

	private readonly singleChunkKeyScratch: number[] = [0];

	private static readonly WIRE_CACHE_CAP = 2048;
	private readonly wireCache = new Map<
		number,
		{ version: number; origLen: number; payload: Uint8Array }
	>();

	private getWireEntry(
		key: number,
		version: number,
	): { version: number; origLen: number; payload: Uint8Array } | undefined {
		const entry = this.wireCache.get(key);
		if (entry === undefined) return undefined;
		if (entry.version !== version) return undefined;
		this.wireCache.delete(key);
		this.wireCache.set(key, entry);
		return entry;
	}

	private setWireEntry(
		key: number,
		entry: { version: number; origLen: number; payload: Uint8Array },
	): void {
		this.wireCache.set(key, entry);
		if (this.wireCache.size > VoxelRoom.WIRE_CACHE_CAP) {
			const oldest = this.wireCache.keys().next().value;
			if (oldest !== undefined) this.wireCache.delete(oldest);
		}
	}

	// PERF: reuse the existing cache entry object instead of allocating a fresh
	// one on every write (the tick save path runs every PLAYER_SAVE_INTERVAL per
	// player). The Map retains the reference, so a single shared scratch would
	// alias every player's entry — we mutate in place when the entry exists.
	private cachePlayerPosition(
		name: string,
		x: number,
		y: number,
		z: number,
		yaw: number,
		pitch: number,
	): void {
		const existing = this.playerPositionCache.get(name);
		if (existing) {
			existing.x = x;
			existing.y = y;
			existing.z = z;
			existing.yaw = yaw;
			existing.pitch = pitch;
		} else {
			this.playerPositionCache.set(name, { x, y, z, yaw, pitch });
		}
	}

	private timeEncoder = new BinaryEncoder(16);
	private editBroadcastEncoder = new BinaryEncoder(64);
	private decoder = new BinaryDecoder(new Uint8Array(0));
	private readonly stateScratch: PlayerStateData = {
		x: 0,
		y: 0,
		z: 0,
		yaw: 0,
		pitch: 0,
		animation: 0,
	};
	private readonly editScratch: BlockEditData = {
		sessionId: "",
		x: 0,
		y: 0,
		z: 0,
		blockId: 0,
		blockState: 0,
		action: 0,
	};
	private readonly chunkRequestScratch = {
		cx: 0,
		cy: 0,
		cz: 0,
		lod: 0,
		cachedVersion: 0,
	};
	private readonly chatScratch: ChatMessageData = {
		sessionId: "",
		name: "",
		message: "",
	};
	private readonly itemDropScratch: ItemDropData = {
		itemId: 0,
		stackSize: 0,
		x: 0,
		y: 0,
		z: 0,
		vx: 0,
		vy: 0,
		vz: 0,
	};
	private readonly itemPickupScratch: ItemPickupData = { itemId: 0 };
	private readonly mobSpawnRequestScratch: MobSpawnRequestData = {
		typeId: 0,
		x: 0,
		y: 0,
		z: 0,
	};
	private readonly mobDamageScratch: MobDamageData = { mobId: 0, damage: 0 };
	private readonly arrowShootScratch: ArrowTrajectoryData = {
		x: 0,
		y: 0,
		z: 0,
		vx: 0,
		vy: 0,
		vz: 0,
		arrowType: 0,
	};

	private editEntryPool: Array<{
		x: number;
		y: number;
		z: number;
		blockId: number;
		blockState: number;
	}> = [];
	private nextPlayerIndex = 0;
	private freedIndices: number[] = [];
	private freedIndexSet = new Set<number>();
	private lastFullSnapshot = 0;

	constructor() {
		super();
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

		this.chunkGen = new ChunkGenerationService();
		this.seed = this.config.seed;
		this.chunkGen.setSeed(this.seed, this.config.wasmEnabled);
		console.log(
			`[VoxelRoom] terrain seed: ${this.seed} (from server.properties), wasm: ${this.config.wasmEnabled}`,
		);

		this.worldStorage = new ServerWorldStorage(
			this.worldName,
			this.seed,
			this.config.worldStoragePath,
			this.config.chunkCacheSize,
		);
		await this.worldStorage.init();
		this.chunkGen.setStorage(this.worldStorage);
		this.worldStorage.setWorldGenerator(this.chunkGen);

		this.mobSim = new ServerMobSimulation(this.worldStorage);
		this.itemSim = new ServerItemSimulation(this.worldStorage);

		// Authoritative water simulation. Shares the client's WaterSimulation
		// class (single definition) — only the block access and scheduler are
		// server-specific. The scheduler drives processFrame() every room tick.
		this.waterBlockAccess = new ServerWaterBlockAccess(this.worldStorage);
		this.waterScheduler = new BlockTickScheduler();
		this.waterSim = new WaterSimulation(
			this.waterBlockAccess,
			this.waterScheduler,
		);
		this.waterScheduler.setProcessCallback((x, y, z) =>
			this.waterSim.processWaterUpdate(x, y, z),
		);

		void this.ensureWorldSpawn();
		this.startTickLoop();

		this.onMessageBytes("binary", (client, data: Uint8Array) => {
			this.handleBinaryMessage(client, data);
		});
	}

	async onJoin(client: Client, options: { name?: string }) {
		const index = this.allocateIndex();
		const name = this.sanitizeName(options?.name, index);
		console.log(`[VoxelRoom] ${name} (${client.sessionId}) joined`);

		try {
			const cached = this.playerPositionCache.get(name);
			const saved =
				cached ?? (await this.worldStorage.loadPlayerPosition(name));

			if (
				client.state === ClientState.LEAVING ||
				client.state === ClientState.CLOSED
			) {
				this.freeIndex(index);
				return;
			}

			const worldSpawn = await this.ensureWorldSpawn();

			const state: ServerPlayerState = {
				sessionId: client.sessionId,
				index,
				name,
				x: saved?.x ?? worldSpawn.x,
				y: saved?.y ?? worldSpawn.y,
				z: saved?.z ?? worldSpawn.z,
				yaw: saved?.yaw ?? worldSpawn.yaw,
				pitch: saved?.pitch ?? worldSpawn.pitch,
				animation: 0,
				skin: null,
				dirty: true,
				saveDirty: false,
				lastSaveTime: 0,
			};

			if (!cached) {
				this.cachePlayerPosition(
					name,
					state.x,
					state.y,
					state.z,
					encodeYawByte(state.yaw),
					encodePitchByte(state.pitch),
				);
			}
			this.players.set(client.sessionId, state);
			onlinePlayers++;

			const joinMsg = encodePlayerJoin({
				index,
				sessionId: client.sessionId,
				name,
			});
			this.broadcastBytes("binary", joinMsg, { except: client });
			client.sendBytes("binary", joinMsg);

			if (this.players.size > 1) {
				const parts: Uint8Array[] = [];
				let totalLen = 0;
				for (const [sid, p] of this.players) {
					if (sid === client.sessionId) continue;
					const msg = encodePlayerJoin({
						index: p.index,
						sessionId: sid,
						name: p.name,
					});
					parts.push(msg);
					totalLen += msg.length;
				}
				if (parts.length > 0) {
					const merged = new Uint8Array(totalLen);
					let offset = 0;
					for (const part of parts) {
						merged.set(part, offset);
						offset += part.length;
					}
					client.sendBytes("binary", merged);
				}
			}

			this.sendFullPlayerSnapshot(client);

			// Bring the newcomer up to date with every mob already in the
			// world — spawn/despawn events are only broadcast for mobs that
			// change after they connect, so a late joiner would otherwise see
			// none of the existing mobs until they happened to respawn.
			this.sendFullMobSnapshot(client);

			// Deliver existing players' skins to the newcomer. One frame per
			// skin — clients parse a single message per binary frame.
			for (const [sid, p] of this.players) {
				if (sid === client.sessionId || !p.skin) continue;
				client.sendBytes(
					"binary",
					encodePlayerSkin({ index: p.index, png: p.skin }),
				);
			}

			if (this.blockEditCount > 0) {
				client.sendBytes(
					"binary",
					encodeBlockEditBatch(this.getBlockEditHistory()),
				);
			}

			/*
			if (this.mobSim.size > 0) {
				const mobs = this.mobSim.snapshotInto(this.mobSnapshotScratch);
				const parts: Uint8Array[] = [];
				let totalLen = 0;
				for (const mob of mobs) {
					const msg = encodeMobSpawn(
						mob.id,
						mob.typeId,
						mob.x,
						mob.y,
						mob.z,
						mob.yaw,
					);
					parts.push(msg);
					totalLen += msg.length;
				}
				if (parts.length > 0) {
					const merged = new Uint8Array(totalLen);
					let offset = 0;
					for (const part of parts) {
						merged.set(part, offset);
						offset += part.length;
					}
					client.sendBytes("binary", merged);
				}
			}
*/
			if (this.itemSim.size > 0) {
				const items = this.itemSim.snapshotInto(this.itemSnapshotScratch);
				const parts: Uint8Array[] = [];
				let totalLen = 0;
				for (const item of items) {
					const msg = encodeItemSpawn({
						id: item.id,
						itemId: item.itemId,
						stackSize: item.stackSize,
						x: item.x,
						y: item.y,
						z: item.z,
						vx: item.vx,
						vy: item.vy,
						vz: item.vz,
					});
					parts.push(msg);
					totalLen += msg.length;
				}
				if (parts.length > 0) {
					const merged = new Uint8Array(totalLen);
					let offset = 0;
					for (const part of parts) {
						merged.set(part, offset);
						offset += part.length;
					}
					client.sendBytes("binary", merged);
				}
			}

			client.sendBytes(
				"binary",
				encodeWorldConfig(
					this.seed,
					this.config.dayDuration,
					this.config.dayCycle,
				),
			);

			const timeMsg = new BinaryEncoder(5);
			timeMsg.writeUint8(MessageType.WorldTime);
			timeMsg.writeFloat32(this.timeOfDay);
			client.sendBytes("binary", timeMsg.getBytes());

			client.sendBytes(
				"binary",
				encodeSpawnPosition(
					state.x,
					state.y,
					state.z,
					saved ? decodeYawByte(state.yaw) : state.yaw,
					saved ? decodePitchByte(state.pitch) : state.pitch,
				),
			);
			this.playersReady.add(client.sessionId);
		} catch (error) {
			const wasPresent = this.players.delete(client.sessionId);
			if (wasPresent) onlinePlayers--;
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
		this.reachRejectWarned.delete(client.sessionId);
		this.unknownTypeWarned.delete(client.sessionId);
		const player = this.players.get(client.sessionId);
		console.log(
			`[VoxelRoom] ${player?.name ?? client.sessionId} left (code: ${code})`,
		);

		if (!player) return;

		this.cachePlayerPosition(
			player.name,
			player.x,
			player.y,
			player.z,
			player.yaw,
			player.pitch,
		);
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
		onlinePlayers--;
		this.playersReady.delete(client.sessionId);
		this.freeIndex(player.index);

		this.broadcastBytes(
			"binary",
			encodePlayerLeave({ index: player.index }),
			{},
		);
	}

	private handleChatCommand(client: Client, raw: string): boolean {
		const parts = raw.split(/\s+/);
		const cmd = parts[0]?.toLowerCase();
		if (cmd !== "time") return false;

		const args = parts.slice(1);
		const reply = (text: string): void => {
			client.sendBytes(
				"binary",
				encodeChatMessage({
					sessionId: client.sessionId,
					name: "Server",
					message: text,
				}),
			);
		};

		if (args.length === 0) {
			reply(
				`Time: ${Math.round(this.timeOfDay * 1000)} (${timeOfDayLabel(this.timeOfDay)})`,
			);
			return true;
		}

		let fraction: number | null = null;
		const arg = args[0].toLowerCase();

		if (arg === "day") {
			fraction = 0.25;
		} else {
			const isRelative = arg.startsWith("+") || arg.startsWith("-");
			const numeric = Number.parseFloat(arg);
			if (Number.isFinite(numeric)) {
				if (isRelative) {
					fraction = (this.timeOfDay + numeric / 1000) % 1;
					if (fraction < 0) fraction += 1;
				} else {
					fraction = Math.max(0, Math.min(1000, numeric)) / 1000;
				}
			}
		}

		if (fraction === null) {
			reply("Usage: !time [<0-1000> | +<amount> | day]");
			return true;
		}

		this.timeOfDay = fraction;
		const timeMsg = new BinaryEncoder(5);
		timeMsg.writeUint8(MessageType.WorldTime);
		timeMsg.writeFloat32(this.timeOfDay);
		this.broadcastBytes("binary", timeMsg.getBytes(), {});

		reply(
			`Time set to ${Math.round(fraction * 1000)} (${timeOfDayLabel(fraction)})`,
		);
		return true;
	}

	async onDispose() {
		console.log("[VoxelRoom] disposed");
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
		const remainingPlayers = this.players.size;
		onlinePlayers = Math.max(0, onlinePlayers - remainingPlayers);
		this.players.clear();
		this.playersReady.clear();
		this.protocolViolations.clear();
		this.reachRejectWarned.clear();
		this.unknownTypeWarned.clear();

		await this.mobSim.persistAll();
		this.clearChunkFlush();
		await this.requestChunkFlush();
		this.pendingChunkEdits.clear();
		await this.chunkGen.terminate();
		if (this.worldStorage) await this.worldStorage.dispose();
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

	private requestChunkFlush(): Promise<void> {
		this.flushRequested = true;
		if (!this.flushPromise) {
			this.flushPromise = this.runChunkFlushLoop().finally(() => {
				this.flushPromise = null;
				if (this.dirtyChunks.size > 0) this.requestChunkFlush();
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
		const dirty = this.dirtyChunks;
		const edits = this.pendingChunkEdits;
		this.dirtyChunks = new Set();
		this.pendingChunkEdits = new Map();

		this.activeFlushKeys = new Set(dirty);
		this.activeFlushPromise = this.applyFlushedEdits(dirty, edits).finally(
			() => {
				this.activeFlushKeys = null;
				this.activeFlushPromise = null;
			},
		);
		await this.activeFlushPromise;
	}

	private async applyFlushedEdits(
		dirty: Set<number>,
		edits: Map<number, Map<number, PendingBlockEdit>>,
	): Promise<void> {
		try {
			await this.applyDirtyEditMapsWithConcurrency(
				dirty,
				edits,
				FLUSH_CONCURRENCY,
			);

			await this.worldStorage.flush();

			for (const editMap of edits.values()) {
				this.releaseEditEntries(editMap);
			}
		} catch (error) {
			this.mergeFailedChunkEdits(dirty, edits);
			throw error;
		}
	}
	private async applyDirtyEditMapsWithConcurrency(
		dirty: Set<number>,
		edits: Map<number, Map<number, PendingBlockEdit>>,
		limit: number,
	): Promise<void> {
		if (dirty.size === 0) return;

		const iterator = dirty.values();
		const workerCount = Math.min(Math.max(1, limit | 0), dirty.size);
		const workers = new Array<Promise<void>>(workerCount);

		const worker = async (): Promise<void> => {
			for (;;) {
				const next = iterator.next();
				if (next.done) return;

				const key = next.value;
				const editMap = edits.get(key);
				if (editMap === undefined || editMap.size === 0) continue;

				const coordinates = unpackChunkKeyFast(key);
				await this.worldStorage.applyBlockEdits(
					coordinates[0],
					coordinates[1],
					coordinates[2],
					editMap.values(),
				);
			}
		};

		for (let i = 0; i < workerCount; i++) {
			workers[i] = worker();
		}

		await Promise.all(workers);
	}

	private async waitForOverlappingFlush(
		keys: readonly number[],
	): Promise<void> {
		const activeKeys = this.activeFlushKeys;
		const activePromise = this.activeFlushPromise;
		if (!activeKeys || !activePromise) return;
		for (let i = 0; i < keys.length; i++) {
			if (activeKeys.has(keys[i])) {
				try {
					await activePromise;
				} catch {}
				return;
			}
		}
	}

	private acquireEditEntry(): PendingBlockEdit {
		return (
			this.editEntryPool.pop() ?? {
				x: 0,
				y: 0,
				z: 0,
				blockId: 0,
				blockState: 0,
			}
		);
	}

	private releaseEditEntry(entry: PendingBlockEdit): void {
		if (this.editEntryPool.length < MAX_POOLED_EDIT_ENTRIES)
			this.editEntryPool.push(entry);
	}

	private releaseEditEntries(editMap: Map<number, PendingBlockEdit>): void {
		for (const entry of editMap.values()) this.releaseEditEntry(entry);
	}

	private mergeFailedChunkEdits(
		dirty: Set<number>,
		failed: Map<number, Map<number, PendingBlockEdit>>,
	): void {
		for (const key of dirty) {
			const failedMap = failed.get(key);
			if (!failedMap) continue;
			let currentMap = this.pendingChunkEdits.get(key);
			if (!currentMap) {
				currentMap = new Map();
				this.pendingChunkEdits.set(key, currentMap);
			}
			for (const [voxel, edit] of failedMap) {
				if (!currentMap.has(voxel)) currentMap.set(voxel, edit);
			}
			this.dirtyChunks.add(key);
		}
	}

	private allocateIndex(): number {
		const recycled = this.freedIndices.pop();
		if (recycled !== undefined) {
			this.freedIndexSet.delete(recycled);
			return recycled;
		}
		if (this.nextPlayerIndex > 255)
			throw new Error("Player index space exhausted");
		return this.nextPlayerIndex++;
	}

	private freeIndex(index: number): void {
		if (!Number.isInteger(index) || index < 0 || index > 255) return;
		if (this.freedIndexSet.has(index)) return;
		this.freedIndexSet.add(index);
		this.freedIndices.push(index);
	}

	private sanitizeName(raw: string | undefined, index: number): string {
		const cleaned = (raw ?? "")
			.trim()
			// biome-ignore lint/suspicious/noControlCharactersInRegex: <allow it here>
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
		return cleaned.slice(0, 32) || `Player${index + 1}`;
	}

	private reportAsync(label: string, promise: Promise<unknown>): void {
		void promise.catch((error) =>
			console.error(`[VoxelRoom] ${label}:`, error),
		);
	}

	private worldSpawnPromise: Promise<{
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	}> | null = null;

	private ensureWorldSpawn(): Promise<{
		x: number;
		y: number;
		z: number;
		yaw: number;
		pitch: number;
	}> {
		if (this.worldSpawnPromise) return this.worldSpawnPromise;
		this.worldSpawnPromise = this.computeWorldSpawn().catch((err) => {
			this.worldSpawnPromise = null;
			throw err;
		});
		return this.worldSpawnPromise;
	}

	private async computeWorldSpawn(): Promise<WorldSpawn> {
		return createWorldSpawn({
			seed: this.seed,
			chunkGen: this.chunkGen,
			worldStorage: this.worldStorage,
			prewarmSpawnArea: (chunkX, chunkZ) =>
				this.prewarmSpawnArea(chunkX, chunkZ),
		});
	}

	private prewarmSpawnArea(centerCx = 0, centerCz = 0): void {
		this.reportAsync(
			"Spawn area prewarm failed",
			this.prewarmSpawnAreaImpl(centerCx, centerCz),
		);
	}

	private async prewarmSpawnAreaImpl(
		centerCx: number,
		centerCz: number,
	): Promise<void> {
		const coords: Array<{ cx: number; cy: number; cz: number }> = [];
		for (
			let dx = -PREWARM_HORIZONTAL_RADIUS;
			dx <= PREWARM_HORIZONTAL_RADIUS;
			dx++
		) {
			for (
				let dz = -PREWARM_HORIZONTAL_RADIUS;
				dz <= PREWARM_HORIZONTAL_RADIUS;
				dz++
			) {
				for (let cy = PREWARM_MIN_CHUNK_Y; cy <= PREWARM_MAX_CHUNK_Y; cy++) {
					coords.push({ cx: centerCx + dx, cy, cz: centerCz + dz });
				}
			}
		}
		const storedMap = await this.worldStorage.readChunks(coords);
		const missing: Array<{ chunkX: number; chunkY: number; chunkZ: number }> =
			[];
		for (const c of coords) {
			if (!storedMap.has(packChunkKeyFast(c.cx, c.cy, c.cz)))
				missing.push({ chunkX: c.cx, chunkY: c.cy, chunkZ: c.cz });
		}
		if (missing.length === 0) return;
		await this.chunkGen.generateChunksBatch(missing);
	}

	private startTickLoop(): void {
		this.lastTickTime = performance.now();
		this.tickInterval = setInterval(() => {
			const now = performance.now();
			const deltaMs = Math.min(now - this.lastTickTime, 250);
			this.lastTickTime = now;
			this.tick(deltaMs);
		}, 1000 / this.config.tickRate);
	}

	private tick(deltaMs: number): void {
		if (this.players.size === 0) return;

		if (this.config.dayCycle && this.config.dayDuration > 0) {
			this.timeOfDay = (this.timeOfDay + deltaMs / this.config.dayDuration) % 1;
		}

		this.timeAccum += deltaMs;
		if (this.timeAccum >= TIME_BROADCAST_INTERVAL) {
			this.timeAccum = 0;
			this.timeEncoder.reset();
			this.timeEncoder.writeUint8(MessageType.WorldTime);
			this.timeEncoder.writeFloat32(this.timeOfDay);
			this.broadcastBytes("binary", this.timeEncoder.getBytes(), {});
		}

		const now = Date.now();
		const fullSnapshotDue =
			now - this.lastFullSnapshot >= FULL_SNAPSHOT_INTERVAL;
		if (fullSnapshotDue) this.lastFullSnapshot = now;

		// Engine optimization: Single pass over players for position collection
		const posScratch = this.playerPosScratch;
		const posPool = this.playerPosPool;
		let playerCount = 0;

		for (const p of this.players.values()) {
			let slot = posPool[playerCount];
			if (!slot) {
				slot = { x: 0, y: 0, z: 0 };
				posPool[playerCount] = slot;
			}
			slot.x = p.x;
			slot.y = p.y;
			slot.z = p.z;
			posScratch[playerCount++] = slot;
		}
		posScratch.length = playerCount;
		this.worldStorage.setPlayerPositions(posScratch);

		const mobEvents = this.mobSim.tick(deltaMs, posScratch);

		this.mobDebugAccum += deltaMs;
		if (this.mobDebugAccum >= 5000) {
			this.mobDebugAccum = 0;
			const stats = this.mobSim.getDebugStats();
			console.log(
				`[VoxelRoom] mobs=${stats.total} byType=${JSON.stringify(stats.byType)} lastSpawn=${stats.lastSpawnCount} players=${this.players.size}`,
			);
		}

		for (let i = 0; i < mobEvents.length; i++) {
			const event = mobEvents[i];
			if (event.kind === "spawn") {
				this.broadcastBytes(
					"binary",
					encodeMobSpawn(
						event.mob.id,
						event.mob.typeId,
						event.mob.x,
						event.mob.y,
						event.mob.z,
						event.mob.yaw,
					),
					{},
				);
			} else if (event.kind === "impact") {
				const stats = MOB_STATS[event.mob.typeId];
				this.broadcastBytes(
					"binary",
					encodeMobImpact({
						mobId: event.mob.id,
						x: event.mob.x,
						y: event.mob.y - stats.feetHeight,
						z: event.mob.z,
						fallDistance: event.fallDistance ?? 0,
					}),
					{},
				);
				if (event.damage !== undefined && event.damage > 0) {
					this.broadcastBytes(
						"binary",
						encodeMobDamage({
							mobId: event.mob.id,
							damage: event.damage,
						}),
						{},
					);
				}
			} else {
				this.broadcastBytes("binary", encodeMobDespawn(event.mob.id), {});
			}
		}
		this.spawnMobDeathDrops();
		this.mobTickAccum += deltaMs;
		if (this.mobTickAccum >= MOB_UPDATE_INTERVAL) {
			this.mobTickAccum = 0;
			this.writeMobUpdateBatch();
		}

		const itemEvents = this.itemSim.tick(deltaMs);
		for (let i = 0; i < itemEvents.length; i++) {
			this.broadcastBytes(
				"binary",
				encodeItemDespawn(itemEvents[i].item.id),
				{},
			);
		}
		this.itemTickAccum += deltaMs;
		if (this.itemTickAccum >= ITEM_UPDATE_INTERVAL) {
			this.itemTickAccum = 0;
			this.writeItemUpdateBatch();
		}

		// Authoritative water simulation — process this tick's due water updates.
		// The scheduler drains one ring-bucket per frame; processWaterUpdate flows
		// water and reschedules neighbors. Block changes are written to the world
		// cache synchronously and broadcast to clients so their meshes update.
		this.waterScheduler.processFrame();
		this.broadcastWaterEdits();

		// Engine optimization: Single pass over players for state batch and save logic
		const stateScratch = this.statesScratch;
		const statePool = this.statePool;
		let stateIdx = 0;

		for (const p of this.players.values()) {
			if (
				p.saveDirty &&
				this.playersReady.has(p.sessionId) &&
				now - p.lastSaveTime >= PLAYER_SAVE_INTERVAL
			) {
				p.lastSaveTime = now;
				p.saveDirty = false;
				this.cachePlayerPosition(p.name, p.x, p.y, p.z, p.yaw, p.pitch);
				void this.worldStorage
					.savePlayerPosition(p.name, p.x, p.y, p.z, p.yaw, p.pitch)
					.catch((error) => {
						p.saveDirty = true;
						console.error(
							`[VoxelRoom] Position save failed for ${p.name}:`,
							error,
						);
					});
			}

			if (!p.dirty && !fullSnapshotDue) continue;

			let slot = statePool[stateIdx];
			if (!slot) {
				slot = { index: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, animation: 0 };
				statePool[stateIdx] = slot;
			}
			slot.index = p.index;
			slot.x = p.x;
			slot.y = p.y;
			slot.z = p.z;
			slot.yaw = p.yaw;
			slot.pitch = p.pitch;
			slot.animation = p.animation;
			stateScratch[stateIdx++] = slot;
			p.dirty = false;
		}

		stateScratch.length = stateIdx;
		if (stateIdx === 0) return;

		this.tickEncoder.reset();
		writePlayerStateBatch(this.tickEncoder, stateScratch);
		this.broadcastBytes("binary", this.tickEncoder.getBytes(), {});
	}

	private sendFullPlayerSnapshot(client: Client): void {
		const scratch = this.statesScratch;
		let idx = 0;
		for (const p of this.players.values()) {
			if (p.sessionId === client.sessionId) continue;
			let slot = this.statePool[idx];
			if (!slot) {
				slot = { index: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, animation: 0 };
				this.statePool[idx] = slot;
			}
			slot.index = p.index;
			slot.x = p.x;
			slot.y = p.y;
			slot.z = p.z;
			slot.yaw = p.yaw;
			slot.pitch = p.pitch;
			slot.animation = p.animation;
			scratch[idx++] = slot;
		}
		scratch.length = idx;
		if (idx === 0) return;

		this.tickEncoder.reset();
		writePlayerStateBatch(this.tickEncoder, scratch);
		client.sendBytes("binary", this.tickEncoder.getBytes());
	}

	/** Send every active server mob to a single (newly-joined) client. */
	private sendFullMobSnapshot(client: Client): void {
		for (const mob of this.mobSim.getActiveMobs()) {
			client.sendBytes(
				"binary",
				encodeMobSpawn(mob.id, mob.typeId, mob.x, mob.y, mob.z, mob.yaw),
			);
		}
	}

	/**
	 * Spawn food drops for mobs that died since the last tick (player kills
	 * via MobDamage and server-side fall damage alike). Runs before
	 * itemSim.tick() so fresh drops get physics on the same tick, and uses
	 * the exact ItemDrop broadcast shape so clients render/pick them up
	 * like any other drop.
	 */
	private spawnMobDeathDrops(): void {
		const deaths = this.mobSim.drainDeaths(this.mobDeathScratch);
		for (let i = 0; i < deaths.length; i++) {
			const death = deaths[i];
			const drop = rollMobFoodDrop(death.typeId);
			if (!drop) continue;

			const item = this.itemSim.add(
				drop.itemId,
				drop.stackSize,
				death.x,
				death.y + 0.5,
				death.z,
				(Math.random() - 0.5) * 1.5,
				2,
				(Math.random() - 0.5) * 1.5,
			);
			this.broadcastBytes(
				"binary",
				encodeItemSpawn({
					id: item.id,
					itemId: item.itemId,
					stackSize: item.stackSize,
					x: item.x,
					y: item.y,
					z: item.z,
					vx: item.vx,
					vy: item.vy,
					vz: item.vz,
				}),
				{},
			);
		}
	}

	private writeMobUpdateBatch(): void {
		const mobs = this.mobSim.snapshotInto(this.mobSnapshotScratch);
		const mobCount = mobs.length;
		if (mobCount === 0) return;

		const scratch = this.mobStateScratch;
		for (let i = 0; i < mobCount; i++) {
			const mob = mobs[i];
			let slot = this.mobStatePool[i];
			if (!slot) {
				slot = { mobId: 0, x: 0, y: 0, z: 0, yaw: 0 };
				this.mobStatePool[i] = slot;
			}
			slot.mobId = mob.id;
			slot.x = mob.x;
			slot.y = mob.y;
			slot.z = mob.z;
			slot.yaw = mob.yaw;
			scratch[i] = slot;
		}
		scratch.length = mobCount;

		this.mobUpdateEncoder.reset();
		writeMobUpdateBatch(this.mobUpdateEncoder, scratch);
		this.broadcastBytes("binary", this.mobUpdateEncoder.getBytes(), {});
	}

	private writeItemUpdateBatch(): void {
		const items = this.itemSim.snapshotInto(this.itemSnapshotScratch);
		const itemCount = items.length;
		if (itemCount === 0) return;

		const scratch = this.itemStateScratch;
		for (let i = 0; i < itemCount; i++) {
			const item = items[i];
			let slot = this.itemStatePool[i];
			if (!slot) {
				slot = { id: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
				this.itemStatePool[i] = slot;
			}
			slot.id = item.id;
			slot.x = item.x;
			slot.y = item.y;
			slot.z = item.z;
			slot.vx = item.vx;
			slot.vy = item.vy;
			slot.vz = item.vz;
			scratch[i] = slot;
		}
		scratch.length = itemCount;

		// The wire format stores the entry count in one byte, so batches are
		// capped at 255. Split larger snapshots into consecutive messages
		// instead of silently truncating (which would freeze distant items).
		for (let offset = 0; offset < itemCount; offset += 255) {
			this.itemUpdateEncoder.reset();
			writeItemUpdateBatch(
				this.itemUpdateEncoder,
				scratch.slice(offset, offset + 255),
			);
			this.broadcastBytes("binary", this.itemUpdateEncoder.getBytes(), {});
		}
	}

	/**
	 * Broadcasts water-induced block changes accumulated this tick to all
	 * clients. Uses the existing BlockEditBroadcast wire format with the
	 * reserved sessionId "water" so clients can distinguish server-simulated
	 * flow from player edits. Each change is also recorded in the edit history
	 * so late joiners receive them.
	 */
	private broadcastWaterEdits(): void {
		const changes = this.waterBlockAccess.drainChanges();
		const count = changes.length;
		if (count === 0) return;

		const encoder = this.editBroadcastEncoder;
		for (let i = 0; i < count; i++) {
			const c = changes[i];
			const action =
				c.blockId === 0 ? BlockActionType.Break : BlockActionType.Place;
			// Record into the ring buffer for late-join snapshots.
			this.recordBlockEdit({
				sessionId: WATER_EDIT_SESSION_ID,
				x: c.x,
				y: c.y,
				z: c.z,
				blockId: c.blockId,
				blockState: c.blockState,
				action,
			});

			encoder.reset();
			encoder.writeUint8(MessageType.BlockEditBroadcast);
			encoder.writeString(WATER_EDIT_SESSION_ID);
			encoder.writeInt32(c.x);
			encoder.writeInt32(c.y);
			encoder.writeInt32(c.z);
			encoder.writeUint16(c.blockId);
			encoder.writeUint8(c.blockState);
			encoder.writeUint8(action);
			this.broadcastBytes("binary", encoder.getBytes(), {});
		}
	}

	private handleBinaryMessage(client: Client, data: Uint8Array): void {
		if (data.byteLength < 1) return;
		try {
			this.decodeAndHandleBinaryMessage(client, data);
		} catch (error) {
			if (this.recordProtocolViolation(client) === 1) {
				console.warn(
					`[VoxelRoom] Invalid binary packet from ${client.sessionId}:`,
					error,
				);
			}
		}
	}

	private recordProtocolViolation(client: Client): number {
		const count = (this.protocolViolations.get(client.sessionId) ?? 0) + 1;
		this.protocolViolations.set(client.sessionId, count);
		if (count >= MAX_PROTOCOL_VIOLATIONS) {
			this.protocolViolations.delete(client.sessionId);
			client.leave(CloseCode.WITH_ERROR, "Too many malformed packets");
		}
		return count;
	}

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

	private isValidBlockEdit(edit: {
		x: number;
		y: number;
		z: number;
		blockId: number;
		blockState: number;
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
			Number.isInteger(edit.blockState) &&
			edit.blockState >= 0 &&
			edit.blockState <= MAX_BLOCK_STATE &&
			(edit.action === BlockActionType.Place ||
				edit.action === BlockActionType.Break)
		);
	}

	private isValidItemDrop(drop: ItemDropData): boolean {
		return (
			Number.isInteger(drop.itemId) &&
			drop.itemId >= 1 &&
			drop.itemId <= MAX_ITEM_ID &&
			Number.isInteger(drop.stackSize) &&
			drop.stackSize >= 1 &&
			drop.stackSize <= MAX_ITEM_STACK &&
			Number.isFinite(drop.x) &&
			Number.isFinite(drop.y) &&
			Number.isFinite(drop.z) &&
			Number.isFinite(drop.vx) &&
			Number.isFinite(drop.vy) &&
			Number.isFinite(drop.vz) &&
			Math.abs(drop.x) <= WORLD_BOUNDARY &&
			Math.abs(drop.y) <= WORLD_BOUNDARY &&
			Math.abs(drop.z) <= WORLD_BOUNDARY &&
			Math.abs(drop.vx) <= MAX_ITEM_VELOCITY &&
			Math.abs(drop.vy) <= MAX_ITEM_VELOCITY &&
			Math.abs(drop.vz) <= MAX_ITEM_VELOCITY
		);
	}

	private isValidChunkRequest(
		cx: number,
		cy: number,
		cz: number,
		lod: number,
		cachedVersion: number,
	): boolean {
		return (
			Number.isSafeInteger(cx) &&
			Number.isSafeInteger(cy) &&
			Number.isSafeInteger(cz) &&
			Math.abs(cx) <= MAX_CHUNK_COORD &&
			Math.abs(cy) <= MAX_CHUNK_COORD &&
			Math.abs(cz) <= MAX_CHUNK_COORD &&
			lod === 0 &&
			Number.isInteger(cachedVersion) &&
			cachedVersion >= 0 &&
			cachedVersion <= 0xffffffff
		);
	}

	private sendBlockEditRejected(
		client: Client,
		edit: {
			x: number;
			y: number;
			z: number;
			blockId: number;
			blockState: number;
			action: number;
		},
		reason: number,
	): void {
		client.sendBytes(
			"binary",
			encodeBlockEditRejected({
				x: edit.x,
				y: edit.y,
				z: edit.z,
				blockId: edit.blockId,
				blockState: edit.blockState,
				action: edit.action,
				reason,
			}),
		);
	}

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

	private estimateChunkBytes(c: StoredChunkData): number {
		let size = 12 + 4 + 1;
		if (c.isUniform) size += 2;
		else if (c.palette) size += 2 + c.palette.length * 2 + c.blocks.byteLength;
		else size += c.blocks.byteLength;
		return size + 4 + c.light.length;
	}

	private serializeStored(c: StoredChunkData): Uint8Array {
		const paletteArr = c.palette ? Uint16Array.from(c.palette) : null;
		return serializeVoxelData(
			c.blocks,
			paletteArr,
			c.isUniform,
			c.uniformBlockId,
			c.light,
			false,
			c.version,
		);
	}

	private async sendChunkDataBatch(
		client: Client,
		chunks: StoredChunkData[],
	): Promise<void> {
		const count = chunks.length;
		if (count === 0) return;

		if (!deflateSupported()) {
			let groupStart = 0;
			let size = 0;

			for (let i = 0; i < count; i++) {
				const chunk = chunks[i];

				// Defensive check. This should never trigger after fixing ownership.
				if (chunk === undefined) {
					console.error(
						`[VoxelRoom] Undefined chunk in uncompressed batch at index ${i}/${count}`,
					);
					continue;
				}

				const chunkSize = this.estimateChunkBytes(chunk);

				if (groupStart < i && size + chunkSize > CHUNK_BATCH_BYTE_LIMIT) {
					client.sendBytes(
						"binary",
						this.encodeChunkBatch(chunks, groupStart, i),
					);

					groupStart = i;
					size = 0;
				}

				size += chunkSize;
			}

			if (groupStart < count) {
				client.sendBytes(
					"binary",
					this.encodeChunkBatch(chunks, groupStart, count),
				);
			}

			return;
		}

		/*
		 * Critical: await compression and sending before the caller is allowed to
		 * clear or recycle the chunks array.
		 */
		await this.sendChunkDataBatchDeflated(client, chunks);
	}

	private async sendChunkDataBatchDeflated(
		client: Client,
		chunks: StoredChunkData[],
	): Promise<void> {
		const count = chunks.length;
		if (count === 0) return;

		const payloads = new Array<Uint8Array>(count);
		const origLens = new Array<number>(count);
		const sizes = new Array<number>(count);

		await runWithConcurrency(chunks, 4, async (chunk, index): Promise<void> => {
			/*
			 * This guard produces a useful error if another caller passes a
			 * sparse or prematurely-cleared array.
			 */
			if (chunk === undefined) {
				throw new Error(
					`Undefined chunk at index ${index}/${count} during deflate`,
				);
			}

			await this.deflateSingleChunk(chunk, payloads, origLens, sizes, index);
		});

		let groupStart = 0;
		let groupSize = 0;

		for (let i = 0; i < count; i++) {
			const chunkSize = sizes[i];

			if (groupStart < i && groupSize + chunkSize > CHUNK_BATCH_BYTE_LIMIT) {
				client.sendBytes(
					"binary",
					this.encodeDeflatedChunkBatch(
						payloads,
						origLens,
						chunks,
						groupStart,
						i,
					),
				);

				groupStart = i;
				groupSize = 0;
			}

			groupSize += chunkSize;
		}

		if (groupStart < count) {
			client.sendBytes(
				"binary",
				this.encodeDeflatedChunkBatch(
					payloads,
					origLens,
					chunks,
					groupStart,
					count,
				),
			);
		}
	}

	private async deflateSingleChunk(
		c: StoredChunkData,
		payloads: Uint8Array[],
		origLens: number[],
		sizes: number[],
		i: number,
	): Promise<void> {
		const key = packChunkKeyFast(c.chunkX, c.chunkY, c.chunkZ);
		const cached = this.getWireEntry(key, c.version);
		if (cached) {
			payloads[i] = cached.payload;
			origLens[i] = cached.origLen;
			sizes[i] = 24 + cached.payload.byteLength;
			return;
		}
		const blob = this.serializeStored(c);
		const deflated = await deflate(blob);
		this.setWireEntry(key, {
			version: c.version,
			origLen: blob.byteLength,
			payload: deflated,
		});
		payloads[i] = deflated;
		origLens[i] = blob.byteLength;
		sizes[i] = 24 + deflated.byteLength;
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
			enc.writeUint32(c.version);
			const denseU16 =
				!c.isUniform && !c.palette && c.blocks instanceof Uint16Array;
			let flags = 0;
			if (c.isUniform) flags |= 1;
			if (c.palette) flags |= 2;
			if (denseU16) flags |= 4;
			enc.writeUint8(flags);
			if (c.isUniform) {
				enc.writeUint16(c.uniformBlockId);
			} else if (c.palette) {
				enc.writeUint16(c.palette.length);
				for (let j = 0; j < c.palette.length; j++)
					enc.writeUint16(c.palette[j]);
				enc.writeBytes(c.blocks as Uint8Array);
			} else {
				const b = c.blocks;
				enc.writeBytes(
					b instanceof Uint16Array
						? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
						: b,
				);
			}
			enc.writeUint32(c.light.length);
			enc.writeBytes(c.light);
		}
		return enc.getBytes();
	}

	private encodeDeflatedChunkBatch(
		payloads: readonly Uint8Array[],
		origLens: readonly number[],
		chunks: readonly StoredChunkData[],
		start: number,
		end: number,
	): Uint8Array {
		const enc = this.chunkBatchEncoder;
		enc.reset();
		enc.writeUint8(MessageType.ChunkDataDeflatedBatch);
		enc.writeUint16(Math.min(end - start, 65535));
		for (let i = start; i < end; i++) {
			const c = chunks[i];
			enc.writeInt32(c.chunkX);
			enc.writeInt32(c.chunkY);
			enc.writeInt32(c.chunkZ);
			enc.writeUint32(c.version);
			enc.writeUint32(payloads[i].byteLength);
			enc.writeUint32(origLens[i]);
			enc.writeBytes(payloads[i]);
		}
		return enc.getBytes();
	}

	private decodeAndHandleBinaryMessage(client: Client, data: Uint8Array): void {
		const dec = this.decoder;
		dec.setBuffer(data);
		const msgType = dec.readUint8();

		switch (msgType) {
			case MessageType.PlayerState: {
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
					player.saveDirty = true;
				}
				break;
			}

			case MessageType.SkinUpload: {
				const player = this.players.get(client.sessionId);
				if (!player) break;

				const len = dec.readUint16();
				if (len === 0 || len > MAX_SKIN_BYTES) {
					throw new Error(`skin upload out of range: ${len} bytes`);
				}
				const png = dec.readBytes(len);
				if (!isPngBytes(png)) {
					throw new Error("skin upload is not a PNG");
				}

				// Session-scoped: store and relay to everyone else. Late joiners
				// get it via the onJoin snapshot.
				player.skin = png;
				this.broadcastBytes(
					"binary",
					encodePlayerSkin({ index: player.index, png }),
					{ except: client },
				);
				break;
			}

			case MessageType.BlockEdit: {
				const edit = dec.readBlockEditInto(this.editScratch);
				const player = this.players.get(client.sessionId);
				if (!player) {
					this.sendBlockEditRejected(
						client,
						edit,
						BlockEditRejectReason.NotAPlayer,
					);
					return;
				}
				if (!this.isValidBlockEdit(edit)) {
					this.sendBlockEditRejected(
						client,
						edit,
						BlockEditRejectReason.InvalidEdit,
					);
					return;
				}

				const dx = edit.x - player.x;
				const dy = edit.y - player.y;
				const dz = edit.z - player.z;
				const distSq = dx * dx + dy * dy + dz * dz;
				const maxReachSq = this.config.maxReach * this.config.maxReach;
				if (distSq > maxReachSq) {
					if (!this.reachRejectWarned.has(client.sessionId)) {
						this.reachRejectWarned.add(client.sessionId);
						console.warn(
							`[VoxelRoom] Block edit rejected: too far (${Math.sqrt(distSq).toFixed(1)} blocks)`,
						);
					}
					this.sendBlockEditRejected(
						client,
						edit,
						BlockEditRejectReason.TooFar,
					);
					return;
				}

				const blockId =
					edit.action === BlockActionType.Break ? 0 : edit.blockId;
				const blockState =
					edit.action === BlockActionType.Break ? 0 : edit.blockState;
				const storedEdit: BlockEditData = {
					sessionId: client.sessionId,
					x: edit.x,
					y: edit.y,
					z: edit.z,
					blockId,
					blockState,
					action: edit.action,
				};
				this.recordBlockEdit(storedEdit);

				const cx = edit.x >> 5;
				const cy = edit.y >> 5;
				const cz = edit.z >> 5;
				const key = packChunkKeyFast(cx, cy, cz);
				let editMap = this.pendingChunkEdits.get(key);
				if (!editMap) {
					editMap = new Map();
					this.pendingChunkEdits.set(key, editMap);
				}

				const lx = edit.x & 31;
				const ly = edit.y & 31;
				const lz = edit.z & 31;
				const voxelIndex = lx + (ly << 5) + (lz << 10);

				const prev = editMap.get(voxelIndex);
				if (prev) this.releaseEditEntry(prev);
				const entry = this.acquireEditEntry();
				entry.x = edit.x;
				entry.y = edit.y;
				entry.z = edit.z;
				entry.blockId = blockId;
				entry.blockState = blockState;
				editMap.set(voxelIndex, entry);
				this.dirtyChunks.add(key);
				this.scheduleChunkFlush();
				// Make the edit visible to MobSimulation immediately — otherwise
				// TickBlockSampler.getCachedChunkBlocks() keeps returning the old
				// block for up to 500 ms (flush debounce), so mobs hover after
				// their support is mined in multiplayer.
				this.worldStorage.setCachedBlock(
					edit.x,
					edit.y,
					edit.z,
					blockId,
					blockState,
				);
				this.mobSim.notifyBlockEdit(edit.x, edit.y, edit.z, blockId);

				this.editBroadcastEncoder.reset();
				this.editBroadcastEncoder.writeUint8(MessageType.BlockEditBroadcast);
				this.editBroadcastEncoder.writeString(storedEdit.sessionId);
				this.editBroadcastEncoder.writeInt32(storedEdit.x);
				this.editBroadcastEncoder.writeInt32(storedEdit.y);
				this.editBroadcastEncoder.writeInt32(storedEdit.z);
				this.editBroadcastEncoder.writeUint16(storedEdit.blockId);
				this.editBroadcastEncoder.writeUint8(storedEdit.blockState);
				this.editBroadcastEncoder.writeUint8(storedEdit.action);
				this.broadcastBytes("binary", this.editBroadcastEncoder.getBytes(), {
					except: client,
				});
				break;
			}

			case MessageType.ChunkRequest: {
				const req = dec.readChunkRequestInto(this.chunkRequestScratch);
				if (
					!this.isValidChunkRequest(
						req.cx,
						req.cy,
						req.cz,
						req.lod,
						req.cachedVersion,
					)
				)
					break;
				void this.handleChunkRequest(
					client,
					req.cx,
					req.cy,
					req.cz,
					req.cachedVersion,
				);
				break;
			}

			case MessageType.ChunkRequestBatch: {
				this.handleChunkRequestBatchMessage(client, dec);
				break;
			}

			case MessageType.ChatMessage: {
				const chat = dec.readChatMessageInto(this.chatScratch);
				const player = this.players.get(client.sessionId);
				if (!player) return;

				const trimmed = chat.message.trim();
				if (trimmed.length === 0) return;
				const firstChar = trimmed.charCodeAt(0);

				if (firstChar === 33 || firstChar === 47) {
					if (this.handleChatCommand(client, trimmed.slice(1).trim())) break;
				}

				this.broadcastBytes(
					"binary",
					encodeChatMessage({
						sessionId: client.sessionId,
						name: player.name,
						message: chat.message,
					}),
					{ except: client },
				);
				break;
			}

			case MessageType.ItemDrop: {
				const drop = decodeItemDropInto(dec, this.itemDropScratch);
				const player = this.players.get(client.sessionId);
				if (!player) return;
				if (!this.isValidItemDrop(drop)) return;

				const item = this.itemSim.add(
					drop.itemId,
					drop.stackSize,
					drop.x,
					drop.y,
					drop.z,
					drop.vx,
					drop.vy,
					drop.vz,
				);
				this.broadcastBytes(
					"binary",
					encodeItemSpawn({
						id: item.id,
						itemId: item.itemId,
						stackSize: item.stackSize,
						x: item.x,
						y: item.y,
						z: item.z,
						vx: item.vx,
						vy: item.vy,
						vz: item.vz,
					}),
					{},
				);
				break;
			}

			case MessageType.ItemPickup: {
				const pickup = decodeItemPickupInto(dec, this.itemPickupScratch);
				const player = this.players.get(client.sessionId);
				if (!player) return;

				const item = this.itemSim.get(pickup.itemId);
				if (!item) {
					// Tell the picker their optimistic pickup failed so they can
					// roll the phantom stack out of their inventory.
					client.sendBytes(
						"binary",
						encodeItemPickupRejected({
							id: pickup.itemId,
							reason: ItemPickupRejectReason.NotFound,
						}),
					);
					return;
				}

				const dx = item.x - player.x;
				const dy = item.y - player.y;
				const dz = item.z - player.z;
				if (dx * dx + dy * dy + dz * dz > ITEM_PICKUP_RADIUS_SQ) {
					client.sendBytes(
						"binary",
						encodeItemPickupRejected({
							id: pickup.itemId,
							reason: ItemPickupRejectReason.TooFar,
						}),
					);
					return;
				}

				this.itemSim.remove(pickup.itemId);
				this.broadcastBytes("binary", encodeItemDespawn(pickup.itemId), {});
				break;
			}

			case MessageType.MobSpawnRequest: {
				const request = decodeMobSpawnRequestInto(
					dec,
					this.mobSpawnRequestScratch,
				);
				const player = this.players.get(client.sessionId);
				if (!player) return;

				const validRequest =
					Number.isFinite(request.x) &&
					Number.isFinite(request.y) &&
					Number.isFinite(request.z) &&
					Math.abs(request.x) <= WORLD_BOUNDARY &&
					Math.abs(request.y) <= WORLD_BOUNDARY &&
					Math.abs(request.z) <= WORLD_BOUNDARY;
				if (!validRequest) return;

				const dx = request.x - player.x;
				const dy = request.y - player.y;
				const dz = request.z - player.z;
				if (dx * dx + dy * dy + dz * dz > MAX_MOB_SPAWN_REQUEST_DIST_SQ) {
					return;
				}

				// Egg mobs are cap-exempt on the server too; the sim validates
				// the typeId and the spawn cell (loaded chunk, non-solid).
				const mob = this.mobSim.spawnEggMob(
					request.typeId,
					request.x,
					request.y,
					request.z,
				);
				if (!mob) return;

				// Broadcast to everyone (including the requester) so all
				// clients render the new mob via RemoteMobManager.
				this.broadcastBytes(
					"binary",
					encodeMobSpawn(mob.id, mob.typeId, mob.x, mob.y, mob.z, mob.yaw),
					{},
				);
				break;
			}

			case MessageType.MobDamage: {
				const damage = decodeMobDamageInto(dec, this.mobDamageScratch);
				const player = this.players.get(client.sessionId);
				if (!player) return;

				// Clamp hostile values; arrows may deal fractional damage (e.g. 0.4).
				if (damage.damage <= 0 || damage.damage > 20) return;

				const mob = this.mobSim.findMob(damage.mobId);
				if (!mob) return;

				const dx = mob.x - player.x;
				const dy = mob.y - player.y;
				const dz = mob.z - player.z;
				if (dx * dx + dy * dy + dz * dz > MAX_MOB_SPAWN_REQUEST_DIST_SQ) {
					return;
				}

				const killed = this.mobSim.damageMob(damage.mobId, damage.damage);
				// Relay accepted damage as a cosmetic event so every client sees the
				// hit, including clients that do not own the projectile.
				this.broadcastBytes(
					"binary",
					encodeMobDamage({ mobId: damage.mobId, damage: damage.damage }),
					{ except: client },
				);
				if (killed) {
					this.broadcastBytes("binary", encodeMobDespawn(damage.mobId), {});
				}
				break;
			}

			case MessageType.ArrowShoot: {
				const arrow = decodeArrowShootInto(dec, this.arrowShootScratch);
				const player = this.players.get(client.sessionId);
				if (!player) return;

				const speedSq =
					arrow.vx * arrow.vx + arrow.vy * arrow.vy + arrow.vz * arrow.vz;

				const validTrajectory =
					Number.isFinite(arrow.x) &&
					Number.isFinite(arrow.y) &&
					Number.isFinite(arrow.z) &&
					Number.isFinite(arrow.vx) &&
					Number.isFinite(arrow.vy) &&
					Number.isFinite(arrow.vz) &&
					Math.abs(arrow.x) <= WORLD_BOUNDARY &&
					Math.abs(arrow.y) <= WORLD_BOUNDARY &&
					Math.abs(arrow.z) <= WORLD_BOUNDARY &&
					speedSq <= MAX_ARROW_SPEED * MAX_ARROW_SPEED;
				if (!validTrajectory) return;

				// Relay to everyone except the shooter — their own arrow is
				// already simulated locally.
				this.broadcastBytes(
					"binary",
					encodeArrowSpawn({
						x: arrow.x,
						y: arrow.y,
						z: arrow.z,
						vx: arrow.vx,
						vy: arrow.vy,
						vz: arrow.vz,
						arrowType: arrow.arrowType,
					}),
					{ except: client },
				);
				break;
			}

			default:
				if (!this.unknownTypeWarned.has(client.sessionId)) {
					this.unknownTypeWarned.add(client.sessionId);
					console.warn(
						`[VoxelRoom] Unknown message type: 0x${msgType.toString(16)}`,
					);
				}
		}
	}
	private readonly chunkRequestBatchScratchPool: Array<
		Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>
	> = [];

	private handleChunkRequestBatchMessage(
		client: Client,
		dec: BinaryDecoder,
	): void {
		const encodedCount = dec.readUint16();
		const count = Math.min(encodedCount, MAX_CHUNK_BATCH);

		let requests = this.chunkRequestBatchScratchPool.pop();
		if (!requests) requests = [];
		let write = 0;

		for (let i = 0; i < count; i++) {
			const cx = dec.readInt32();
			const cy = dec.readInt32();
			const cz = dec.readInt32();
			const lod = dec.readUint8();
			const cachedVersion = dec.readUint32();

			if (!this.isValidChunkRequest(cx, cy, cz, lod, cachedVersion)) {
				continue;
			}

			let entry = requests[write];
			if (!entry) {
				entry = { cx: 0, cy: 0, cz: 0, lod: 0, cachedVersion: 0 };
				requests[write] = entry;
			}
			entry.cx = cx;
			entry.cy = cy;
			entry.cz = cz;
			entry.lod = lod;
			entry.cachedVersion = cachedVersion;
			write++;
		}

		if (write === 0) {
			requests.length = 0;
			if (this.chunkRequestBatchScratchPool.length < 8) {
				this.chunkRequestBatchScratchPool.push(requests);
			}
			return;
		}
		requests.length = write;
		void this.handleBatchChunkRequest(client, requests).finally(() => {
			requests.length = 0;
			if (this.chunkRequestBatchScratchPool.length < 8) {
				this.chunkRequestBatchScratchPool.push(requests);
			}
		});
	}
	private async ensureEditsApplied(keys: readonly number[]): Promise<void> {
		const keyCount = keys.length;
		if (keyCount === 0) return;

		await this.waitForOverlappingFlush(keys);

		const claimed: Array<{
			key: number;
			editMap: Map<number, PendingBlockEdit>;
		}> = [];

		let claimedCount = 0;

		for (let i = 0; i < keyCount; i++) {
			const key = keys[i];
			const editMap = this.pendingChunkEdits.get(key);

			if (!editMap || editMap.size === 0) continue;

			/*
			 * Only delete the exact map we claimed. JavaScript execution is
			 * synchronous until the next await, but keeping ownership explicit
			 * makes future changes safer.
			 */
			if (this.pendingChunkEdits.get(key) !== editMap) continue;

			this.pendingChunkEdits.delete(key);
			this.dirtyChunks.delete(key);

			claimed[claimedCount++] = { key, editMap };
		}

		if (claimedCount === 0) return;

		try {
			await runWithConcurrency(
				claimed,
				FLUSH_CONCURRENCY,
				async ({ key, editMap }) => {
					const [cx, cy, cz] = unpackChunkKeyFast(key);
					await this.worldStorage.applyBlockEdits(cx, cy, cz, editMap.values());
				},
			);

			await this.worldStorage.flush();

			for (let i = 0; i < claimedCount; i++) {
				this.releaseEditEntries(claimed[i].editMap);
			}
		} catch (error) {
			for (let i = 0; i < claimedCount; i++) {
				const { key, editMap } = claimed[i];

				let current = this.pendingChunkEdits.get(key);
				if (!current) {
					current = new Map();
					this.pendingChunkEdits.set(key, current);
				}

				/*
				 * Newer edits win. If the same voxel was edited while the claimed
				 * batch was being persisted, do not overwrite that newer edit.
				 */
				for (const [voxelIndex, entry] of editMap) {
					if (current.has(voxelIndex)) {
						this.releaseEditEntry(entry);
					} else {
						current.set(voxelIndex, entry);
					}
				}

				this.dirtyChunks.add(key);
			}

			this.scheduleChunkFlush();
			throw error;
		}
	}

	private async handleChunkRequest(
		client: Client,
		cx: number,
		cy: number,
		cz: number,
		cachedVersion: number,
	): Promise<void> {
		try {
			const key = packChunkKeyFast(cx, cy, cz);
			const keyScratch = this.singleChunkKeyScratch;
			keyScratch[0] = key;

			await this.ensureEditsApplied(keyScratch);

			const stored = await this.worldStorage.readChunk(cx, cy, cz);
			const chunk = stored ?? (await this.chunkGen.generateChunk(cx, cy, cz));

			if (stored?.version === cachedVersion) {
				if (DEBUG_ENABLED) {
					debugLog(
						`[VoxelRoom] handleChunkRequest ${cx},${cy},${cz} cachedVersion=${cachedVersion} serverVersion=${stored.version} unchanged`,
					);
				}

				client.sendBytes(
					"binary",
					encodeChunkUnchanged(cx, cy, cz, stored.version),
				);
				return;
			}

			if (DEBUG_ENABLED && stored !== undefined) {
				debugLog(
					`[VoxelRoom] handleChunkRequest ${cx},${cy},${cz} cachedVersion=${cachedVersion} serverVersion=${stored?.version} sendingFullData`,
				);
			}

			if (!deflateSupported()) {
				client.sendBytes("binary", encodeChunkData(chunk));
				return;
			}

			const chunkKey = packChunkKeyFast(
				chunk.chunkX,
				chunk.chunkY,
				chunk.chunkZ,
			);

			let entry = this.getWireEntry(chunkKey, chunk.version);
			if (entry === undefined) {
				const blob = this.serializeStored(chunk);
				const payload = await deflate(blob);

				entry = {
					version: chunk.version,
					origLen: blob.byteLength,
					payload,
				};
				this.setWireEntry(chunkKey, entry);
			}

			client.sendBytes(
				"binary",
				encodeChunkDataDeflatedPayload({
					chunkX: chunk.chunkX,
					chunkY: chunk.chunkY,
					chunkZ: chunk.chunkZ,
					version: chunk.version,
					origLen: entry.origLen,
					deflated: entry.payload,
				}),
			);
		} catch (error) {
			console.error(
				`[VoxelRoom] Chunk gen failed for ${cx},${cy},${cz}:`,
				error,
			);
		}
	}

	private async handleBatchChunkRequest(
		client: Client,
		requests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>,
	): Promise<void> {
		const requestCount = requests.length;
		if (requestCount === 0) return;

		/*
		 * Batch handlers may overlap because callers intentionally do not await them.
		 * Therefore, class-level scratch arrays cannot safely remain checked out
		 * across awaits. Claim a reusable workspace for this invocation and return
		 * it in finally.
		 */
		type Request = (typeof requests)[number];
		type Coord = { cx: number; cy: number; cz: number };
		type MissingCoord = {
			chunkX: number;
			chunkY: number;
			chunkZ: number;
		};
		type UnchangedChunk = {
			cx: number;
			cy: number;
			cz: number;
			version: number;
		};

		type BatchWorkspace = {
			uniqueRequests: Request[];
			coords: Coord[];
			keys: number[];
			missingCoords: MissingCoord[];
			fullChunks: StoredChunkData[];
			unchangedChunks: UnchangedChunk[];
			seen: Set<number>;
		};

		/*
		 * Put this field on VoxelRoom to reuse workspaces safely:
		 *
		 * private readonly chunkBatchWorkspacePool: BatchWorkspace[] = [];
		 *
		 * If keeping helper types outside the method is preferred, move Request and
		 * BatchWorkspace to module scope.
		 */
		const workspacePool = this.chunkBatchWorkspacePool as BatchWorkspace[];
		const workspace =
			workspacePool.pop() ??
			({
				uniqueRequests: [],
				coords: [],
				keys: [],
				missingCoords: [],
				fullChunks: [],
				unchangedChunks: [],
				seen: new Set<number>(),
			} satisfies BatchWorkspace);

		const uniqueRequests = workspace.uniqueRequests;
		const coords = workspace.coords;
		const keys = workspace.keys;
		const missingCoords = workspace.missingCoords;
		const fullChunks = workspace.fullChunks;
		const unchangedChunks = workspace.unchangedChunks;
		const seen = workspace.seen;

		uniqueRequests.length = 0;
		coords.length = 0;
		keys.length = 0;
		missingCoords.length = 0;
		fullChunks.length = 0;
		unchangedChunks.length = 0;
		seen.clear();

		try {
			let uniqueCount = 0;

			for (let i = 0; i < requestCount; i++) {
				const request = requests[i];
				const key = packChunkKeyFast(request.cx, request.cy, request.cz);

				if (seen.has(key)) continue;
				seen.add(key);

				uniqueRequests[uniqueCount] = request;

				let coord = coords[uniqueCount];
				if (coord === undefined) {
					coord = { cx: 0, cy: 0, cz: 0 };
					coords[uniqueCount] = coord;
				}

				coord.cx = request.cx;
				coord.cy = request.cy;
				coord.cz = request.cz;
				keys[uniqueCount] = key;
				uniqueCount++;
			}

			if (uniqueCount === 0) return;

			uniqueRequests.length = uniqueCount;
			coords.length = uniqueCount;
			keys.length = uniqueCount;

			await this.ensureEditsApplied(keys);

			const storedMap = await this.worldStorage.readChunks(coords);

			let missingCount = 0;
			let fullCount = 0;
			let unchangedCount = 0;

			for (let i = 0; i < uniqueCount; i++) {
				const request = uniqueRequests[i];
				const stored = storedMap.get(keys[i]);

				if (stored === undefined) {
					let missing = missingCoords[missingCount];
					if (missing === undefined) {
						missing = {
							chunkX: 0,
							chunkY: 0,
							chunkZ: 0,
						};
						missingCoords[missingCount] = missing;
					}

					missing.chunkX = request.cx;
					missing.chunkY = request.cy;
					missing.chunkZ = request.cz;
					missingCount++;
					continue;
				}

				if (stored.version === request.cachedVersion) {
					let unchanged = unchangedChunks[unchangedCount];
					if (unchanged === undefined) {
						unchanged = {
							cx: 0,
							cy: 0,
							cz: 0,
							version: 0,
						};
						unchangedChunks[unchangedCount] = unchanged;
					}

					unchanged.cx = request.cx;
					unchanged.cy = request.cy;
					unchanged.cz = request.cz;
					unchanged.version = stored.version;
					unchangedCount++;
				} else {
					fullChunks[fullCount++] = stored;
				}
			}

			missingCoords.length = missingCount;
			fullChunks.length = fullCount;
			unchangedChunks.length = unchangedCount;

			if (fullCount !== 0) {
				await this.sendChunkDataBatch(client, fullChunks);
			}

			if (unchangedCount !== 0) {
				this.sendUnchangedBatch(client, unchangedChunks);
			}

			if (missingCount === 0) return;

			try {
				const generated =
					await this.chunkGen.generateChunksBatch(missingCoords);

				await this.sendChunkDataBatch(client, generated);
			} catch (batchError) {
				console.warn(
					`[VoxelRoom] Batch generation failed; retrying ${missingCount} chunks individually`,
					batchError,
				);

				await runWithConcurrency(
					missingCoords,
					4,
					async (coord): Promise<void> => {
						try {
							const data = await this.chunkGen.generateChunk(
								coord.chunkX,
								coord.chunkY,
								coord.chunkZ,
							);

							await this.sendChunkDataBatch(client, [data]);
						} catch (singleError) {
							console.error(
								`[VoxelRoom] Single chunk gen failed: ${coord.chunkX},${coord.chunkY},${coord.chunkZ}`,
								singleError,
							);
						}
					},
				);
			}
		} catch (error) {
			console.error(
				`[VoxelRoom] Batch chunk request FAILED (${requestCount} chunks):`,
				error,
			);
		} finally {
			uniqueRequests.length = 0;
			coords.length = 0;
			keys.length = 0;
			missingCoords.length = 0;
			fullChunks.length = 0;
			unchangedChunks.length = 0;
			seen.clear();

			/*
			 * Bound retained memory. A small pool is sufficient because normal
			 * concurrency should remain low, while preventing a traffic spike from
			 * permanently retaining many large workspaces.
			 */
			if (workspacePool.length < 8) {
				workspacePool[workspacePool.length] = workspace;
			}
		}
	}
	private readonly chunkBatchWorkspacePool: Array<{
		uniqueRequests: Array<{
			cx: number;
			cy: number;
			cz: number;
			lod: number;
			cachedVersion: number;
		}>;
		coords: Array<{ cx: number; cy: number; cz: number }>;
		keys: number[];
		missingCoords: Array<{
			chunkX: number;
			chunkY: number;
			chunkZ: number;
		}>;
		fullChunks: StoredChunkData[];
		unchangedChunks: Array<{
			cx: number;
			cy: number;
			cz: number;
			version: number;
		}>;
		seen: Set<number>;
	}> = [];
	private sendUnchangedBatch(
		client: Client,
		unchangedChunks: Array<{
			cx: number;
			cy: number;
			cz: number;
			version: number;
		}>,
	): void {
		if (unchangedChunks.length === 0) return;
		const enc = this.chunkBatchEncoder;
		enc.reset();
		enc.writeUint8(MessageType.ChunkUnchangedBatch);
		enc.writeUint16(unchangedChunks.length);
		for (let i = 0; i < unchangedChunks.length; i++) {
			const u = unchangedChunks[i];
			enc.writeInt32(u.cx);
			enc.writeInt32(u.cy);
			enc.writeInt32(u.cz);
			enc.writeUint32(u.version);
		}
		client.sendBytes("binary", enc.getBytes());
	}
}
