/**
 * Binary protocol definitions for b102 multiplayer.
 *
 * Message types are single-byte IDs. All multi-byte integers are little-endian.
 * Positions are float32 (sub-block precision, full float range).
 * Rotations are uint8 (1.4° precision).
 *
 * Shared between client and server.
 */

export const MessageType = {
	// Client → Server
	PlayerState: 0x01,
	BlockEdit: 0x02,
	ChunkRequest: 0x03,

	// Server → Client
	PlayerStateBatch: 0x10,
	PlayerJoin: 0x11,
	PlayerLeave: 0x12,
	BlockEditBroadcast: 0x13,
	BlockEditBatch: 0x14, // Sent on join: all recent edits
	ChunkData: 0x15,
	WorldTime: 0x16,
	ChatMessage: 0x17,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const BlockActionType = {
	Place: 0,
	Break: 1,
} as const;

export type BlockActionType =
	(typeof BlockActionType)[keyof typeof BlockActionType];

export interface PlayerStateData {
	sessionId: string;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	animation: number;
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
	sessionId: string;
	name: string;
}

export interface PlayerLeaveData {
	sessionId: string;
}

export interface ChatMessageData {
	sessionId: string;
	name: string;
	message: string;
}
