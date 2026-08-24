import { MeshData } from "../Chunk/DataStructures/MeshData";

const _emptyU8 = new Uint8Array(0);

const MESH_HEADER_BYTES = 8;
const MESH_PAIR_HEADER_BYTES = 11;

// v3: three separate SoA face sections (faceDataA/B/C).
// v4: single interleaved face-record section (12 bytes per face, 3 u32
// words), matching the GPU arena layout end-to-end. Old-format blobs return
// null from deserializeMeshPair and are silently re-meshed.
const MESH_FORMAT_VERSION = 4;

function writeU32LE(buf: Uint8Array, off: number, val: number): void {
	const v = val >>> 0;
	buf[off] = v & 0xff;
	buf[off + 1] = (v >>> 8) & 0xff;
	buf[off + 2] = (v >>> 16) & 0xff;
	buf[off + 3] = v >>> 24;
}
function readU32LE(buf: Uint8Array, off: number): number {
	return (
		(buf[off] |
			(buf[off + 1] << 8) |
			(buf[off + 2] << 16) |
			(buf[off + 3] << 24)) >>>
		0
	);
}

function serializedMeshLength(mesh: MeshData): number {
	return MESH_HEADER_BYTES + mesh.faceData.length;
}

function writeSerializedMeshInto(
	out: Uint8Array,
	off: number,
	mesh: MeshData,
): number {
	const data = mesh.faceData;
	const dataLen = data.length;

	writeU32LE(out, off, mesh.faceCount >>> 0);
	writeU32LE(out, off + 4, dataLen);

	if (dataLen !== 0) {
		out.set(data, off + MESH_HEADER_BYTES);
	}

	return MESH_HEADER_BYTES + dataLen;
}

/**
 * Serializes a MeshData into a single Uint8Array for OPFS storage.
 * Format (v4):
 * [faceCount: u32 LE]
 * [dataLen: u32 LE]
 * [faceData: interleaved face records, dataLen bytes]
 */
export function serializeMesh(
	mesh: MeshData | null | undefined,
): Uint8Array | null {
	if (!mesh) return null;

	const out = new Uint8Array(serializedMeshLength(mesh));
	writeSerializedMeshInto(out, 0, mesh);
	return out;
}

/**
 * Deserializes a Uint8Array, as written by serializeMesh, into a MeshData.
 * Throws if the data is too short or declares more bytes than available.
 */
export function deserializeMesh(bytes: Uint8Array): MeshData {
	if (bytes.byteLength < MESH_HEADER_BYTES) {
		throw new Error("Invalid mesh data: too short");
	}

	const faceCountRaw = readU32LE(bytes, 0);
	const dataLen = readU32LE(bytes, 4);

	const total = MESH_HEADER_BYTES + dataLen;

	if (total > bytes.byteLength) {
		throw new Error(
			`Invalid mesh data: declared ${total} bytes, got ${bytes.byteLength}`,
		);
	}

	// Defensive: a corrupt faceCount must never desync from the byte stream.
	// Clamp to the record-aligned length instead of trusting the header.
	const faceCount =
		faceCountRaw * 12 === dataLen ? faceCountRaw : (dataLen / 12) | 0;

	const mesh = new MeshData();

	mesh.faceCount = faceCount;
	mesh.faceData =
		dataLen !== 0 ? bytes.subarray(MESH_HEADER_BYTES, total) : _emptyU8;

	return mesh;
}

/**
 * Combines an opaque + transparent mesh into a single Uint8Array for storage.
 * Format:
 * [version: u8]
 * [hasOpaque: u8]
 * [hasTransparent: u8]
 * [oLen: u32 LE]
 * [tLen: u32 LE]
 * [oData: oLen bytes, only if hasOpaque]
 * [tData: tLen bytes, only if hasTransparent]
 */
export function serializeMeshPair(
	opaque: MeshData | null | undefined,
	transparent: MeshData | null | undefined,
): Uint8Array | null {
	if (!opaque && !transparent) return null;

	const oLen = opaque ? serializedMeshLength(opaque) : 0;
	const tLen = transparent ? serializedMeshLength(transparent) : 0;

	const out = new Uint8Array(MESH_PAIR_HEADER_BYTES + oLen + tLen);

	out[0] = MESH_FORMAT_VERSION;
	out[1] = opaque ? 1 : 0;
	out[2] = transparent ? 1 : 0;

	writeU32LE(out, 3, oLen);
	writeU32LE(out, 7, tLen);

	let off = MESH_PAIR_HEADER_BYTES;

	if (opaque) {
		off += writeSerializedMeshInto(out, off, opaque);
	}

	if (transparent) {
		writeSerializedMeshInto(out, off, transparent);
	}

	return out;
}

export type DeserializedMeshPair = {
	opaque: MeshData | null;
	transparent: MeshData | null;
	lod: number;
};

/**
 * Deserializes a mesh pair from a Uint8Array, as written by serializeMeshPair.
 * Throws if the data is too short or declares more bytes than available.
 * Returns null for stale or unsupported mesh format versions.
 */
export function deserializeMeshPair(
	bytes: Uint8Array,
	lod: number,
): DeserializedMeshPair | null {
	if (bytes.byteLength < MESH_PAIR_HEADER_BYTES) {
		throw new Error("Invalid mesh pair: too short");
	}

	const version = bytes[0];

	if (version !== MESH_FORMAT_VERSION) {
		return null;
	}

	const hasO = bytes[1] !== 0;
	const hasT = bytes[2] !== 0;

	const oLen = readU32LE(bytes, 3);
	const tLen = readU32LE(bytes, 7);

	const total = MESH_PAIR_HEADER_BYTES + oLen + tLen;

	if (total > bytes.byteLength) {
		throw new Error(
			`Invalid mesh pair: declared ${total} bytes, got ${bytes.byteLength}`,
		);
	}

	if (!hasO && oLen !== 0) {
		throw new Error("Invalid mesh pair: opaque length set without opaque mesh");
	}

	if (!hasT && tLen !== 0) {
		throw new Error(
			"Invalid mesh pair: transparent length set without transparent mesh",
		);
	}

	let off = MESH_PAIR_HEADER_BYTES;
	let opaque: MeshData | null = null;
	let transparent: MeshData | null = null;

	if (hasO && oLen !== 0) {
		opaque = deserializeMesh(bytes.subarray(off, off + oLen));
	}

	off += oLen;

	if (hasT && tLen !== 0) {
		transparent = deserializeMesh(bytes.subarray(off, off + tLen));
	}

	return { opaque, transparent, lod };
}
