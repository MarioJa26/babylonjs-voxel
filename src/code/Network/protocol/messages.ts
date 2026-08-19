/**
 * Binary protocol definitions for b102 multiplayer.
 *
 * Message types are single-byte IDs. All multi-byte integers are little-endian.
 * Positions are float32 (sub-block precision, full float range).
 * Rotations are uint8 (yaw: 0-255 maps the full 360° circle, pitch: 0-255 maps
 * -90°..+90°).
 *
 * Player identity:
 *  - C→S messages (PlayerState, BlockEdit) carry NO sessionId — the server
 *    uses the connection identity.
 *  - S→C PlayerStateBatch uses a per-room uint8 player index (assigned at
 *    join, announced in PlayerJoin) instead of repeating sessionId strings.
 *  - PlayerJoin carries the assigned index; PlayerLeave carries the index
 *    instead of a sessionId string.
 *
 * Shared between client and server — single source of truth. The server
 * imports this module via its "@/code/Network/protocol/*" path alias.
 */

export const MessageType = {
	// Client → Server
	PlayerState: 0x01,
	BlockEdit: 0x02,
	ChunkRequest: 0x03,
	ChunkRequestBatch: 0x04,

	// Server → Client
	PlayerStateBatch: 0x10,
	PlayerJoin: 0x11,
	PlayerLeave: 0x12,
	BlockEditBroadcast: 0x13,
	BlockEditBatch: 0x14, // Sent on join: all recent edits
	ChunkData: 0x15,
	ChunkUnchanged: 0x16, // Server says "your cached chunk is still valid"
	WorldTime: 0x17,
	ChatMessage: 0x18,
	ChunkDataBatch: 0x19,
	ChunkUnchangedBatch: 0x1c, // Server → client: multiple "still valid" stamps
	WorldConfig: 0x1a, // Server → client: authoritative world seed on join
	SpawnPosition: 0x1b, // Server → client: teleport player to saved position
	BlockEditRejected: 0x1d, // Server → client: a block edit was rejected

	// Server → Client: server-authoritative mobs
	// 0x20 is reserved for a future client → server MobDamage message.
	MobSpawn: 0x21, // New mob appeared (also sent as join snapshot)
	MobUpdateBatch: 0x22, // Position batch for all mobs (fixed-rate broadcast)
	MobDespawn: 0x23, // Mob removed (wandered off / despawned)

	// Server → Client: deflated chunk blobs — the full serialized storage
	// blob (serializeVoxelData output) compressed with zlib deflate. Carries
	// the same data as ChunkData/ChunkDataBatch but ~5-10x smaller on the
	// wire, and the client can persist it without re-serializing.
	ChunkDataDeflated: 0x24, // Single chunk: [cx:i32][cy:i32][cz:i32][version:u32][len:u32][deflated blob]
	ChunkDataDeflatedBatch: 0x25, // Multiple deflated chunk blobs in one message
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Discriminator for decoded chunk responses. Not part of the wire format
 * (the wire distinguishes data vs unchanged via MessageType) — it is stamped
 * by the decoders so consumers can switch on a numeric value instead of
 * comparing strings.
 */
export enum ChunkResultKind {
	Data = 0,
	Unchanged = 1,
}

export const BlockActionType = {
	Place: 0,
	Break: 1,
} as const;

export type BlockActionType =
	(typeof BlockActionType)[keyof typeof BlockActionType];

export const BlockEditRejectReason = {
	InvalidEdit: 0,
	TooFar: 1,
	NotAPlayer: 2,
} as const;

export type BlockEditRejectReason =
	(typeof BlockEditRejectReason)[keyof typeof BlockEditRejectReason];

/** Server → Client: the server rejected a block edit from this client. */
export interface BlockEditRejectedData {
	x: number;
	y: number;
	z: number;
	/** The block the client tried to place, or the block it broke. */
	blockId: number;
	action: number;
	reason: number;
}

/** Client → Server: full local player state (no sessionId — connection identity). */
export interface PlayerStateData {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	animation: number;
}

/** Server → Client: one entry of a PlayerStateBatch (index instead of sessionId). */
export interface PlayerStateBatchEntry extends PlayerStateData {
	index: number;
}

export interface BlockEditData {
	sessionId: string;
	x: number;
	y: number;
	z: number;
	blockId: number;
	action: number;
}

export interface PlayerJoinData {
	index: number;
	sessionId: string;
	name: string;
}

export interface PlayerLeaveData {
	index: number;
}

export interface ChatMessageData {
	sessionId: string;
	name: string;
	message: string;
}

/**
 * Server-authoritative mob species. Mirrors the client's singleplayer mob
 * registry (MobSetup.ts) so both sides agree on what a type id renders as.
 * Pure constants — safe to import from the server (no Babylon dependency).
 */
export const MobTypeId = {
	Chicken: 1,
	Sheep: 2,
} as const;

export type MobTypeId = (typeof MobTypeId)[keyof typeof MobTypeId];

/** One entry of a S→C MobUpdateBatch: identity + snapshot state. */
export interface MobUpdateBatchEntry {
	mobId: number;
	x: number;
	y: number;
	z: number;
	/** 0-255 byte mapping the full 360° circle (same convention as players). */
	yaw: number;
}

/** S→C: a single mob appeared (also sent as the join snapshot). */
export interface MobSpawnData {
	/** Server-assigned mob id (uint16). */
	id: number;
	/** MobTypeId (Chicken=1, Sheep=2). */
	typeId: number;
	x: number;
	y: number;
	z: number;
	/** 0-255 byte mapping the full 360° circle (same convention as players). */
	yaw: number;
}

/** S→C: a single mob was removed (wandered off / despawned). */
export interface MobDespawnData {
	/** Server-assigned mob id (uint16). */
	mobId: number;
}
