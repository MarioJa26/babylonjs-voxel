import { MeshData } from "../Chunk/DataStructures/MeshData";

const _emptyU8 = new Uint8Array(0);

function writeU32LE(buf: Uint8Array, off: number, val: number): void {
	buf[off] = val & 0xff;
	buf[off + 1] = (val >> 8) & 0xff;
	buf[off + 2] = (val >> 16) & 0xff;
	buf[off + 3] = (val >> 24) & 0xff;
}

/**
 * Serializes a MeshData into a single Uint8Array for OPFS storage.
 * Format (no version — gzip compression is applied by the OPFS worker):
 *   [faceCount: u32 LE]
 *   [aLen: u32 LE]
 *   [bLen: u32 LE]
 *   [cLen: u32 LE]
 *   [aData: aLen bytes]
 *   [bData: bLen bytes]
 *   [cData: cLen bytes]
 */
export function serializeMesh(
	mesh: MeshData | null | undefined,
): Uint8Array | null {
	if (!mesh) return null;
	const a = mesh.faceDataA ?? _emptyU8;
	const b = mesh.faceDataB ?? _emptyU8;
	const c = mesh.faceDataC ?? _emptyU8;
	const aLen = a.length;
	const bLen = b.length;
	const cLen = c.length;
	const total = 16 + aLen + bLen + cLen;
	const out = new Uint8Array(total);
	writeU32LE(out, 0, mesh.faceCount >>> 0);
	writeU32LE(out, 4, aLen);
	writeU32LE(out, 8, bLen);
	writeU32LE(out, 12, cLen);
	out.set(a, 16);
	out.set(b, 16 + aLen);
	out.set(c, 16 + aLen + bLen);
	return out;
}

/**
 * Deserializes a Uint8Array (as written by serializeMesh) into a MeshData.
 * Throws if the data is too short or declares more bytes than available.
 */
export function deserializeMesh(bytes: Uint8Array): MeshData {
	if (bytes.byteLength < 16) {
		throw new Error("Invalid mesh data: too short");
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const faceCount = dv.getUint32(0, true);
	const aLen = dv.getUint32(4, true);
	const bLen = dv.getUint32(8, true);
	const cLen = dv.getUint32(12, true);
	const total = 16 + aLen + bLen + cLen;
	if (total > bytes.byteLength) {
		throw new Error(
			`Invalid mesh data: declared ${total} bytes, got ${bytes.byteLength}`,
		);
	}
	const mesh = new MeshData();
	mesh.faceCount = faceCount;
	mesh.faceDataA = aLen > 0 ? bytes.subarray(16, 16 + aLen) : _emptyU8;
	mesh.faceDataB =
		bLen > 0 ? bytes.subarray(16 + aLen, 16 + aLen + bLen) : _emptyU8;
	mesh.faceDataC =
		cLen > 0
			? bytes.subarray(16 + aLen + bLen, 16 + aLen + bLen + cLen)
			: _emptyU8;
	return mesh;
}

/**
 * Combines an opaque + transparent mesh into a single Uint8Array for storage.
 * Format:
 *   [hasOpaque: u8]
 *   [hasTransparent: u8]
 *   [oLen: u32 LE]
 *   [tLen: u32 LE]
 *   [oData: oLen bytes (only if hasOpaque)]
 *   [tData: tLen bytes (only if hasTransparent)]
 */
/**
 * Bump this when the mesh on-disk format changes. Stale meshes written with an
 * older version are discarded on read and re-meshed in the worker, which is
 * essential after fixes that change how blocks are meshed (e.g. grass crosses
 * were previously cached as full cubes before shape JSON finished loading).
 */
const MESH_FORMAT_VERSION = 2;

export function serializeMeshPair(
	opaque: MeshData | null | undefined,
	transparent: MeshData | null | undefined,
): Uint8Array | null {
	const o = serializeMesh(opaque);
	const t = serializeMesh(transparent);
	if (!o && !t) return null;
	const oLen = o?.length ?? 0;
	const tLen = t?.length ?? 0;
	const total = 11 + oLen + tLen;
	const out = new Uint8Array(total);
	out[0] = MESH_FORMAT_VERSION;
	out[1] = o ? 1 : 0;
	out[2] = t ? 1 : 0;
	writeU32LE(out, 3, oLen);
	writeU32LE(out, 7, tLen);
	if (o) out.set(o, 11);
	if (t) out.set(t, 11 + oLen);
	return out;
}

export type DeserializedMeshPair = {
	opaque: MeshData | null;
	transparent: MeshData | null;
	lod: number;
};

/**
 * Deserializes a mesh pair from a Uint8Array (as written by serializeMeshPair).
 * Throws if the data is too short or declares more bytes than available.
 */
export function deserializeMeshPair(
	bytes: Uint8Array,
	lod: number,
): DeserializedMeshPair | null {
	if (bytes.byteLength < 11) {
		throw new Error("Invalid mesh pair: too short");
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint8(0);
	if (version !== MESH_FORMAT_VERSION) {
		// Stale/unsupported mesh (e.g. a cube cached before shape JSON loaded).
		// Returning null makes the caller fall back to a fresh worker re-mesh.
		return null;
	}
	const hasO = dv.getUint8(1) !== 0;
	const hasT = dv.getUint8(2) !== 0;
	const oLen = dv.getUint32(3, true);
	const tLen = dv.getUint32(7, true);
	const total = 11 + oLen + tLen;
	if (total > bytes.byteLength) {
		throw new Error(
			`Invalid mesh pair: declared ${total} bytes, got ${bytes.byteLength}`,
		);
	}
	let off = 11;
	let opaque: MeshData | null = null;
	let transparent: MeshData | null = null;
	if (hasO && oLen > 0) {
		opaque = deserializeMesh(bytes.subarray(off, off + oLen));
		off += oLen;
	}
	if (hasT && tLen > 0) {
		transparent = deserializeMesh(bytes.subarray(off, off + tLen));
	}
	return { opaque, transparent, lod };
}
