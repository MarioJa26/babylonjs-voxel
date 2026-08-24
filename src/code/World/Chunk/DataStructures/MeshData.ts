const EMPTY_U8 = new Uint8Array(0);

/**
 * Interleaved face-record stream: 12 bytes per face = 3 little-endian u32
 * words, matching the GPU arena's native record layout:
 *   word0 = sx | sy<<8 | sz<<16 | (axisFace|tint<<3)<<24
 *   word1 = sw | sh<<8 | tx<<16 | ty<<24
 *   word2 = ao | light<<8 | meta<<16 | chunkIndex<<24 (index stamped at merge)
 *
 * Single contiguous buffer end-to-end: the worker emits one record write,
 * transfers are one ArrayBuffer per bucket, merged-group assembly is one
 * memcpy per member, and the arena pack step is a plain copy instead of a
 * three-stream gather.
 */
export class MeshData {
	faceData: Uint8Array = EMPTY_U8;
	faceCount = 0;
}

export const MESH_FACE_BYTES = 12;
